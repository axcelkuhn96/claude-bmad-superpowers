import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureWindowsPrivateDirectory, readWindowsBinary, publishWindowsBinary,
  rewriteWindowsBinary, deleteWindowsBinary, withWindowsFileLock, windowsPathKey } from './windows-security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytesFor = value => Buffer.from(JSON.stringify(value) + '\n');
const missing = async file => {
  try { await fs.lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};

async function readIfPresent(file) {
  if (await missing(file)) return null;
  return readWindowsBinary(file, { length: 16 * 1024 * 1024 });
}

function decoded(observed) {
  if (!observed || observed.size !== observed.bytes.length) throw new Error('windows_state_oversize');
  try { return JSON.parse(observed.bytes.toString('utf8')); }
  catch { throw new Error('windows_state_corrupt'); }
}

// Intent is immutable and durable before same-handle rewrite. Unknown post-crash bytes are retained.
export function createWindowsState(file) {
  const canonical = windowsPathKey(file);
  const dir = path.win32.dirname(file);
  const journalDir = path.win32.join(dir, '.journal');
  const lockFile = path.win32.join(dir, `.lock-${hash(canonical)}`);
  const intentFile = path.win32.join(journalDir, `${hash(canonical)}.intent.json`);
  const withLock = async callback => {
    if (!(await ensureWindowsPrivateDirectory(journalDir)).ok) throw new Error('unsafe_windows_journal');
    return withWindowsFileLock(lockFile, callback);
  };

  async function replay() {
    const intentObserved = await readIfPresent(intentFile);
    if (!intentObserved) return;
    const intent = decoded(intentObserved);
    if (intent?.version !== 1 || intent.target !== canonical ||
        !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(intent.fileId ?? '') ||
        !/^[a-f0-9-]{36}$/.test(intent.transaction ?? '') ||
        typeof intent.old !== 'string' || typeof intent.next !== 'string') {
      throw new Error('windows_recovery_required');
    }
    const old = Buffer.from(intent.old, 'base64');
    const next = Buffer.from(intent.next, 'base64');
    if (old.toString('base64') !== intent.old || next.toString('base64') !== intent.next ||
        hash(old) !== intent.oldSha256 || hash(next) !== intent.nextSha256) {
      throw new Error('windows_recovery_required');
    }
    const observed = await readIfPresent(file);
    if (!observed || observed.fileId !== intent.fileId || observed.size !== observed.bytes.length) {
      throw new Error('windows_recovery_required');
    }
    if (!observed.bytes.equals(old) && !observed.bytes.equals(next)) {
      throw new Error('windows_recovery_required');
    }
    const receipt = path.win32.join(journalDir, `${hash(canonical)}-${intent.transaction}.commit.json`);
    if (observed.bytes.equals(next)) {
      const proof = bytesFor({ target: canonical, transaction: intent.transaction,
        fileId: intent.fileId, sha256: intent.nextSha256 });
      const existing = await readIfPresent(receipt);
      if (existing ? !existing.bytes.equals(proof) : false) throw new Error('windows_recovery_required');
      if (!existing) await publishWindowsBinary(receipt, proof);
    } else if (!(await missing(receipt))) {
      throw new Error('windows_recovery_required');
    }
    await deleteWindowsBinary(intentFile, intentObserved.fileId, intentObserved.bytes);
  }

  return {
    read: () => withLock(async () => {
      await replay();
      const observed = await readIfPresent(file);
      return observed ? decoded(observed) : null;
    }),
    write: value => withLock(async () => {
      await replay();
      const next = bytesFor(value);
      if (next.length > 1024 * 1024) throw new Error('windows_state_oversize');
      const before = await readIfPresent(file);
      if (!before) return publishWindowsBinary(file, next);
      if (before.size !== before.bytes.length) throw new Error('windows_state_oversize');
      if (before.bytes.equals(next)) return before;
      const transaction = randomUUID();
      const intentBytes = bytesFor({ version: 1, target: canonical, fileId: before.fileId,
        transaction, old: before.bytes.toString('base64'), next: next.toString('base64'),
        oldSha256: hash(before.bytes), nextSha256: hash(next) });
      if (intentBytes.length > 4 * 1024 * 1024) throw new Error('windows_state_oversize');
      await publishWindowsBinary(intentFile, intentBytes);
      await rewriteWindowsBinary(file, before.fileId, before.bytes, next);
      await replay();
      return { fileId: before.fileId };
    }),
  };
}
