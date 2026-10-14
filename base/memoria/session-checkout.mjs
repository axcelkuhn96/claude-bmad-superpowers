import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureWindowsPrivateDirectory, publishWindowsBinary, readWindowsBinary } from './windows-security.mjs';
import { nativeProfile } from './native-profile.mjs';

const fileFor = (stateDir, cli, sessionId) => path.join(stateDir, 'sessions',
  `${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.checkout.json`);
const blocked = reason => ({ kind: 'blocked', reason });

export async function readSessionCheckout(stateDir, cli, sessionId) {
  const file = fileFor(stateDir, cli, sessionId);
  if (process.platform === 'win32') {
    try {
      const result = await readWindowsBinary(file, { length: 8192 });
      if (result.size !== result.bytes.length) return blocked('unsafe_session_checkout');
      const value = JSON.parse(result.bytes.toString('utf8'));
      return value.cli === cli && value.sessionId === sessionId && path.isAbsolute(value.profile ?? '')
        ? { kind: 'bound', ...value } : blocked('session_checkout_changed');
    } catch (error) {
      return blocked(error.code === 'ENOENT' || error.message === 'windows_read_open'
        ? 'missing_session_checkout' : 'unsafe_session_checkout');
    }
  }
  try {
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!process.getuid || !dir.isDirectory() || !stat.isFile() ||
        dir.uid !== process.getuid() || stat.uid !== process.getuid() ||
        (dir.mode & 0o077) || (stat.mode & 0o077)) return blocked('unsafe_session_checkout');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return value.cli === cli && value.sessionId === sessionId ? { kind: 'bound', ...value } : blocked('session_checkout_changed');
  } catch (error) { return blocked(error.code === 'ENOENT' ? 'missing_session_checkout' : 'unsafe_session_checkout'); }
}

export async function recordSessionCheckout(resolution, cli, sessionId, nativeRoot) {
  if (!['claude', 'codex'].includes(cli) || !sessionId || !path.isAbsolute(nativeRoot)) return blocked('invalid_session_checkout');
  const profile = nativeProfile(cli);
  if (process.platform === 'win32' && (!profile || !path.isAbsolute(profile))) {
    return blocked('invalid_session_checkout');
  }
  const file = fileFor(resolution.stateDir, cli, sessionId);
  const expected = { cli, sessionId, nativeRoot, projectRoot: resolution.projectRoot,
    projectId: resolution.projectId, ...(process.platform === 'win32' ? { profile } : {}) };
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(path.dirname(file))).ok) return blocked('unsafe_session_checkout');
    const prior = await readSessionCheckout(resolution.stateDir, cli, sessionId);
    if (prior.kind === 'bound') return Object.entries(expected).every(([key, value]) => prior[key] === value)
      ? prior : blocked('session_checkout_changed');
    if (prior.reason !== 'missing_session_checkout') return prior;
    try { await publishWindowsBinary(file, Buffer.from(JSON.stringify(expected) + '\n')); }
    catch (error) { if (error.message !== 'windows_publish_failed') return blocked('session_checkout_write_failed'); }
    const saved = await readSessionCheckout(resolution.stateDir, cli, sessionId);
    return saved.kind === 'bound' && Object.entries(expected).every(([key, value]) => saved[key] === value)
      ? saved : blocked('session_checkout_changed');
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const dir = await fs.lstat(path.dirname(file));
  if (!process.getuid || dir.uid !== process.getuid() || (dir.mode & 0o077)) return blocked('unsafe_session_checkout');
  const prior = await readSessionCheckout(resolution.stateDir, cli, sessionId);
  if (prior.kind === 'bound') return Object.entries(expected).every(([key, value]) => prior[key] === value)
    ? prior : blocked('session_checkout_changed');
  if (prior.reason !== 'missing_session_checkout') return prior;
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(expected) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') return blocked('session_checkout_write_failed');
  }
  const saved = await readSessionCheckout(resolution.stateDir, cli, sessionId);
  return saved.kind === 'bound' && Object.entries(expected).every(([key, value]) => saved[key] === value)
    ? saved : blocked('session_checkout_changed');
}
