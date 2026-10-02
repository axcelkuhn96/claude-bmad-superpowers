import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { identifyProject } from './project-id.mjs';
import { withProjectLock } from './ledger.mjs';

const run = promisify(execFile);
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const plugins = { claude: 'claude-mem@thedotmack', codex: 'claude-mem@claude-mem-local' };
const blocked = (reason) => ({ kind: 'blocked', reason });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stateRoot = (options) => options.stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const snapshotFile = (root, cli, options) => path.join(stateRoot(options), hash(options.projectRoot ?? root),
  (options.projectRoot && options.projectRoot !== root ? `native-${cli}-${hash(root)}.json` : `native-${cli}.json`));
const configFile = (root, cli) => path.join(root, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
const captureEvents = { claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd'],
  codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] };
const captureScript = fileURLToPath(new URL('./capture-hook.mjs', import.meta.url));
const hookFile = root => path.join(root, '.codex', 'hooks.json');
function captureCommand(cli, event) {
  if ([process.execPath, captureScript].some(value => /[$`"\r\n]/.test(value))) return null;
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

async function safeFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && (!process.getuid || stat.uid === process.getuid());
  } catch (error) { return error.code === 'ENOENT'; }
}
async function safeParent(file) {
  try {
    const stat = await fs.lstat(path.dirname(file));
    return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid());
  } catch (error) { return error.code === 'ENOENT'; }
}
async function tracked(root, file) {
  const relative = path.relative(root, file);
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files', '--cached', '--', relative], { env: gitEnv(), timeout: 5000 });
    return !!stdout.trim();
  } catch { return true; }
}
async function excludePlan(root, cli, target = configFile(root, cli)) {
  const relative = path.relative(root, target);
  const block = `# cbs-memoria ${cli}\n/${relative}\n`;
  let ignored = false;
  try {
    await run('git', ['-C', root, 'check-ignore', '-q', '--', relative], { env: gitEnv(), timeout: 5000 });
    ignored = true;
  } catch (error) {
    if (error.code !== 1) return null;
  }
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { env: gitEnv(), timeout: 5000 });
    const file = path.resolve(root, stdout.trim());
    if (!await safeParent(file) || !await safeFile(file)) return null;
    return { added: !ignored, file, block };
  } catch { return null; }
}
async function addExclude(plan) {
  if (!plan.added) return;
  await fs.mkdir(path.dirname(plan.file), { recursive: true, mode: 0o700 });
  const current = await readOptional(plan.file) ?? '';
  if (current.includes(plan.block)) return;
  await writeAtomic(plan.file, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${plan.block}`);
}
async function removeExclude(plan) {
  if (!plan?.added) return true;
  if (!await safeFile(plan.file)) return false;
  const current = await readOptional(plan.file);
  if (current === null || !current.includes(plan.block)) return false;
  await writeAtomic(plan.file, current.replace(plan.block, ''));
  return true;
}
async function leaseExclude(plan, root, options, remove = false) {
  if (!plan?.file || !plan.block) return true;
  const canonical = options.projectRoot ?? root;
  const state = path.join(stateRoot(options), hash(canonical));
  const leaseFile = path.join(state, `exclude-${hash(`${plan.file}:${plan.block}`)}.json`);
  return withProjectLock(state, async () => {
    let lease;
    try { lease = JSON.parse(await fs.readFile(leaseFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    if (lease && (lease.file !== plan.file || lease.block !== plan.block || !Array.isArray(lease.owners))) return false;
    if (!remove) {
      const first = !lease;
      lease ??= { file: plan.file, block: plan.block, createdByCBS: plan.added, owners: [] };
      if (lease.releasing && lease.createdByCBS && !(await readOptional(plan.file))?.includes(plan.block)) {
        await addExclude({ ...plan, added: true });
      }
      if (!lease.owners.includes(root)) lease.owners.push(root);
      delete lease.releasing;
      if (first && plan.added) await addExclude(plan);
      try { await writeAtomic(leaseFile, JSON.stringify(lease) + '\n'); }
      catch (error) {
        if (first && plan.added) await removeExclude(plan);
        throw error;
      }
      return true;
    }
    if (!lease) return !(plan.added && (await readOptional(plan.file))?.includes(plan.block));
    if (!lease.owners.includes(root)) {
      if (lease.releasing !== root) return lease.owners.length > 0;
      if (lease.owners.length) {
        delete lease.releasing;
        await writeAtomic(leaseFile, JSON.stringify(lease) + '\n');
        return true;
      }
    }
    if (lease.owners.includes(root)) {
      lease.owners = lease.owners.filter(owner => owner !== root);
      if (lease.owners.length) { await writeAtomic(leaseFile, JSON.stringify(lease) + '\n'); return true; }
      if (lease.createdByCBS && !(await readOptional(plan.file))?.includes(plan.block)) return false;
      lease.releasing = root;
      await writeAtomic(leaseFile, JSON.stringify(lease) + '\n');
    }
    if (lease.createdByCBS && (await readOptional(plan.file))?.includes(plan.block) &&
        !await removeExclude({ ...plan, added: true })) return false;
    await fs.rm(leaseFile);
    return true;
  });
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeAtomic(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) { await fs.rm(temp, { force: true }); throw error; }
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

async function supportedCodex(root, options) {
  if (options.installedPlugin === true) return true;
  try {
    const { stdout } = await run('codex', ['plugin', 'list'], { cwd: root, timeout: 5000 });
    return stdout.split('\n').some((line) => line.includes(plugins.codex) &&
      /installed/.test(line) && !/workspace.managed/i.test(line));
  } catch { return false; }
}

export async function applyNativeExclusion(root, options = {}) {
  const { cli } = options;
  if (process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  if (!plugins[cli]) return blocked('unsupported_cli');
  const scope = await identifyProject(root);
  if (scope.kind !== 'git' || scope.projectRoot !== (options.projectRoot ?? await fs.realpath(root).catch(() => null)) ||
      scope.activeRoot !== await fs.realpath(root).catch(() => null)) return blocked('unsupported_git');
  if (cli === 'codex' && !await supportedCodex(root, options)) return blocked('unsupported_plugin');
  const file = configFile(root, cli);
  if (!await safeParent(file) || !await safeFile(file)) return blocked('unsafe_native_config');
  if (await tracked(root, file)) return blocked('tracked_native_config');
  const snapshot = snapshotFile(root, cli, options);
  if (!await safeParent(snapshot) || !await safeFile(snapshot)) return blocked('unsafe_snapshot');
  const priorSnapshot = await readOptional(snapshot);
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
  const save = { cli, file, projectRoot: scope.projectRoot, nativeRoot: root, leased: true,
    existed: raw !== null, had: edit.had, previous: edit.previous,
    hadEnabledPlugins: cli === 'claude' && raw !== null && Object.hasOwn(JSON.parse(raw), 'enabledPlugins'),
    hadSection: edit.hadSection, old: edit.old, exclude,
    capturePath, captureExisted: cli === 'codex' && captureRaw !== null, captureExclude,
    pluginChecked: cli === 'codex' };
  await writeAtomic(snapshot, JSON.stringify(save) + '\n');
  let leasedExclude = false;
  let leasedCapture = false;
  try {
    await writeAtomic(file, cli === 'claude' ? captureEdit : edit.raw);
    if (cli === 'codex') await writeAtomic(capturePath, captureEdit);
    leasedExclude = await leaseExclude(exclude, root, { ...options, projectRoot: scope.projectRoot });
    if (!leasedExclude) throw new Error('exclude_lease_failed');
    leasedCapture = await leaseExclude(captureExclude, root, { ...options, projectRoot: scope.projectRoot });
    if (!leasedCapture) throw new Error('exclude_lease_failed');
  }
  catch (error) {
    const captureReleased = !leasedCapture || await leaseExclude(captureExclude, root,
      { ...options, projectRoot: scope.projectRoot }, true).catch(() => false);
    const excludeReleased = !leasedExclude || await leaseExclude(exclude, root,
      { ...options, projectRoot: scope.projectRoot }, true).catch(() => false);
    if (!captureReleased || !excludeReleased) return blocked('native_rollback_failed');
    if (raw === null) await fs.rm(file, { force: true }); else await writeAtomic(file, raw);
    if (cli === 'codex') {
      if (captureRaw === null) await fs.rm(capturePath, { force: true });
      else await writeAtomic(capturePath, captureRaw);
    }
    await fs.rm(snapshot, { force: true });
    return blocked('native_write_failed');
  }
  return { kind: 'applied' };
}

export async function restoreNativeExclusion(root, options = {}) {
  const { cli } = options;
  if (process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  if (!plugins[cli]) return blocked('unsupported_cli');
  const snapshot = snapshotFile(root, cli, options);
  let saved;
  if (!await safeFile(snapshot)) return blocked('unsafe_snapshot');
  try { saved = JSON.parse(await fs.readFile(snapshot, 'utf8')); }
  catch { return blocked('missing_snapshot'); }
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
  const raw = await readOptional(file);
  const captureRaw = hasCapture ? await readOptional(capturePath) : null;
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
  try {
    if (!saved.rollback) await writeAtomic(snapshot, JSON.stringify({ ...saved, rollback: plan }) + '\n');
    if (raw !== plan.config) {
      if (plan.config === null) await fs.rm(file, { force: true });
      else await writeAtomic(file, plan.config);
    }
    if (cli === 'codex' && hasCapture && captureRaw !== plan.capture) {
      if (plan.capture === null) await fs.rm(capturePath, { force: true });
      else await writeAtomic(capturePath, plan.capture);
    }
    if (saved.leased) {
      if (!await leaseExclude(saved.exclude, root, { ...options, projectRoot: scope.projectRoot }, true) ||
          !await leaseExclude(saved.captureExclude, root, { ...options, projectRoot: scope.projectRoot }, true)) {
        return blocked('git_exclude_changed');
      }
    } else {
      if (!await removeExclude(saved.exclude) || !await removeExclude(saved.captureExclude)) {
        return blocked('git_exclude_changed');
      }
    }
  } catch { return blocked('git_exclude_changed'); }
  await fs.rm(snapshot);
  return { kind: 'restored' };
}

export async function verifyNativeCapture(root, options = {}) {
  const { cli } = options;
  if (!captureEvents[cli] || process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  const scope = await identifyProject(root);
  if (root !== await fs.realpath(root).catch(() => null) || scope.kind !== 'git' ||
      scope.projectRoot !== (options.projectRoot ?? scope.projectRoot) || scope.activeRoot !== root) return blocked('unsupported_git');
  const file = configFile(root, cli);
  const capturePath = cli === 'claude' ? file : hookFile(root);
  if (!await safeFile(file) || !await safeFile(capturePath) || await tracked(root, file) ||
      (cli === 'codex' && await tracked(root, capturePath))) return blocked('unsafe_native_config');
  let saved;
  try { saved = JSON.parse(await fs.readFile(snapshotFile(root, cli, options), 'utf8')); }
  catch { return blocked('missing_native_snapshot'); }
  if (saved.cli !== cli || saved.file !== file || saved.capturePath !== capturePath ||
      (saved.projectRoot && saved.projectRoot !== scope.projectRoot) ||
      (saved.nativeRoot && saved.nativeRoot !== root) ||
      (cli === 'codex' && saved.pluginChecked !== true)) return blocked('native_snapshot_changed');
  const raw = await readOptional(file);
  const captureRaw = await readOptional(capturePath);
  if (!raw || !captureRaw || !(cli === 'claude' ? claudeEdit(raw, saved) : codexEdit(raw, saved))) {
    return blocked('native_config_changed');
  }
  let hooks;
  try { hooks = JSON.parse(captureRaw).hooks; } catch { return blocked('capture_hooks_changed'); }
  if (!captureEvents[cli].every(event => hooks?.[event]?.some(group =>
    group?.hooks?.some(h => h?.command === captureCommand(cli, event))))) return blocked('capture_hooks_changed');
  return { kind: 'verified' };
}
