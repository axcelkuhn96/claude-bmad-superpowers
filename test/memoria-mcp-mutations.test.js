import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReadonlyMcp, readonlyDefinitions } from '../base/memoria/mcp-readonly.mjs';
import * as proof from '../base/memoria/mcp-request-proof.mjs';
import { targetVersion } from '../base/memoria/correction.mjs';
import { mcpOperationMatches } from '../base/memoria/broker.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { localDevice } from '../base/memoria/policy.mjs';

const id = '64eef286-9f7e-4326-b137-5658f0286c46';
async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-mutation-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const consent = { version: 1, enabled: true, projectId: 'p', ownerId: 'alice',
    consentHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64),
    deviceId: 'device', enabledAt: '2026-10-22T00:00:00Z' };
  const resolution = { provider: 'mem0', stateDir, projectId: 'p', projectRoot: '/project',
    destination: { collection: 'curated' }, ownerId: 'alice',
    extractor: { autoPublish: true, autoPublishConsent: consent } };
  const target = { sdkId: id, qdrantId: id, externalId: 'source-1', projectId: 'p',
    status: 'active', text: 'Old text', metadata: { scope: 'personal', owner_id: 'alice',
      type: 'rule', condition: 'during tests', status: 'active' } };
  return { consent, resolution, target, base: { resolution, cli: 'codex',
    profile: '/profiles/codex', ownerId: 'alice', consent } };
}

async function mcpFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-mutation-live-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const stateRoot = path.join(base, 'state');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  assert.equal(spawnSync('git', ['-C', root, 'init', '-q']).status, 0);
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p', qdrant: {
      url: 'https://mem.example.org/', address: '157.230.226.207', allow_public: true,
      collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' }, embedding: {
      model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } }));
  const resolution = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  const device = await localDevice(resolution.stateDir);
  const consent = { version: 1, enabled: true, projectId: resolution.projectId,
    ownerId: 'alice', consentHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64),
    deviceId: device.deviceId, enabledAt: '2026-10-22T00:00:00Z' };
  const ledger = path.join(resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: resolution.projectId, collection: resolution.destination.collection,
    deviceId: device.deviceId, generation: 1 }) + '\n', { mode: 0o600 });
  return { root, stateRoot, resolution, consent, device };
}

function mcpOptions(f, workerFactory, overrides = {}) {
  return { cwd: f.root, cli: 'codex', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'alice' }), autoPublish: async () => f.consent,
    authorize: async () => ({ kind: 'authorized', key: 'fixture', connection: {} }),
    writer: async () => ({ kind: 'writer' }),
    writerControl: async () => ({ kind: 'authority', record: {
      state: 'active', deviceId: f.device.deviceId, generation: 1 } }),
    workerFactory, ...overrides };
}

test('normal MCP exposes update and delete with truthful mutation annotations', () => {
  const update = readonlyDefinitions.find(item => item.name === 'update');
  const remove = readonlyDefinitions.find(item => item.name === 'delete');
  assert.ok(update);
  assert.ok(remove);
  assert.deepEqual(update.annotations, { readOnlyHint: false, destructiveHint: false,
    idempotentHint: true, openWorldHint: true });
  assert.deepEqual(remove.annotations, { readOnlyHint: false, destructiveHint: true,
    idempotentHint: true, openWorldHint: true });
  assert.deepEqual(update.inputSchema.required, ['memory_id', 'text']);
  assert.deepEqual(remove.inputSchema.required, ['memory_id']);
});

test('update source preserves target identity and honest MCP correction provenance', async t => {
  const f = await fixture(t);
  const created = await proof.createExplicitMcpRequest({ ...f.base, text: 'New text',
    type: 'rule', scope: 'personal', condition: 'during tests', correctionTarget: f.target });
  assert.equal(created.kind, 'request');
  assert.equal(created.operation.metadata.supersedes_id, id);
  assert.equal(created.operation.metadata.correction_target_version, targetVersion(f.target));
  assert.equal(created.operation.metadata.origin, 'assistant_report');
  assert.equal(created.operation.metadata.review_mode, 'explicit_mcp');
  assert.equal((await proof.sourceForExplicitMcp(created.operation, f.resolution)).kind, 'local_source');
  assert.equal(mcpOperationMatches({ op: 'read', projectId: 'p', sdkId: id },
    created.operation), true);
  assert.equal((await proof.sourceForExplicitMcp({ ...created.operation,
    metadata: { ...created.operation.metadata, correction_target_version: '0'.repeat(64) } },
  f.resolution)).kind, 'blocked');
});

test('delete source is bound to project, owner, ID, version and local consent', async t => {
  const f = await fixture(t);
  assert.equal(typeof proof.createExplicitMcpDeleteRequest, 'function');
  const created = await proof.createExplicitMcpDeleteRequest({ ...f.base,
    memoryId: id, expectedVersion: targetVersion(f.target) });
  assert.equal(created.kind, 'request');
  assert.equal(created.operation.op, 'delete_curated');
  assert.equal((await proof.sourceForExplicitMcp(created.operation, f.resolution)).kind, 'local_source');
  assert.equal(mcpOperationMatches(created.operation, created.operation), true);
  assert.equal(mcpOperationMatches({ ...created.operation, memoryId: '64eef286-9f7e-4326-b137-5658f0286c47' },
    created.operation), false);
  assert.equal((await proof.sourceForExplicitMcp(created.operation,
    { ...f.resolution, ownerId: 'bob' })).kind, 'blocked');
});

test('MCP update supersedes only the selected active memory after remote ACK', async t => {
  const f = await mcpFixture(t);
  const nextId = '64eef286-9f7e-4326-b137-5658f0286c48';
  const old = { sdkId: id, qdrantId: id, externalId: 'source-1', projectId: 'p',
    status: 'active', text: 'Old text', metadata: { scope: 'project', type: 'rule',
      condition: 'during tests', status: 'active', source: 'message', actor: 'human',
      origin: 'user_direct', speaker_role: 'user', evidence_at: '2026-10-20T00:00:00Z' } };
  const other = { ...old, sdkId: '64eef286-9f7e-4326-b137-5658f0286c47',
    qdrantId: '64eef286-9f7e-4326-b137-5658f0286c47', externalId: 'source-2' };
  const rows = new Map([[old.sdkId, old], [other.sdkId, other]]);
  const mcp = createReadonlyMcp(mcpOptions(f, () => ({ close: async () => {},
    request: async (request, _auth, beforeDispatch) => {
      if (beforeDispatch) assert.equal((await beforeDispatch()).kind, 'allowed');
      if (request.op === 'mutation_target') return { kind: 'item', item: rows.get(request.memoryId) };
      if (request.op === 'dedup_find') return { kind: 'clear' };
      if (request.op === 'find') return { kind: 'items', items: [...rows.values()].filter(row =>
        row.externalId === request.externalId) };
      if (request.op === 'read') return { kind: 'item', item: rows.get(request.sdkId) };
      if (request.op === 'add') {
        rows.set(nextId, { sdkId: nextId, qdrantId: nextId, externalId: request.externalId,
          projectId: 'p', sessionId: request.sessionId, text: request.text,
          metadata: request.metadata, status: 'pending' });
        return { kind: 'pending', sdkId: nextId };
      }
      if (request.op === 'activate') {
        const next = rows.get(nextId);
        rows.set(id, { ...rows.get(id), status: 'superseded', metadata: {
          ...rows.get(id).metadata, status: 'superseded',
          superseded_by: nextId,
          superseded_by_external_id: next.externalId } });
        rows.set(nextId, { ...next, status: 'active' });
        return { kind: 'item', item: rows.get(nextId) };
      }
      throw Error(`unexpected ${request.op}`);
    } })));
  const result = await mcp.call('update', { memory_id: id, text: 'New text' });
  assert.deepEqual(result, { kind: 'updated', memoryId: nextId, previousMemoryId: id });
  assert.equal(rows.get(id).status, 'superseded');
  assert.equal(rows.get(nextId).metadata.type, 'rule');
  assert.equal(rows.get(nextId).metadata.condition, 'during tests');
  assert.equal(rows.get(other.sdkId).status, 'active');
  await mcp.close();
});

test('MCP delete confirms target absence and leaves other memories untouched', async t => {
  const f = await mcpFixture(t);
  const other = '64eef286-9f7e-4326-b137-5658f0286c47';
  const rows = new Map([[id, { sdkId: id, qdrantId: id, externalId: 'source-1',
    projectId: 'p', status: 'active', text: 'Old text', metadata: {
      scope: 'project', type: 'fact', status: 'active' } }],
  [other, { sdkId: other, projectId: 'p', status: 'active' }]]);
  let deletions = 0;
  const mcp = createReadonlyMcp(mcpOptions(f, () => ({ close: async () => {},
    request: async (request, _auth, beforeDispatch) => {
      if (beforeDispatch) assert.equal((await beforeDispatch()).kind, 'allowed');
      if (request.op === 'mutation_target') return rows.has(request.memoryId)
        ? { kind: 'item', item: rows.get(request.memoryId) }
        : { kind: 'absent', memoryId: request.memoryId };
      if (request.op === 'delete_curated') {
        deletions++;
        rows.delete(request.memoryId);
        return { kind: 'deleted', memoryId: request.memoryId };
      }
      throw Error(`unexpected ${request.op}`);
    } })));
  assert.deepEqual(await mcp.call('delete', { memory_id: id }),
    { kind: 'deleted', memoryId: id });
  assert.deepEqual(await mcp.call('delete', { memory_id: id }),
    { kind: 'absent', memoryId: id });
  assert.equal(deletions, 1);
  assert.deepEqual([...rows.keys()], [other]);
  await mcp.close();
});

test('MCP mutations reject invalid inputs and disabled writing before remote access', async t => {
  const f = await mcpFixture(t);
  let remote = 0;
  const mcp = createReadonlyMcp(mcpOptions(f, () => ({ close: async () => {},
    request: async () => { remote++; return { kind: 'absent', memoryId: id }; } })));
  assert.equal((await mcp.call('update', { memory_id: 'bad', text: 'new' })).reason,
    'invalid_memory_id');
  assert.equal((await mcp.call('delete', { memory_id: 'bad' })).reason,
    'invalid_memory_id');
  assert.equal((await mcp.call('update', { memory_id: id, text: ' ' })).reason,
    'invalid_request');
  assert.equal(remote, 0);
  f.consent.enabled = false;
  assert.equal((await mcp.call('delete', { memory_id: id })).reason,
    'automatic_write_disabled');
  assert.equal(remote, 0);
  await mcp.close();
});

test('MCP delete does not claim success for foreign owner, conflict or failed remote ACK', async t => {
  const f = await mcpFixture(t);
  let target = { kind: 'blocked', reason: 'target_unavailable' };
  let outcome = { kind: 'conflict', reason: 'target_changed' };
  let deletes = 0;
  const mcp = createReadonlyMcp(mcpOptions(f, () => ({ close: async () => {},
    request: async request => {
      if (request.op === 'mutation_target') return target;
      if (request.op === 'delete_curated') { deletes++; return outcome; }
      throw Error(`unexpected ${request.op}`);
    } })));
  assert.equal((await mcp.call('delete', { memory_id: id })).reason, 'target_unavailable');
  assert.equal(deletes, 0);
  target = { kind: 'item', item: { sdkId: id, qdrantId: id,
    externalId: 'source-1', projectId: 'p', status: 'active', text: 'old',
    metadata: { scope: 'personal', owner_id: 'alice', type: 'fact' } } };
  assert.equal((await mcp.call('delete', { memory_id: id })).kind, 'conflict');
  outcome = { kind: 'unavailable', reason: 'remote_delete_failed' };
  assert.deepEqual(await mcp.call('delete', { memory_id: id }),
    { kind: 'unavailable', reason: 'remote_delete_failed' });
  assert.equal(deletes, 2);
  await mcp.close();
});
