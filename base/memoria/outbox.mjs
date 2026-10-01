import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { externalIdFor } from './ledger.mjs';

const DEFAULT_MAX = 256 * 1024 * 1024;
const blocked = reason => ({ kind: 'blocked', reason });
const validId = id => typeof id === 'string' && /^src-[a-f0-9]{64}$/.test(id);

export function createOutbox(stateDir, options = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('invalid_state_dir');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_outbox_limit');
  const root = path.join(stateDir, 'outbox');
  const items = path.join(root, 'items');
  const acks = path.join(root, 'acks');
  const lock = path.join(root, 'lock');
  const itemFile = id => path.join(items, `${id}.json`);
  const ackFile = id => path.join(acks, `${id}.json`);
  const retryFile = id => path.join(items, `${id}.retry.json`);

  async function syncDir(dir) {
    const h = await fs.open(dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  }
  async function ensure() {
    if (process.platform === 'win32' || !process.getuid) throw new Error('native_windows_unproved');
    for (const dir of [stateDir, root, items, acks]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('unsafe_outbox_dir');
    }
  }
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function durable(file, value) {
    const dir = path.dirname(file);
    const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await options.fault?.('after_write');
      await handle.sync();
      await options.fault?.('after_file_sync');
    } finally { await handle.close(); }
    try {
      await fs.rename(temporary, file);
      await options.fault?.('after_rename');
      await syncDir(dir);
      await options.fault?.('after_dir_sync');
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  async function withLock(callback) {
    await ensure();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
        try {
          for (const dir of [items, acks]) {
            let removed = false;
            for (const name of await fs.readdir(dir)) if (/^\.[a-f0-9-]+\.tmp$/.test(name)) {
              await fs.rm(path.join(dir, name));
              removed = true;
            }
            if (removed) await syncDir(dir);
          }
          let reclaimed = false;
          for (const name of await fs.readdir(acks)) if (/^src-[a-f0-9]{64}\.json$/.test(name)) {
            const retry = retryFile(name.slice(0, -5));
            const present = await Promise.all([fs.stat(path.join(items, name)).then(() => true, error => {
              if (error.code === 'ENOENT') return false; throw error;
            }), fs.stat(retry).then(() => true, error => {
              if (error.code === 'ENOENT') return false; throw error;
            })]);
            if (present.some(Boolean)) {
              await syncDir(acks);
              if (present[0]) await fs.rm(path.join(items, name));
              if (present[1]) await fs.rm(retry);
              reclaimed = true;
            }
          }
          if (reclaimed) await syncDir(items);
          return await callback();
        }
        finally { await fs.rm(lock, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
        if (owner && owner !== process.pid) {
          try { process.kill(owner, 0); }
          catch (e) { if (e.code === 'ESRCH') { await fs.rm(lock, { recursive: true, force: true }); continue; } }
        }
        if (!owner && Date.now() - (await fs.stat(lock)).mtimeMs > 1000) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
    throw new Error('outbox_lock_timeout');
  }
  async function records() {
    await ensure();
    const rows = [];
    for (const dir of [acks, items]) {
      for (const name of await fs.readdir(dir)) {
        if (!/^src-[a-f0-9]{64}\.json$/.test(name)) continue;
        const row = await read(path.join(dir, name));
        if (!row || row.operationId !== name.slice(0, -5)) throw new Error('corrupt_outbox');
        rows.push({ ...row, acknowledged: dir === acks });
      }
    }
    return rows;
  }
  function unique(rows) {
    const byId = new Map();
    for (const row of rows) if (!byId.has(row.operationId) || row.acknowledged) byId.set(row.operationId, row);
    return [...byId.values()];
  }
  async function pendingUnlocked() {
    const rows = unique(await records()).filter(row => !row.acknowledged).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId) || a.start - b.start);
    return Promise.all(rows.map(async row => {
      const retry = await read(retryFile(row.operationId));
      if (retry && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 5 ||
          !Number.isSafeInteger(retry.retryAt) || typeof retry.lastError !== 'string')) {
        throw new Error('corrupt_retry');
      }
      return { ...row, ...(retry ?? { attempts: 0, retryAt: 0, lastError: null }) };
    }));
  }
  function cursorFrom(rows, cli, sessionId) {
    rows = rows.filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    let queuedEnd = 0;
    let ackedEnd = 0;
    for (const row of rows) {
      if (row.start === queuedEnd) queuedEnd = row.end;
      if (row.acknowledged && row.start === ackedEnd) ackedEnd = row.end;
    }
    return { queuedEnd, ackedEnd };
  }
  async function cursorUnlocked(cli, sessionId) { return cursorFrom(unique(await records()), cli, sessionId); }
  async function enqueueCheckpoint(slice, identity) {
    const { cli, sessionId, start, end, sliceHash, messages } = slice ?? {};
    const { projectId, policyVersion } = identity ?? {};
    const operationId = externalIdFor({ originCli: cli, projectId, sessionId, start, end, sliceHash, policyVersion });
    if (!Array.isArray(messages) || !messages.every(message => message && typeof message === 'object' &&
        (!message.sessionId || message.sessionId === sessionId) &&
        (message.start === undefined || Number.isSafeInteger(message.start) && message.start >= start) &&
        (message.end === undefined || Number.isSafeInteger(message.end) && message.end <= end))) {
      throw new Error('invalid_checkpoint_messages');
    }
    return withLock(async () => {
      const existing = await read(itemFile(operationId)) ?? await read(ackFile(operationId));
      if (existing) return { kind: existing.sdkId ? 'acked' : 'queued', operationId,
        alert: (await usageUnlocked()) >= maxBytes * 0.8 };
      const rows = unique(await records());
      const position = cursorFrom(rows, cli, sessionId);
      if (start !== position.queuedEnd) return blocked('cursor_gap');
      const row = { operationId, projectId, cli, sessionId, start, end, sliceHash, policyVersion, messages };
      const size = Buffer.byteLength(JSON.stringify(row) + '\n');
      let used = 0;
      for (const queued of rows) if (!queued.acknowledged) used += (await fs.stat(itemFile(queued.operationId))).size;
      if (used + size > maxBytes) return { kind: 'full', operationId, usedBytes: used, maxBytes };
      await durable(itemFile(operationId), row);
      return { kind: 'queued', operationId, alert: used + size >= maxBytes * 0.8,
        usedBytes: used + size };
    });
  }
  async function usageUnlocked() {
    const rows = unique(await records()).filter(row => !row.acknowledged);
    let bytes = 0;
    for (const row of rows) bytes += (await fs.stat(itemFile(row.operationId))).size;
    return bytes;
  }
  async function ackVerified(operationId, proof) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row) return await read(ackFile(operationId)) ? { kind: 'acked', operationId } : blocked('missing_operation');
      if (proof?.externalId !== operationId || proof.projectId !== row.projectId ||
          proof.status !== 'active' || !proof.sdkId || !proof.qdrantId) return blocked('unverified_remote');
      await durable(ackFile(operationId), { operationId, projectId: row.projectId, cli: row.cli,
        sessionId: row.sessionId, start: row.start, end: row.end, sdkId: proof.sdkId, qdrantId: proof.qdrantId });
      await fs.rm(itemFile(operationId));
      await fs.rm(retryFile(operationId), { force: true });
      await syncDir(items);
      return { kind: 'acked', operationId };
    });
  }
  async function markFailed(operationId, reason) {
    if (!validId(operationId) || typeof reason !== 'string' || !/^[a-z_]{1,64}$/.test(reason)) {
      return blocked('invalid_failure');
    }
    return withLock(async () => {
      if (await read(ackFile(operationId))) return { kind: 'acked', operationId };
      if (!await read(itemFile(operationId))) return blocked('missing_operation');
      const previous = await read(retryFile(operationId));
      if (previous && (!Number.isSafeInteger(previous.attempts) || previous.attempts < 1 ||
          previous.attempts > 5)) throw new Error('corrupt_retry');
      const attempts = Math.min(5, (previous?.attempts ?? 0) + 1);
      const retryAt = Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1));
      await durable(retryFile(operationId), { attempts, retryAt, lastError: reason });
      return { kind: 'pending', operationId, attempts, retryAt };
    });
  }
  async function ready(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_retry_clock');
    return (await withLock(pendingUnlocked)).filter(row => row.attempts < 5 && row.retryAt <= now);
  }
  return { enqueueCheckpoint, ackVerified, pending: () => withLock(pendingUnlocked),
    cursor: (cli, sessionId) => withLock(() => cursorUnlocked(cli, sessionId)),
    usage: () => withLock(usageUnlocked), markFailed, ready };
}
