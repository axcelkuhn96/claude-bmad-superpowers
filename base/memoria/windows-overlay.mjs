import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureWindowsPrivateDirectory, readWindowsBinary, publishWindowsBinary,
  hashWindowsFile, holdWindowsHash, deleteWindowsBinary, windowsPathKey,
  inspectWindowsPath, windowsSystemLocations } from './windows-security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const defaultRoot = () => path.win32.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const overlayFile = (stateRoot, token) => path.win32.join(stateRoot ?? defaultRoot(),
  'overlays', `${hash(token)}.json`);
const launchFile = (stateRoot, token) => path.win32.join(stateRoot ?? defaultRoot(),
  'launches', `${hash(token)}.json`);

async function optionalJson(file, privateState) {
  const parent = path.win32.dirname(file);
  try {
    await fs.lstat(parent);
    if (!(await inspectWindowsPath(parent, 'directory', { privateState })).ok) {
      throw new Error('windows_capture_source_unsafe');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const observed = await readWindowsBinary(file, { length: 2 * 1024 * 1024, privateState });
  if (observed.size !== observed.bytes.length) throw new Error('windows_capture_source_oversize');
  return JSON.parse(observed.bytes.toString('utf8'));
}

export async function inspectWindowsCaptureSources({ cli, root, projectRoot, profile } = {}) {
  if (!['claude', 'codex'].includes(cli) || !profile ||
      !path.win32.isAbsolute(profile)) throw new Error('windows_capture_source_args');
  const profileKey = windowsPathKey(profile);
  const mainKey = windowsPathKey(projectRoot);
  const activeKey = windowsPathKey(root);
  if (profileKey === mainKey || profileKey.startsWith(mainKey + '\\') ||
      profileKey === activeKey || profileKey.startsWith(activeKey + '\\')) {
    throw new Error('windows_capture_profile_unsafe');
  }
  if (!(await inspectWindowsPath(profile, 'directory')).ok) {
    throw new Error('windows_capture_profile_unsafe');
  }
  if (cli === 'claude') {
    const locations = await windowsSystemLocations();
    const programData = path.win32.join(path.win32.parse(locations.windows).root, 'ProgramData');
    if (windowsPathKey(process.env.ProgramData ?? '') !== windowsPathKey(programData)) {
      throw new Error('windows_managed_policy_unproved');
    }
    for (const managed of [path.win32.join(programData, 'ClaudeCode', 'managed-settings.json'),
      path.win32.join(locations.programFiles, 'ClaudeCode', 'managed-settings.json')]) {
      try { await fs.lstat(managed); throw new Error('windows_managed_policy_unproved'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const sources = cli === 'claude'
    ? [[projectRoot, '.claude', 'settings.json'], [projectRoot, '.claude', 'settings.local.json'],
      [root, '.claude', 'settings.json'], [root, '.claude', 'settings.local.json'],
      [profile, 'settings.json'], [profile, 'settings.local.json']]
    : [[projectRoot, '.codex', 'hooks.json'], [root, '.codex', 'hooks.json'],
      [profile, 'hooks.json']];
  for (const parts of sources) {
    const file = path.win32.join(...parts);
    const value = await optionalJson(file, parts[0] === profile);
    if (value === null) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        JSON.stringify(value).includes('capture-hook.mjs')) {
      throw new Error('windows_capture_source_ambiguous');
    }
  }
  if (cli === 'codex') {
    for (const parts of [[projectRoot, '.codex', 'config.toml'],
      [root, '.codex', 'config.toml'], [profile, 'config.toml']]) {
      const file = path.win32.join(...parts);
      const parent = path.win32.dirname(file);
      try { await fs.lstat(parent); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!(await inspectWindowsPath(parent, 'directory', { privateState: parts[0] === profile })).ok) {
        throw new Error('windows_capture_source_unsafe');
      }
      try {
        const observed = await readWindowsBinary(file,
          { length: 2 * 1024 * 1024, privateState: parts[0] === profile });
        if (observed.size !== observed.bytes.length ||
            observed.bytes.includes(Buffer.from('capture-hook.mjs'))) {
          throw new Error('windows_capture_source_ambiguous');
        }
      } catch (error) { if (error.message !== 'windows_read_open' ||
          !await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) throw error; }
    }
  }
  return { kind: 'verified', source: 'session' };
}

export async function prepareWindowsOverlay({ stateRoot, token, hooks } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !hooks || typeof hooks !== 'object') {
    throw new Error('windows_overlay_args');
  }
  const file = overlayFile(stateRoot, token);
  if (!(await ensureWindowsPrivateDirectory(path.win32.dirname(file))).ok) {
    throw new Error('windows_overlay_state');
  }
  const bytes = Buffer.from(JSON.stringify({
    enabledPlugins: { 'claude-mem@thedotmack': false }, hooks,
  }) + '\n');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('windows_overlay_oversize');
  const created = await publishWindowsBinary(file, bytes);
  return { file, fileId: created.fileId, sha256: hash(bytes), size: bytes.length };
}

export async function verifyWindowsOverlay({ stateRoot, token, expected } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !expected ||
      windowsPathKey(expected.file) !== windowsPathKey(overlayFile(stateRoot, token))) {
    throw new Error('windows_overlay_changed');
  }
  const observed = await hashWindowsFile(expected.file);
  if (observed.fileId !== expected.fileId || observed.sha256 !== expected.sha256 ||
      observed.size !== expected.size) throw new Error('windows_overlay_changed');
  return observed;
}

export async function holdWindowsOverlay({ stateRoot, token, expected } = {}) {
  await verifyWindowsOverlay({ stateRoot, token, expected });
  return holdWindowsHash(expected.file, expected.fileId, expected.sha256);
}

export async function removeWindowsOverlay({ stateRoot, token, expected } = {}) {
  await verifyWindowsOverlay({ stateRoot, token, expected });
  const observed = await readWindowsBinary(expected.file, { length: expected.size });
  if (observed.size !== expected.size || hash(observed.bytes) !== expected.sha256) {
    throw new Error('windows_overlay_changed');
  }
  await deleteWindowsBinary(expected.file, expected.fileId, observed.bytes);
}

export async function verifyWindowsLaunchOverlay({ stateRoot, token, cli, nativeRoot, projectRoot } = {}) {
  const file = launchFile(stateRoot, token);
  const observed = await readWindowsBinary(file, { length: 8192 });
  if (observed.size !== observed.bytes.length) throw new Error('windows_launch_changed');
  const launch = JSON.parse(observed.bytes.toString('utf8'));
  if (launch.cli !== cli || windowsPathKey(launch.nativeRoot) !== windowsPathKey(nativeRoot) ||
      windowsPathKey(launch.projectRoot) !== windowsPathKey(projectRoot) ||
      Date.now() - launch.createdAt > 12 * 60 * 60 * 1000) {
    throw new Error('windows_launch_changed');
  }
  if (cli === 'claude') await verifyWindowsOverlay({ stateRoot, token, expected: launch.overlay });
  else if (launch.overlay) throw new Error('windows_launch_changed');
  return launch;
}
