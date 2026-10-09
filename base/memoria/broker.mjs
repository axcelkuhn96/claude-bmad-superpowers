#!/usr/bin/env node
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FrameReader, encodeFrame } from './frame.mjs';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { authorizeCurrentDestination } from './setup.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { openArtifactIdentity, runtimePython, verifyRuntimeArtifacts } from './runtime.mjs';
import { withProjectLock } from './ledger.mjs';
import { createBrokerWorker } from './broker-worker.mjs';
import { ensureWindowsPrivateDirectory, readWindowsBinary, publishWindowsBinary,
  deleteWindowsBinary, hashWindowsFile, holdWindowsHash,
  windowsSystemLocations } from './windows-security.mjs';
import { parseWindowsDiscovery, newWindowsDiscovery, authenticateWindowsClient,
  authenticateWindowsServer } from './windows-transport.mjs';

const blocked = reason => ({ kind: 'unavailable', reason });
export const brokerPath = (root = path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria')) =>
  path.join(root, process.platform === 'win32' ? 'encoder.discovery.json' : 'encoder.sock');
async function windowsDiscovery(root) {
  const observed = await readWindowsBinary(brokerPath(root), { length: 4096 });
  if (observed.size !== observed.bytes.length) throw new Error('windows_broker_discovery_invalid');
  return { observed, value: parseWindowsDiscovery(observed.bytes.toString('utf8')) };
}
export async function brokerEndpointStatus(root) {
  if (process.platform === 'win32') {
    let discovery;
    try { discovery = (await windowsDiscovery(root)).value; }
    catch (error) {
      if (error.message === 'windows_read_open' &&
          await fs.lstat(brokerPath(root)).then(() => false, cause => cause.code === 'ENOENT')) return 'missing';
      return 'unsafe';
    }
    const socket = net.createConnection({ host: '127.0.0.1', port: discovery.port });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 1000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await authenticateWindowsClient(socket, discovery, Date.now() + 1000);
      return 'live';
    } catch (error) { return error.code === 'ECONNREFUSED' ? 'orphan' : 'unsafe'; }
    finally { socket.destroy(); }
  }
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
  if (process.platform === 'win32') {
    const status = await brokerEndpointStatus(root);
    if (status === 'missing') return 'ready';
    if (status !== 'orphan') return status === 'unsafe' ? 'unsafe' : 'live';
    const { observed } = await windowsDiscovery(root);
    await deleteWindowsBinary(brokerPath(root), observed.fileId, observed.bytes);
    return 'ready';
  }
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

// encoder.lock serializes claims; the durable guard survives a broker crash or uncertain child stop.
export async function claimBrokerWorker(root) {
  const directory = path.join(root, 'ledger');
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(directory)).ok) throw new Error('unsafe_worker_guard');
    const file = path.join(directory, 'encoder-worker.guard');
    const bytes = Buffer.from(JSON.stringify({ state: 'worker_may_be_live',
      generation: randomUUID() }) + '\n');
    const identity = await publishWindowsBinary(file, bytes);
    return { async release(confirmedClosed) {
      if (!confirmedClosed) return false;
      await deleteWindowsBinary(file, identity.fileId, bytes);
      return true;
    } };
  }
  const dirStat = await fs.lstat(directory);
  if (!dirStat.isDirectory() || dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)) {
    throw new Error('unsafe_worker_guard');
  }
  const file = path.join(directory, 'encoder-worker.guard');
  const handle = await fs.open(file, 'wx', 0o600);
  let identity;
  try {
    identity = await handle.stat();
    await handle.writeFile('{"state":"worker_may_be_live"}\n');
    await handle.sync();
  } finally { await handle.close(); }
  const syncDirectory = async () => {
    const dir = await fs.open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  };
  await syncDirectory();
  return { async release(confirmedClosed) {
    if (!confirmedClosed) return false;
    const current = await fs.lstat(file);
    if (!current.isFile() || current.uid !== process.getuid() ||
        current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('worker_guard_changed');
    }
    await fs.unlink(file);
    await syncDirectory();
    return true;
  } };
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
  if (process.platform === 'win32') {
    const root = stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
    const key = Buffer.from(secret ?? '');
    let socket;
    try {
      const discovery = (await windowsDiscovery(root)).value;
      const deadlineAt = Date.now() + Math.max(1, Math.min(deadlineMs, 120000));
      socket = net.createConnection({ host: '127.0.0.1', port: discovery.port });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('deadline')); },
          Math.max(1, deadlineAt - Date.now()));
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await authenticateWindowsClient(socket, discovery, deadlineAt);
      const parser = new FrameReader({ response: true });
      return await new Promise(resolve => {
        let settled = false;
        let response;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(blocked('deadline')),
          Math.max(1, deadlineAt - Date.now()));
        socket.on('data', chunk => {
          try {
            const frames = parser.push(chunk);
            if (frames.length > 1 || frames.length && (parser.buffer.length || response !== undefined)) {
              finish(blocked('broker_protocol'));
            } else if (frames.length) response = frames[0].value;
          } catch { finish(blocked('broker_protocol')); }
        });
        socket.once('end', () => {
          try { parser.end(); finish(response === undefined ? blocked('broker_protocol') : response); }
          catch { finish(blocked('broker_protocol')); }
        });
        socket.once('error', () => finish(blocked('broker_unavailable')));
        socket.once('close', () => finish(blocked('broker_unavailable')));
        socket.resume();
        socket.write(encodeFrame({ ...request, deadlineAt }, key));
      });
    } catch { return blocked('broker_unavailable'); }
    finally { key.fill(0); socket?.destroy(); }
  }
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
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
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
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(root)).ok) return blocked('unsafe_broker');
  } else {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await fs.lstat(root);
    if (dir.uid !== process.getuid() || (dir.mode & 0o077)) return blocked('unsafe_broker');
  }
  const file = brokerPath(root);
  const endpoint = await brokerEndpointStatus(root);
  if (endpoint === 'live' || endpoint === 'unknown') return blocked('broker_owned');
  if (endpoint === 'unsafe') return blocked('unsafe_broker');
  try { return await withProjectLock(root, async () => {
  let guard;
  if (process.platform === 'win32') {
    try { guard = await claimBrokerWorker(root); }
    catch { return blocked('broker_owned'); }
  }
  const prepared = await prepareBrokerEndpoint(root);
  if (prepared !== 'ready') {
    await guard?.release(true);
    return blocked(prepared === 'unsafe' ? 'unsafe_broker' : 'broker_owned');
  }
  const artifacts = await openArtifactIdentity([model, tokenizer]);
  if (artifacts.kind !== 'opened') {
    await guard?.release(true);
    return blocked(artifacts.reason);
  }
  let runtimeRelease = () => {};
  let windowsSystem;
  if (process.platform === 'win32') {
    try {
      windowsSystem = await windowsSystemLocations();
      const python = runtimePython(resolution.stateDir);
      const current = await hashWindowsFile(python);
      runtimeRelease = await holdWindowsHash(python, current.fileId, current.sha256);
    } catch {
      await guard.release(true);
      await artifacts.close();
      return blocked('runtime_unsafe');
    }
  }
  try { guard ??= await claimBrokerWorker(root); }
  catch { await artifacts.close(); return blocked('broker_owned'); }
  let server;
  const bridge = createBrokerWorker(() => spawn(runtimePython(resolution.stateDir), [script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...envAllow(), ...(process.platform === 'win32' ? {
      PATH: [path.dirname(runtimePython(resolution.stateDir)),
        path.join(windowsSystem.windows, 'System32')].join(path.delimiter),
    } : {}), CBS_MEMORIA_MODEL: model, CBS_MEMORIA_TOKENIZER: tokenizer,
      OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
  }), { onFatal: () => { if (server?.listening) server.close(); } });
  async function closeOwnedWorker() {
    const confirmedClosed = await bridge.close();
    try { await guard.release(confirmedClosed); }
    finally { runtimeRelease(); await artifacts.close(); }
  }
  const ready = await bridge.start();
  if (ready.kind !== 'ready' || !await artifacts.unchanged()) {
    await closeOwnedWorker(); return ready.kind === 'ready' ? blocked('artifact_changed') : ready;
  }
  let queued = 0;
  let chain = Promise.resolve();
  let active = 0;
  let idle;
  let discovery;
  let discoveryIdentity;
  server = net.createServer(socket => {
    active++;
    clearTimeout(idle);
    const controller = new AbortController();
    const accept = frame => {
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
    };
    if (process.platform === 'win32') {
      if (!discovery) socket.destroy();
      else authenticateWindowsServer(socket, discovery, Date.now() + 1000)
        .then(() => { readBrokerRequest(socket, accept); socket.resume(); })
        .catch(() => socket.destroy());
    } else readBrokerRequest(socket, accept);
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
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      if (process.platform === 'win32') server.listen(0, '127.0.0.1', resolve);
      else server.listen(file, resolve);
    });
    if (process.platform === 'win32') {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        throw new Error('unsafe_broker_endpoint');
      }
      discovery = newWindowsDiscovery(address.port);
      const bytes = Buffer.from(JSON.stringify(discovery) + '\n');
      discoveryIdentity = { ...(await publishWindowsBinary(file, bytes)), bytes };
    } else await fs.chmod(file, 0o600);
    idle = setTimeout(() => server.close(), idleMs);
    await new Promise(resolve => server.once('close', resolve));
  } catch {
    if (server?.listening) server.close();
    return blocked('broker_unavailable');
  }
  finally {
    try { await closeOwnedWorker(); }
    finally {
      clearTimeout(idle);
      try {
        if (process.platform === 'win32') {
          if (discoveryIdentity) await deleteWindowsBinary(file,
            discoveryIdentity.fileId, discoveryIdentity.bytes);
        } else {
          const stat = await fs.lstat(file);
          if (stat.isSocket() && stat.uid === process.getuid()) await fs.rm(file);
        }
      }
      catch { /* no owned endpoint */ }
    }
  }
  return { kind: 'closed' };
  }, 'encoder.lock'); }
  catch { return blocked('broker_owned'); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [stateRoot, cwd, sessionId] = process.argv.slice(2);
  await serveBroker({ stateRoot, bootstrapCwd: cwd, bootstrapSessionId: sessionId });
}
