import test from 'node:test';
import assert from 'node:assert/strict';
import { transientCbsRuntimeStatus, selectExistingMemories } from '../base/memoria/curation-policy.mjs';
import { readExistingMemories } from '../base/memoria/curation-context.mjs';

test('transient CBS write status is rejected without filtering durable CBS rules or bugs', () => {
  assert.equal(transientCbsRuntimeStatus('At the time of this session, the CBS Qdrant memory for this project was read-only (automaticWriteConfigured: false), so the assistant could not write to it.'), true);
  assert.equal(transientCbsRuntimeStatus('Nesta sessão a memória CBS estava somente leitura: automaticWriteConfigured: false.'), true);
  assert.equal(transientCbsRuntimeStatus('A configuração CBS deve mostrar automaticWriteConfigured: false quando a escrita estiver desabilitada.'), false);
  assert.equal(transientCbsRuntimeStatus('Bug: CBS retornou automaticWriteConfigured: false mesmo com consentimento ativo.'), false);
  assert.equal(transientCbsRuntimeStatus('At the time of this session, the Laravel API was read-only.'), false);
});

test('existing memory context uses full active same-project text and keeps corrections', () => {
  const now = '2026-10-14T22:00:00Z';
  const prior = 'Compile A, B, C, D and E in that order.';
  const points = [
    { id: 'one', payload: { project_id: 'p', user_id: 'p', status: 'active',
      scope: 'project', data: prior, condition: 'Only after RPO promotion',
      ingested_at: '2026-10-14T20:00:00Z' } },
    { id: 'two', payload: { project_id: 'other', user_id: 'other', status: 'active',
      scope: 'project', data: 'Other project', ingested_at: now } },
    { id: 'three', payload: { project_id: 'p', user_id: 'p', status: 'superseded',
      scope: 'project', data: 'Old version', ingested_at: now } },
    { id: 'four', payload: { project_id: 'p', user_id: 'p', status: 'active',
      scope: 'personal', owner_id: 'other-owner', data: 'Private memory', ingested_at: now } },
    { id: 'five', payload: { project_id: 'p', user_id: 'p', status: 'active',
      scope: 'project', data: 'Expired memory', valid_to: '2026-10-13T22:00:00Z', ingested_at: now } },
    { id: 'six', payload: { project_id: 'p', user_id: 'p', status: 'active',
      scope: 'project', data: 'A new helper U_MZAScrUsr is needed.', ingested_at: now } },
  ];
  const selected = selectExistingMemories(points, { projectId: 'p', ownerId: 'owner',
    now, query: 'Compile A B C D E and U_MZAScrUsr' });
  assert.deepEqual(selected.map(x => x.memory_id), ['six', 'one']);
  assert.equal(selected[1].text, prior);
  assert.equal(selected[1].condition, 'Only after RPO promotion');
});

test('one trusted bounded scroll supplies context without an encoder or broker', async () => {
  let scrolls = 0;
  const consent = { enabled: true, ownerId: 'owner', consentHash: 'c'.repeat(64) };
  const row = { sessionId: 'session', projectId: 'p', messages: [
    { text: 'Compile A then B.' }] };
  const result = await readExistingMemories(row, { autoPublishConsent: consent }, {
    contextCwd: '/project', stateRoot: '/private-state',
    resolveProject: async (cwd, session, options) => {
      assert.equal(cwd, '/project');
      assert.equal(session, 'session');
      assert.equal(options.stateRoot, '/private-state');
      return { provider: 'mem0', projectId: 'p', ownerId: 'owner',
        extractor: { autoPublishConsent: consent }, destination: { collection: 'c' } };
    },
    authorize: async () => ({ kind: 'authorized', connection: { url: 'https://example.test/' },
      key: 'private' }),
    scroll: async (_connection, collection, _key, project) => {
      scrolls++;
      assert.equal(collection, 'c');
      assert.equal(project, 'p');
      return { kind: 'ready', scanned: 1, points: [
        { id: 'old', payload: { project_id: 'p', user_id: 'p', status: 'active',
          scope: 'project', data: 'Compile A then B.', ingested_at: '2026-10-14T21:00:00Z' } },
      ] };
    },
  });
  assert.equal(scrolls, 1);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.items.map(item => item.text), ['Compile A then B.']);
});

test('saturated or unreachable remote context degrades without trusting partial inventory', async () => {
  const consent = { enabled: true, ownerId: 'owner', consentHash: 'c'.repeat(64) };
  const options = { contextCwd: '/project',
    resolveProject: async () => ({ provider: 'mem0', projectId: 'p', ownerId: 'owner',
      extractor: { autoPublishConsent: consent }, destination: { collection: 'c' } }),
    authorize: async () => ({ kind: 'authorized', connection: {}, key: 'private' }) };
  const row = { sessionId: 'session', projectId: 'p', messages: [] };
  const saturated = await readExistingMemories(row, { autoPublishConsent: consent }, {
    ...options, scroll: async () => ({ kind: 'saturated', scanned: 64, items: [] }) });
  assert.equal(saturated.kind, 'saturated');
  assert.deepEqual(saturated.items, []);
  const unreachable = await readExistingMemories(row, { autoPublishConsent: consent }, {
    ...options, scroll: async () => { throw Error('offline'); } });
  assert.equal(unreachable.kind, 'unavailable');
  assert.deepEqual(unreachable.items, []);
});

test('context keeps at most eight complete memories and 4096 content bytes', () => {
  const points = Array.from({ length: 12 }, (_, n) => ({
    id: `id-${n}`, payload: { project_id: 'p', user_id: 'p', status: 'active',
      scope: 'project', data: `Compile order ${n}: ${'A'.repeat(495)}` },
  }));
  const selected = selectExistingMemories(points, { projectId: 'p', ownerId: 'owner',
    query: 'Compile order', now: '2026-10-14T22:00:00Z' });
  assert.equal(selected.length, 8);
  assert.ok(selected.every(item => points.some(point => point.payload.data === item.text)));
  assert.ok(selected.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= 4096);
  assert.deepEqual(selectExistingMemories(Array.from({ length: 70 }, (_, n) =>
    ({ ...points[n % points.length], id: `overflow-${n}` })), { projectId: 'p',
    ownerId: 'owner', query: 'Compile order' }), []);
});

test('context considers the ninth ranked memory when an earlier memory exceeds the byte budget', () => {
  const points = Array.from({ length: 9 }, (_, n) => ({ id: `id-${n}`, payload: {
    project_id: 'p', user_id: 'p', status: 'active', scope: 'project',
    data: n === 8 ? 'Short useful rule.' : 'A'.repeat(512),
    ...(n === 7 ? { condition: 'Only after approval.' } : {}),
  } }));
  const selected = selectExistingMemories(points, { projectId: 'p', ownerId: 'owner',
    now: '2026-10-14T22:00:00Z' });
  assert.deepEqual(selected.map(item => item.memory_id),
    ['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-8']);
});

test('time-bounded existing memories cannot suppress a durable new memory', () => {
  const points = [
    { id: 'future-expiry', payload: { project_id: 'p', user_id: 'p',
      status: 'active', scope: 'project', data: 'Use short-lived endpoint.',
      valid_to: '2026-12-31T00:00:00Z' } },
    { id: 'past-start', payload: { project_id: 'p', user_id: 'p',
      status: 'active', scope: 'project', data: 'Use revised endpoint.',
      valid_from: '2026-01-01T00:00:00Z' } },
    { id: 'durable', payload: { project_id: 'p', user_id: 'p',
      status: 'active', scope: 'project', data: 'Use durable endpoint.' } },
  ];
  assert.deepEqual(selectExistingMemories(points, { projectId: 'p', ownerId: 'owner',
    now: '2026-10-14T22:00:00Z' }).map(item => item.memory_id), ['durable']);
});
