import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applyNativeExclusion, restoreNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, cli) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-tracked-native-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(root);
  git(root, 'init', '-q');
  const config = path.join(root, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
  const hooks = path.join(root, '.codex/hooks.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  const initial = cli === 'claude'
    ? JSON.stringify({ enabledPlugins: { 'other@plugin': true }, custom: 'committed' }) + '\n'
    : '[features]\nhooks = true\n';
  await fs.writeFile(config, initial);
  if (cli === 'codex') await fs.writeFile(hooks, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }],
  }, custom: 'committed' }) + '\n');
  const paths = cli === 'claude' ? [config] : [config, hooks];
  for (const file of paths) git(root, 'add', '-f', path.relative(root, file));
  const index = paths.map(file => git(root, 'ls-files', '--stage', '--', path.relative(root, file)));
  return { root, stateRoot, config, hooks, initial, index, paths };
}

test('tracked Claude config requires explicit opt-in and restores preexisting dirty bytes without changing index', async t => {
  const f = await fixture(t, 'claude');
  const dirty = JSON.stringify({ enabledPlugins: { 'other@plugin': true }, custom: 'dirty' }) + '\n';
  await fs.writeFile(f.config, dirty);
  const options = { cli: 'claude', stateRoot: f.stateRoot };
  assert.equal((await applyNativeExclusion(f.root, options)).reason, 'tracked_native_config');
  assert.equal((await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'verified');
  assert.equal(git(f.root, 'ls-files', '--stage', '--', '.claude/settings.local.json'), f.index[0]);
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'restored');
  assert.equal(await fs.readFile(f.config, 'utf8'), dirty);
  assert.equal(git(f.root, 'ls-files', '--stage', '--', '.claude/settings.local.json'), f.index[0]);
});

test('tracked Codex config and hooks preserve existing hooks and index on restore', async t => {
  const f = await fixture(t, 'codex');
  const originalHooks = await fs.readFile(f.hooks, 'utf8');
  const dirtyConfig = f.initial + '\n[custom]\nvalue = 7\n';
  await fs.writeFile(f.config, dirtyConfig);
  const options = { cli: 'codex', stateRoot: f.stateRoot, installedPlugin: true };
  assert.equal((await applyNativeExclusion(f.root, options)).reason, 'tracked_native_config');
  assert.equal((await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'verified');
  assert.match(await fs.readFile(f.hooks, 'utf8'), /echo existing/);
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'restored');
  assert.equal(await fs.readFile(f.config, 'utf8'), dirtyConfig);
  assert.equal(await fs.readFile(f.hooks, 'utf8'), originalHooks);
  assert.deepEqual(f.paths.map(file => git(f.root, 'ls-files', '--stage', '--', path.relative(f.root, file))), f.index);
});

test('tracked Codex upgrades owned 0.13.3 hooks in place without touching user hooks or index', async t => {
  const f = await fixture(t, 'codex');
  const originalHooks = await fs.readFile(f.hooks, 'utf8');
  const options = { cli: 'codex', stateRoot: f.stateRoot, installedPlugin: true };
  assert.equal((await applyNativeExclusion(f.root,
    { ...options, allowTrackedNative: true })).kind, 'applied');
  const scope = createHash('sha256').update(f.root).digest('hex');
  const snapshot = path.join(f.stateRoot, scope, 'native-codex.json');
  const installed = JSON.parse(await fs.readFile(f.hooks, 'utf8'));
  delete installed.hooks.PreCompact;
  delete installed.hooks.Interrupt;
  installed.hooks.SessionEnd.at(-1).hooks[0].timeout = 10;
  const oldHooks = JSON.stringify(installed, null, 2) + '\n';
  await fs.writeFile(f.hooks, oldHooks);
  const saved = JSON.parse(await fs.readFile(snapshot, 'utf8'));
  delete saved.captureSchema;
  saved.trackedNative.paths.find(row => row.file === f.hooks).installedHash =
    createHash('sha256').update(oldHooks).digest('hex');
  const { rollback, ...sealed } = saved;
  saved.trackedNative.seal = createHash('sha256').update(JSON.stringify({ ...sealed,
    trackedNative: { rootIdentity: saved.trackedNative.rootIdentity,
      paths: saved.trackedNative.paths } })).digest('hex');
  await fs.writeFile(snapshot, JSON.stringify(saved) + '\n');

  const rename = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    if (to === snapshot && !injected) { injected = true; throw new Error('injected snapshot failure'); }
    return rename(from, to);
  };
  let failed;
  try { failed = await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true }); }
  finally { fs.rename = rename; }
  assert.equal(failed.reason, 'native_snapshot_changed');
  assert.equal(await fs.readFile(f.hooks, 'utf8'), oldHooks);

  const upgraded = await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true });
  assert.equal(upgraded.kind, 'applied', JSON.stringify(upgraded));
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'verified');
  const after = JSON.parse(await fs.readFile(f.hooks, 'utf8'));
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  assert.equal(after.hooks.SessionEnd.at(-1).hooks[0].timeout, 3);
  assert.equal(after.hooks.Interrupt.at(-1).hooks[0].timeout, 3);
  assert.deepEqual(f.paths.map(file => git(f.root, 'ls-files', '--stage', '--', path.relative(f.root, file))), f.index);
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'restored');
  assert.equal(await fs.readFile(f.hooks, 'utf8'), originalHooks);
});

test('tracked Codex restore resumes after the second config write fails', async t => {
  const f = await fixture(t, 'codex');
  const originalHooks = await fs.readFile(f.hooks, 'utf8');
  const options = { cli: 'codex', stateRoot: f.stateRoot, installedPlugin: true };
  assert.equal((await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  const rename = fs.rename;
  let failed;
  fs.rename = async (from, to) => {
    if (to === f.hooks) throw new Error('injected second write failure');
    return rename(from, to);
  };
  try { failed = await restoreNativeExclusion(f.root, options); }
  finally { fs.rename = rename; }
  assert.deepEqual(failed, { kind: 'blocked', reason: 'native_write_failed' });
  assert.equal(await fs.readFile(f.config, 'utf8'), f.initial);
  assert.notEqual(await fs.readFile(f.hooks, 'utf8'), originalHooks);
  const installedHooks = await fs.readFile(f.hooks, 'utf8');
  const [scope] = await fs.readdir(f.stateRoot);
  const snapshot = path.join(f.stateRoot, scope, 'native-codex.json');
  const saved = await fs.readFile(snapshot, 'utf8');
  const missingRollback = JSON.parse(saved);
  delete missingRollback.rollback;
  await fs.writeFile(snapshot, JSON.stringify(missingRollback) + '\n');
  assert.equal((await restoreNativeExclusion(f.root, options)).reason, 'native_config_changed');
  const tamperedRollback = JSON.parse(saved);
  tamperedRollback.rollback.config = 'tampered';
  await fs.writeFile(snapshot, JSON.stringify(tamperedRollback) + '\n');
  assert.equal((await restoreNativeExclusion(f.root, options)).reason, 'native_snapshot_changed');
  await fs.writeFile(snapshot, saved);
  await fs.writeFile(f.hooks, installedHooks.replace('echo existing', 'echo user edit'));
  assert.equal((await restoreNativeExclusion(f.root, options)).reason, 'native_config_changed');
  assert.match(await fs.readFile(f.hooks, 'utf8'), /echo user edit/);
  await fs.writeFile(f.hooks, installedHooks);
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'restored');
  assert.equal(await fs.readFile(f.config, 'utf8'), f.initial);
  assert.equal(await fs.readFile(f.hooks, 'utf8'), originalHooks);
  assert.deepEqual(f.paths.map(file => git(f.root, 'ls-files', '--stage', '--', path.relative(f.root, file))), f.index);
});

test('tracked Codex hooks alone still require opt-in', async t => {
  const f = await fixture(t, 'codex');
  git(f.root, 'rm', '--cached', '-q', '.codex/config.toml');
  const options = { cli: 'codex', stateRoot: f.stateRoot, installedPlugin: true };
  assert.equal((await applyNativeExclusion(f.root, options)).reason, 'unsafe_capture_hooks');
  assert.equal((await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'verified');
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'restored');
});

test('tracked native capture fails closed after user edit or index change', async t => {
  const f = await fixture(t, 'claude');
  const options = { cli: 'claude', stateRoot: f.stateRoot };
  assert.equal((await applyNativeExclusion(f.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  const edited = (await fs.readFile(f.config, 'utf8')).replace('committed', 'user edit');
  await fs.writeFile(f.config, edited);
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'blocked');
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'blocked');
  assert.equal(await fs.readFile(f.config, 'utf8'), edited);
  await fs.writeFile(f.config, '{"custom":"new staged value"}\n');
  git(f.root, 'add', '.claude/settings.local.json');
  await fs.writeFile(f.config, edited.replace('user edit', 'committed'));
  assert.equal((await verifyNativeCapture(f.root, options)).kind, 'blocked');
  assert.equal((await restoreNativeExclusion(f.root, options)).kind, 'blocked');
  assert.equal(await fs.readFile(f.config, 'utf8'), edited.replace('user edit', 'committed'));
});

test('tracked native snapshot cannot be reused for another root or changed path', async t => {
  const first = await fixture(t, 'claude');
  const second = await fixture(t, 'claude');
  const options = { cli: 'claude', stateRoot: first.stateRoot };
  assert.equal((await applyNativeExclusion(first.root, { ...options, allowTrackedNative: true })).kind, 'applied');
  const [scope] = await fs.readdir(first.stateRoot);
  const snapshot = path.join(first.stateRoot, scope, 'native-claude.json');
  const original = await fs.readFile(snapshot, 'utf8');
  const stateSecond = path.join(first.stateRoot, createHash('sha256').update(second.root).digest('hex'));
  await fs.mkdir(stateSecond);
  await fs.writeFile(path.join(stateSecond, 'native-claude.json'), original);
  assert.equal((await verifyNativeCapture(second.root, { cli: 'claude', stateRoot: first.stateRoot })).kind, 'blocked');
  const changed = JSON.parse(original);
  changed.trackedNative.paths[0].file = second.config;
  await fs.writeFile(snapshot, JSON.stringify(changed) + '\n');
  assert.equal((await verifyNativeCapture(first.root, options)).kind, 'blocked');
  assert.equal((await restoreNativeExclusion(first.root, options)).kind, 'blocked');
});
