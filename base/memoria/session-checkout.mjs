import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureWindowsPrivateDirectory, publishWindowsBinary, readWindowsBinary } from './windows-security.mjs';
import { nativeProfile } from './native-profile.mjs';
import { withProjectLock } from './ledger.mjs';

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
    return value.cli === cli && value.sessionId === sessionId &&
      (value.profile == null || typeof value.profile === 'string' && path.isAbsolute(value.profile))
      ? { kind: 'bound', ...value } : blocked('session_checkout_changed');
  } catch (error) { return blocked(error.code === 'ENOENT' ? 'missing_session_checkout' : 'unsafe_session_checkout'); }
}

export async function bindSessionCheckoutProfile(stateDir, cli, sessionId, profile) {
  if (!['claude', 'codex'].includes(cli) || !sessionId ||
      typeof profile !== 'string' || !path.isAbsolute(profile)) return blocked('invalid_session_checkout');
  try {
    return await withProjectLock(stateDir, async () => {
      const prior = await readSessionCheckout(stateDir, cli, sessionId);
      if (prior.kind !== 'bound') return prior;
      if (prior.profile === profile) return prior;
      if (prior.profile != null || process.platform === 'win32') return blocked('session_checkout_changed');
      const file = fileFor(stateDir, cli, sessionId);
      const before = await fs.lstat(file);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let original;
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino) return blocked('session_checkout_changed');
        original = await handle.readFile('utf8');
      } finally { await handle.close(); }
      const value = JSON.parse(original);
      if (value.profile != null || value.cli !== cli || value.sessionId !== sessionId ||
          value.nativeRoot !== prior.nativeRoot || value.projectRoot !== prior.projectRoot ||
          value.projectId !== prior.projectId) return blocked('session_checkout_changed');
      const temporary = `${file}.${randomUUID()}.tmp`;
      const replacement = await fs.open(temporary, 'wx', 0o600);
      try { await replacement.writeFile(JSON.stringify({ ...value, profile }) + '\n');
        await replacement.sync(); }
      finally { await replacement.close(); }
      try {
        const current = await fs.lstat(file);
        if (current.dev !== before.dev || current.ino !== before.ino) {
          await fs.rm(temporary, { force: true });
          return blocked('session_checkout_changed');
        }
        await fs.rename(temporary, file);
      } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return readSessionCheckout(stateDir, cli, sessionId);
    }, 'checkout-profile.lock');
  } catch { return blocked('unsafe_session_checkout'); }
}

export async function recordSessionCheckout(resolution, cli, sessionId, nativeRoot,
  profile = nativeProfile(cli)) {
  if (!['claude', 'codex'].includes(cli) || !sessionId || !path.isAbsolute(nativeRoot)) return blocked('invalid_session_checkout');
  if (!profile || !path.isAbsolute(profile)) {
    return blocked('invalid_session_checkout');
  }
  const file = fileFor(resolution.stateDir, cli, sessionId);
  const expected = { cli, sessionId, nativeRoot, projectRoot: resolution.projectRoot,
    projectId: resolution.projectId, profile };
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
  if (prior.kind === 'bound') {
    if (Object.entries(expected).every(([key, value]) => prior[key] === value)) return prior;
    return prior.profile == null && ['cli', 'sessionId', 'nativeRoot', 'projectRoot', 'projectId']
      .every(key => prior[key] === expected[key])
      ? bindSessionCheckoutProfile(resolution.stateDir, cli, sessionId, profile)
      : blocked('session_checkout_changed');
  }
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
