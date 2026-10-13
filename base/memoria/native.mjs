import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { identifyProject } from './project-id.mjs';
import { withProjectLock } from './ledger.mjs';
import { canonicalWindowsPath, ensureWindowsPrivateDirectory, inspectWindowsPath,
  probeWindowsCodexPlugin, readWindowsPrivateFile, removeWindowsPrivateFile,
  resolveWindowsExecutable, windowsPathKey, withWindowsLock,
  writeWindowsPrivateFile, windowsGitPattern } from './windows-security.mjs';
import { inspectWindowsCaptureSources, verifyWindowsLaunchOverlay } from './windows-overlay.mjs';

const run = promisify(execFile);
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const gitCommand = root => process.platform === 'win32'
  ? resolveWindowsExecutable('git.exe', [root, path.resolve(path.dirname(captureScript), '..', '..')])
  : 'git';
const gitArgs = (root, ...args) => process.platform === 'win32'
  ? ['-c', 'core.fsmonitor=false', '-C', root, ...args] : ['-C', root, ...args];
const plugins = { claude: 'claude-mem@thedotmack', codex: 'claude-mem@claude-mem-local' };
const blocked = (reason) => ({ kind: 'blocked', reason });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stateRoot = (options) => options.stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const snapshotFile = (root, cli, options) => path.join(stateRoot(options), hash(options.projectRoot ?? root),
  (options.projectRoot && options.projectRoot !== root ? `native-${cli}-${hash(root)}.json` : `native-${cli}.json`));
const versionFile = snapshot => `${snapshot}.versions`;
const validVersion = value => /^[a-f0-9]{64}$/.test(value?.sha256 ?? '') &&
  /^[a-f0-9]{8}:[a-f0-9]{16}$/.test(value?.fileId ?? '');
const fileVersion = value => validVersion(value)
  ? { sha256: value.sha256, fileId: value.fileId } : null;
const sameVersion = (actual, expected) => validVersion(actual) && validVersion(expected) &&
  actual.sha256 === expected.sha256 && actual.fileId === expected.fileId;
const configFile = (root, cli) => path.join(root, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
const captureEvents = { claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd'],
  codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] };
const captureScript = fileURLToPath(new URL('./capture-hook.mjs', import.meta.url));
const hookFile = root => path.join(root, '.codex', 'hooks.json');
function captureCommand(cli, event) {
  if (process.platform === 'win32') {
    if ([process.execPath, captureScript].some(value => !path.win32.isAbsolute(value) ||
        /[%!^&|<>"\r\n]/.test(value))) return null;
  } else if ([process.execPath, captureScript].some(value => /[$`"\r\n]/.test(value))) return null;
  return `"${process.execPath}" "${captureScript}" ${cli} ${event}`;
}
function editCaptureHooks(raw, cli, remove = false) {
  let value;
  try { value = raw === null ? {} : JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)))) return null;
  const hooks = { ...(value.hooks ?? {}) };
  for (const event of captureEvents[cli]) {
    const command = captureCommand(cli, event);
    if (!command || (hooks[event] !== undefined && !Array.isArray(hooks[event]))) return null;
    const groups = hooks[event] ?? [];
    const ours = group => group?.hooks?.some(h => h?.command === command);
    if (groups.some(group => group?.hooks?.some(h => typeof h?.command === 'string' &&
        h.command.includes('capture-hook.mjs') && h.command !== command))) return null;
    hooks[event] = remove ? groups.filter(group => !ours(group)) :
      groups.some(ours) ? groups : [...groups, { hooks: [{ type: 'command', command, timeout: 10 }] }];
    if (!hooks[event].length) delete hooks[event];
  }
  if (Object.keys(hooks).length) value.hooks = hooks;
  else delete value.hooks;
  return JSON.stringify(value, null, 2) + '\n';
}

function windowsSessionHooks(cli) {
  const edited = editCaptureHooks(null, cli);
  if (!edited) throw new Error('unsafe_capture_hooks');
  return JSON.parse(edited).hooks;
}

function exactCodexHooks(hooks, allowUnrelated = false) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  if (!allowUnrelated && Object.keys(hooks).length !== captureEvents.codex.length) return null;
  const selected = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) return null;
      const ours = group.hooks.filter(handler =>
        typeof handler?.command === 'string' && handler.command.includes('capture-hook.mjs'));
      if (!ours.length) {
        if (!allowUnrelated) return null;
        continue;
      }
      const handler = ours[0];
      if (!captureEvents.codex.includes(event) || ours.length !== 1 ||
          group.hooks.length !== 1 || Object.keys(group).length !== 1 ||
          Object.keys(handler).length !== 3 || handler.type !== 'command' ||
          handler.command !== captureCommand('codex', event) || handler.timeout !== 10 ||
          selected[event]) return null;
      selected[event] = [group];
    }
  }
  const count = Object.keys(selected).length;
  if (!count) return { kind: 'absent' };
  return count === captureEvents.codex.length ? { kind: 'exact', hooks: selected } : null;
}

async function safeFile(file, privateState = false) {
  if (process.platform === 'win32') {
    const result = await inspectWindowsPath(file, 'file', { privateState });
    return result.ok || result.code === 'missing';
  }
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && (!process.getuid || stat.uid === process.getuid());
  } catch (error) { return error.code === 'ENOENT'; }
}
async function safeParent(file, privateState = false) {
  if (process.platform === 'win32') {
    const result = await inspectWindowsPath(path.dirname(file), 'directory', { privateState });
    return result.ok || result.code === 'missing';
  }
  try {
    const stat = await fs.lstat(path.dirname(file));
    return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid());
  } catch (error) { return error.code === 'ENOENT'; }
}
async function tracked(root, file) {
  const relative = process.platform === 'win32' ? windowsGitPattern(root, file).slice(1) : path.relative(root, file);
  try {
    const { stdout } = await run(await gitCommand(root), gitArgs(root, 'ls-files', '--cached', '--', relative), { env: gitEnv(), timeout: 5000 });
    return !!stdout.trim();
  } catch { return true; }
}
async function excludePlan(root, cli, target = configFile(root, cli)) {
  const relative = process.platform === 'win32' ? windowsGitPattern(root, target).slice(1) : path.relative(root, target);
  const block = `# cbs-memoria ${cli}\n/${relative}\n`;
  let ignored = false;
  try {
    await run(await gitCommand(root), gitArgs(root, 'check-ignore', '-q', '--', relative), { env: gitEnv(), timeout: 5000 });
    ignored = true;
  } catch (error) {
    if (error.code !== 1) return null;
  }
  try {
    const { stdout } = await run(await gitCommand(root), gitArgs(root, 'rev-parse', '--git-path', 'info/exclude'), { env: gitEnv(), timeout: 5000 });
    const file = path.resolve(root, stdout.trim());
    if (!await safeParent(file) || !await safeFile(file)) return null;
    return { added: !ignored, file, block, target: relative };
  } catch { return null; }
}
async function actuallyIgnored(root, relative) {
  try {
    await run(await gitCommand(root), gitArgs(root, 'check-ignore', '-q', '--', relative),
      { env: gitEnv(), timeout: 5000 });
    return true;
  } catch { return false; }
}
async function addExclude(plan) {
  if (!plan.added) return;
  if (process.platform !== 'win32') await fs.mkdir(path.dirname(plan.file), { recursive: true, mode: 0o700 });
  const current = await readOptional(plan.file) ?? '';
  if (current.includes(plan.block)) return;
  await writeAtomic(plan.file, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${plan.block}`, false, current);
}
async function removeExclude(plan) {
  if (!plan?.added) return true;
  if (!await safeFile(plan.file)) return false;
  const current = await readOptional(plan.file);
  if (current === null || !current.includes(plan.block)) return false;
  await writeAtomic(plan.file, current.replace(plan.block, ''), false, current);
  return true;
}
const excludeLeaseFile = (plan, root, options) => path.join(stateRoot(options),
  hash(options.projectRoot ?? root), `exclude-${hash(`${plan.file}:${plan.block}`)}.json`);
async function leaseExclude(plan, root, options, remove = false, expectedVersion = null) {
  if (!plan?.file || !plan.block) return true;
  const canonical = options.projectRoot ?? root;
  const state = path.join(stateRoot(options), hash(canonical));
  const leaseFile = excludeLeaseFile(plan, root, options);
  const lock = process.platform === 'win32' ? withWindowsLock : withProjectLock;
  return lock(state, async (assertHeld = () => {}) => {
    const mutate = async operation => {
      assertHeld();
      const result = await operation();
      assertHeld();
      return result;
    };
    if (process.platform === 'win32') {
      let observed;
      try { observed = await readOptionalVersion(leaseFile, true); }
      catch { return false; }
      if (!remove) {
        if (observed || plan.added) return false;
        const lease = { file: plan.file, block: plan.block, createdByCBS: false, owners: [root] };
        try { return await mutate(() => writeAtomic(leaseFile, JSON.stringify(lease) + '\n', true, '')); }
        catch { return false; }
      }
      if (!observed) return !plan.added;
      if (!sameVersion(observed, expectedVersion)) return false;
      let lease;
      try { lease = JSON.parse(observed.text); } catch { return false; }
      if (plan.added || lease.file !== plan.file || lease.block !== plan.block ||
          lease.createdByCBS !== false || lease.releasing ||
          !Array.isArray(lease.owners) || lease.owners.length !== 1 || lease.owners[0] !== root) {
        return false;
      }
      try { await mutate(() => removeIfCurrent(leaseFile, observed, true)); }
      catch { return false; }
      return true;
    }
    let lease;
    try {
      const raw = await readOptional(leaseFile, true);
      if (raw !== null) lease = JSON.parse(raw);
    } catch { return false; }
    if (lease && (lease.file !== plan.file || lease.block !== plan.block || !Array.isArray(lease.owners))) return false;
    if (!remove) {
      const first = !lease;
      lease ??= { file: plan.file, block: plan.block, createdByCBS: plan.added, owners: [] };
      if (lease.releasing && lease.createdByCBS && !(await readOptional(plan.file))?.includes(plan.block)) {
        await mutate(() => addExclude({ ...plan, added: true }));
      }
      if (!lease.owners.includes(root)) lease.owners.push(root);
      delete lease.releasing;
      if (first && plan.added) await mutate(() => addExclude(plan));
      try { await mutate(() => writeAtomic(leaseFile, JSON.stringify(lease) + '\n')); }
      catch (error) {
        if (first && plan.added) await mutate(() => removeExclude(plan));
        throw error;
      }
      return true;
    }
    if (!lease) return !(plan.added && (await readOptional(plan.file))?.includes(plan.block));
    if (!lease.owners.includes(root)) {
      if (lease.releasing !== root) return lease.owners.length > 0;
      if (lease.owners.length) {
        delete lease.releasing;
        await mutate(() => writeAtomic(leaseFile, JSON.stringify(lease) + '\n'));
        return true;
      }
    }
    if (lease.owners.includes(root)) {
      lease.owners = lease.owners.filter(owner => owner !== root);
      if (lease.owners.length) {
        await mutate(() => writeAtomic(leaseFile, JSON.stringify(lease) + '\n'));
        return true;
      }
      if (lease.createdByCBS && !(await readOptional(plan.file))?.includes(plan.block)) return false;
      lease.releasing = root;
      await mutate(() => writeAtomic(leaseFile, JSON.stringify(lease) + '\n'));
    }
    if (lease.createdByCBS && (await readOptional(plan.file))?.includes(plan.block) &&
        !await mutate(() => removeExclude({ ...plan, added: true }))) return false;
    const currentLease = await readOptional(leaseFile, true);
    await mutate(() => removeIfCurrent(leaseFile, currentLease, true));
    return true;
  });
}
async function readOptional(file, privateState = false) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file, { privateState });
    if (result.ok) return result.text;
    if (result.code === 'missing') return null;
    throw new Error('unsafe_native_file');
  }
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readOptionalVersion(file, privateState = false) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file, { privateState });
    if (result.ok) return result;
    if (result.code === 'missing') return null;
    throw new Error('unsafe_native_file');
  }
  const text = await readOptional(file, privateState);
  return text === null ? null : { text };
}
async function removeIfCurrent(file, expectedVersion, privateState = false) {
  if (process.platform === 'win32') {
    const removed = await removeWindowsPrivateFile(file, expectedVersion, { privateState });
    if (!removed.ok) throw new Error(removed.code);
    return;
  }
  await fs.rm(file, { force: true });
}
async function writeAtomic(file, contents, privateState = true, expectedText) {
  if (process.platform === 'win32') {
    if (expectedText === undefined) throw new Error('expected_version_required');
    if (expectedText !== '') throw new Error('unsupported_windows_replace');
    const directory = await ensureWindowsPrivateDirectory(path.dirname(file), { privateState });
    if (!directory.ok) throw new Error('unsafe_native_directory');
    const existing = await readWindowsPrivateFile(file, { privateState });
    if (!existing.ok && existing.code !== 'missing') throw new Error('unsafe_native_file');
    if (existing.ok) throw new Error('unsupported_windows_replace');
    const written = await writeWindowsPrivateFile(file, contents, { privateState });
    if (!written.ok) throw new Error(written.code);
    return written;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

async function readWindowsManifest(snapshot, saved, snapshotVersion) {
  const observed = await readOptionalVersion(versionFile(snapshot), true);
  if (!observed) return { kind: 'missing' };
  let data;
  try { data = JSON.parse(observed.text); } catch { return { kind: 'invalid' }; }
  const hasCapture = saved.cli === 'codex';
  if (!/^[a-f0-9-]{36}$/.test(saved.nonce ?? '') || !data ||
      Object.keys(data).join(',') !== 'nonce,snapshot,config,capture,exclude,captureExclude' ||
      observed.text !== JSON.stringify(data) + '\n' ||
      ![data.snapshot, data.config, data.exclude,
        ...(hasCapture ? [data.capture, data.captureExclude] : [])]
        .every(value => Object.keys(value ?? {}).join(',') === 'sha256,fileId') ||
      data.nonce !== saved.nonce || !sameVersion(snapshotVersion, data.snapshot) ||
      !validVersion(data.config) || !validVersion(data.exclude) ||
      (hasCapture ? !validVersion(data.capture) || !validVersion(data.captureExclude)
        : data.capture !== null || data.captureExclude !== null)) return { kind: 'invalid' };
  return { kind: 'valid', data, observed };
}

function claudeEdit(raw, prior) {
  let settings;
  try { settings = raw === null ? {} : JSON.parse(raw); } catch { return null; }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') return null;
  if (settings.enabledPlugins !== undefined &&
      (!settings.enabledPlugins || Array.isArray(settings.enabledPlugins) || typeof settings.enabledPlugins !== 'object')) return null;
  const enabled = { ...settings.enabledPlugins };
  const key = plugins.claude;
  if (prior === undefined) {
    const had = Object.hasOwn(enabled, key);
    const previous = had ? enabled[key] : null;
    enabled[key] = false;
    return { raw: JSON.stringify({ ...settings, enabledPlugins: enabled }, null, 2) + '\n', had, previous };
  }
  if (enabled[key] !== false) return null;
  if (prior.had) enabled[key] = prior.previous; else delete enabled[key];
  if (!prior.had && !Object.keys(enabled).length && !prior.hadEnabledPlugins) delete settings.enabledPlugins;
  else settings.enabledPlugins = enabled;
  return { raw: JSON.stringify(settings, null, 2) + '\n' };
}

const section = '[plugins."claude-mem@claude-mem-local"]';
function codexEdit(raw, prior) {
  const text = raw ?? '';
  const lines = text.split('\n');
  const matches = lines.flatMap((line, index) => line.trim() === section ? [index] : []);
  if (matches.length > 1 || (!matches.length && text.includes('claude-mem@claude-mem-local'))) return null;
  const start = matches[0];
  const end = start === undefined ? undefined : lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const limit = end === -1 ? lines.length : end;
  const keyLines = start === undefined ? [] : lines.flatMap((line, index) =>
    index > start && index < limit && /^\s*enabled\s*=/.test(line) ? [index] : []);
  if (keyLines.length > 1) return null;
  const old = keyLines.length ? lines[keyLines[0]] : null;
  if (old && !/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.test(old)) return null;
  if (prior === undefined) {
    if (start === undefined) return { raw: `${text.trimEnd()}\n\n${section}\nenabled = false\n`, hadSection: false, old: null };
    if (old) lines[keyLines[0]] = 'enabled = false'; else lines.splice(start + 1, 0, 'enabled = false');
    return { raw: lines.join('\n'), hadSection: true, old };
  }
  if (old?.trim() !== 'enabled = false') return null;
  if (!prior.hadSection) {
    if (start === undefined || lines.slice(start + 1, limit).filter(Boolean).length !== 1) return null;
    return { raw: [...lines.slice(0, start), ...lines.slice(limit)].join('\n').replace(/\n{3,}/g, '\n\n') };
  }
  if (prior.old === null) lines.splice(keyLines[0], 1); else lines[keyLines[0]] = prior.old;
  return { raw: lines.join('\n') };
}

async function supportedCodex(root, options, allowDisabled = false) {
  if (process.platform === 'win32') {
    const probe = await probeWindowsCodexPlugin(root, path.resolve(path.dirname(captureScript), '..', '..'));
    return probe.ok && probe.installed === true;
  }
  if (options.installedPlugin === true) return true;
  try {
    const { stdout } = await run('codex', ['plugin', 'list', '--marketplace', 'claude-mem-local', '--json'],
      { cwd: root, timeout: 5000 });
    const listed = JSON.parse(stdout);
    if (!Array.isArray(listed?.installed)) return false;
    const matching = listed.installed.filter(row => row?.pluginId === plugins.codex);
    if (matching.length !== 1) return false;
    const plugin = matching[0];
    return plugin.name === 'claude-mem' && plugin.marketplaceName === 'claude-mem-local' &&
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(plugin.version) &&
      plugin.installed === true && (plugin.enabled === true || (allowDisabled && plugin.enabled === false)) &&
      plugin.installPolicy === 'AVAILABLE' && plugin.source?.source === 'local' &&
      plugin.marketplaceSource?.sourceType === 'local';
  } catch { return false; }
}

export async function applyNativeExclusion(root, options = {}) {
  const { cli } = options;
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
  if (!plugins[cli]) return blocked('unsupported_cli');
  const scope = await identifyProject(root);
  if (process.platform === 'win32') {
    const actual = await canonicalWindowsPath(root).catch(() => null);
    const expected = options.projectRoot ? await canonicalWindowsPath(options.projectRoot).catch(() => null) : actual;
    if (scope.kind !== 'git' || !actual || !expected || scope.projectRoot !== expected ||
        scope.activeRoot !== actual) return blocked('unsupported_git');
    try {
      for (const commandPath of [process.execPath, captureScript]) {
        const key = windowsPathKey(commandPath);
        if (key !== windowsPathKey(await fs.realpath(commandPath)) ||
            key === actual || key.startsWith(actual + '\\')) return blocked('unsafe_hook_command');
      }
    } catch { return blocked('unsafe_hook_command'); }
    root = actual;
    options = { ...options, projectRoot: scope.projectRoot };
  } else if (scope.kind !== 'git' || scope.projectRoot !== (options.projectRoot ?? await fs.realpath(root).catch(() => null)) ||
      scope.activeRoot !== await fs.realpath(root).catch(() => null)) return blocked('unsupported_git');
  if (process.platform === 'win32') {
    try {
      await inspectWindowsCaptureSources({ cli, root, projectRoot: scope.projectRoot,
        profile: options.profile ?? (cli === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) });
      windowsSessionHooks(cli);
      return { kind: 'applied', existing: false, source: 'session' };
    } catch (error) { return blocked(error.message); }
  }
  const file = configFile(root, cli);
  if (!await safeParent(file) || !await safeFile(file)) return blocked('unsafe_native_config');
  if (await tracked(root, file)) return blocked('tracked_native_config');
  const snapshot = snapshotFile(root, cli, options);
  if (!await safeParent(snapshot, true) || !await safeFile(snapshot, true)) return blocked('unsafe_snapshot');
  const versionsPath = versionFile(snapshot);
  if (process.platform === 'win32' && !await safeFile(versionsPath, true)) return blocked('unsafe_snapshot');
  const priorSnapshot = await readOptional(snapshot, true);
  if (cli === 'codex' && !await supportedCodex(root, options, priorSnapshot !== null)) return blocked('unsupported_plugin');
  if (priorSnapshot !== null) {
    let saved;
    try { saved = JSON.parse(priorSnapshot); } catch { return blocked('unsafe_snapshot'); }
    const raw = await readOptional(file);
    if (saved.cli !== cli || saved.file !== file || (saved.nativeRoot && saved.nativeRoot !== root) ||
        (saved.projectRoot && saved.projectRoot !== scope.projectRoot) || raw === null ||
        !(cli === 'claude' ? claudeEdit(raw, saved) : codexEdit(raw, saved))) {
      return blocked('native_config_changed');
    }
    const verification = await verifyNativeCapture(root, { ...options, projectRoot: scope.projectRoot });
    return verification.kind === 'verified' ? { kind: 'applied', existing: true } : blocked(verification.reason);
  }
  if (process.platform === 'win32' && await readOptional(versionsPath, true) !== null) {
    return blocked('native_recovery_required');
  }
  const raw = await readOptional(file);
  const edit = (cli === 'claude' ? claudeEdit : codexEdit)(raw);
  if (!edit) return blocked('invalid_native_config');
  const capturePath = cli === 'claude' ? file : hookFile(root);
  if (!await safeParent(capturePath) || !await safeFile(capturePath) ||
      (cli === 'codex' && await tracked(root, capturePath))) return blocked('unsafe_capture_hooks');
  const captureRaw = cli === 'claude' ? edit.raw : await readOptional(capturePath);
  const captureEdit = editCaptureHooks(captureRaw, cli);
  if (!captureEdit) return blocked('invalid_capture_hooks');
  const exclude = await excludePlan(root, cli);
  const captureExclude = cli === 'codex' ? await excludePlan(root, cli, capturePath) : { added: false };
  if (!exclude || !captureExclude) return blocked('unsafe_git_exclude');
  if (process.platform === 'win32' && (raw !== null ||
      (cli === 'codex' && captureRaw !== null) || exclude.added || captureExclude.added)) {
    return blocked('unsupported_windows_replace');
  }
  const save = { cli, file, projectRoot: scope.projectRoot, nativeRoot: root, leased: true,
    existed: raw !== null, had: edit.had, previous: edit.previous,
    hadEnabledPlugins: cli === 'claude' && raw !== null && Object.hasOwn(JSON.parse(raw), 'enabledPlugins'),
    hadSection: edit.hadSection, old: edit.old, exclude,
    capturePath, captureExisted: cli === 'codex' && captureRaw !== null, captureExclude,
    pluginChecked: cli === 'codex' };
  if (process.platform === 'win32') {
    save.rollback = { config: null, capture: null };
    save.nonce = randomUUID();
  }
  const snapshotText = JSON.stringify(save) + '\n';
  let snapshotVersion;
  try { snapshotVersion = await writeAtomic(snapshot, snapshotText, true, ''); }
  catch (error) {
    if (process.platform === 'win32') return blocked(error.message === 'unsupported_windows_replace'
      ? 'native_snapshot_changed' : 'unsafe_snapshot');
    throw error;
  }
  let leasedExclude = false;
  let leasedCapture = false;
  let configVersion;
  let captureVersion;
  let manifestVersion;
  try {
    configVersion = await writeAtomic(file, cli === 'claude' ? captureEdit : edit.raw, false, raw ?? '');
    if (cli === 'codex') captureVersion = await writeAtomic(capturePath, captureEdit, false, captureRaw ?? '');
    leasedExclude = await leaseExclude(exclude, root, { ...options, projectRoot: scope.projectRoot });
    if (!leasedExclude) throw new Error('exclude_lease_failed');
    leasedCapture = await leaseExclude(captureExclude, root, { ...options, projectRoot: scope.projectRoot });
    if (!leasedCapture) throw new Error('exclude_lease_failed');
    if (process.platform === 'win32' && (!await actuallyIgnored(root, exclude.target) ||
        (cli === 'codex' && !await actuallyIgnored(root, captureExclude.target)))) {
      throw new Error('git_exclude_unverified');
    }
    if (process.platform === 'win32') {
      const manifest = { nonce: save.nonce, snapshot: fileVersion(snapshotVersion),
        config: fileVersion(configVersion), capture: cli === 'codex' ? fileVersion(captureVersion) : null,
        exclude: fileVersion(leasedExclude),
        captureExclude: cli === 'codex' ? fileVersion(leasedCapture) : null };
      if (!manifest.snapshot || !manifest.config || !manifest.exclude ||
          (cli === 'codex' && (!manifest.capture || !manifest.captureExclude))) {
        throw new Error('native_version_missing');
      }
      manifestVersion = await writeAtomic(versionsPath, JSON.stringify(manifest) + '\n', true, '');
      if (!sameVersion(await readOptionalVersion(snapshot, true), snapshotVersion)) {
        throw new Error('native_snapshot_changed');
      }
    }
  }

  catch (error) {
    try {
      const current = await readOptional(file);
      const installed = cli === 'claude' ? captureEdit : edit.raw;
      const currentCapture = cli === 'codex' ? await readOptional(capturePath) : null;
      if ((current !== raw && current !== installed) ||
          (cli === 'codex' && currentCapture !== captureRaw && currentCapture !== captureEdit)) {
        return blocked('native_rollback_failed');
      }
      const captureReleased = !leasedCapture || await leaseExclude(captureExclude, root,
        { ...options, projectRoot: scope.projectRoot }, true, fileVersion(leasedCapture)).catch(() => false);
      const excludeReleased = !leasedExclude || await leaseExclude(exclude, root,
        { ...options, projectRoot: scope.projectRoot }, true, fileVersion(leasedExclude)).catch(() => false);
      if (!captureReleased || !excludeReleased) return blocked('native_rollback_failed');
      if (current !== raw) {
        if (raw === null) await removeIfCurrent(file, process.platform === 'win32' ? configVersion : installed);
        else await writeAtomic(file, raw, false, installed);
      }
      if (cli === 'codex' && currentCapture !== captureRaw) {
        if (captureRaw === null) await removeIfCurrent(capturePath,
          process.platform === 'win32' ? captureVersion : captureEdit);
        else await writeAtomic(capturePath, captureRaw, false, captureEdit);
      }
      if (manifestVersion) await removeIfCurrent(versionsPath, manifestVersion, true);
      await removeIfCurrent(snapshot, process.platform === 'win32' ? snapshotVersion : snapshotText, true);
      return blocked('native_write_failed');
    } catch { return blocked('native_rollback_failed'); }
  }
  return { kind: 'applied' };
}

export async function restoreNativeExclusion(root, options = {}) {
  const { cli } = options;
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
  if (!plugins[cli]) return blocked('unsupported_cli');
  if (process.platform === 'win32') {
    const scope = await identifyProject(root);
    const actual = await canonicalWindowsPath(root).catch(() => null);
    const expected = options.projectRoot ? await canonicalWindowsPath(options.projectRoot).catch(() => null) : scope.projectRoot;
    if (scope.kind !== 'git' || !actual || !expected || scope.activeRoot !== actual ||
        scope.projectRoot !== expected) return blocked('unsupported_git');
    root = actual;
    options = { ...options, projectRoot: scope.projectRoot };
  }
  const snapshot = snapshotFile(root, cli, options);
  let saved;
  let savedVersion;
  if (!await safeFile(snapshot, true)) return blocked('unsafe_snapshot');
  try {
    savedVersion = await readOptionalVersion(snapshot, true);
    saved = JSON.parse(savedVersion?.text);
  }
  catch { return blocked('missing_snapshot'); }
  // A later call cannot prove the original .versions file ID or which missing-sidecar phase occurred.
  // Retain every Windows artifact for manual recovery until an independent ownership receipt exists.
  if (process.platform === 'win32') return blocked('native_recovery_required');
  if (process.platform === 'win32' && !saved.rollback) return blocked('unsupported_windows_replace');
  let manifest;
  if (process.platform === 'win32') {
    if (saved.leased !== true || !saved.exclude?.file || !saved.exclude?.block ||
        (cli === 'codex' && (!saved.captureExclude?.file || !saved.captureExclude?.block)) ||
        saved.existed || saved.captureExisted || saved.exclude?.added ||
        saved.captureExclude?.added || saved.rollback.config !== null ||
        saved.rollback.capture !== null) return blocked('unsupported_windows_replace');
    try { manifest = await readWindowsManifest(snapshot, saved, savedVersion); }
    catch { return blocked('native_recovery_required'); }
    if (manifest.kind === 'invalid') return blocked('native_recovery_required');
  }
  const file = configFile(root, cli);
  const scope = await identifyProject(root);
  if (scope.kind !== 'git' || scope.projectRoot !== (options.projectRoot ?? scope.projectRoot) ||
      (saved.projectRoot && saved.projectRoot !== scope.projectRoot) ||
      (saved.nativeRoot && saved.nativeRoot !== root) ||
      saved.cli !== cli || saved.file !== file || !await safeFile(file) || await tracked(root, file)) return blocked('unsafe_native_config');
  const hasCapture = Object.hasOwn(saved, 'capturePath');
  const capturePath = saved.capturePath;
  if (hasCapture && (capturePath !== (cli === 'claude' ? file : hookFile(root)) ||
      !await safeFile(capturePath))) return blocked('unsafe_capture_hooks');
  const rawVersion = await readOptionalVersion(file);
  const raw = rawVersion?.text ?? null;
  const captureVersion = hasCapture ? await readOptionalVersion(capturePath) : null;
  const captureRaw = captureVersion?.text ?? null;
  if (process.platform === 'win32') {
    const leaseVersions = [];
    try {
      for (const plan of [saved.exclude, saved.captureExclude]) {
        leaseVersions.push(plan?.file && plan?.block
          ? await readOptionalVersion(excludeLeaseFile(plan, root, options), true) : null);
      }
    } catch { return blocked('native_recovery_required'); }
    if (manifest.kind === 'missing') {
      if (rawVersion || (cli === 'codex' && captureVersion) || leaseVersions.some(Boolean)) {
        return blocked('native_recovery_required');
      }
      try { await removeIfCurrent(snapshot, savedVersion, true); }
      catch { return blocked('native_snapshot_changed'); }
      return { kind: 'restored' };
    }
    if ((rawVersion && !sameVersion(rawVersion, manifest.data.config)) ||
        (cli === 'codex' && captureVersion && !sameVersion(captureVersion, manifest.data.capture)) ||
        (leaseVersions[0] && !sameVersion(leaseVersions[0], manifest.data.exclude)) ||
        (cli === 'codex' && leaseVersions[1] &&
          !sameVersion(leaseVersions[1], manifest.data.captureExclude))) {
      return blocked('native_config_changed');
    }
  }
  let plan = saved.rollback;
  if (!plan) {
    if (raw === null) return blocked('native_config_changed');
    const edit = (cli === 'claude' ? claudeEdit : codexEdit)(raw, saved);
    if (!edit) return blocked('native_config_changed');
    const captureEdit = hasCapture ? editCaptureHooks(cli === 'claude' ? edit.raw : captureRaw, cli, true) : edit.raw;
    if (!captureEdit || (hasCapture && cli === 'codex' && captureRaw === null)) return blocked('capture_hooks_changed');
    const configText = cli === 'claude' ? captureEdit : edit.raw;
    plan = { config: !saved.existed && (cli === 'claude' ? Object.keys(JSON.parse(configText)).length === 0 :
      !configText.trim()) ? null : configText,
    capture: cli === 'codex' && hasCapture ?
      !saved.captureExisted && Object.keys(JSON.parse(captureEdit)).length === 0 ? null : captureEdit : null };
  } else if (!Object.hasOwn(plan, 'config') || !Object.hasOwn(plan, 'capture') ||
      ![plan.config, plan.capture].every(value => value === null || typeof value === 'string')) {
    return blocked('unsafe_snapshot');
  }
  if (raw !== plan.config) {
    if (raw === null) return blocked('native_config_changed');
    const edit = (cli === 'claude' ? claudeEdit : codexEdit)(raw, saved);
    const restored = edit && (cli === 'claude' ? editCaptureHooks(edit.raw, cli, true) : edit.raw);
    if (!restored) return blocked('native_config_changed');
    const target = !saved.existed && (cli === 'claude' ? Object.keys(JSON.parse(restored)).length === 0 :
      !restored.trim()) ? null : restored;
    if (plan.config !== target) return blocked('native_config_changed');
  }
  if (cli === 'codex' && hasCapture && captureRaw !== plan.capture) {
    const restored = captureRaw && editCaptureHooks(captureRaw, cli, true);
    if (!restored) return blocked('capture_hooks_changed');
    const target = !saved.captureExisted && Object.keys(JSON.parse(restored)).length === 0 ? null : restored;
    if (plan.capture !== target) return blocked('capture_hooks_changed');
  }
  if (!saved.rollback && saved.exclude?.added && !(await readOptional(saved.exclude.file))?.includes(saved.exclude.block)) {
    return blocked('git_exclude_changed');
  }
  if (!saved.rollback && saved.captureExclude?.added && !(await readOptional(saved.captureExclude.file))?.includes(saved.captureExclude.block)) {
    return blocked('git_exclude_changed');
  }
  if (process.platform === 'win32' &&
      ((raw !== plan.config && plan.config !== null) ||
       (cli === 'codex' && hasCapture && captureRaw !== plan.capture && plan.capture !== null))) {
    return blocked('unsupported_windows_replace');
  }
  try {
    if (!saved.rollback) await writeAtomic(snapshot, JSON.stringify({ ...saved, rollback: plan }) + '\n');
    if (raw !== plan.config) {
      if (plan.config === null) await removeIfCurrent(file,
        process.platform === 'win32' ? rawVersion : raw);
      else await writeAtomic(file, plan.config, false, raw ?? '');
    }
    if (cli === 'codex' && hasCapture && captureRaw !== plan.capture) {
      if (plan.capture === null) await removeIfCurrent(capturePath,
        process.platform === 'win32' ? captureVersion : captureRaw);
      else await writeAtomic(capturePath, plan.capture, false, captureRaw ?? '');
    }
    if (saved.leased) {
      if (!await leaseExclude(saved.exclude, root, { ...options, projectRoot: scope.projectRoot },
        true, manifest?.data.exclude) ||
          !await leaseExclude(saved.captureExclude, root, { ...options, projectRoot: scope.projectRoot },
            true, manifest?.data.captureExclude)) {
        return blocked('git_exclude_changed');
      }
    } else {
      if (!await removeExclude(saved.exclude) || !await removeExclude(saved.captureExclude)) {
        return blocked('git_exclude_changed');
      }
    }
  } catch (error) {
    return blocked(process.platform === 'win32' && error.message === 'changed'
      ? 'native_config_changed' : 'git_exclude_changed');
  }
  if (process.platform === 'win32') {
    try { await removeIfCurrent(versionFile(snapshot), manifest.observed, true); }
    catch { return blocked('native_snapshot_changed'); }
  }
  try { await removeIfCurrent(snapshot, process.platform === 'win32'
    ? savedVersion : await readOptional(snapshot, true), true); }
  catch { return blocked('native_snapshot_changed'); }
  return { kind: 'restored' };
}

export async function verifyNativeCapture(root, options = {}) {
  const { cli } = options;
  if (!captureEvents[cli] || (process.platform !== 'win32' && !process.getuid)) return blocked('native_windows_unproved');
  const scope = await identifyProject(root);
  if (process.platform === 'win32') {
    const actual = await canonicalWindowsPath(root).catch(() => null);
    const expected = options.projectRoot ? await canonicalWindowsPath(options.projectRoot).catch(() => null) : scope.projectRoot;
    if (scope.kind !== 'git' || !actual || !expected || scope.projectRoot !== expected ||
        scope.activeRoot !== actual) return blocked('unsupported_git');
    root = actual;
    options = { ...options, projectRoot: scope.projectRoot };
  } else if (root !== await fs.realpath(root).catch(() => null) || scope.kind !== 'git' ||
      scope.projectRoot !== (options.projectRoot ?? scope.projectRoot) || scope.activeRoot !== root) return blocked('unsupported_git');
  if (process.platform === 'win32') {
    try {
      const profile = options.profile ?? (cli === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR);
      await inspectWindowsCaptureSources({ cli, root, projectRoot: scope.projectRoot, profile });
      if (options.launchToken) {
        const launch = await verifyWindowsLaunchOverlay({ stateRoot: options.stateRoot,
          token: options.launchToken, cli, nativeRoot: root, projectRoot: scope.projectRoot });
        if (windowsPathKey(launch.profile) !== windowsPathKey(profile)) return blocked('capture_profile_changed');
      }
      return { kind: 'verified', source: 'session', hooks: windowsSessionHooks(cli) };
    } catch (error) { return blocked(error.message); }
  }
  const file = configFile(root, cli);
  const capturePath = cli === 'claude' ? file : hookFile(root);
  if (!await safeFile(file) || !await safeFile(capturePath) || await tracked(root, file) ||
      (cli === 'codex' && await tracked(root, capturePath))) return blocked('unsafe_native_config');
  let saved;
  const snapshot = snapshotFile(root, cli, options);
  let snapshotVersion;
  try {
    if (process.platform === 'win32') {
      snapshotVersion = await readOptionalVersion(snapshot, true);
      saved = JSON.parse(snapshotVersion?.text);
    } else saved = JSON.parse(await readOptional(snapshot, true));
  }
  catch { return blocked('missing_native_snapshot'); }
  if (!saved || saved.cli !== cli || saved.file !== file || saved.capturePath !== capturePath ||
      (saved.projectRoot && saved.projectRoot !== scope.projectRoot) ||
      (saved.nativeRoot && saved.nativeRoot !== root) ||
      (cli === 'codex' && saved.pluginChecked !== true)) return blocked('native_snapshot_changed');
  if (process.platform === 'win32' && (!await actuallyIgnored(root, windowsGitPattern(root, file).slice(1)) ||
      (cli === 'codex' && !await actuallyIgnored(root, windowsGitPattern(root, capturePath).slice(1))))) {
    return blocked('git_exclude_unverified');
  }
  let manifest;
  if (process.platform === 'win32') {
    try { manifest = await readWindowsManifest(snapshot, saved, snapshotVersion); }
    catch { return blocked('native_recovery_required'); }
    if (manifest.kind !== 'valid') return blocked('native_recovery_required');
  }
  const rawVersion = process.platform === 'win32' ? await readOptionalVersion(file) : null;
  const captureVersion = process.platform === 'win32' && cli === 'codex'
    ? await readOptionalVersion(capturePath) : null;
  const raw = process.platform === 'win32' ? rawVersion?.text : await readOptional(file);
  const captureRaw = process.platform === 'win32' ?
    (cli === 'claude' ? raw : captureVersion?.text) : await readOptional(capturePath);
  if (process.platform === 'win32' && (!sameVersion(rawVersion, manifest.data.config) ||
      (cli === 'codex' && !sameVersion(captureVersion, manifest.data.capture)))) {
    return blocked('native_config_changed');
  }
  if (process.platform === 'win32') {
    const excludeLease = await readOptionalVersion(excludeLeaseFile(saved.exclude, root, options), true);
    const captureLease = cli === 'codex'
      ? await readOptionalVersion(excludeLeaseFile(saved.captureExclude, root, options), true) : null;
    if (!sameVersion(excludeLease, manifest.data.exclude) ||
        (cli === 'codex' && !sameVersion(captureLease, manifest.data.captureExclude))) {
      return blocked('git_exclude_changed');
    }
  }
  if (!raw || !captureRaw || !(cli === 'claude' ? claudeEdit(raw, saved) : codexEdit(raw, saved))) {
    return blocked('native_config_changed');
  }
  let hooks;
  try { hooks = JSON.parse(captureRaw).hooks; } catch { return blocked('capture_hooks_changed'); }
  if (!captureEvents[cli].every(event => hooks?.[event]?.some(group =>
    group?.hooks?.some(h => h?.command === captureCommand(cli, event))))) return blocked('capture_hooks_changed');
  if (cli === 'codex' && options.includeLaunchHooks) {
    // Only CBS definitions may be copied to argv. Unknown hooks in this otherwise
    // undiscovered linked-worktree file require a separate merge decision.
    const exact = exactCodexHooks(hooks);
    if (exact?.kind !== 'exact') return blocked('unmerged_capture_hooks');
    return { kind: 'verified', hooks: exact.hooks };
  }
  return { kind: 'verified' };
}

export async function inspectCodexMainHooks(root, options = {}) {
  if (process.platform === 'win32') {
    try {
      await inspectWindowsCaptureSources({ cli: 'codex', root,
        projectRoot: options.projectRoot ?? root,
        profile: options.profile ?? process.env.CODEX_HOME });
      return { kind: 'absent' };
    } catch (error) { return blocked(error.message); }
  }
  const file = hookFile(root);
  const snapshot = snapshotFile(root, 'codex', { ...options, projectRoot: root });
  if (!await safeParent(file) || !await safeFile(file) || !await safeFile(snapshot, true)) {
    return blocked('unsafe_main_hooks');
  }
  let raw, saved;
  try {
    raw = await readOptional(file);
    saved = await readOptional(snapshot, true);
  } catch { return blocked('unsafe_main_hooks'); }
  if (raw === null) return saved === null ? { kind: 'absent' } : blocked('stale_main_hooks');
  let hooks;
  try { hooks = JSON.parse(raw).hooks ?? {}; } catch { return blocked('ambiguous_main_hooks'); }
  const exact = exactCodexHooks(hooks, true);
  if (!exact) return blocked('ambiguous_main_hooks');
  if (exact.kind === 'absent') return saved === null ? { kind: 'absent' } : blocked('stale_main_hooks');
  if (saved === null) return blocked('stale_main_hooks');
  const verified = await verifyNativeCapture(root, { ...options, cli: 'codex', projectRoot: root });
  if (verified.kind !== 'verified') return blocked(verified.reason);
  return { kind: 'verified', fingerprint: hash(raw) };
}
