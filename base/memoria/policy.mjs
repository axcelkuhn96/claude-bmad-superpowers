import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureWindowsPrivateDirectory, readWindowsPrivateFile,
  writeWindowsPrivateFile } from './windows-security.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = resolution => digest([resolution.projectId, resolution.destination,
  resolution.embeddingFingerprint]);
const ownerValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);

async function readPrivate(file) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file);
    if (result.code === 'missing') return null;
    if (!result.ok) throw new Error('unsafe_policy');
    return JSON.parse(result.text);
  }
  try {
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
        !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe_policy');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePrivate(file, data, replace = false) {
  const dir = path.dirname(file);
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_policy');
    // A policy change is an explicit new declaration. Existing sessions retain their frozen record.
    const previous = await readWindowsPrivateFile(file);
    if (previous.ok && !replace) throw new Error('policy_exists');
    if (!(await writeWindowsPrivateFile(file, JSON.stringify(data) + '\n',
      { replace: previous.ok, expectedText: previous.ok ? previous.text : null })).ok) throw new Error('unsafe_policy');
    return;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe_policy');
  const previous = await readPrivate(file);
  if (previous && !replace) throw new Error('policy_exists');
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  const directory = await fs.open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function registerOwner(resolution, cli, profilePath, ownerId, attested) {
  if (!['claude', 'codex'].includes(cli) || !ownerValid(ownerId) || attested !== true ||
      typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) return blocked('owner_declaration_required');
  let profile;
  try {
    profile = await fs.realpath(profilePath);
    const stat = await fs.stat(profile);
    if (!stat.isDirectory() || process.platform !== 'win32' && (!process.getuid ||
        stat.uid !== process.getuid() || (stat.mode & 0o022))) throw new Error('profile');
  } catch { return blocked('owner_profile_untrusted'); }
  const file = path.join(resolution.stateDir, `owner-${cli}.json`);
  try {
    await writePrivate(file, { projectId: resolution.projectId, binding: binding(resolution),
      cli, profile, ownerId,
      declaration: 'new native human messages under this profile belong to this declared owner',
      declaredAt: new Date().toISOString() }, true);
    return { kind: 'registered', ownerId };
  } catch { return blocked('unsafe_owner_state'); }
}

export async function readOwner(resolution, cli, profilePath) {
  if (!['claude', 'codex'].includes(cli) || !profilePath) return null;
  try {
    const value = await readPrivate(path.join(resolution.stateDir, `owner-${cli}.json`));
    if (!value) return null;
    if (value.projectId !== resolution.projectId || value.binding !== binding(resolution) ||
        value.cli !== cli ||
        !ownerValid(value.ownerId) || typeof value.declaration !== 'string') throw new Error('owner_binding_changed');
    if (value.profile !== await fs.realpath(profilePath)) return null;
    return { ownerId: value.ownerId, declaration: value.declaration,
      declaredAt: value.declaredAt };
  } catch { return blocked('owner_binding_changed'); }
}

export async function configureExtractor(resolution, selection) {
  if (!selection || !['sonnet', 'haiku', 'sol'].includes(selection.route) ||
      ['sonnet', 'haiku'].includes(selection.route) && (typeof selection.profile !== 'string' ||
      !path.isAbsolute(selection.profile) || typeof selection.executable !== 'string' ||
      !path.isAbsolute(selection.executable))) return blocked('extractor_selection_invalid');
  if (selection.route === 'sol') return blocked('sol_tool_isolation_unproved');
  let profile, executable;
  try {
    [profile, executable] = await Promise.all([fs.realpath(selection.profile), fs.realpath(selection.executable)]);
    const [profileStat, executableStat] = await Promise.all([fs.stat(profile), fs.stat(executable)]);
    if (!profileStat.isDirectory() || !executableStat.isFile() ||
        process.platform !== 'win32' && (!process.getuid || profileStat.uid !== process.getuid() ||
          (profileStat.mode & 0o022) || (executableStat.mode & 0o022))) throw new Error('untrusted');
  } catch { return blocked('extractor_path_untrusted'); }
  try {
    await writePrivate(path.join(resolution.stateDir, 'extractor.json'), {
      projectId: resolution.projectId, binding: binding(resolution), route: selection.route,
      profile, executable, maxCallsPerSession: 4, maxCandidatesPerCheckpoint: 5,
      autoPublish: false, selectedAt: new Date().toISOString() }, true);
  } catch { return blocked('unsafe_extractor_state'); }
  return { kind: 'selected', route: selection.route, cost: 'up to four automatic paid CLI calls per session; five candidates per checkpoint; auto publication off' };
}

export async function readExtractor(resolution) {
  try {
    const value = await readPrivate(path.join(resolution.stateDir, 'extractor.json'));
    if (!value) return null;
    if (value.projectId !== resolution.projectId || value.binding !== binding(resolution) ||
        !['sonnet', 'haiku'].includes(value.route) || value.maxCallsPerSession !== 4 ||
        value.maxCandidatesPerCheckpoint !== 5 || value.autoPublish !== false) throw new Error('extractor_binding_changed');
    const [profile, executable] = await Promise.all([fs.realpath(value.profile), fs.realpath(value.executable)]);
    if (profile !== value.profile || executable !== value.executable) throw new Error('extractor_path_changed');
    return value;
  } catch { return blocked('extractor_binding_changed'); }
}

export async function localDevice(stateDir) {
  const file = path.join(path.dirname(stateDir), 'device.json');
  try {
    let value = await readPrivate(file);
    if (!value) {
      await writePrivate(file, { deviceId: randomUUID() });
      value = await readPrivate(file);
    }
    if (!/^[a-f0-9-]{36}$/.test(value?.deviceId ?? '')) throw new Error('unsafe_device_state');
    return { kind: 'device', deviceId: value.deviceId };
  } catch (error) {
    if (error.code === 'EEXIST') return localDevice(stateDir);
    return blocked('unsafe_device_state');
  }
}
