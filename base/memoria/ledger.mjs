import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ensureWindowsPrivateDirectory, publishWindowsBinary, readWindowsBinary,
  withWindowsFileLock } from './windows-security.mjs';
import { createWindowsState } from './windows-state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const pending = reason => ({ kind: 'pending', reason });

export function externalIdFor(source) {
  if (!source || !['claude', 'codex'].includes(source.originCli) ||
      ![source.projectId, source.sessionId, source.policyVersion].every(x => typeof x === 'string' && x) ||
      !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) ||
      source.start < 0 || source.end <= source.start || !/^[a-f0-9]{64}$/.test(source.sliceHash ?? '')) {
    throw new Error('invalid_source_identity');
  }
  if (source.candidateKey !== undefined &&
      (typeof source.candidateKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(source.candidateKey))) {
    throw new Error('invalid_source_identity');
  }
  const identity = [source.projectId, source.originCli, source.sessionId,
    source.start, source.end, source.sliceHash, source.policyVersion];
  if (source.candidateKey !== undefined) identity.push(source.candidateKey);
  return `src-${hash(JSON.stringify(identity))}`;
}

export function createLedger(stateDir, writerId, generation) {
  if (!stateDir || !writerId || !Number.isSafeInteger(generation) || generation < 1) throw new Error('ledger_identity_required');
  const dir = path.join(stateDir, 'ledger');
  const file = externalId => path.join(dir, `${hash(externalId)}.json`);
  async function read(externalId) {
    if (process.platform === 'win32') return createWindowsState(file(externalId)).read();
    try { return JSON.parse(await fs.readFile(file(externalId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function durable(filePath, data) {
    if (process.platform === 'win32') {
      if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_ledger_dir');
      await createWindowsState(filePath).write(data);
      return;
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temp, filePath); }
    catch (error) { await fs.rm(temp, { force: true }); throw error; }
    const directory = await fs.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function exclusive(filePath, data) {
    if (process.platform === 'win32') {
      if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_ledger_dir');
      await publishWindowsBinary(filePath, Buffer.from(JSON.stringify(data) + '\n'));
      return;
    }
    const temp = `${filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temp, filePath); }
    finally { await fs.rm(temp, { force: true }); }
    const directory = await fs.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function save(record) { await durable(file(record.externalId), record); }
  async function begin(operation) {
    if (process.platform === 'win32') {
      if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_ledger_dir');
    } else await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const writerFile = path.join(dir, 'writer.json');
    const owner = process.platform === 'win32' ? await createWindowsState(writerFile).read() :
      await fs.readFile(writerFile, 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!owner || owner.deviceId !== writerId || owner.projectId !== operation.projectId ||
        owner.generation !== generation || owner.revoked === true) return pending('writer_mismatch');
    if (operation.metadata?.supersedes_id) {
      const correction = path.join(dir, `correction-${hash(operation.metadata.supersedes_id)}.json`);
      try { await exclusive(correction, { externalId: operation.externalId }); }
      catch (error) { if (process.platform !== 'win32' ? error.code !== 'EEXIST' :
        error.message !== 'windows_publish_failed') throw error; }
      const claim = process.platform === 'win32' ? await readWindowsBinary(correction, { length: 8192 }) : null;
      const savedClaim = claim ? JSON.parse(claim.bytes.toString('utf8')) :
        JSON.parse(await fs.readFile(correction, 'utf8'));
      if (savedClaim.externalId !== operation.externalId) return { kind: 'conflict', reason: 'concurrent_correction' };
    }
    const digest = hash(JSON.stringify({ text: operation.text, metadata: operation.metadata }));
    let record = await read(operation.externalId);
    if (record && (record.digest !== digest || record.projectId !== operation.projectId)) return { kind: 'conflict', reason: 'source_changed' };
    if (!record) {
      record = { externalId: operation.externalId, projectId: operation.projectId, digest,
        canonicalId: null, status: 'queued', attempts: 0, lastError: null };
      await save(record);
    }
    return record;
  }
  return { read, save, begin };
}

export async function withProjectLock(stateDir, callback, lockName = 'writer.lock', timeoutMs = 5000) {
  if (!/^[a-z][a-z0-9-]{0,63}\.lock$/.test(lockName)) throw new Error('invalid_lock_name');
  const directory = path.join(stateDir, 'ledger');
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(directory)).ok) throw new Error('unsafe_ledger_dir');
    return withWindowsFileLock(path.join(directory, lockName), callback, { timeoutMs });
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const child = spawn('python3',
    ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()', path.join(directory, lockName)],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('writer_lock_timeout')); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`writer_lock_failed:${code}`)); });
      child.stdout.once('data', chunk => {
        clearTimeout(timer);
        chunk.toString().trim() === 'ready' ? resolve() : reject(new Error('writer_lock_failed'));
      });
    });
    return await callback();
  } finally {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
}

export async function transferWriter(stateDir, { projectId, fromWriterId, toWriterId, quiescent }) {
  return pending('administrative_transfer_required');
}

function valid(row, operation, status) {
  return row && row.externalId === operation.externalId && row.projectId === operation.projectId &&
    row.status === status && (!operation.text || row.text === operation.text) && row.sdkId && row.qdrantId &&
    (!operation.sessionId || row.sessionId === operation.sessionId) &&
    Object.entries(operation.metadata ?? {}).every(([key, value]) => JSON.stringify(row.metadata?.[key]) === JSON.stringify(value));
}

export async function reconcileStore(operation, deps) {
  if (!operation?.externalId || !operation?.projectId) return pending('invalid_operation');
  const ledger = deps.ledger;
  let local;
  try {
    local = ledger ? await ledger.begin(operation) : null;
    if (local?.kind === 'pending' || local?.kind === 'conflict') return local;
    const found = await deps.findRemote(operation.externalId);
    const rows = Array.isArray(found) ? found : found ? [found] : [];
    if (rows.some(row => row.externalId !== operation.externalId || row.projectId !== operation.projectId ||
        (operation.text && row.text !== operation.text) ||
        (operation.sessionId && row.sessionId !== operation.sessionId) ||
        Object.entries(operation.metadata ?? {}).some(([key, value]) =>
          JSON.stringify(row.metadata?.[key]) !== JSON.stringify(value)) ||
        !['pending', 'active'].includes(row.status))) {
      return { kind: 'conflict', reason: 'remote_mismatch' };
    }
    const active = rows.filter(row => valid(row, operation, 'active'));
    if (active.length > 1 || (local?.canonicalId && active.some(row => row.sdkId !== local.canonicalId))) {
      return { kind: 'conflict', reason: 'multiple_active' };
    }
    let canonicalId = local?.canonicalId ?? active[0]?.sdkId;
    if (local && canonicalId && !local.canonicalId) {
      local.canonicalId = canonicalId; local.status = 'canonical'; await ledger.save(local);
    }
    if (!canonicalId) {
      const candidates = rows.filter(row => valid(row, operation, 'pending')).sort((a, b) => a.sdkId.localeCompare(b.sdkId));
      if (!candidates.length) {
        if (!deps.addViaSdk) return pending('remote_missing');
        try { await deps.addViaSdk(operation); }
        catch (error) {
          if (ledger) { local.attempts++; local.lastError = 'remote_error'; await ledger.save(local); }
          return error.conflict ? { kind: 'conflict', reason: error.code } : pending('remote_error');
        }
        const refreshed = await deps.findRemote(operation.externalId);
        candidates.push(...(Array.isArray(refreshed) ? refreshed : refreshed ? [refreshed] : [])
          .filter(row => valid(row, operation, 'pending')).sort((a, b) => a.sdkId.localeCompare(b.sdkId)));
      }
      if (!candidates.length) return pending('remote_unverified');
      canonicalId = candidates[0].sdkId;
      if (ledger) { local.canonicalId = canonicalId; local.status = 'canonical'; await ledger.save(local); }
    }
    let proof = active.find(row => row.sdkId === canonicalId);
    if (!proof && deps.readRemote) proof = await deps.readRemote(canonicalId);
    if (!valid(proof, operation, 'active')) {
      if (!deps.activateViaSdk) return pending('activation_required');
      await deps.activateViaSdk(canonicalId);
      proof = await deps.readRemote(canonicalId);
    }
    if (!valid(proof, operation, 'active')) return pending('remote_unverified');
    if (typeof deps.ackLocal !== 'function') return pending('ack_required');
    const ack = await deps.ackLocal(operation.externalId, proof);
    if (ack?.kind !== 'acked' || ack.operationId !== operation.externalId) return pending('local_ack_unconfirmed');
    if (ledger) { local.status = 'acked'; local.lastError = null; await ledger.save(local); }
    return { kind: 'stored', externalId: operation.externalId, sdkId: proof.sdkId,
      qdrantId: proof.qdrantId, verified: true };
  } catch (error) {
    if (ledger && local && !local.kind) {
      local.attempts++; local.lastError = error.code ?? 'operation_failed';
      await ledger.save(local);
    }
    return error.conflict ? { kind: 'conflict', reason: error.code ?? 'operation_failed' } :
      pending(error.code ?? 'operation_failed');
  }
}
