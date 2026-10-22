import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadonlyMcp, installReadonlyShutdown, readonlyDefinitions, localWorkerEnvironment } from '../base/memoria/mcp-readonly.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-ro-'));
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
  return { root, stateRoot, configFile, config, resolution };
}

const item = { sdkId: 'mem-1', projectId: 'project-one', status: 'active', text: 'Use Postgres.',
  score: .97, scoreSource: 'mem0_sdk_search', metadata: { scope: 'project', source: 'message-1',
    actor: 'user', origin: 'user_direct', speaker_role: 'user', evidence_at: '2026-10-01T00:00:00Z' } };

test('local worker forwards an explicit CPU device without unrelated process secrets', () => {
  const env = localWorkerEnvironment({ PATH: '/bin', CBS_MEMORIA_EMBEDDING_DEVICE: 'cpu',
    OPENAI_API_KEY: 'secret' });
  assert.equal(env.CBS_MEMORIA_EMBEDDING_DEVICE, 'cpu');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.throws(() => localWorkerEnvironment({ CBS_MEMORIA_EMBEDDING_DEVICE: 'unknown' }),
    /embedding_device_invalid/);
});

test('standalone tools describe read and explicit write behavior', () => {
  assert.deepEqual(readonlyDefinitions.map(tool => tool.name), ['search', 'get', 'status', 'remember']);
  for (const tool of readonlyDefinitions.slice(0, 3)) assert.deepEqual(tool.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.deepEqual(readonlyDefinitions.at(-1).annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
});

test('standalone MCP searches approved project memory without session or launcher', async t => {
  const f = await fixture(t);
  let calls = 0;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: { url: f.config.qdrant.url } }),
    search: async request => { calls++; assert.equal(request.projectId, 'project-one');
      assert.equal(request.sessionId, undefined); return { kind: 'items', items: [item] }; } });
  assert.equal((await mcp.call('status')).kind, 'ready');
  assert.equal(calls, 0);
  const result = await mcp.call('search', { query: 'database' });
  assert.equal(result.kind, 'items');
  assert.match(result.context, /Use Postgres/);
  assert.equal(calls, 1);
  assert.equal((await mcp.call('propose')).reason, 'unknown_method');
  await mcp.close();
});

test('standalone MCP accepts verified lexical identifier and labels partial retrieval', async t => {
  const f = await fixture(t);
  const lexical = { ...item, text: 'HML_TRIPEX_COMP is the code.', score: undefined,
    scoreSource: 'lexical_verified', retrievalEvidence: { lexicalRank: 1,
      literalSpans: ['HML_TRIPEX_COMP'] } };
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: {} }),
    search: async () => ({ kind: 'items', items: [], lexical_items: [lexical],
      vector_degradation: 'vector_unavailable' }) });
  const found = await mcp.call('search', { query: 'HML_TRIPEX_COMP', source: 'curated' });
  assert.equal(found.kind, 'items');
  assert.equal(found.retrievalStatus, 'lexical_only');
  assert.match(found.context, /HML_TRIPEX_COMP/);
  await mcp.close();
});

test('read-only MCP status reports locally configured automatic writing without contacting Qdrant', async t => {
  const f = await fixture(t);
  let remoteCalls = 0;
  let consent = { version: 1, enabled: true, projectId: 'project-one',
    ownerId: 'axcel-local', consentHash: 'a'.repeat(64) };
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    owner: async () => ({ ownerId: 'axcel-local' }),
    autoPublish: async () => consent,
    authorize: async () => { remoteCalls++; throw Error('unexpected remote call'); } });
  assert.deepEqual(await mcp.call('status'), { kind: 'ready', provider: 'mem0',
    mode: 'readonly', projectId: 'project-one', automaticWriteConfigured: true,
    manualWriteConfigured: false });
  consent = null;
  assert.equal((await mcp.call('status')).automaticWriteConfigured, false);
  assert.equal(remoteCalls, 0);
  await mcp.close();
});

test('standalone MCP denies changed trust, project root overrides and bad queries before authorization', async t => {
  const f = await fixture(t);
  let authorized = 0;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'codex', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => { authorized++; return { kind: 'authorized', key: 'private', connection: {} }; },
    search: async () => ({ kind: 'items', items: [item] }) });
  assert.equal((await mcp.call('search', { query: 'database', projectRoot: '/other' })).reason, 'invalid_arguments');
  assert.equal((await mcp.call('search', { query: ' '.repeat(4100) })).reason, 'invalid_query');
  assert.equal(authorized, 0);
  assert.equal((await mcp.call('status')).kind, 'ready');
  f.config.qdrant.collection = 'other';
  await fs.writeFile(f.configFile, JSON.stringify(f.config));
  assert.equal((await mcp.call('search', { query: 'database' })).reason, 'project_changed');
  assert.equal(authorized, 0);
  await mcp.close();
});

test('standalone MCP denies missing native verification before secret/network', async t => {
  const f = await fixture(t);
  let authorized = false;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'blocked', reason: 'native_config_changed' }),
    authorize: async () => { authorized = true; return {}; } });
  assert.equal((await mcp.call('search', { query: 'database' })).reason, 'native_config_changed');
  assert.equal(authorized, false);
  await mcp.close();
});

test('standalone MCP freezes initial project binding before first tool call', async t => {
  const f = await fixture(t);
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }) });
  await mcp.ready;
  f.config.qdrant.collection = 'changed-before-first-call';
  await fs.writeFile(f.configFile, JSON.stringify(f.config));
  assert.equal((await mcp.call('status')).reason, 'project_changed');
  await mcp.close();
});


test('SIGTERM closes only the owned MCP worker before process exit', async () => {
  const emitter = new EventEmitter();
  const events = [];
  const removed = installReadonlyShutdown({ close: async () => { events.push('close'); } },
    emitter, code => { events.push(`exit:${code}`); });
  emitter.emit('SIGTERM');
  emitter.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['close', 'exit:0']);
  removed();
});

test('explicit search returns curated first and bounded labelled legacy pointers', async t => {
  const f = await fixture(t);
  const calls = [];
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: {} }),
    search: async request => { calls.push(`curated:${request.query}`); return { kind: 'items', items: [item] }; },
    legacySearch: async request => { calls.push(`legacy:${request.query}`); return { kind: 'items', items: [
      { id: '27dbfc70-f05f-4b74-a2a0-3d41f87807dd', readId: '64eef286-9f7e-4326-b137-5658f0286c46',
        preview: 'Old generated note', sourceProject: 'old-name', sourceTable: 'observations',
        sourceId: 42, evidenceAt: '2024-01-01T00:00:00Z', score: .83 } ] }; } });
  const result = await mcp.call('search', { query: 'database' });
  assert.equal(result.kind, 'items');
  assert.deepEqual(calls, ['curated:database', 'legacy:database']);
  assert.ok(result.context.indexOf('Use Postgres.') < result.context.indexOf('Old generated note'));
  assert.match(result.context, /Claude-mem legado.*não verificado/);
  assert.match(result.context, /64eef286-9f7e-4326-b137-5658f0286c46/);
  calls.length = 0;
  const curated = await mcp.call('search', { query: 'database', source: 'curated' });
  assert.equal(curated.kind, 'items');
  assert.deepEqual(calls, ['curated:database']);
  await mcp.close();
});

test('active automatic v3 memory remains searchable as curated source', async t => {
  const f = await fixture(t);
  const id = '64eef286-9f7e-4326-b137-5658f0286c46';
  const automatic = { ...item, sdkId: id, text: 'Use Postgres for project memory.',
    metadata: { ...item.metadata, format_version: 3, type: 'rule',
      review_mode: 'automatic', auto_actor: 'project_auto_publisher',
      auto_consent_hash: 'a'.repeat(64) } };
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: {} }),
    search: async () => ({ kind: 'items', items: [automatic] }),
    get: async ({ projectId }) => ({ kind: 'item', item: { projectId, source: 'curated',
      memoryId: id, text: automatic.text, offset: 0, nextOffset: null } }) });
  const found = await mcp.call('search', { query: 'project memory', source: 'curated' });
  assert.equal(found.kind, 'items');
  assert.match(found.context, /Use Postgres for project memory/);
  assert.doesNotMatch(found.context, /human.review/i);
  const read = await mcp.call('get', { memory_id: id, source: 'curated' });
  assert.equal(read.item.text, automatic.text);
  await mcp.close();
});

test('active conversation summary is labelled as generated in MCP search and get', async t => {
  const f = await fixture(t);
  const id = '64eef286-9f7e-4326-b137-5658f0286c46';
  const sourceRefs = [
    { message_id: 'm1', role: 'user', origin: 'human', actor: 'user',
      offsets: { start: 0, end: 20 }, source_text_sha256: 'a'.repeat(64),
      excerpt: 'Use PostgreSQL.' },
    { message_id: 'm2', role: 'assistant', origin: 'assistant', actor: 'assistant',
      offsets: { start: 21, end: 70 }, source_text_sha256: 'b'.repeat(64),
      excerpt: 'I will use PostgreSQL.' },
  ];
  const summary = { ...item, sdkId: id, text: 'The conversation chose PostgreSQL.',
    metadata: { ...item.metadata, source: 'm1', actor: 'conversation',
      origin: 'conversation_summary', speaker_role: 'mixed', format_version: 4,
      type: 'decision', source_offsets: sourceRefs[0].offsets,
      source_text_sha256: sourceRefs[0].source_text_sha256,
      dedup_key: dedupKeyFor({ projectId: 'project-one', scope: 'project',
        type: 'decision', text: 'The conversation chose PostgreSQL.' }),
      source_refs: sourceRefs } };
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: {} }),
    search: async () => ({ kind: 'items', items: [summary] }),
    get: async ({ projectId }) => ({ kind: 'item', item: { projectId, source: 'curated',
      memoryId: id, text: summary.text, provenance: { generated: true,
        origin: 'conversation_summary', source_refs: sourceRefs },
      offset: 0, nextOffset: null } }) });
  const found = await mcp.call('search', { query: 'PostgreSQL', source: 'curated' });
  assert.equal(found.kind, 'items');
  assert.match(found.context, /resumo gerado; referências 2/);
  assert.match(found.context, /Current human instruction takes precedence/);
  const read = await mcp.call('get', { memory_id: id, source: 'curated' });
  assert.equal(read.item.provenance.generated, true);
  assert.deepEqual(read.item.provenance.source_refs, sourceRefs);
  await mcp.close();
});

test('legacy absence is empty and untrusted selector is rejected before authorization', async t => {
  const f = await fixture(t);
  let authorized = 0;
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'codex', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => { authorized++; return { kind: 'authorized', key: 'private', connection: {} }; },
    search: async () => ({ kind: 'items', items: [] }),
    legacySearch: async () => ({ kind: 'items', items: [] }) });
  assert.equal((await mcp.call('search', { query: 'db', source: 'other' })).reason, 'invalid_source');
  assert.equal((await mcp.call('search', { query: 'db', collection: 'foreign' })).reason, 'invalid_arguments');
  assert.equal((await mcp.call('get', { memory_id: 'x', source: 'legacy' })).reason, 'invalid_memory_id');
  assert.equal(authorized, 0);
  assert.equal((await mcp.call('search', { query: 'db' })).kind, 'abstain');
  assert.equal(authorized, 1);
  await mcp.close();
});

test('get binds UUID and source, pages only the selected project result', async t => {
  const f = await fixture(t);
  const id = '64eef286-9f7e-4326-b137-5658f0286c46';
  const requests = [];
  const mcp = createReadonlyMcp({ cwd: f.root, cli: 'claude', stateRoot: f.stateRoot,
    verifyNative: async () => ({ kind: 'verified' }),
    authorize: async () => ({ kind: 'authorized', key: 'private', connection: {} }),
    get: async request => { requests.push(request); return { kind: 'item', item: {
      projectId: request.projectId, source: 'legacy', label: 'Claude-mem legado, gerado, não verificado',
      text: 'old page', offset: request.offset, nextOffset: null } }; } });
  assert.equal((await mcp.call('get', { memory_id: id, source: 'legacy', offset: 0 })).kind, 'item');
  assert.deepEqual(requests.map(row => [row.memoryId, row.source, row.projectId]),
    [[id, 'legacy', 'project-one']]);
  assert.equal((await mcp.call('get', { memory_id: id, source: 'legacy', offset: -1 })).reason, 'invalid_offset');
  assert.equal((await mcp.call('get', { memory_id: id, source: 'other' })).reason, 'invalid_source');
  assert.equal((await mcp.call('get', { memory_id: id, source: 'curated', projectRoot: '/other' })).reason, 'invalid_arguments');
  await mcp.close();
});
