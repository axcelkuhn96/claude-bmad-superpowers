import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProject } from './provider.mjs';
import { searchProject } from './bridge.mjs';
import { renderRecall, selectRecall } from './context.mjs';
import { withProjectLock } from './ledger.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const validCapture = result => result && !['blocked', 'pass_through', 'full'].includes(result.kind);
const stateFile = (stateDir, cli, sessionId) => path.join(stateDir, 'sessions',
  `${digest(JSON.stringify([cli, sessionId]))}.recall.json`);

async function readSeen(file) {
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

export async function recallForPrompt({ cli, event = 'UserPromptSubmit', payload, result, stateRoot,
  began = performance.now(), resolve = resolveProject, search = searchProject,
  readSecret = name => process.env[name], now = () => new Date().toISOString() } = {}) {
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
      await withProjectLock(current.stateDir, async () => { await fs.rm(file, { force: true }); },
        'recall.lock', Math.max(1, Math.min(remaining(), 100)));
      return null;
    }
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 4096) return null;
    const deadlineMs = remaining();
    if (deadlineMs <= 0) return null;
    let timer;
    const answer = await Promise.race([
      search({ cwd: payload.cwd, sessionId: payload.session_id, projectId: current.projectId,
        query: payload.prompt }, readSecret, { stateRoot, deadlineMs }),
      new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline(null), deadlineMs); }),
    ]).finally(() => clearTimeout(timer));
    if (answer?.kind !== 'items' || remaining() <= 0) return null;
    const eligible = selectRecall(answer.items, { projectId: current.projectId, now: now() });
    if (!eligible.length) return null;
    return await withProjectLock(current.stateDir, async () => {
      if (remaining() <= 0) return null;
      const seen = await readSeen(file);
      if (!seen) return null;
      if (seen.size >= 2048) return null;
      const keyed = eligible.map(row => ({ row, key: digest(`${row.sdkId ?? row.memory_id ?? row.id}:${row.text ?? row.memory}`) }));
      const unseen = keyed.filter(item => !seen.has(item.key));
      const rendered = renderRecall(unseen.map(item => item.row), 500);
      if (!rendered.used.length || seen.size + rendered.used.length > 2048 || remaining() <= 0) return null;
      for (const row of rendered.used) {
        const item = keyed.find(item => item.row === row);
        seen.add(item.key);
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const dir = await fs.lstat(path.dirname(file));
      if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return null;
      await saveSeen(file, seen);
      if (remaining() <= 0) return null;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: rendered.text } };
    }, 'recall.lock', Math.max(1, Math.min(remaining(), 100)));
  } catch { return null; }
}
