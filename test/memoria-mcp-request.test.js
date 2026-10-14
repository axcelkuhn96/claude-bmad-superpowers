import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReadonlyMcp } from '../base/memoria/mcp-readonly.mjs';
import { createExplicitMcpRequest, sourceForExplicitMcp,
  ackExplicitMcpRequest } from '../base/memoria/mcp-request-proof.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { localDevice } from '../base/memoria/policy.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-write-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  assert.equal(spawnSync('git', ['-C', root, 'init', '-q']).status, 0);
  const configFile = path.join(root, '.cbs', 'memoria.json');
  const config = { provider: 'mem0', project_id: 'project-one', qdrant: {
    url: 'https://mem.example.org/', address: '157.230.226.207', allow_public: true,
    collection: 'cbs-project-one', api_key_env: 'CBS_TEST_KEY' }, embedding: {
    model: 'multilingual-e5-small', dimension: 384,
    fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } };
  await fs.writeFile(configFile, JSON.stringify(config));
  const resolution = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  const consent = { version: 1, enabled: true, projectId: resolution.projectId,
    ownerId: 'axcel-local', consentHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64),
    deviceId: 'device-1', enabledAt: '2026-10-14T00:00:00.000Z' };
  return { root, stateRoot, configFile, config, resolution, consent };
}

const remote = operation => ({ status: 'active', externalId: operation.externalId,
  projectId: operation.projectId, sdkId: 'sdk-1', qdrantId: 'point-1' });

test('explicit MCP request has durable private provenance, stable id and honest role', async t => {
  const f = await fixture(t);
  const fields = { resolution: f.resolution, cli: 'claude', profile: '/profiles/claude',
    ownerId: 'axcel-local', consent: f.consent, text: 'Promote the RPO before REST tests.',
    type: 'rule', scope: 'project', condition: 'When testing MizuAprov REST' };
  const one = await createExplicitMcpRequest(fields);
  const two = await createExplicitMcpRequest(fields);
  const bound = { ...f.resolution, ownerId: fields.ownerId,
    extractor: { autoPublish: true, autoPublishConsent: f.consent } };
  assert.equal(one.kind, 'request');
  assert.equal(two.kind, 'request');
  assert.equal(one.requestId, two.requestId);
  assert.deepEqual(one.operation, two.operation);
  assert.equal(one.operation.metadata.format_version, 5);
  assert.equal(one.operation.metadata.origin, 'assistant_report');
  assert.equal(one.operation.metadata.speaker_role, 'assistant');
  assert.equal(one.operation.metadata.review_mode, 'explicit_mcp');
  assert.equal(one.operation.metadata.source, `mcp_request:${one.requestId}`);
  assert.equal((await sourceForExplicitMcp(one.operation, bound)).kind, 'local_source');
  const file = path.join(f.resolution.stateDir, 'mcp-requests', `${one.requestId}.json`);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await ackExplicitMcpRequest(one.operation, bound,
    one.operation.externalId, { ...remote(one.operation), sdkId: null })).kind, 'blocked');
  assert.deepEqual(await ackExplicitMcpRequest(one.operation, bound,
    one.operation.externalId, remote(one.operation)), { kind: 'acked',
    operationId: one.operation.externalId });
  assert.equal((await createExplicitMcpRequest(fields)).ack.sdkId, 'sdk-1');
  assert.equal((await sourceForExplicitMcp({ ...one.operation, text: 'altered' },
    bound)).kind, 'blocked');
  assert.notEqual((await createExplicitMcpRequest({ ...fields, cli: 'codex' })).requestId,
    one.requestId);
});

test('MCP write returns saved only with remote ACK, uses active binding for both CLIs', async t => {
  const f = await fixture(t);
  for (const cli of ['claude', 'codex']) {
    let writes = 0;
    const mcp = createReadonlyMcp({ cwd: f.root, cli, stateRoot: f.stateRoot,
      verifyNative: async () => ({ kind: 'verified' }),
      owner: async () => ({ ownerId: 'axcel-local' }),
      autoPublish: async () => f.consent,
      authorize: async () => ({ kind: 'authorized', key: 'fixture', connection: {} }),
      writer: async () => ({ kind: 'writer' }),
      remember: async (operation, options) => {
        writes++;
        assert.equal(operation.sourceIdentity.originCli, cli);
        assert.equal(operation.metadata.origin, 'assistant_report');
        assert.equal((await options.beforeDispatch()).kind, 'allowed');
        const proof = remote(operation);
        assert.equal((await options.ackLocal(operation.externalId, proof)).kind, 'acked');
        return { kind: 'stored', sdkId: proof.sdkId, qdrantId: proof.qdrantId };
      },
    });
    assert.deepEqual(await mcp.call('remember', { text: 'Promote RPO before REST tests.',
      type: 'rule' }), { kind: 'stored', memoryId: 'sdk-1', qdrantId: 'point-1' });
    assert.equal(writes, 1);
    await mcp.close();
  }
});

test('status reports only local writing configuration, without a remote check', async t => {
  const f = await fixture(t);
  const ledger = path.join(f.resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: f.resolution.projectId, collection: f.resolution.destination.collection,
    deviceId: f.consent.deviceId, generation: 1 }) + '\n', { mode: 0o600 });
  let remoteCalls = 0;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }), autoPublish: async () => f.consent,
    authorize: async () => { remoteCalls++; return { kind: 'authorized' }; } });
  const status = await mcp.call('status');
  assert.equal(status.mode, 'readwrite_configured');
  assert.equal(status.manualWriteConfigured, true);
  assert.equal(remoteCalls, 0);
  await mcp.close();
});

test('normal MCP remember uses bridge and confirms remote activation before reporting saved', async t => {
  const f = await fixture(t);
  const device = await localDevice(f.resolution.stateDir);
  assert.equal(device.kind, 'device');
  f.consent.deviceId = device.deviceId;
  const ledger = path.join(f.resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: f.resolution.projectId, collection: f.resolution.destination.collection,
    deviceId: device.deviceId, generation: 1 }) + '\n', { mode: 0o600 });
  const rows = [];
  let adds = 0;
  const id = '64eef286-9f7e-4326-b137-5658f0286c46';
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'codex', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }), autoPublish: async () => f.consent,
    authorize: async () => ({ kind: 'authorized', key: 'fixture', connection: {} }),
    writer: async () => ({ kind: 'writer' }),
    writerControl: async () => ({ kind: 'authority', record: {
      state: 'active', deviceId: device.deviceId, generation: 1 } }),
    workerFactory: () => ({ close: async () => {}, request: async (request, _auth, beforeDispatch) => {
      if (beforeDispatch) assert.equal((await beforeDispatch()).kind, 'allowed');
      if (request.op === 'dedup_find') return { kind: 'clear' };
      if (request.op === 'find') return { kind: 'items', items: rows.filter(row =>
        row.externalId === request.externalId) };
      if (request.op === 'add') {
        adds++;
        rows.push({ projectId: request.projectId, externalId: request.externalId,
          sessionId: request.sessionId, sdkId: id, qdrantId: id, status: 'pending',
          text: request.text, metadata: request.metadata });
        return { kind: 'pending', sdkId: id };
      }
      if (request.op === 'read') return { kind: 'item', item: rows[0] };
      if (request.op === 'activate') {
        rows[0].status = 'active';
        return { kind: 'item', item: rows[0] };
      }
      throw Error(`unexpected ${request.op}`);
    } }),
  });
  const args = { text: 'Compile on TRIPEX before RPO promotion.', type: 'rule' };
  assert.deepEqual(await mcp.call('remember', args),
    { kind: 'stored', memoryId: id, qdrantId: id });
  assert.deepEqual(await mcp.call('remember', args),
    { kind: 'stored', memoryId: id, qdrantId: id });
  assert.equal(adds, 1);
  await mcp.close();
});

test('MCP write rejects secrets before authorization and never reports queued as saved', async t => {
  const f = await fixture(t);
  let authorized = 0;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }), autoPublish: async () => f.consent,
    authorize: async () => { authorized++; return { kind: 'authorized', key: 'fixture', connection: {} }; },
    writer: async () => ({ kind: 'writer' }),
    remember: async () => ({ kind: 'pending', reason: 'remote_unavailable' }) });
  assert.equal((await mcp.call('remember', { text: '{"password":"fixture-canary"}' })).reason,
    'invalid_request');
  assert.equal(authorized, 0);
  assert.deepEqual(await mcp.call('remember', { text: 'Remember this project fact' }),
    { kind: 'unavailable', reason: 'remote_unavailable' });
  await mcp.close();
});

test('MCP write stops when consent changes before dispatch', async t => {
  const f = await fixture(t);
  let consent = f.consent;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'codex', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }), autoPublish: async () => consent,
    authorize: async () => ({ kind: 'authorized', key: 'fixture', connection: {} }),
    writer: async () => ({ kind: 'writer' }),
    remember: async (_operation, options) => {
      consent = null;
      const denied = await options.beforeDispatch();
      return { kind: 'pending', reason: denied.reason };
    } });
  assert.deepEqual(await mcp.call('remember', { text: 'Use a new rule' }),
    { kind: 'unavailable', reason: 'automatic_write_disabled' });
  await mcp.close();
});

test('long explicit request is discoverable by search pointer and complete through get', async t => {
  const f = await fixture(t);
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const text = 'HML_TRIPEX_COMP compila pelo TDS e a promoção de RPO precisa ocorrer antes dos testes REST. '.repeat(12);
  let saved;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }), autoPublish: async () => f.consent,
    authorize: async () => ({ kind: 'authorized', key: 'fixture', connection: {} }),
    writer: async () => ({ kind: 'writer' }),
    remember: async (operation, options) => {
      saved = { sdkId: id, projectId: operation.projectId, status: 'active',
        score: .99, scoreSource: 'mem0_sdk_search', text: operation.text,
        metadata: operation.metadata };
      const proof = { ...remote(operation), sdkId: id };
      assert.equal((await options.ackLocal(operation.externalId, proof)).kind, 'acked');
      return { kind: 'stored', sdkId: id, qdrantId: proof.qdrantId };
    },
    search: async () => ({ kind: 'items', items: saved ? [saved] : [] }),
    get: async () => ({ kind: 'item', item: { projectId: f.resolution.projectId,
      source: 'curated', text: saved.text, provenance: { generated: true,
        source: saved.metadata.source, condition: saved.metadata.condition } } }),
  });
  assert.equal((await mcp.call('remember', { text, type: 'rule',
    condition: 'Only after RPO promotion' })).kind, 'stored');
  const result = await mcp.call('search', { query: 'HML TRIPEX', source: 'curated' });
  assert.equal(result.kind, 'items');
  assert.match(result.context, /pedido via MCP\/agente/);
  assert.match(result.context, /texto longo; use get source=curated memory_id=/);
  assert.match(result.context, new RegExp(id));
  const full = await mcp.call('get', { memory_id: id, source: 'curated' });
  assert.equal(full.item.text, text);
  assert.equal(full.item.provenance.condition, 'Only after RPO promotion');
  await mcp.close();
});
