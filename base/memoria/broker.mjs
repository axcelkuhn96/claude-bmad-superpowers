#!/usr/bin/env node
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameReader, encodeFrame } from './frame.mjs';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { authorizeCurrentDestination } from './setup.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { openArtifactIdentity, runtimePython, verifyRuntimeArtifacts } from './runtime.mjs';
import { withProjectLock } from './ledger.mjs';
import { createBrokerWorker } from './broker-worker.mjs';

const blocked = reason => ({ kind: 'unavailable', reason });
export const brokerPath = (root = path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria')) =>
  path.join(root, 'encoder.sock');
export async function brokerEndpointStatus(root) {
  if (!process.getuid) return 'unsafe';
  const file = brokerPath(root);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unsafe'; }
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return 'unsafe';
  return new Promise(resolve => {
    const socket = net.createConnection(file);
    const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish('unknown'), 150);
    socket.once('connect', () => finish('live'));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'orphan' : 'unknown'));
  });
}

// Called only while encoder.lock is held by the prospective owner.
export async function prepareBrokerEndpoint(root) {
  const file = brokerPath(root);
  let before;
  try { before = await fs.lstat(file); }
  catch (error) { return error.code === 'ENOENT' ? 'ready' : 'unsafe'; }
  if (await brokerEndpointStatus(root) !== 'orphan') return 'live';
  const after = await fs.lstat(file).catch(() => null);
  if (!after || !after.isSocket() || after.uid !== process.getuid() ||
      (after.mode & 0o077) || after.dev !== before.dev || after.ino !== before.ino) return 'unsafe';
  await fs.unlink(file);
  return 'ready';
}
const script = fileURLToPath(new URL('./python/worker.py', import.meta.url));
const envAllow = () => Object.fromEntries(['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CBS_MEMORIA_CA_FILE']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

export function readBrokerRequest(socket, accept, { receptionMs = 1000 } = {}) {
  const input = new FrameReader();
  let received = false;
  const deadline = performance.now() + receptionMs;
  const timer = setTimeout(() => { if (!received) socket.destroy(); }, receptionMs);
  socket.once('close', () => clearTimeout(timer));
  socket.on('data', chunk => {
    let frames;
    try { frames = input.push(chunk); }
    catch { socket.destroy(); return; }
    if (performance.now() >= deadline) {
      for (const frame of frames) frame.secret.fill(0);
      socket.destroy();
      return;
    }
    if (received || frames.length > 1 || frames.length && input.buffer.length) {
      for (const frame of frames) frame.secret.fill(0);
      socket.destroy();
      return;
    }
    if (!frames.length) return;
    received = true;
    clearTimeout(timer);
    accept(frames[0]);
  });
  socket.on('end', () => {
    try { input.end(); } catch { socket.destroy(); }
  });
}

export async function requestBroker(request, secret, { stateRoot, deadlineMs = 120000 } = {}) {
  if (process.platform === 'win32') return blocked('native_windows_unproved');
  const file = brokerPath(stateRoot);
  let socket;
  const key = Buffer.from(secret ?? '');
  try {
    const stat = await fs.lstat(path.dirname(file));
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return blocked('unsafe_broker');
    const endpoint = await fs.lstat(file);
    if (!endpoint.isSocket() || endpoint.uid !== process.getuid() || (endpoint.mode & 0o077)) return blocked('unsafe_broker');
    socket = net.createConnection(file);
    const parser = new FrameReader({ response: true });
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolve(value); } };
      const timer = setTimeout(() => finish(blocked('deadline')), deadlineMs);
      socket.once('connect', () => socket.write(encodeFrame({ ...request, deadlineAt: Date.now() + deadlineMs }, key)));
      socket.on('data', chunk => {
        try { const frames = parser.push(chunk); if (frames.length) finish(frames[0].value); }
        catch { finish(blocked('broker_protocol')); }
      });
      socket.once('error', () => finish(blocked('broker_unavailable')));
      socket.once('close', () => { if (!settled) finish(blocked('broker_unavailable')); });
    });
  } catch { return blocked('broker_unavailable'); }
  finally { key.fill(0); socket?.destroy(); }
}

export async function serveBroker({ stateRoot, bootstrapCwd, bootstrapSessionId, idleMs = 300000 } = {}) {
  if (process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  const resolution = await inspectConfiguration(bootstrapCwd, { stateRoot });
  if (resolution.provider !== 'mem0') return blocked(resolution.reason ?? 'unbound');
  const trust = await readLocalTrust(resolution.stateDir);
  if (!trust || Object.entries(trustTuple(resolution)).some(([key, value]) => trust[key] !== value)) {
    return blocked('trust_changed');
  }
  const model = path.join(resolution.stateDir, 'artifacts', 'model.onnx');
  const tokenizer = path.join(resolution.stateDir, 'artifacts', 'tokenizer.json');
  if ((await verifyRuntimeArtifacts(model, tokenizer)).kind !== 'verified') return blocked('missing_artifact');
  const root = stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.lstat(root);
  if (dir.uid !== process.getuid() || (dir.mode & 0o077)) return blocked('unsafe_broker');
  const file = brokerPath(root);
  const endpoint = await brokerEndpointStatus(root);
  if (endpoint === 'live' || endpoint === 'unknown') return blocked('broker_owned');
  if (endpoint === 'unsafe') return blocked('unsafe_broker');
  try { return await withProjectLock(root, async () => {
  const prepared = await prepareBrokerEndpoint(root);
  if (prepared !== 'ready') return blocked(prepared === 'unsafe' ? 'unsafe_broker' : 'broker_owned');
  const artifacts = await openArtifactIdentity([model, tokenizer]);
  if (artifacts.kind !== 'opened') return blocked(artifacts.reason);
  let server;
  const bridge = createBrokerWorker(() => spawn(runtimePython(resolution.stateDir), [script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...envAllow(), CBS_MEMORIA_MODEL: model, CBS_MEMORIA_TOKENIZER: tokenizer,
      OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
  }), { onFatal: () => { if (server?.listening) server.close(); } });
  const ready = await bridge.start();
  if (ready.kind !== 'ready' || !await artifacts.unchanged()) {
    await bridge.close(); await artifacts.close(); return ready.kind === 'ready' ? blocked('artifact_changed') : ready;
  }
  let queued = 0;
  let chain = Promise.resolve();
  let active = 0;
  let idle;
  server = net.createServer(socket => {
    active++;
    clearTimeout(idle);
    const controller = new AbortController();
    readBrokerRequest(socket, frame => {
      if (queued >= 2) {
        frame.secret.fill(0);
        socket.end(encodeFrame(blocked('queue_full'), undefined, true));
        return;
      }
      const enqueuedAt = Date.now();
      queued++;
      chain = chain.then(async () => {
        queued--;
        const { value, secret } = frame;
        if (socket.destroyed) { secret.fill(0); return; }
        try {
          const result = Date.now() - enqueuedAt > 100 ? blocked('queue_timeout') :
            await handle(value, secret, controller.signal);
          if (!socket.destroyed) socket.end(encodeFrame(result, undefined, true));
        } finally { secret.fill(0); }
      }).catch(() => { if (!socket.destroyed) socket.end(encodeFrame(blocked('broker_failed'), undefined, true)); });
    });
    socket.once('close', () => {
      controller.abort();
      active--;
      if (!active) idle = setTimeout(() => server.close(), idleMs);
    });
  });
  async function handle(value, secret, signal) {
    if (!value || typeof value !== 'object' || secret.length === 0) return blocked('worker_unavailable');
    if (!await artifacts.unchanged()) {
      if (server.listening) server.close();
      return blocked('artifact_changed');
    }
    const { cwd, sessionId, operation } = value;
    if (!cwd || !sessionId || !operation || typeof operation !== 'object') return blocked('invalid_request');
    const current = await resolveProject(cwd, sessionId, { stateRoot });
    if (current.provider !== 'mem0' || current.embeddingFingerprint !== resolution.embeddingFingerprint) return blocked('project_mismatch');
    const deadlineAt = Math.min(Number(value.deadlineAt), Date.now() + 120000);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || signal.aborted) return blocked('deadline');
    const authorized = await authorizeCurrentDestination(cwd, sessionId, () => secret.toString('utf8'),
      { stateRoot, deadlineAt, signal });
    if (authorized.kind !== 'authorized') return blocked(authorized.reason);
    const request = { ...operation, projectId: current.projectId, state: current.stateDir,
      collection: current.destination.collection, connection: authorized.connection };
    if (deadlineAt <= Date.now()) return blocked('deadline');
    return bridge.request(request, secret, deadlineAt);
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
    await fs.chmod(file, 0o600);
    idle = setTimeout(() => server.close(), idleMs);
    await new Promise(resolve => server.once('close', resolve));
  } catch { return blocked('broker_unavailable'); }
  finally {
    await bridge.close();
    await artifacts.close();
    clearTimeout(idle);
    try { const stat = await fs.lstat(file); if (stat.isSocket() && stat.uid === process.getuid()) await fs.rm(file); }
    catch { /* no owned endpoint */ }
  }
  return { kind: 'closed' };
  }, 'encoder.lock'); }
  catch { return blocked('broker_owned'); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [stateRoot, cwd, sessionId] = process.argv.slice(2);
  await serveBroker({ stateRoot, bootstrapCwd: cwd, bootstrapSessionId: sessionId });
}
