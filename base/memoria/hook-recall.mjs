import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProject } from './provider.mjs';
import { searchProject } from './bridge.mjs';
import { renderRecall, selectRecall } from './context.mjs';
import { withProjectLock } from './ledger.mjs';
import { createWindowsState } from './windows-state.mjs';
import { ensureWindowsPrivateDirectory, readWindowsBinary,
  deleteWindowsBinary } from './windows-security.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const validCapture = result => result && !['blocked', 'pass_through', 'full'].includes(result.kind);
const stateFile = (stateDir, cli, sessionId) => path.join(stateDir, 'sessions',
  `${digest(JSON.stringify([cli, sessionId]))}.recall.json`);

async function readSeen(file) {
  if (process.platform === 'win32') {
    try {
      const value = await createWindowsState(file).read();
      return value === null ? new Set() : Array.isArray(value) && value.length <= 2048 &&
        value.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
        ? new Set(value) : null;
    } catch { return null; }
  }
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
        (stat.mode & 0o077) || stat.size > 160000) return null;
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(value) && value.length <= 2048 &&
      value.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
      ? new Set(value) : null;
  } catch (error) { return error.code === 'ENOENT' ? new Set() : null; }
}

async function saveSeen(file, seen) {
  if (process.platform === 'win32') {
    await createWindowsState(file).write([...seen]);
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify([...seen]) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function recordRecallWindow({ stateDir, cli, sessionId, eligible, remaining,
  writeSeen = saveSeen }) {
  const file = stateFile(stateDir, cli, sessionId);
  return withProjectLock(stateDir, async () => {
    if (remaining() <= 0) return { kind: 'unavailable', reason: 'deadline' };
    const seen = await readSeen(file);
    if (!seen) return { kind: 'unavailable', reason: 'unsafe_window' };
    if (seen.size >= 2048) return { kind: 'unavailable', reason: 'window_full' };
    const keyed = eligible.map(row => ({ row,
      key: digest(`${row.sdkId ?? row.memory_id ?? row.id}:${row.text ?? row.memory}`) }));
    const rendered = renderRecall(keyed.filter(item => !seen.has(item.key)).map(item => item.row), 500);
    if (!rendered.used.length) return { kind: 'abstain' };
    const additions = keyed.filter(item => rendered.used.includes(item.row)).map(item => item.key);
    if (seen.size + additions.length > 2048) return { kind: 'unavailable', reason: 'window_full' };
    if (process.platform === 'win32') {
      if (!(await ensureWindowsPrivateDirectory(path.dirname(file))).ok) {
        return { kind: 'unavailable', reason: 'unsafe_window' };
      }
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const dir = await fs.lstat(path.dirname(file));
      if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) {
        return { kind: 'unavailable', reason: 'unsafe_window' };
      }
    }
    const previous = new Set(seen);
    for (const key of additions) seen.add(key);
    if (remaining() <= 0) return { kind: 'unavailable', reason: 'deadline' };
    await writeSeen(file, seen);
    if (remaining() <= 0) {
      await saveSeen(file, previous);
      return { kind: 'unavailable', reason: 'deadline' };
    }
    const rollback = () => withProjectLock(stateDir, async () => {
      const current = await readSeen(file);
      if (!current) return false;
      for (const key of additions) current.delete(key);
      await saveSeen(file, current);
      return true;
    }, 'recall.lock', 1000);
    return { kind: 'items', items: rendered.used, text: rendered.text, rollback };
  }, 'recall.lock', Math.max(1, Math.min(remaining(), 100)));
}

export async function recallForPrompt({ cli, event = 'UserPromptSubmit', payload, result, stateRoot,
  began = performance.now(), resolve = resolveProject, search = searchProject,
  readSecret = name => process.env[name], now = () => new Date().toISOString(),
  recordWindow = recordRecallWindow } = {}) {
  if (!validCapture(result) || !['claude', 'codex'].includes(cli) ||
      typeof payload?.cwd !== 'string' || typeof payload.session_id !== 'string') return null;
  if (event !== 'UserPromptSubmit' && event !== 'PreCompact') return null;
  try {
    const remaining = () => Math.floor(1000 - (performance.now() - began));
    if (remaining() <= 0) return null;
    const current = await resolve(payload.cwd, payload.session_id, { stateRoot });
    if (current.provider !== 'mem0' || !current.projectId || !current.stateDir) return null;
    const file = stateFile(current.stateDir, cli, payload.session_id);
    if (event === 'PreCompact') {
      await withProjectLock(current.stateDir, async () => {
        if (process.platform === 'win32') {
          await createWindowsState(file).read();
          try {
            const observed = await readWindowsBinary(file, { length: 160000 });
            if (observed.size !== observed.bytes.length) throw new Error('unsafe_window');
            await deleteWindowsBinary(file, observed.fileId, observed.bytes);
          } catch (error) {
            if (error.message !== 'windows_read_open' ||
                !await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) throw error;
          }
        } else await fs.rm(file, { force: true });
      },
        'recall.lock', Math.max(1, Math.min(remaining(), 100)));
      return null;
    }
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 4096) return null;
    const deadlineMs = remaining();
    if (deadlineMs <= 0) return null;
    let timer;
    const answer = await Promise.race([
      search({ cwd: payload.cwd, sessionId: payload.session_id, projectId: current.projectId,
        query: payload.prompt }, readSecret, { stateRoot, deadlineMs, ownerId: current.ownerId }),
      new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline(null), deadlineMs); }),
    ]).finally(() => clearTimeout(timer));
    if (answer?.kind !== 'items' || remaining() <= 0) return null;
    const eligible = selectRecall(answer.items, { projectId: current.projectId,
      ownerId: current.ownerId, now: now() });
    if (!eligible.length) return null;
    const selected = await recordWindow({ stateDir: current.stateDir, cli,
      sessionId: payload.session_id, eligible, remaining });
    if (selected.kind !== 'items') return null;
    if (remaining() <= 0) { await selected.rollback(); return null; }
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: selected.text } };
  } catch { return null; }
}
