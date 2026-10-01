import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identifyProject } from './project-id.mjs';

const run = promisify(execFile);
const plugins = { claude: 'claude-mem@thedotmack', codex: 'claude-mem@claude-mem-local' };
const blocked = (reason) => ({ kind: 'blocked', reason });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stateRoot = (options) => options.stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const snapshotFile = (root, cli, options) => path.join(stateRoot(options), hash(root), `native-${cli}.json`);
const configFile = (root, cli) => path.join(root, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');

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
    const { stdout } = await run('git', ['-C', root, 'ls-files', '--cached', '--', relative], { timeout: 5000 });
    return !!stdout.trim();
  } catch { return true; }
}
async function excludePlan(root, cli) {
  const relative = path.relative(root, configFile(root, cli));
  try {
    await run('git', ['-C', root, 'check-ignore', '-q', '--', relative], { timeout: 5000 });
    return { added: false };
  } catch (error) {
    if (error.code !== 1) return null;
  }
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { timeout: 5000 });
    const file = path.resolve(root, stdout.trim());
    if (!await safeParent(file) || !await safeFile(file)) return null;
    return { added: true, file, block: `# cbs-memoria ${cli}\n/${relative}\n` };
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
  if (!plugins[cli]) return blocked('unsupported_cli');
  const scope = await identifyProject(root);
  if (scope.kind !== 'git' || scope.projectRoot !== await fs.realpath(root).catch(() => null)) return blocked('unsupported_git');
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
    if (saved.cli !== cli || saved.file !== file || raw === null ||
        !(cli === 'claude' ? claudeEdit(raw, saved) : codexEdit(raw, saved))) {
      return blocked('native_config_changed');
    }
    return { kind: 'applied', existing: true };
  }
  const raw = await readOptional(file);
  const edit = (cli === 'claude' ? claudeEdit : codexEdit)(raw);
  if (!edit) return blocked('invalid_native_config');
  const exclude = await excludePlan(root, cli);
  if (!exclude) return blocked('unsafe_git_exclude');
  const save = { cli, file, existed: raw !== null, had: edit.had, previous: edit.previous,
    hadEnabledPlugins: cli === 'claude' && raw !== null && Object.hasOwn(JSON.parse(raw), 'enabledPlugins'),
    hadSection: edit.hadSection, old: edit.old, exclude };
  await writeAtomic(snapshot, JSON.stringify(save) + '\n');
  try { await writeAtomic(file, edit.raw); await addExclude(exclude); }
  catch (error) {
    if (raw === null) await fs.rm(file, { force: true }); else await writeAtomic(file, raw);
    await fs.rm(snapshot, { force: true });
    return blocked('native_write_failed');
  }
  return { kind: 'applied' };
}

export async function restoreNativeExclusion(root, options = {}) {
  const { cli } = options;
  if (!plugins[cli]) return blocked('unsupported_cli');
  const snapshot = snapshotFile(root, cli, options);
  let saved;
  if (!await safeFile(snapshot)) return blocked('unsafe_snapshot');
  try { saved = JSON.parse(await fs.readFile(snapshot, 'utf8')); }
  catch { return blocked('missing_snapshot'); }
  const file = configFile(root, cli);
  if (saved.cli !== cli || saved.file !== file || !await safeFile(file) || await tracked(root, file)) return blocked('unsafe_native_config');
  const raw = await readOptional(file);
  if (raw === null) return blocked('native_config_changed');
  const edit = (cli === 'claude' ? claudeEdit : codexEdit)(raw, saved);
  if (!edit) return blocked('native_config_changed');
  if (saved.exclude?.added && !(await readOptional(saved.exclude.file))?.includes(saved.exclude.block)) {
    return blocked('git_exclude_changed');
  }
  if (saved.existed) await writeAtomic(file, edit.raw);
  else if (cli === 'claude' && Object.keys(JSON.parse(edit.raw)).length === 0) await fs.rm(file);
  else if (cli === 'codex' && !edit.raw.trim()) await fs.rm(file);
  else await writeAtomic(file, edit.raw);
  if (!await removeExclude(saved.exclude)) return blocked('git_exclude_changed');
  await fs.rm(snapshot);
  return { kind: 'restored' };
}
