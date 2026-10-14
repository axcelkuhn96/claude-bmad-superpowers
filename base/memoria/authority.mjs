import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { authorizeCurrentDestination } from './setup.mjs';
import { inspectConfiguration, initializeSession, resolveProject } from './provider.mjs';
import { localDevice } from './policy.mjs';
import { withProjectLock } from './ledger.mjs';
import { createWindowsState } from './windows-state.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const sha = value => createHash('sha256').update(value).digest('hex');
const pointId = resolution => {
  const hex = sha(JSON.stringify(['cbs-writer-v1', resolution.projectId,
    resolution.destination.url, resolution.destination.collection])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const writerFile = stateDir => path.join(stateDir, 'ledger', 'writer.json');
const validDevice = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

async function requestQdrant(connection, key, method, endpoint, body) {
  const target = new URL(endpoint, connection.url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = transport.request(target, {
      method, headers: { 'api-key': key, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}) }, timeout: 5000,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address: connection.address, family: net.isIP(connection.address) }])
        : callback(null, connection.address, net.isIP(connection.address)),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(blocked('authority_unavailable')); return; }
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy();
      });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(blocked('authority_unavailable')); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(blocked('authority_unavailable')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function control(resolution, auth, command, record, options = {}) {
  if (options.control) return options.control(command, resolution, record);
  const collection = encodeURIComponent(resolution.destination.collection);
  const base = `/collections/${collection}/points`;
  const id = pointId(resolution);
  if (command === 'read') {
    const response = await requestQdrant(auth.connection, auth.key, 'POST', base,
      { ids: [id], with_payload: true, with_vector: false });
    if (response.kind === 'blocked' || !Array.isArray(response.result)) return blocked('authority_unavailable');
    if (response.result.length === 0) return { kind: 'missing' };
    if (response.result.length !== 1 || response.result[0].id !== id) return blocked('authority_ambiguous');
    const data = response.result[0].payload;
    if (data?.cbs_control !== 'writer_v1' || data.projectId !== resolution.projectId ||
        data.collection !== resolution.destination.collection || !validDevice(data.deviceId) ||
        !Number.isSafeInteger(data.generation) || data.generation < 1 ||
        !['active', 'transferring'].includes(data.state)) return blocked('authority_ambiguous');
    return { kind: 'authority', record: data };
  }
  const payload = { cbs_control: 'writer_v1', projectId: resolution.projectId,
    collection: resolution.destination.collection, ...record };
  const response = await requestQdrant(auth.connection, auth.key, 'PUT', `${base}?wait=true`,
    { points: [{ id, vector: [1, ...Array(383).fill(0)], payload }] });
  return response.kind === 'blocked' || response.status !== 'ok'
    ? blocked('authority_write_unconfirmed') : { kind: 'written' };
}

async function readCache(stateDir) {
  if (process.platform === 'win32') return createWindowsState(writerFile(stateDir)).read();
  try {
    const file = writerFile(stateDir);
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
        !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeCache(stateDir, value) {
  const file = writerFile(stateDir);
  if (process.platform === 'win32') { await createWindowsState(file).write(value); return; }
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  const directory = await fs.open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function assertWriter(resolution, auth, options = {}) {
  if (await fs.lstat(path.join(resolution.stateDir, 'deactivating.json')).then(() => true,
    error => error.code === 'ENOENT' ? false : Promise.reject(error))) return blocked('deactivation_pending');
  const device = await localDevice(resolution.stateDir);
  if (device.kind !== 'device') return device;
  let cache;
  try { cache = await readCache(resolution.stateDir); } catch { return blocked('writer_cache_unsafe'); }
  if (!cache || cache.projectId !== resolution.projectId || cache.deviceId !== device.deviceId ||
      cache.collection !== resolution.destination.collection || cache.revoked === true ||
      !Number.isSafeInteger(cache.generation)) return blocked('writer_not_designated');
  const remote = await control(resolution, auth, 'read', null, options);
  if (remote.kind !== 'authority') return blocked(remote.reason ?? 'writer_authority_missing');
  const record = remote.record;
  if (record.state !== 'active' || record.deviceId !== device.deviceId ||
      record.generation !== cache.generation) return blocked('writer_generation_changed');
  return { kind: 'writer', deviceId: device.deviceId, generation: cache.generation };
}

async function context(cwd, sessionId, readSecret, options = {}) {
  const resolution = await resolveProject(cwd, sessionId, options);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason ?? 'not_mem0');
  const auth = await authorizeCurrentDestination(cwd, sessionId, readSecret, options);
  return auth.kind === 'authorized' ? { kind: 'ready', resolution, auth } : auth;
}

export async function bootstrapWriter(cwd, sessionId, readSecret, options = {}) {
  if (options.confirm !== true || options.clientsQuiescent !== true || options.singleAdministrator !== true) {
    return blocked('serial_admin_confirmation_required');
  }
  const ready = await context(cwd, sessionId, readSecret, options);
  if (ready.kind !== 'ready') return ready;
  const { resolution, auth } = ready;
  const device = await localDevice(resolution.stateDir);
  if (device.kind !== 'device') return device;
  const old = await control(resolution, auth, 'read', null, options);
  if (old.kind !== 'missing') return blocked(old.kind === 'authority'
    ? 'writer_already_designated' : old.reason);
  const record = { deviceId: device.deviceId, generation: 1, state: 'active' };
  const written = await control(resolution, auth, 'write', record, options);
  if (written.kind !== 'written') return written;
  const checked = await control(resolution, auth, 'read', null, options);
  if (checked.kind !== 'authority' || JSON.stringify(checked.record) !== JSON.stringify({
    cbs_control: 'writer_v1', projectId: resolution.projectId,
    collection: resolution.destination.collection, ...record })) return blocked('authority_write_unconfirmed');
  await writeCache(resolution.stateDir, { projectId: resolution.projectId,
    collection: resolution.destination.collection, deviceId: device.deviceId, generation: 1 });
  return { kind: 'designated', deviceId: device.deviceId, generation: 1 };
}

export async function beginWriterTransfer(cwd, sessionId, toDeviceId, readSecret, options = {}) {
  if (options.confirm !== true || !validDevice(toDeviceId)) return blocked('transfer_confirmation_required');
  const ready = await context(cwd, sessionId, readSecret, options);
  if (ready.kind !== 'ready') return ready;
  const { resolution, auth } = ready;
  return withProjectLock(resolution.stateDir, async () => {
    const cached = await readCache(resolution.stateDir);
    if (cached?.revoked === true && cached.toDeviceId === toDeviceId &&
        /^[a-f0-9]{64}$/.test(cached.handoffDigest ?? '')) {
      const bundleFile = path.join(resolution.stateDir, `handoff-${cached.handoffDigest}.json`);
      const bundle = JSON.parse(await fs.readFile(bundleFile, 'utf8'));
      if (sha(JSON.stringify(bundle)) !== cached.handoffDigest) return blocked('handoff_conflict');
      const remote = await control(resolution, auth, 'read', null, options);
      if (remote.kind !== 'authority' || remote.record.deviceId !== cached.deviceId ||
          remote.record.generation !== cached.generation) return blocked('handoff_mismatch');
      if (remote.record.state === 'active') {
        const written = await control(resolution, auth, 'write', { deviceId: cached.deviceId,
          generation: cached.generation, state: 'transferring', toDeviceId,
          handoffDigest: cached.handoffDigest }, options);
        if (written.kind !== 'written') return written;
      } else if (remote.record.state !== 'transferring' ||
          remote.record.handoffDigest !== cached.handoffDigest ||
          remote.record.toDeviceId !== toDeviceId) return blocked('handoff_mismatch');
      return { kind: 'handoff', bundleFile, handoffDigest: cached.handoffDigest };
    }
    const own = await assertWriter(resolution, auth, options);
    if (own.kind !== 'writer' || own.deviceId === toDeviceId) return blocked(own.reason ?? 'invalid_transfer_target');
    const ledgerDir = path.join(resolution.stateDir, 'ledger');
    const entries = [];
    for (const name of (await fs.readdir(ledgerDir)).sort()) {
      if (!/^(?:[a-f0-9]{64}|correction-[a-f0-9]{64})\.json$/.test(name)) continue;
      const value = JSON.parse(await fs.readFile(path.join(ledgerDir, name), 'utf8'));
      if (!name.startsWith('correction-') && value.status !== 'acked') return blocked('writer_operation_unsettled');
      entries.push({ name, value });
    }
    const bundle = { kind: 'cbs_writer_handoff_v1', projectId: resolution.projectId,
      collection: resolution.destination.collection, generation: own.generation, entries };
    const handoffDigest = sha(JSON.stringify(bundle));
    const bundleFile = path.join(resolution.stateDir, `handoff-${handoffDigest}.json`);
    const savedBundle = await fs.readFile(bundleFile, 'utf8').catch(error =>
      error.code === 'ENOENT' ? null : Promise.reject(error));
    if (savedBundle && JSON.stringify(JSON.parse(savedBundle)) !== JSON.stringify(bundle)) return blocked('handoff_conflict');
    if (!savedBundle) {
      const handle = await fs.open(bundleFile, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(bundle) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
    }
    await writeCache(resolution.stateDir, { projectId: resolution.projectId,
      collection: resolution.destination.collection, deviceId: own.deviceId,
      generation: own.generation, revoked: true, toDeviceId, handoffDigest });
    const written = await control(resolution, auth, 'write', { deviceId: own.deviceId,
      generation: own.generation, state: 'transferring', toDeviceId, handoffDigest }, options);
    if (written.kind !== 'written') return written;
    const checked = await control(resolution, auth, 'read', null, options);
    if (checked.kind !== 'authority' || checked.record.state !== 'transferring' ||
        checked.record.handoffDigest !== handoffDigest) return blocked('authority_write_unconfirmed');
    return { kind: 'handoff', bundleFile, handoffDigest };
  });
}

export async function completeWriterTransfer(cwd, sessionId, bundle, readSecret, options = {}) {
  if (options.confirm !== true || !bundle || bundle.kind !== 'cbs_writer_handoff_v1' ||
      !Array.isArray(bundle.entries)) return blocked('handoff_confirmation_required');
  const ready = await context(cwd, sessionId, readSecret, options);
  if (ready.kind !== 'ready') return ready;
  const { resolution, auth } = ready;
  const device = await localDevice(resolution.stateDir);
  if (device.kind !== 'device') return device;
  return withProjectLock(resolution.stateDir, async () => {
    const remote = await control(resolution, auth, 'read', null, options);
    const handoffDigest = sha(JSON.stringify(bundle));
    const generation = bundle.generation + 1;
    const cached = await readCache(resolution.stateDir);
    const prepared = cached && cached.projectId === resolution.projectId &&
      cached.collection === resolution.destination.collection && cached.deviceId === device.deviceId &&
      cached.generation === generation && cached.fromGeneration === bundle.generation &&
      cached.handoffDigest === handoffDigest;
    const transferring = remote.kind === 'authority' && remote.record.state === 'transferring' &&
      remote.record.toDeviceId === device.deviceId && remote.record.handoffDigest === handoffDigest &&
      remote.record.generation === bundle.generation;
    const promoted = remote.kind === 'authority' && remote.record.state === 'active' &&
      remote.record.deviceId === device.deviceId && remote.record.generation === generation && prepared;
    if (bundle.projectId !== resolution.projectId || bundle.collection !== resolution.destination.collection ||
        !Number.isSafeInteger(bundle.generation) || bundle.generation < 1 ||
        !Number.isSafeInteger(generation) || cached && !prepared ||
        !transferring && !promoted) return blocked('handoff_mismatch');
    const dir = path.join(resolution.stateDir, 'ledger');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const entry of bundle.entries) {
      if (!/^(?:[a-f0-9]{64}|correction-[a-f0-9]{64})\.json$/.test(entry.name) ||
          !entry.value || typeof entry.value !== 'object' ||
          !entry.name.startsWith('correction-') && (entry.value.projectId !== resolution.projectId ||
            !['acked'].includes(entry.value.status) || typeof entry.value.canonicalId !== 'string')) {
        return blocked('handoff_invalid');
      }
      const file = path.join(dir, entry.name);
      const existing = await fs.readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(entry.value)) return blocked('handoff_conflict');
      if (!existing) {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(entry.value) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
      }
    }
    const directory = await fs.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    if (!prepared) await writeCache(resolution.stateDir, { projectId: resolution.projectId,
      collection: resolution.destination.collection, deviceId: device.deviceId, generation,
      fromGeneration: bundle.generation, handoffDigest, revoked: true });
    if (transferring) {
      const written = await control(resolution, auth, 'write', { deviceId: device.deviceId,
        generation, state: 'active' }, options);
      if (written.kind !== 'written') return written;
    }
    const checked = await control(resolution, auth, 'read', null, options);
    if (checked.kind !== 'authority' || checked.record.deviceId !== device.deviceId ||
        checked.record.generation !== generation || checked.record.state !== 'active') return blocked('authority_write_unconfirmed');
    await writeCache(resolution.stateDir, { projectId: resolution.projectId,
      collection: resolution.destination.collection, deviceId: device.deviceId, generation,
      fromGeneration: bundle.generation, handoffDigest });
    return { kind: 'transferred', generation, deviceId: device.deviceId };
  });
}

export async function administrativeSession(cwd, options = {}) {
  const current = await inspectConfiguration(cwd, options);
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  const sessionId = `admin-${randomUUID()}`;
  const session = await initializeSession(cwd, sessionId, { ...options, event: 'SessionStart', adminSession: true });
  return session.provider === 'mem0' ? { kind: 'session', sessionId,
    resolution: session } : blocked(session.reason ?? 'admin_session_unavailable');
}
