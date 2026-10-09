import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { externalIdFor } from '../base/memoria/ledger.mjs';
import { createMcp } from '../base/memoria/mcp.mjs';
import { inspectConfiguration, initializeSession, resolveProject } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { registerOwner, configureExtractor, localDevice } from '../base/memoria/policy.mjs';
import { assertWriter, bootstrapWriter, beginWriterTransfer,
  completeWriterTransfer } from '../base/memoria/authority.mjs';
import { extractCheckpoint } from '../base/memoria/candidates.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { targetEligible, targetVersion } from '../base/memoria/correction.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { deactivateProject } from '../base/memoria/deactivate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function temporary(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cbs-final-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function project(t, label) {
  const root = await temporary(t, label);
  const gitRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(gitRoot);
  const initialized = spawnSync('git', ['-C', gitRoot, 'init', '-q']);
  assert.equal(initialized.status, 0);
  const file = path.join(gitRoot, '.cbs', 'memoria.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify({ provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } }));
  const resolution = await inspectConfiguration(gitRoot, { stateRoot });
  assert.equal(resolution.provider, 'mem0');
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  return { root, gitRoot, stateRoot, resolution };
}

test('fonte aprovada sobrevive ao ACK e só expõe o excerto sustentador', async t => {
  const root = await temporary(t, 'source');
  const stateDir = path.join(root, 'state');
  const box = createOutbox(stateDir);
  const message = { messageId: 'm1', role: 'user', speakerRole: 'user', origin: 'human',
    actor: 'user', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 80,
    text: 'Use Postgres for this project.\napi_key=SECRET-NEVER-EXPOSE\n-----BEGIN PRIVATE KEY-----\nPEM-NEVER-EXPOSE\n-----END PRIVATE KEY-----' };
  const queued = await box.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0,
    end: 80, sliceHash: 'a'.repeat(64), messages: [message] },
  { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(queued.kind, 'queued');
  const identity = { projectId: 'p', originCli: 'claude', sessionId: 's', start: 0, end: 80,
    sliceHash: 'a'.repeat(64), policyVersion: 'native-v1', candidateKey: 'fact' };
  const externalId = externalIdFor(identity);
  const payload = { external_id: externalId, project_id: 'p', checkpoint_id: queued.operationId,
    session_id: 's', origin_cli: 'claude', policy_version: 'native-v1',
    slice_start: 0, slice_end: 80, slice_hash: 'a'.repeat(64), candidate_key: 'fact',
    source_message_id: 'm1', source_offsets: { start: 0, end: 80 },
    scope: 'project', owner_id: null, actor: 'user', origin: 'user_direct',
    evidence_at: message.timestamp, text: 'Use Postgres for this project.' };
  const persisted = await box.persistCandidatePayload(queued.operationId, payload);
  assert.equal(persisted.kind, 'persisted');
  const manifest = await box.recordManifest(queued.operationId, [{ candidateKey: 'fact',
    externalId, evidence: { messageId: 'm1', start: 0, end: 80 }, payloadRef: persisted.payloadRef }]);
  assert.equal(manifest.kind, 'manifested');
  const item = { externalId, projectId: 'p', sessionId: 's', text: payload.text,
    metadata: { source: 'm1', checkpoint_id: queued.operationId,
      source_offsets: payload.source_offsets, policy_version: 'native-v1',
      evidence_at: message.timestamp, origin: 'user_direct', actor: 'user', scope: 'project' } };
  const proof = { ...item, sdkId: 'sdk-1', qdrantId: 'q-1', status: 'active' };
  assert.equal((await box.ackCandidate(queued.operationId, 'fact', proof)).kind, 'acked');
  assert.equal((await box.completeCheckpoint(queued.operationId)).kind, 'processed');
  assert.equal((await box.pending()).length, 0);
  const source = await createOutbox(stateDir).sourceForRemote(item);
  assert.equal(source.kind, 'local_source');
  assert.equal(source.text, 'Use Postgres for this project.');
  assert.equal(JSON.stringify(source).includes('SECRET-NEVER-EXPOSE'), false);
  assert.equal(JSON.stringify(source).includes('PEM-NEVER-EXPOSE'), false);
  assert.equal((await box.sourceForRemote({ ...item, projectId: 'other' })).reason, 'source_mismatch');
  assert.equal((await box.sourceForRemote({ ...item, metadata: { ...item.metadata,
    owner_id: 'owner-opaque-other' } })).reason, 'source_mismatch');
  const mcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', projectId: 'p', nativeSessionId: 's', cwd: '/fixture', stateDir }),
    read: async () => ({ kind: 'item', item }) });
  assert.equal((await mcp.call('source', { memory_id: 'sdk-1' })).kind, 'local_source');
});

test('owner opaco exige perfil declarado e congela sessões das duas CLIs', async t => {
  const fixture = await project(t, 'owner');
  const claude = path.join(fixture.root, 'claude-profile');
  const codex = path.join(fixture.root, 'codex-profile');
  const other = path.join(fixture.root, 'other-profile');
  for (const profile of [claude, codex, other]) await fs.mkdir(profile, { mode: 0o700 });
  const ownerId = 'owner-opaque-111';
  assert.equal((await registerOwner(fixture.resolution, 'claude', claude, ownerId, true)).kind, 'registered');
  assert.equal((await registerOwner(fixture.resolution, 'codex', codex, ownerId, true)).kind, 'registered');
  const a = await initializeSession(fixture.gitRoot, 'claude-a', { event: 'SessionStart',
    stateRoot: fixture.stateRoot, cli: 'claude', profile: claude });
  const b = await initializeSession(fixture.gitRoot, 'codex-b', { event: 'SessionStart',
    stateRoot: fixture.stateRoot, cli: 'codex', profile: codex });
  assert.equal(a.ownerId, ownerId);
  assert.equal(b.ownerId, ownerId);
  assert.equal((await initializeSession(fixture.gitRoot, 'other', { event: 'SessionStart',
    stateRoot: fixture.stateRoot, cli: 'claude', profile: other })).ownerId, null);
  assert.equal((await registerOwner(fixture.resolution, 'claude', claude, 'owner-opaque-222', true)).kind, 'registered');
  assert.equal((await resolveProject(fixture.gitRoot, 'claude-a', { stateRoot: fixture.stateRoot })).ownerId, ownerId);
  assert.equal((await initializeSession(fixture.gitRoot, 'claude-new', { event: 'SessionStart',
    stateRoot: fixture.stateRoot, cli: 'claude', profile: claude })).ownerId, 'owner-opaque-222');
  assert.equal((await resolveProject(fixture.gitRoot, 'codex-b', { stateRoot: fixture.stateRoot })).ownerId, ownerId);
});

test('deactivate restaura fragmentos CBS, preserva terceiros e é idempotente sem config', async t => {
  const fixture = await project(t, 'deactivate');
  const settings = path.join(fixture.gitRoot, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ enabledPlugins: { 'other@plugin': true }, custom: 7 }));
  assert.equal((await applyNativeExclusion(fixture.gitRoot, { cli: 'claude',
    stateRoot: fixture.stateRoot })).kind, 'applied');
  const applied = JSON.parse(await fs.readFile(settings, 'utf8'));
  assert.equal(applied.enabledPlugins['claude-mem@thedotmack'], false);
  applied.thirdPartyAfterActivation = true;
  await fs.writeFile(settings, JSON.stringify(applied));
  const deactivated = await deactivateProject(fixture.gitRoot, { stateRoot: fixture.stateRoot });
  assert.equal(deactivated.kind, 'deactivated');
  const restored = JSON.parse(await fs.readFile(settings, 'utf8'));
  assert.equal(restored.enabledPlugins['other@plugin'], true);
  assert.equal('claude-mem@thedotmack' in restored.enabledPlugins, false);
  assert.equal(restored.custom, 7);
  assert.equal(restored.thirdPartyAfterActivation, true);
  assert.equal((await resolveProject(fixture.gitRoot, 'new', { stateRoot: fixture.stateRoot })).provider,
    'claude-mem');
  assert.equal((await deactivateProject(fixture.gitRoot, { stateRoot: fixture.stateRoot })).kind,
    'deactivated');
});

test('deactivate bloqueia sessão ambígua sem alterar configuração existente', async t => {
  const fixture = await project(t, 'active');
  const settings = path.join(fixture.gitRoot, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, '{}');
  assert.equal((await applyNativeExclusion(fixture.gitRoot, { cli: 'claude',
    stateRoot: fixture.stateRoot })).kind, 'applied');
  await initializeSession(fixture.gitRoot, 'active-session', { event: 'SessionStart',
    stateRoot: fixture.stateRoot });
  const before = await fs.readFile(settings, 'utf8');
  assert.equal((await deactivateProject(fixture.gitRoot, { stateRoot: fixture.stateRoot })).reason,
    'active_or_ambiguous_session');
  assert.equal(await fs.readFile(settings, 'utf8'), before);
  await assert.rejects(fs.stat(path.join(fixture.resolution.stateDir, 'deactivating.json')),
    { code: 'ENOENT' });
});

test('deactivate localiza snapshot após remoção da seleção', async t => {
  const fixture = await project(t, 'selection-removed');
  const settings = path.join(fixture.gitRoot, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ custom: 9 }));
  assert.equal((await applyNativeExclusion(fixture.gitRoot, { cli: 'claude',
    stateRoot: fixture.stateRoot })).kind, 'applied');
  await fs.rm(path.join(fixture.gitRoot, '.cbs', 'memoria.json'));
  assert.equal((await deactivateProject(fixture.gitRoot, { stateRoot: fixture.stateRoot })).kind,
    'deactivated');
  assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), { custom: 9 });
});

test('designação Qdrant compartilhada bloqueia leitor e transfere só após handoff', async t => {
  const a = await project(t, 'writer-a');
  const b = await project(t, 'writer-b');
  const firstDevice = await localDevice(a.resolution.stateDir);
  const secondDevice = await localDevice(b.resolution.stateDir);
  assert.notEqual(firstDevice.deviceId, secondDevice.deviceId);
  let remote;
  const control = async (command, resolution, row) => {
    if (command === 'read') return remote ? { kind: 'authority', record: remote } : { kind: 'missing' };
    remote = { cbs_control: 'writer_v1', projectId: resolution.projectId,
      collection: resolution.destination.collection, ...row };
    return { kind: 'written' };
  };
  const options = fixture => ({ stateRoot: fixture.stateRoot,
    lookup: async () => ['10.1.2.3'], control });
  await initializeSession(a.gitRoot, 's', { event: 'SessionStart', stateRoot: a.stateRoot });
  await initializeSession(b.gitRoot, 's', { event: 'SessionStart', stateRoot: b.stateRoot });
  const readSecret = () => 'fixture-secret';
  assert.equal((await bootstrapWriter(a.gitRoot, 's', readSecret, {
    ...options(a), confirm: true, clientsQuiescent: true, singleAdministrator: true })).kind, 'designated');
  assert.equal((await bootstrapWriter(b.gitRoot, 's', readSecret, {
    ...options(b), confirm: true, clientsQuiescent: true, singleAdministrator: true })).reason,
  'writer_already_designated');
  const auth = { kind: 'authorized', key: 'fixture-secret' };
  assert.equal((await assertWriter(a.resolution, auth, options(a))).kind, 'writer');
  assert.equal((await assertWriter(b.resolution, auth, options(b))).reason, 'writer_not_designated');
  const inflight = path.join(a.resolution.stateDir, 'ledger', `${'e'.repeat(64)}.json`);
  await fs.writeFile(inflight, JSON.stringify({ projectId: 'p', status: 'queued' }));
  assert.equal((await beginWriterTransfer(a.gitRoot, 's', secondDevice.deviceId, readSecret,
    { ...options(a), confirm: true })).reason, 'writer_operation_unsettled');
  await fs.rm(inflight);
  const transfer = await beginWriterTransfer(a.gitRoot, 's', secondDevice.deviceId, readSecret,
    { ...options(a), confirm: true });
  assert.equal(transfer.kind, 'handoff');
  assert.equal((await assertWriter(a.resolution, auth, options(a))).reason, 'writer_not_designated');
  assert.equal((await assertWriter(b.resolution, auth, options(b))).reason, 'writer_not_designated');
  const bundle = JSON.parse(await fs.readFile(transfer.bundleFile, 'utf8'));
  assert.equal((await completeWriterTransfer(b.gitRoot, 's', bundle, readSecret,
    { ...options(b), confirm: true })).kind, 'transferred');
  assert.equal((await assertWriter(b.resolution, auth, options(b))).kind, 'writer');
  assert.equal((await assertWriter(a.resolution, auth, options(a))).reason, 'writer_not_designated');
});

test('correção só aceita alvo ativo no mesmo projeto/escopo/owner', () => {
  const target = { sdkId: 'id', externalId: 'src-' + 'a'.repeat(64), projectId: 'p',
    status: 'active', text: 'Old rule', metadata: { scope: 'personal', owner_id: 'owner-a' } };
  const candidate = { project_id: 'p', scope: 'personal', owner_id: 'owner-a' };
  assert.equal(targetEligible(target, candidate), true);
  assert.match(targetVersion(target), /^[a-f0-9]{64}$/);
  assert.equal(targetEligible({ ...target, status: 'superseded' }, candidate), false);
  assert.equal(targetEligible(target, { ...candidate, owner_id: 'owner-b' }), false);
  assert.equal(targetEligible(target, { ...candidate, project_id: 'other' }), false);
});

test('extrator unset/Sol não chama CLI; seleção Sonnet congela sessão', async t => {
  let calls = 0;
  const checkpoint = { operationId: 'src-' + 'a'.repeat(64) };
  const options = { runCli: async () => { calls++; throw new Error('unexpected'); } };
  assert.equal((await extractCheckpoint(checkpoint, {}, options)).reason, 'extractor_route_unselected');
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sol' }, options)).reason,
    'sol_tool_isolation_unproved');
  assert.equal(calls, 0);
  const fixture = await project(t, 'extractor');
  const profile = path.join(fixture.root, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  assert.equal((await configureExtractor(fixture.resolution, { route: 'sonnet',
    profile, executable: process.execPath })).kind, 'selected');
  const session = await initializeSession(fixture.gitRoot, 's', { event: 'SessionStart',
    stateRoot: fixture.stateRoot });
  assert.equal(session.extractor.route, 'sonnet');
  assert.equal(session.extractor.maxCallsPerSession, 4);
  assert.equal(session.extractor.autoPublish, false);
});

test('CLI do pacote opera de cwd externo e mantém gates públicos tipados', async t => {
  const cwd = path.join(await temporary(t, 'cwd'), 'external with spaces');
  await fs.mkdir(cwd);
  const bin = path.join(repo, 'bin', 'cli.js');
  const help = spawnSync(process.execPath, [bin, 'memoria', 'help'], { cwd, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /writer-transfer-complete/);
  const activate = spawnSync(process.execPath, [bin, 'memoria', 'activate', '--project', cwd,
    '--cli', 'claude'], { cwd, encoding: 'utf8' });
  assert.equal(activate.status, 1);
  assert.match(activate.stdout, /local_native_gate_failed/);
  const standard = spawnSync(process.execPath, [bin, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(standard.status, 0);
});
