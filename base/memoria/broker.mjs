#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FrameReader, encodeFrame } from './frame.mjs';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { identifyProject } from './project-id.mjs';
import { authorizeCurrentDestination } from './setup.mjs';
import { assertWriter, writerConnection } from './authority.mjs';
import { readAutoPublish, readOwner } from './policy.mjs';
import { readSessionCheckout } from './session-checkout.mjs';
import { createOutbox } from './outbox.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple, authorizeDestination } from './trust.mjs';
import { pinDestination } from './activation.mjs';
import { verifyNativeCapture } from './native.mjs';
import { sourceForExplicitMcp } from './mcp-request-proof.mjs';
import { targetVersion } from './correction.mjs';
import { openArtifactIdentity, runtimePython, verifyRuntimeArtifacts } from './runtime.mjs';
import { withProjectLock } from './ledger.mjs';
import { createBrokerWorker } from './broker-worker.mjs';
import { createBrokerQueue } from './broker-queue.mjs';
import { ensureWindowsPrivateDirectory, readWindowsBinary, publishWindowsBinary,
  deleteWindowsBinary, hashWindowsFile, holdWindowsHash,
  windowsSystemLocations } from './windows-security.mjs';
import { parseWindowsDiscovery, newWindowsDiscovery, authenticateWindowsClient,
  authenticateWindowsServer } from './windows-transport.mjs';

const blocked = reason => ({ kind: 'unavailable', reason });
const denied = reason => ({ kind: 'blocked', reason });
const sameAutoConsent = (frozen, live, current) => frozen?.version === 1 &&
  frozen.enabled === true && live?.version === 1 && live.enabled === true &&
  current.extractor?.autoPublish === true && current.ownerId === frozen.ownerId &&
  frozen.projectId === current.projectId && live.projectId === current.projectId &&
  ['consentHash', 'destinationHash', 'ownerId', 'deviceId', 'enabledAt']
    .every(key => typeof frozen[key] === 'string' && frozen[key] && frozen[key] === live[key]) &&
  ['consentHash', 'destinationHash', 'ownerId', 'deviceId', 'enabledAt']
    .every(key => current.extractor.autoPublishConsent?.[key] === frozen[key]);
export function mcpOperationMatches(operation, source, observed) {
  if (operation.op === 'delete_curated') return isDeepStrictEqual(operation, source);
  const keys = {
    dedup_find: ['op', 'projectId', 'externalId', 'sessionId', 'text', 'metadata'],
    find: ['op', 'projectId', 'externalId'],
    read: ['op', 'projectId', 'sdkId'],
    activate: ['op', 'projectId', 'externalId', 'sdkId'],
  };
  if (operation.op === 'add') return isDeepStrictEqual(operation, source);
  if (!keys[operation.op] || !isDeepStrictEqual(Object.keys(operation).sort(),
    keys[operation.op].sort()) || operation.projectId !== source.projectId) return false;
  if (operation.op === 'dedup_find') return operation.externalId === source.externalId &&
    operation.sessionId === source.sessionId && operation.text === source.text &&
    isDeepStrictEqual(operation.metadata, source.metadata);
  if (operation.op === 'find') return operation.externalId === source.externalId;
  if (operation.op === 'read') return typeof operation.sdkId === 'string' &&
    (observed?.has(operation.sdkId) === true ||
      source.metadata?.supersedes_id === operation.sdkId);
  if (operation.op === 'activate') return operation.externalId === source.externalId &&
    typeof operation.sdkId === 'string' && observed?.get(operation.sdkId) === true;
  return false;
}
function mcpRowMatches(row, source) {
  return row?.projectId === source.projectId && row.externalId === source.externalId &&
    row.sessionId === source.sessionId && row.text === source.text &&
    typeof row.sdkId === 'string' && !!row.sdkId &&
    typeof row.qdrantId === 'string' && !!row.qdrantId &&
    Object.entries(source.metadata ?? {}).every(([key, value]) =>
      isDeepStrictEqual(row.metadata?.[key], value));
}
export function mcpBindingMatches(current, binding, ownerId, fingerprint) {
  return current?.provider === 'mem0' && binding &&
    current.projectRoot === binding.projectRoot &&
    current.projectId === binding.projectId &&
    current.embeddingFingerprint === binding.embeddingFingerprint &&
    current.embeddingFingerprint === fingerprint &&
    isDeepStrictEqual(current.destination, binding.destination) &&
    ownerId === binding.ownerId;
}

export async function authorizeAutomaticBrokerWrite(current, operation, consent,
  readConsent = readAutoPublish) {
  if (!['add', 'activate'].includes(operation?.op)) return { kind: 'allowed' };
  const marked = operation.approval?.mode === 'automatic' ||
    operation.metadata?.review_mode === 'automatic' ||
    operation.metadata?.auto_consent_hash != null;
  if (!consent) return marked ? denied('auto_publish_unproved') : { kind: 'allowed' };
  if (operation.op === 'add' &&
      (operation.approval?.kind !== 'approved' || operation.approval?.mode !== 'automatic' ||
        operation.metadata?.review_mode !== 'automatic' ||
        ![3, 4].includes(operation.metadata?.format_version) ||
        operation.metadata?.format_version === 4 &&
          (operation.metadata?.origin !== 'conversation_summary' ||
            operation.metadata?.speaker_role !== 'mixed' ||
            operation.metadata?.actor !== 'conversation' ||
            !Array.isArray(operation.metadata?.source_refs) ||
            operation.metadata.source_refs.length < 2 ||
            operation.metadata.source_refs.length > 10 ||
            !/^[a-f0-9]{64}$/.test(operation.metadata?.dedup_key ?? '')) ||
        operation.metadata?.auto_actor !== 'project_auto_publisher' ||
        operation.metadata?.auto_consent_hash !== consent.consentHash)) {
    return denied('auto_publish_unproved');
  }
  try {
    return sameAutoConsent(consent, await readConsent(current), current)
      ? { kind: 'allowed' } : denied('auto_publish_revoked');
  } catch { return denied('auto_publish_revoked'); }
}
export async function authorizeAutomaticOrigin(current, cwd, sessionId, operation,
  { readCheckout = readSessionCheckout, readProfileOwner = readOwner } = {}) {
  try {
    const checkouts = await Promise.all(['claude', 'codex'].map(async cli => ({ cli,
      checkout: await readCheckout(current.stateDir, cli, sessionId) })));
    const matches = checkouts.filter(({ checkout }) => checkout.kind === 'bound' &&
      checkout.nativeRoot === cwd && checkout.projectRoot === current.projectRoot &&
      checkout.projectId === current.projectId && path.isAbsolute(checkout.profile ?? ''));
    if (matches.length !== 1 || operation.op === 'add' &&
        (operation.sourceIdentity?.originCli !== matches[0].cli ||
          operation.sourceIdentity?.projectId !== current.projectId ||
          operation.sourceIdentity?.sessionId !== sessionId)) return denied('auto_origin_changed');
    const { cli, checkout } = matches[0];
    const owner = await readProfileOwner(current, cli, checkout.profile);
    return owner?.ownerId === current.ownerId ? { kind: 'allowed' } :
      denied('auto_origin_changed');
  } catch { return denied('auto_origin_changed'); }
}
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
  if (process.platform === 'linux') {
    const syncDirectory = async () => {
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    };
    let previous = null;
    let previousIdentity;
    try {
      const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
            stat.size > 512 || stat.size < 1) throw new Error('unsafe_worker_guard');
        const bytes = await handle.readFile('utf8');
        previous = JSON.parse(bytes);
        if (previous.version !== 2 || previous.protocol !== 'worker-flock-v1' ||
            previous.state !== 'worker_may_be_live' ||
            !/^[a-f0-9-]{36}$/.test(previous.generation ?? '') ||
            !/^\d+$/.test(previous.lockIdentity?.dev ?? '') ||
            !/^\d+$/.test(previous.lockIdentity?.ino ?? '')) throw new Error('unsafe_worker_guard');
        const pathname = await fs.lstat(file);
        if (pathname.dev !== stat.dev || pathname.ino !== stat.ino) throw new Error('unsafe_worker_guard');
        previousIdentity = { dev: stat.dev, ino: stat.ino };
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('unsafe_worker_guard');
    }
    const lockPath = path.join(directory, 'encoder-process.lock');
    let lockHandle;
    try {
      lockHandle = await fs.open(lockPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (previous ? 0 : fsConstants.O_CREAT), 0o600);
      const stat = await lockHandle.stat();
      const pathname = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
          stat.nlink !== 1 || pathname.dev !== stat.dev || pathname.ino !== stat.ino) {
        throw new Error('unsafe_worker_lock');
      }
      const lockIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
      if (previous && (previous.lockIdentity.dev !== lockIdentity.dev ||
          previous.lockIdentity.ino !== lockIdentity.ino)) throw new Error('unsafe_worker_lock');
      await lockHandle.sync();
      if (!previous) await syncDirectory();
      const bytes = JSON.stringify({ version: 2, protocol: 'worker-flock-v1',
        state: 'worker_may_be_live', generation: randomUUID(), lockIdentity }) + '\n';
      const temp = `${file}.${randomUUID()}.tmp`;
      let identity;
      const tempHandle = await fs.open(temp, 'wx', 0o600);
      try {
        identity = await tempHandle.stat();
        await tempHandle.writeFile(bytes);
        await tempHandle.sync();
      } finally { await tempHandle.close(); }
      try {
        if (previous) {
          const current = await fs.lstat(file);
          if (!current.isFile() || current.uid !== process.getuid() ||
              current.dev !== previousIdentity.dev || current.ino !== previousIdentity.ino) {
            throw new Error('worker_guard_changed');
          }
          await fs.rename(temp, file);
        } else await fs.link(temp, file);
      } finally { await fs.rm(temp, { force: true }); }
      await syncDirectory();
      return { lockPath, async release(confirmedClosed) {
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
    } finally { await lockHandle?.close(); }
  }
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
const envAllow = () => Object.fromEntries(['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CBS_MEMORIA_CA_FILE', 'CBS_MEMORIA_EMBEDDING_DEVICE']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

const launchDigest = token => createHash('sha256').update(token).digest('hex');
const leaseFile = (root, digest) => path.join(root, 'launches', `${digest}.lease`);
const privateFile = stat => stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077);

export async function createBrokerLeaseCredential(root, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('unsafe_lease');
  if (process.platform === 'win32') {
    const digest = launchDigest(token);
    const secret = randomBytes(32);
    const file = leaseFile(root, digest);
    const published = await publishWindowsBinary(file, secret);
    const stored = Buffer.from(secret);
    return { digest, secret, async release() {
      secret.fill(0);
      await deleteWindowsBinary(file, published.fileId, stored).catch(() => {});
      stored.fill(0);
    } };
  }
  const directory = path.join(root, 'launches');
  const dir = await fs.lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('unsafe_lease');
  const digest = launchDigest(token);
  const secret = randomBytes(32);
  let identity;
  try {
    const handle = await fs.open(leaseFile(root, digest), 'wx', 0o600);
    try {
      identity = await handle.stat();
      await handle.writeFile(secret);
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    secret.fill(0);
    if (identity) {
      const current = await fs.lstat(leaseFile(root, digest)).catch(() => null);
      if (current && privateFile(current) && current.dev === identity.dev && current.ino === identity.ino) {
        await fs.unlink(leaseFile(root, digest)).catch(() => {});
      }
    }
    throw error;
  }
  return { digest, secret, async release() {
    secret.fill(0);
    const current = await fs.lstat(leaseFile(root, digest)).catch(() => null);
    if (current && privateFile(current) && current.dev === identity.dev && current.ino === identity.ino) {
      await fs.unlink(leaseFile(root, digest));
    }
  } };
}

// A one-use secret belongs to the launcher, never to the CLI environment or a worker request.
export async function authorizeBrokerLease(root, cwd, resolution, digest, secret) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') ||
      !Buffer.isBuffer(secret) || secret.length !== 32 || typeof cwd !== 'string') return false;
  const windows = process.platform === 'win32';
  const directory = path.join(root, 'launches');
  const recordFile = path.join(directory, `${digest}.json`);
  const sidecar = leaseFile(root, digest);
  const closedFile = path.join(directory, `${digest}.closed`);
  try {
    let record;
    if (windows) {
      const observed = await readWindowsBinary(recordFile, { length: 8192 });
      if (observed.size !== observed.bytes.length) return false;
      record = JSON.parse(observed.bytes.toString('utf8'));
    } else {
      const dir = await fs.lstat(directory);
      if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return false;
      const recordHandle = await fs.open(recordFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const stat = await recordHandle.stat();
        if (!privateFile(stat) || stat.size > 8192) return false;
        record = JSON.parse(await recordHandle.readFile('utf8'));
      } finally { await recordHandle.close(); }
    }
    const scope = await identifyProject(cwd);
    if (scope.kind !== 'git' || record.nativeRoot !== scope.activeRoot) return false;
    const currentProject = await inspectConfiguration(cwd, { stateRoot: root });
    if (currentProject.provider !== 'mem0' ||
        currentProject.embeddingFingerprint !== resolution.embeddingFingerprint) return false;
    const trust = await readLocalTrust(currentProject.stateDir);
    if (!sameTrustTuple(trustTuple(currentProject), trust)) return false;
    if (!['claude', 'codex'].includes(record.cli) ||
        record.projectRoot !== currentProject.projectRoot || record.projectId !== currentProject.projectId ||
        record.embeddingFingerprint !== currentProject.embeddingFingerprint ||
        JSON.stringify(record.destination) !== JSON.stringify(currentProject.destination) ||
        !Number.isSafeInteger(record.createdAt) || record.createdAt > Date.now() + 5000 ||
        Date.now() - record.createdAt > 120000) return false;
    if (await fs.lstat(closedFile).then(() => true, error => error.code === 'ENOENT' ? false : true)) return false;
    if (windows) {
      // One-use like POSIX: the launcher's release tolerates the sidecar already being gone.
      const stored = await readWindowsBinary(sidecar, { length: 64 });
      const matched = stored.size === 32 && stored.bytes.length === 32 && timingSafeEqual(stored.bytes, secret);
      if (matched) await deleteWindowsBinary(sidecar, stored.fileId, stored.bytes);
      stored.bytes.fill(0);
      return matched;
    }
    const sidecarHandle = await fs.open(sidecar, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let identity;
    let expected;
    try {
      identity = await sidecarHandle.stat();
      if (!privateFile(identity) || identity.size !== 32) return false;
      expected = await sidecarHandle.readFile();
    } finally { await sidecarHandle.close(); }
    const matched = expected.length === 32 && timingSafeEqual(expected, secret);
    expected.fill(0);
    if (!matched || await fs.lstat(closedFile).then(() => true,
      error => error.code === 'ENOENT' ? false : true)) return false;
    const current = await fs.lstat(sidecar);
    if (!privateFile(current) || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    await fs.unlink(sidecar);
    return true;
  } catch { return false; }
}

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

// Own each accepted socket until close; late worker results cannot write to a disconnected client.
export function manageBrokerConnection(socket, onClose) {
  const controller = new AbortController();
  let disconnected = false;
  socket.on('error', () => {
    disconnected = true;
    controller.abort();
    socket.destroy();
  });
  socket.once('close', () => {
    disconnected = true;
    controller.abort();
    onClose();
  });
  return {
    signal: controller.signal,
    acknowledge(value) {
      if (disconnected || socket.destroyed || socket.writableEnded) return false;
      try { socket.write(encodeFrame(value, undefined, true)); return true; }
      catch { disconnected = true; controller.abort(); socket.destroy(); return false; }
    },
    respond(value) {
      if (disconnected || socket.destroyed || socket.writableEnded) return false;
      try { socket.end(encodeFrame(value, undefined, true)); return true; }
      catch { disconnected = true; controller.abort(); socket.destroy(); return false; }
    },
  };
}

export async function openBrokerLease(cwd, digest, secret, { stateRoot, deadlineMs = 1000 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') ||
      !Buffer.isBuffer(secret) || secret.length !== 32) return blocked('lease_invalid');
  const windows = process.platform === 'win32';
  const file = brokerPath(stateRoot);
  let socket;
  try {
    if (windows) {
      const root = stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
      const deadlineAt = Date.now() + deadlineMs;
      const discovery = (await windowsDiscovery(root)).value;
      socket = net.createConnection({ host: '127.0.0.1', port: discovery.port });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('deadline')), Math.max(1, deadlineAt - Date.now()));
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await authenticateWindowsClient(socket, discovery, deadlineAt);
    } else {
      const [dir, endpoint] = await Promise.all([fs.lstat(path.dirname(file)), fs.lstat(file)]);
      if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
          !endpoint.isSocket() || endpoint.uid !== process.getuid() || (endpoint.mode & 0o077)) {
        return blocked('unsafe_broker');
      }
      socket = net.createConnection(file);
    }
    const parser = new FrameReader({ response: true });
    const result = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value.kind !== 'leased') socket.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(blocked('broker_unavailable')), deadlineMs);
      const send = () => socket.write(encodeFrame({ kind: 'launch_lease', cwd,
        launchDigest: digest }, secret));
      if (windows) { socket.resume(); send(); } else socket.once('connect', send);
      socket.on('data', chunk => {
        try {
          const frames = parser.push(chunk);
          if (frames.length > 1 || frames.length && parser.buffer.length) {
            finish(blocked('broker_protocol'));
          } else if (frames.length) finish(frames[0].value);
        } catch { finish(blocked('broker_protocol')); }
      });
      socket.once('error', () => finish(blocked('broker_unavailable')));
      socket.once('close', () => finish(blocked('broker_unavailable')));
    });
    if (result.kind !== 'leased') return result;
    let released = false;
    return { kind: 'leased', release() { if (!released) { released = true; socket.destroy(); } } };
  } catch { socket?.destroy(); return blocked('broker_unavailable'); }
}

export async function requestBroker(request, secret, { stateRoot, deadlineMs = 120000 } = {}) {
  const deadlineAt = Date.now() + Math.max(1, Math.min(deadlineMs, 120000));
  if (process.platform === 'win32') {
    const root = stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
    const key = Buffer.from(secret ?? '');
    let socket;
    try {
      const discovery = (await windowsDiscovery(root)).value;
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
    } catch (error) { return blocked(error.message === 'deadline' ? 'deadline' : 'broker_unavailable'); }
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
      const timer = setTimeout(() => finish(blocked('deadline')),
        Math.max(1, deadlineAt - Date.now()));
      socket.once('connect', () => {
        if (Date.now() >= deadlineAt) { finish(blocked('deadline')); return; }
        socket.write(encodeFrame({ ...request, deadlineAt }, key));
      });
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
  const requestedDevice = process.env.CBS_MEMORIA_EMBEDDING_DEVICE ?? 'auto';
  if (!['auto', 'cpu', 'cuda', 'directml'].includes(requestedDevice)) return blocked('embedding_device_invalid');
  const resolution = await inspectConfiguration(bootstrapCwd, { stateRoot });
  if (resolution.provider !== 'mem0') return blocked(resolution.reason ?? 'unbound');
  const trust = await readLocalTrust(resolution.stateDir);
  if (!sameTrustTuple(trustTuple(resolution), trust)) {
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
  const leaseSockets = new Set();
  const bridge = createBrokerWorker(() => spawn(runtimePython(resolution.stateDir), [script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...envAllow(), ...(process.platform === 'win32' ? {
      PATH: [path.dirname(runtimePython(resolution.stateDir)),
        path.join(windowsSystem.windows, 'System32')].join(path.delimiter),
    } : {}), CBS_MEMORIA_MODEL: model, CBS_MEMORIA_TOKENIZER: tokenizer,
      ...(process.platform === 'linux' ? { CBS_MEMORIA_WORKER_LOCK: guard.lockPath } : {}),
      OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
  }), { onFatal: () => {
    for (const socket of leaseSockets) socket.destroy();
    if (server?.listening) server.close();
  } });
  async function closeOwnedWorker(readyWasObserved = true) {
    const confirmedClosed = await bridge.close();
    try { await guard.release(confirmedClosed && readyWasObserved); }
    finally { runtimeRelease(); await artifacts.close(); }
  }
  const ready = await bridge.start();
  if (ready.kind !== 'ready' || !await artifacts.unchanged()) {
    await closeOwnedWorker(process.platform !== 'linux');
    return ready.kind === 'ready' ? blocked('artifact_changed') : ready;
  }
  const queue = createBrokerQueue(handle);
  let active = 0;
  let leases = 0;
  let idle;
  let discovery;
  let discoveryIdentity;
  const mcpObserved = new Map();
  server = net.createServer(socket => {
    active++;
    clearTimeout(idle);
    let leased = false;
    const connection = manageBrokerConnection(socket, () => {
      active--;
      if (leased) { leases--; leaseSockets.delete(socket); }
      if (!active) idle = setTimeout(() => server.close(), idleMs);
    });
    const accept = frame => {
      if (frame.value?.kind === 'device_status') {
        const valid = Object.keys(frame.value).sort().join(',') === 'deadlineAt,kind' &&
          frame.secret.length === 0 && Number.isFinite(frame.value.deadlineAt) &&
          frame.value.deadlineAt > Date.now();
        frame.secret.fill(0);
        connection.respond(valid ? { kind: 'device_status', requested: requestedDevice } :
          blocked('invalid_request'));
        return;
      }
      if (frame.value?.kind === 'launch_lease') {
        if (leases >= 16) {
          frame.secret.fill(0);
          connection.respond(blocked('lease_full'));
          return;
        }
        leases++;
        (async () => {
          try {
            const accepted = await authorizeBrokerLease(root, frame.value.cwd, resolution,
              frame.value.launchDigest, frame.secret);
            if (!accepted || connection.signal.aborted) {
              connection.respond(blocked('lease_invalid'));
            } else {
              leased = connection.acknowledge({ kind: 'leased' });
              if (leased) leaseSockets.add(socket);
            }
          } catch { connection.respond(blocked('lease_invalid')); }
          finally { frame.secret.fill(0); if (!leased) leases--; }
        })();
        return;
      }
      queue.enqueue(frame, connection.signal, value => connection.respond(value));
    };
    if (process.platform === 'win32') {
      if (!discovery) socket.destroy();
      else authenticateWindowsServer(socket, discovery, Date.now() + 1000)
        .then(() => { readBrokerRequest(socket, accept); socket.resume(); })
        .catch(() => socket.destroy());
    } else readBrokerRequest(socket, accept);
  });
  async function handle(value, secret, signal) {
    if (!value || typeof value !== 'object' || secret.length === 0) return blocked('worker_unavailable');
    if (!await artifacts.unchanged()) {
      for (const socket of leaseSockets) socket.destroy();
      if (server.listening) server.close();
      return blocked('artifact_changed');
    }
    if (value.origin === 'mcp') return handleMcp(value, secret, signal);
    const { cwd, sessionId, operation } = value;
    if (!cwd || !sessionId || !operation || typeof operation !== 'object') return blocked('invalid_request');
    if (operation.metadata?.review_mode === 'explicit_mcp' ||
        operation.metadata?.format_version === 5 ||
        operation.approval?.mode === 'explicit_mcp') return blocked('explicit_mcp_unproved');
    const current = await resolveProject(cwd, sessionId, { stateRoot });
    if (current.provider !== 'mem0' || current.embeddingFingerprint !== resolution.embeddingFingerprint) return blocked('project_mismatch');
    const deadlineAt = Math.min(Number(value.deadlineAt), Date.now() + 120000);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || signal.aborted) return blocked('deadline');
    const authorized = await authorizeCurrentDestination(cwd, sessionId, () => secret.toString('utf8'),
      { stateRoot, deadlineAt, signal });
    if (authorized.kind !== 'authorized') return blocked(authorized.reason);
    const writing = ['add', 'activate'].includes(operation.op);
    const autoConsent = value.autoPublishConsent;
    const automatic = writing && (autoConsent || operation.approval?.mode === 'automatic' ||
      operation.metadata?.review_mode === 'automatic' || operation.metadata?.auto_consent_hash != null);
    const automaticSummary = automatic && operation.op === 'add' &&
      operation.metadata?.format_version === 4;
    const summarySourceAllowed = async stateDir => {
      if (!automaticSummary) return { kind: 'allowed' };
      try {
        const source = await createOutbox(stateDir).sourceForRemote(operation);
        return source.kind === 'local_source' ? { kind: 'allowed' } : denied('source_review_unproved');
      } catch { return denied('source_review_unproved'); }
    };
    if (writing) {
      const writer = await assertWriter(current, authorized, { stateRoot });
      if (writer.kind !== 'writer') return blocked(writer.reason ?? 'writer_authority_unavailable');
      const consent = await authorizeAutomaticBrokerWrite(current, operation, autoConsent);
      if (consent.kind !== 'allowed') return consent;
      if (automatic) {
        const origin = await authorizeAutomaticOrigin(current, cwd, sessionId, operation);
        if (origin.kind !== 'allowed') return origin;
        const source = await summarySourceAllowed(current.stateDir);
        if (source.kind !== 'allowed') return source;
      }
    }
    const request = { ...operation, projectId: current.projectId, state: current.stateDir,
      collection: current.destination.collection,
      connection: writerConnection(current, authorized.connection) };
    if (signal.aborted || deadlineAt <= Date.now()) return blocked('deadline');
    const beforeDispatch = automatic
      ? async () => {
        if (signal.aborted || deadlineAt <= Date.now()) return denied('deadline');
        const live = await resolveProject(cwd, sessionId, { stateRoot });
        if (live.provider !== 'mem0' || live.projectId !== current.projectId ||
            live.embeddingFingerprint !== current.embeddingFingerprint) return denied('project_mismatch');
        const writer = await assertWriter(live, authorized, { stateRoot });
        if (writer.kind !== 'writer') return denied(writer.reason ?? 'writer_authority_unavailable');
        const consent = await authorizeAutomaticBrokerWrite(live, operation, autoConsent);
        if (consent.kind !== 'allowed') return consent;
        const origin = await authorizeAutomaticOrigin(live, cwd, sessionId, operation);
        const source = origin.kind === 'allowed' ? await summarySourceAllowed(live.stateDir) : origin;
        return signal.aborted || deadlineAt <= Date.now() ? denied('deadline') : source;
      } : undefined;
    return bridge.request(request, secret, deadlineAt, beforeDispatch);
  }
  async function handleMcp(value, secret, signal) {
    const { cwd, cli, profile, binding, operation, sourceOperation } = value;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) ||
        !['claude', 'codex'].includes(cli) || typeof profile !== 'string' ||
        !path.isAbsolute(profile) || !binding || typeof binding !== 'object' ||
        !operation || typeof operation !== 'object' ||
        Array.isArray(operation)) return blocked('invalid_request');
    const writes = ['find', 'dedup_find', 'read', 'add', 'activate', 'delete_curated'];
    const isWriteFlow = writes.includes(operation.op);
    if (!isWriteFlow && (!['search', 'raw_search', 'readonly_get', 'history_get',
        'mutation_target'].includes(operation.op) ||
        sourceOperation !== undefined)) return blocked('invalid_operation');
    const readonlyKeys = { search: ['op', 'query', 'ownerId'],
      raw_search: ['op', 'query'],
      readonly_get: ['op', 'memoryId', 'source', 'offset', 'ownerId'],
      history_get: ['op', 'memoryId', 'ownerId'],
      mutation_target: ['op', 'memoryId', 'ownerId'] };
    if (!isWriteFlow && (!isDeepStrictEqual(Object.keys(operation).sort(),
      readonlyKeys[operation.op].sort()) || operation.op === 'search' &&
        (typeof operation.query !== 'string' || !operation.query.trim()) ||
        operation.op === 'raw_search' &&
        (typeof operation.query !== 'string' || !operation.query.trim()))) {
      return blocked('invalid_operation');
    }
    if (isWriteFlow && (!sourceOperation || typeof sourceOperation !== 'object')) {
      return blocked('explicit_mcp_unproved');
    }
    const deadlineAt = Math.min(Number(value.deadlineAt), Date.now() + 120000);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || signal.aborted) return blocked('deadline');
    const validate = async () => {
      if (signal.aborted || deadlineAt <= Date.now()) return blocked('deadline');
      const scope = await identifyProject(cwd);
      if (scope.kind !== 'git' || scope.activeRoot !== cwd) return blocked('unsupported_git');
      const current = await inspectConfiguration(cwd, { stateRoot });
      if (current.provider !== 'mem0' ||
          current.embeddingFingerprint !== resolution.embeddingFingerprint) {
        return blocked('project_mismatch');
      }
      if (!sameTrustTuple(trustTuple(current), await readLocalTrust(current.stateDir))) {
        return blocked('trust_changed');
      }
      const native = await verifyNativeCapture(scope.activeRoot,
        { cli, profile, projectRoot: current.projectRoot, stateRoot });
      if (native.kind !== 'verified') return blocked(native.reason ?? 'native_unavailable');
      const owner = await readOwner(current, cli, profile);
      if (owner?.kind === 'blocked') return blocked(owner.reason ?? 'owner_changed');
      const bound = { ...current, ownerId: owner?.ownerId ?? null };
      if (!mcpBindingMatches(current, binding, bound.ownerId,
        resolution.embeddingFingerprint)) return blocked('project_mismatch');
      if (operation.projectId !== undefined && operation.projectId !== current.projectId ||
          operation.ownerId !== undefined && operation.ownerId !== bound.ownerId) {
        return blocked('project_mismatch');
      }
      if (isWriteFlow) {
        const consent = await readAutoPublish(current);
        if (!bound.ownerId || !sameAutoConsent(consent, consent,
          { ...bound, extractor: { autoPublish: true, autoPublishConsent: consent } })) {
          return blocked('auto_publish_revoked');
        }
        bound.extractor = { autoPublish: true, autoPublishConsent: consent };
        const source = await sourceForExplicitMcp(sourceOperation, bound);
        if (source.kind !== 'local_source' || source.record.cli !== cli ||
            source.record.profile !== profile ||
            !mcpOperationMatches(operation, sourceOperation,
              mcpObserved.get(sourceOperation.externalId))) return blocked('explicit_mcp_unproved');
      }
      return bound;
    };
    const current = await validate();
    if (current.provider !== 'mem0') return current;
    const authorize = async live => {
      const pin = await pinDestination(live.destination.url, { address: live.destination.address,
        allowPublic: live.destination.allowPublic });
      if (pin.kind !== 'pinned') return blocked(pin.reason ?? 'destination_unavailable');
      const checked = await validate();
      if (checked.provider !== 'mem0') return checked;
      const auth = authorizeDestination(checked,
        await readLocalTrust(checked.stateDir), () => secret.toString('utf8'));
      return auth.kind === 'authorized' ? { ...auth, connection: pin.connection } : auth;
    };
    const auth = await authorize(current);
    if (auth.kind !== 'authorized') return blocked(auth.reason ?? 'authorization_failed');
    if (isWriteFlow) {
      const writer = await assertWriter(current, auth, { stateRoot });
      if (writer.kind !== 'writer') return blocked(writer.reason ?? 'writer_authority_unavailable');
    }
    const request = { ...operation, projectId: current.projectId, state: current.stateDir,
      collection: current.destination.collection,
      connection: writerConnection(current, auth.connection) };
    const beforeDispatch = async () => {
      if (!await artifacts.unchanged()) return blocked('artifact_changed');
      const live = await validate();
      if (live.provider !== 'mem0') return live;
      const freshAuth = await authorize(live);
      if (freshAuth.kind !== 'authorized') return freshAuth;
      if (!isDeepStrictEqual(freshAuth.connection, auth.connection)) {
        return blocked('destination_changed');
      }
      if (isWriteFlow) {
        const writer = await assertWriter(live, freshAuth, { stateRoot });
        if (writer.kind !== 'writer') return blocked(writer.reason ?? 'writer_authority_unavailable');
      }
      return signal.aborted || deadlineAt <= Date.now() ? blocked('deadline') : { kind: 'allowed' };
    };
    const result = await bridge.request(request, secret, deadlineAt, beforeDispatch);
    if (operation.op === 'delete_curated' &&
        ['deleted', 'absent'].includes(result.kind) &&
        result.memoryId !== operation.memoryId) return blocked('remote_ack_unconfirmed');
    if (operation.op === 'activate' && result.kind === 'item' &&
        (!mcpRowMatches(result.item, sourceOperation) ||
          result.item.sdkId !== operation.sdkId || result.item.status !== 'active')) {
      return blocked('explicit_mcp_unproved');
    }
    if (isWriteFlow && ['find', 'add', 'read'].includes(operation.op)) {
      const ids = mcpObserved.get(sourceOperation.externalId) ?? new Map();
      if (operation.op === 'add' && result.kind === 'pending' && typeof result.sdkId === 'string') {
        ids.set(result.sdkId, false);
      }
      if (operation.op === 'find' && result.kind === 'items') {
        for (const item of result.items ?? []) {
          if (mcpRowMatches(item, sourceOperation)) ids.set(item.sdkId, false);
        }
      }
      if (operation.op === 'read' && result.kind === 'item') {
        const target = sourceOperation.metadata?.supersedes_id === operation.sdkId;
        if (target) {
          if (result.item?.sdkId !== operation.sdkId ||
              result.item?.projectId !== sourceOperation.projectId ||
              result.item?.externalId !== sourceOperation.metadata.correction_target_external_id ||
              !(result.item.status === 'active' &&
                targetVersion(result.item) === sourceOperation.metadata.correction_target_version ||
                result.item.status === 'superseded' &&
                result.item.metadata?.superseded_by_external_id === sourceOperation.externalId &&
                typeof result.item.metadata?.superseded_by === 'string')) {
            return blocked('explicit_mcp_unproved');
          }
        } else {
          if (!mcpRowMatches(result.item, sourceOperation) ||
              result.item.sdkId !== operation.sdkId) return blocked('explicit_mcp_unproved');
          ids.set(operation.sdkId, true);
        }
      }
      mcpObserved.set(sourceOperation.externalId, ids);
      if (mcpObserved.size > 256) mcpObserved.delete(mcpObserved.keys().next().value);
    }
    return result;
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
  void serveBroker({ stateRoot, bootstrapCwd: cwd, bootstrapSessionId: sessionId })
    .catch(() => { process.exitCode = 1; });
}
