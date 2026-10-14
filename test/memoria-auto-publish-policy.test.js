import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectConfiguration, initializeSession, resolveProject } from '../base/memoria/provider.mjs';
import { registerOwner, configureExtractor, enableAutoPublish, disableAutoPublish,
  readAutoPublish, readExtractor, readOwner, localDevice } from '../base/memoria/policy.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-autopublish-policy-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  const profile = path.join(home, 'claude-profile');
  const stateRoot = path.join(home, '.local', 'state', 'cbs', 'memoria');
  await fs.mkdir(path.join(project, '.cbs'), { recursive: true });
  await fs.mkdir(profile, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
  const configuration = { provider: 'mem0', project_id: 'fixture-project',
    qdrant: { url: 'https://qdrant.internal', collection: 'fixture-memory',
      api_key_env: 'CBS_POLICY_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } };
  const configFile = path.join(project, '.cbs', 'memoria.json');
  await fs.writeFile(configFile, JSON.stringify(configuration));
  const resolution = await inspectConfiguration(project, { stateRoot });
  assert.equal(resolution.provider, 'mem0');
  assert.equal((await configureExtractor(resolution, { route: 'haiku', profile,
    executable: process.execPath })).kind, 'selected');
  return { home, project, profile, stateRoot, resolution, configuration, configFile };
}

async function designated(f) {
  const device = await localDevice(f.resolution.stateDir);
  assert.equal(device.kind, 'device');
  const ledger = path.join(f.resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: f.resolution.projectId, collection: f.resolution.destination.collection,
    deviceId: device.deviceId, generation: 1 }) + '\n', { mode: 0o600 });
  return device;
}

test('opt-in exige owner registrado e writer designado, e congela consentimento na sessão nova', async t => {
  const f = await fixture(t);
  assert.equal((await readAutoPublish(f.resolution)), null);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'blocked');
  assert.equal((await registerOwner(f.resolution, 'claude', f.profile,
    'axcel-local', true)).kind, 'registered');
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).reason, 'writer_not_designated');
  const device = await designated(f);
  const granted = await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile });
  assert.equal(granted.kind, 'enabled');
  const consent = await readAutoPublish(f.resolution);
  assert.equal(consent.version, 1);
  assert.equal(consent.enabled, true);
  assert.equal(consent.projectId, 'fixture-project');
  assert.equal(consent.ownerId, 'axcel-local');
  assert.equal(consent.deviceId, device.deviceId);
  assert.match(consent.consentHash, /^[a-f0-9]{64}$/);
  const started = await initializeSession(f.project, 'new', { event: 'SessionStart',
    stateRoot: f.stateRoot, cli: 'claude', profile: f.profile });
  assert.equal(started.ownerId, 'axcel-local');
  assert.equal(started.extractor.autoPublish, true);
  assert.equal(started.extractor.autoPublishConsent.consentHash, consent.consentHash);
  const unrelated = await initializeSession(f.project, 'codex-unowned', {
    event: 'SessionStart', stateRoot: f.stateRoot, cli: 'codex', profile: f.profile });
  assert.equal(unrelated.provider, 'mem0');
  assert.equal(unrelated.ownerId, null);
  assert.equal(unrelated.extractor.autoPublish, false);
});

test('revogação desliga consentimento atual e não promove sessão antiga', async t => {
  const f = await fixture(t);
  await designated(f);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  const old = await initializeSession(f.project, 'old', { event: 'SessionStart',
    stateRoot: f.stateRoot, cli: 'claude', profile: f.profile });
  assert.equal(old.extractor.autoPublish, false);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  assert.equal((await resolveProject(f.project, 'old', { stateRoot: f.stateRoot })).extractor.autoPublish, false);
  const live = await readAutoPublish(f.resolution);
  assert.equal((await disableAutoPublish(f.resolution)).kind, 'disabled');
  assert.equal(await readAutoPublish(f.resolution), null);
  assert.equal((await readExtractor(f.resolution)).autoPublish, false);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  assert.notEqual((await readAutoPublish(f.resolution)).consentHash, live.consentHash);
});

test('alteração de destino, device, owner ou hash invalida opt-in', async t => {
  const f = await fixture(t);
  const device = await designated(f);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  const alteredDestination = { ...f.resolution,
    destination: { ...f.resolution.destination, collection: 'other' } };
  assert.equal(await readAutoPublish(alteredDestination), null);
  const deviceFile = path.join(path.dirname(f.resolution.stateDir), 'device.json');
  await fs.writeFile(deviceFile, JSON.stringify({ deviceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), { mode: 0o600 });
  assert.equal(await readAutoPublish(f.resolution), null);
  const changedDeviceSession = await initializeSession(f.project, 'device-changed', {
    event: 'SessionStart', stateRoot: f.stateRoot, cli: 'claude', profile: f.profile });
  assert.equal(changedDeviceSession.provider, 'mem0');
  assert.equal(changedDeviceSession.extractor.autoPublish, false);
  await fs.writeFile(deviceFile, JSON.stringify({ deviceId: device.deviceId }), { mode: 0o600 });
  await registerOwner(f.resolution, 'claude', f.profile, 'other-owner', true);
  assert.equal(await readAutoPublish(f.resolution), null);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  const extractorFile = path.join(f.resolution.stateDir, 'extractor.json');
  const record = JSON.parse(await fs.readFile(extractorFile, 'utf8'));
  record.autoPublishConsent.consentHash = 'f'.repeat(64);
  await fs.writeFile(extractorFile, JSON.stringify(record), { mode: 0o600 });
  assert.equal(await readAutoPublish(f.resolution), null);
});

test('status CLI reflete consentimento real e disable revoga sem interação', async t => {
  const f = await fixture(t);
  const bin = new URL('../bin/cli.js', import.meta.url).pathname;
  const run = action => spawnSync(process.execPath,
    [bin, 'memoria', action, '--project', f.project],
    { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  assert.equal(JSON.parse(run('status').stdout).autoPublish, false);
  await designated(f);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  assert.equal(JSON.parse(run('check').stdout).autoPublish, false);
  await writeLocalTrust(f.resolution.stateDir, trustTuple(f.resolution));
  assert.equal(JSON.parse(run('check').stdout).autoPublish, true);
  assert.equal(JSON.parse(run('check').stdout).owner, 'axcel-local');
  await fs.rm(path.join(f.resolution.stateDir, 'ledger', 'writer.json'));
  assert.equal(JSON.parse(run('status').stdout).autoPublish, false);
  const revoked = run('auto-publish-disable');
  assert.equal(revoked.status, 0, revoked.stdout + revoked.stderr);
  assert.equal(JSON.parse(run('status').stdout).autoPublish, false);
  assert.equal(await readAutoPublish(f.resolution), null);
});

test('perfil do owner com permissão de escrita de terceiros revoga publicação', async t => {
  const f = await fixture(t);
  await designated(f);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  await fs.chmod(f.profile, 0o777);
  assert.equal(await readAutoPublish(f.resolution), null);
});

test('registros de perfis Claude coexistem e arquivo não expõe caminho do perfil', async t => {
  const f = await fixture(t);
  const second = path.join(f.home, 'claude-sigamina');
  await fs.mkdir(second, { mode: 0o700 });
  assert.equal((await registerOwner(f.resolution, 'claude', f.profile,
    'axcel-local', true)).kind, 'registered');
  assert.equal((await registerOwner(f.resolution, 'claude', second,
    'axcel-local', true)).kind, 'registered');
  assert.equal((await readOwner(f.resolution, 'claude', f.profile)).ownerId, 'axcel-local');
  assert.equal((await readOwner(f.resolution, 'claude', second)).ownerId, 'axcel-local');
  const ownerFiles = (await fs.readdir(f.resolution.stateDir)).filter(name => name.startsWith('owner-'));
  assert.equal(ownerFiles.length, 2);
  for (const name of ownerFiles) {
    assert.match(name, /^owner-claude-[a-f0-9]{64}\.json$/);
    assert.equal(name.includes('sigamina'), false);
  }
});

test('consentimento de um perfil permanece válido ao registrar outro e revoga se o original mudar', async t => {
  const f = await fixture(t);
  await designated(f);
  const second = path.join(f.home, 'claude-conta2');
  await fs.mkdir(second, { mode: 0o700 });
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  const consent = await readAutoPublish(f.resolution);
  await registerOwner(f.resolution, 'claude', second, 'axcel-local', true);
  assert.equal((await readOwner(f.resolution, 'claude', f.profile)).ownerId, 'axcel-local');
  assert.equal((await readAutoPublish(f.resolution)).consentHash, consent.consentHash);
  await registerOwner(f.resolution, 'claude', f.profile, 'other-owner', true);
  assert.equal(await readAutoPublish(f.resolution), null);
});

test('opt-in pode usar perfil secundário e registro legado fica acessível apenas no perfil correspondente', async t => {
  const f = await fixture(t);
  await designated(f);
  const legacyFile = path.join(f.resolution.stateDir, 'owner-claude.json');
  const secondary = path.join(f.home, 'claude-sigamina');
  await fs.mkdir(secondary, { mode: 0o700 });
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  const firstFile = (await fs.readdir(f.resolution.stateDir)).find(name => name.startsWith('owner-claude-'));
  if (firstFile) {
    await fs.copyFile(path.join(f.resolution.stateDir, firstFile), legacyFile);
    await fs.chmod(legacyFile, 0o600);
    await fs.rm(path.join(f.resolution.stateDir, firstFile));
  }
  assert.equal((await readOwner(f.resolution, 'claude', f.profile)).ownerId, 'axcel-local');
  assert.equal(await readOwner(f.resolution, 'claude', secondary), null);
  await registerOwner(f.resolution, 'claude', secondary, 'axcel-local', true);
  assert.equal((await readOwner(f.resolution, 'claude', f.profile)).ownerId, 'axcel-local');
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: secondary })).kind, 'enabled');
  assert.equal((await readAutoPublish(f.resolution)).ownerId, 'axcel-local');
  await registerOwner(f.resolution, 'claude', f.profile, 'other-owner', true);
  assert.equal((await readAutoPublish(f.resolution)).ownerId, 'axcel-local');
});

test('upgrade de owner legado mantém opt-in ativo e revoga ao trocar o owner', async t => {
  const f = await fixture(t);
  await designated(f);
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  const hashedFile = path.join(f.resolution.stateDir,
    (await fs.readdir(f.resolution.stateDir)).find(name => name.startsWith('owner-claude-')));
  const legacyFile = path.join(f.resolution.stateDir, 'owner-claude.json');
  await fs.rename(hashedFile, legacyFile);

  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  assert.equal((await readAutoPublish(f.resolution)).ownerId, 'axcel-local');
  await writeLocalTrust(f.resolution.stateDir, trustTuple(f.resolution));
  const bin = new URL('../bin/cli.js', import.meta.url).pathname;
  const status = () => spawnSync(process.execPath,
    [bin, 'memoria', 'status', '--project', f.project],
    { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  assert.equal(JSON.parse(status().stdout).autoPublish, true);

  const secondary = path.join(f.home, 'claude-conta2');
  await fs.mkdir(secondary, { mode: 0o700 });
  await registerOwner(f.resolution, 'claude', secondary, 'axcel-local', true);
  assert.equal((await readAutoPublish(f.resolution)).ownerId, 'axcel-local');
  const legacy = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
  await fs.writeFile(legacyFile, JSON.stringify({ ...legacy, ownerId: 'other-owner' }), { mode: 0o600 });
  assert.equal(await readAutoPublish(f.resolution), null);
  assert.equal(JSON.parse(status().stdout).autoPublish, false);
});

test('consentimento legado continua válido ao registrar alias e detecta troca do owner original', async t => {
  const f = await fixture(t);
  await designated(f);
  const secondary = path.join(f.home, 'claude-conta3');
  await fs.mkdir(secondary, { mode: 0o700 });
  await registerOwner(f.resolution, 'claude', f.profile, 'axcel-local', true);
  const firstFile = (await fs.readdir(f.resolution.stateDir)).find(name => name.startsWith('owner-claude-'));
  const legacyFile = path.join(f.resolution.stateDir, 'owner-claude.json');
  await fs.copyFile(path.join(f.resolution.stateDir, firstFile), legacyFile);
  await fs.chmod(legacyFile, 0o600);
  await fs.rm(path.join(f.resolution.stateDir, firstFile));
  assert.equal((await enableAutoPublish(f.resolution, { ownerId: 'axcel-local',
    cli: 'claude', profile: f.profile })).kind, 'enabled');
  const extractorFile = path.join(f.resolution.stateDir, 'extractor.json');
  const extractor = JSON.parse(await fs.readFile(extractorFile, 'utf8'));
  const consent = extractor.autoPublishConsent;
  delete consent.ownerProfileHash;
  consent.consentHash = createHash('sha256').update(JSON.stringify([
    consent.version, consent.enabled, consent.projectId, consent.destinationHash,
    consent.ownerId, consent.deviceId, consent.ownerCli, consent.enabledAt, consent.nonce
  ])).digest('hex');
  await fs.writeFile(extractorFile, JSON.stringify(extractor), { mode: 0o600 });
  assert.equal((await readAutoPublish(f.resolution)).consentHash, consent.consentHash);
  await registerOwner(f.resolution, 'claude', secondary, 'axcel-local', true);
  assert.equal((await readAutoPublish(f.resolution)).consentHash, consent.consentHash);
  await registerOwner(f.resolution, 'claude', f.profile, 'other-owner', true);
  assert.equal(await readAutoPublish(f.resolution), null);
});
