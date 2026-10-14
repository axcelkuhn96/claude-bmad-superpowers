import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectConfiguration, resolveProject } from '../base/memoria/provider.mjs';
import { registerOwner, configureExtractor, enableAutoPublish, disableAutoPublish,
  localDevice } from '../base/memoria/policy.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';

async function fixture(t, cli) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `cbs-native-profile-${cli}-`));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  const stateRoot = path.join(home, 'state');
  const profile = path.join(home, cli === 'codex' ? '.codex' : '.claude');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  await fs.mkdir(profile, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: `native-${cli}`,
    qdrant: { url: 'https://qdrant.internal', collection: `native-${cli}`,
      api_key_env: 'CBS_NATIVE_PROFILE_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  assert.equal((await applyNativeExclusion(root, { cli, stateRoot, installedPlugin: true })).kind, 'applied');
  const resolution = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  assert.equal((await registerOwner(resolution, cli, profile, 'axcel-local', true)).kind, 'registered');
  assert.equal((await configureExtractor(resolution, { route: 'haiku', profile,
    executable: process.execPath })).kind, 'selected');
  const device = await localDevice(resolution.stateDir);
  assert.equal(device.kind, 'device');
  const ledger = path.join(resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: resolution.projectId, collection: resolution.destination.collection,
    deviceId: device.deviceId, generation: 1 }) + '\n', { mode: 0o600 });
  assert.equal((await enableAutoPublish(resolution, { ownerId: 'axcel-local', cli, profile })).kind,
    'enabled');
  return { home, root, stateRoot, profile };
}

function nativeStart(f, cli, sessionId, profile) {
  const moduleUrl = new URL('../base/memoria/checkpoint.mjs', import.meta.url).href;
  const script = `import { captureEvent } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(await captureEvent(JSON.parse(process.argv[1]))));`;
  const args = { cli, event: 'SessionStart', stateRoot: f.stateRoot, installedPlugin: true,
    payload: { cwd: f.root, session_id: sessionId,
      transcript_path: path.join(f.home, `${sessionId}.jsonl`), hook_event_name: 'SessionStart' } };
  const profileKey = cli === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key !== 'CODEX_HOME' && key !== 'CLAUDE_CONFIG_DIR' &&
      key !== 'CBS_MEMORIA_LAUNCH_ID'));
  env.HOME = f.home;
  if (profile !== undefined) env[profileKey] = profile;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify(args)], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const cli of ['claude', 'codex']) {
  test(`${cli} native SessionStart resolves default profile without environment override`, async t => {
    const f = await fixture(t, cli);
    const started = nativeStart(f, cli, 'default-profile');
    assert.equal(started.kind, 'no_complete_bytes', JSON.stringify(started));
    const session = await resolveProject(f.root, 'default-profile', { stateRoot: f.stateRoot });
    assert.equal(session.ownerId, 'axcel-local');
    assert.equal(session.extractor.autoPublish, true);
    assert.equal((await disableAutoPublish(await inspectConfiguration(f.root,
      { stateRoot: f.stateRoot }))).kind, 'disabled');
    const optedOut = nativeStart(f, cli, 'opted-out');
    assert.equal(optedOut.kind, 'no_complete_bytes', JSON.stringify(optedOut));
    const later = await resolveProject(f.root, 'opted-out', { stateRoot: f.stateRoot });
    assert.equal(later.ownerId, 'axcel-local');
    assert.equal(later.extractor.autoPublish, false);
  });

  test(`${cli} native SessionStart preserves explicit profile and rejects unsafe profile`, async t => {
    const f = await fixture(t, cli);
    const alternate = path.join(f.home, 'alternate-profile');
    await fs.mkdir(alternate, { mode: 0o700 });
    const resolution = await inspectConfiguration(f.root, { stateRoot: f.stateRoot });
    assert.equal((await registerOwner(resolution, cli, alternate, 'alternate-owner', true)).kind,
      'registered');
    const selected = nativeStart(f, cli, 'selected-profile', alternate);
    assert.equal(selected.kind, 'no_complete_bytes', JSON.stringify(selected));
    const session = await resolveProject(f.root, 'selected-profile', { stateRoot: f.stateRoot });
    assert.equal(session.ownerId, 'alternate-owner');
    assert.equal(session.extractor.autoPublish, false);
    const alias = path.join(f.home, 'profile-alias');
    await fs.symlink(alternate, alias);
    const aliased = nativeStart(f, cli, 'aliased-profile', alias);
    assert.equal(aliased.kind, 'no_complete_bytes', JSON.stringify(aliased));
    assert.equal((await resolveProject(f.root, 'aliased-profile',
      { stateRoot: f.stateRoot })).ownerId, 'alternate-owner');
    const absent = nativeStart(f, cli, 'empty-profile', '');
    assert.equal(absent.kind, 'no_complete_bytes', JSON.stringify(absent));
    const unowned = await resolveProject(f.root, 'empty-profile', { stateRoot: f.stateRoot });
    assert.equal(unowned.ownerId, null);
    assert.equal(unowned.extractor.autoPublish, false);
    await fs.chmod(alternate, 0o775);
    const unsafe = nativeStart(f, cli, 'unsafe-profile', alternate);
    assert.equal(unsafe.reason, 'local_policy_changed');
  });
}
