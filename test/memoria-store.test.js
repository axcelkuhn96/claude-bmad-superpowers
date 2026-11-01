import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, externalIdFor, reconcileStore, transferWriter, withProjectLock } from '../base/memoria/ledger.mjs';
import { runBridgeOperation, searchProject } from '../base/memoria/bridge.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { createExplicitMcpRequest } from '../base/memoria/mcp-request-proof.mjs';

async function seedLedger(stateDir, writerId = 'writer-a') {
  await fs.mkdir(path.join(stateDir, 'ledger'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'ledger', 'writer.json'), JSON.stringify({
    projectId: 'p', deviceId: writerId, collection: 'fixture', generation: 1 }) + '\n', { mode: 0o600 });
}

test('explicit MCP request stores only a sealed source and confirms the remote ACK', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'project');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const deviceId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(root, 'device.json'), JSON.stringify({ deviceId }) + '\n', { mode: 0o600 });
  await seedLedger(stateDir, deviceId);
  const consent = { version: 1, enabled: true, projectId: 'p', ownerId: 'owner',
    destinationHash: 'a'.repeat(64), consentHash: 'b'.repeat(64), deviceId,
    enabledAt: '2026-10-14T12:00:00Z' };
  const resolution = { provider: 'mem0', projectId: 'p', projectRoot: root, stateDir,
    ownerId: 'owner', destination: { collection: 'fixture', url: 'https://example.test:48677/' },
    extractor: { autoPublish: true, autoPublishConsent: consent } };
  const source = await createExplicitMcpRequest({ resolution, cli: 'claude',
    profile: path.join(root, 'profile'), ownerId: 'owner', consent,
    text: 'Compilar no TRIPEX_COMP antes de promover RPO.', type: 'rule' });
  assert.equal(source.kind, 'request');
  const rows = [];
  let additions = 0;
  let acknowledgements = 0;
  const options = {
    resolve: async () => resolution, authorize: async () => ({ kind: 'authorized', key: 'test-key',
      connection: { url: resolution.destination.url } }),
    readAutoPublish: async () => consent, autoPublishConsent: consent,
    control: async () => ({ kind: 'protocol' }),
    run: async (_python, _script, request) => {
      if (request.op === 'dedup_find') return { kind: 'clear' };
      if (request.op === 'find') return { kind: 'items', items: rows.filter(row =>
        row.externalId === request.externalId) };
      if (request.op === 'add') {
        additions++;
        rows.push({ projectId: 'p', externalId: request.externalId,
          sessionId: request.sessionId,
          sdkId: '64eef286-9f7e-4326-b137-5658f0286c46',
          qdrantId: '64eef286-9f7e-4326-b137-5658f0286c46', status: 'pending',
          text: request.text, metadata: request.metadata });
        return { kind: 'pending', sdkId: rows[0].sdkId };
      }
      if (request.op === 'read') return { kind: 'item', item: rows[0] };
      if (request.op === 'activate') {
        rows[0].status = 'active';
        return { kind: 'item', item: rows[0] };
      }
      throw new Error('unexpected SDK operation');
    },
    ackLocal: async externalId => {
      acknowledgements++;
      return { kind: 'acked', operationId: externalId };
    },
  };
  const denied = await storeMemory(root, source.operation.sessionId,
    { ...source.operation, text: 'Tampered' }, () => 'secret', options);
  assert.equal(denied.kind, 'blocked');
  assert.equal(additions, 0);
  const revoked = await storeMemory(root, source.operation.sessionId, source.operation,
    () => 'secret', { ...options, readAutoPublish: async () => ({ ...consent, enabled: false }) });
  assert.equal(revoked.kind, 'blocked');
  assert.equal(additions, 0);
  const stored = await storeMemory(root, source.operation.sessionId, source.operation,
    () => 'secret', options);
  assert.equal(stored.kind, 'stored', JSON.stringify(stored));
  assert.equal(additions, 1);
  assert.equal(acknowledgements, 1);
});

test('remote-add observation runs after real bridge add and before local ACK', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-remote-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'project');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const deviceId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(root, 'device.json'), JSON.stringify({ deviceId }) + '\n', { mode: 0o600 });
  await seedLedger(stateDir, deviceId);
  const sourceIdentity = { projectId: 'p', originCli: 'claude', sessionId: 's',
    start: 0, end: 1, sliceHash: 'a'.repeat(64), policyVersion: 'v1' };
  const operation = { externalId: externalIdFor(sourceIdentity), projectId: 'p', sessionId: 's',
    sourceIdentity, text: 'fact', approval: { kind: 'approved' },
    metadata: { source: 'm', actor: 'human', origin: 'user_direct',
      scope: 'project', evidence_at: '2026-10-09T00:00:00Z' } };
  const rows = [];
  let acked = false;
  let boundary = false;
  const result = await storeMemory('fixture', 's', operation, () => 'key', {
    stateRoot: root,
    resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir,
      destination: { collection: 'fixture' } }),
    authorize: async () => ({ kind: 'authorized', key: 'key', connection: { url: 'http://127.0.0.1/' } }),
    control: async () => ({ kind: 'protocol' }),
    run: async (_python, _script, request) => {
      if (request.op === 'find') return { kind: 'items', items: rows };
      if (request.op === 'add') { rows.push({ ...request, sdkId: 'sdk', qdrantId: 'q', status: 'pending' });
        return { kind: 'pending' }; }
      throw new Error('unexpected continuation');
    },
    onRemoteAdd: async () => { boundary = true; throw new Error('contained_crash_boundary'); },
    ackLocal: async () => { acked = true; return { kind: 'acked', operationId: operation.externalId }; },
  });
  assert.equal(result.kind, 'pending');
  assert.equal(boundary, true);
  assert.equal(rows.length, 1);
  assert.equal(acked, false);
});

test('remote write before local ACK is reconciled without another SDK add', async () => {
  const operation = { externalId: 'src-claude-s1-0-84-v1', projectId: 'p' };
  const remote = { externalId: operation.externalId, projectId: 'p', sdkId: 'sdk-7', qdrantId: 'q-7', status: 'active' };
  let adds = 0;
  const acks = [];
  const result = await reconcileStore(operation, {
    findRemote: async () => remote,
    addViaSdk: async () => { adds++; throw new Error('duplicate write'); },
    ackLocal: async (externalId, proof) => { acks.push({ externalId, proof }); return { kind: 'acked', operationId: externalId }; },
  });
  assert.deepEqual(result, { kind: 'stored', externalId: operation.externalId, sdkId: 'sdk-7', qdrantId: 'q-7', verified: true });
  assert.equal(adds, 0);
  assert.equal(acks.length, 1);
});

test('verified remote state remains pending without a successful local ACK', async () => {
  const operation = { externalId: 'source-no-ack', projectId: 'p' };
  const remote = { ...operation, sdkId: 'uuid-1', qdrantId: 'uuid-1', status: 'active' };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  try {
    await seedLedger(root);
    const ledger = createLedger(root, 'writer-a', 1);
    const deps = { ledger, findRemote: async () => [remote], readRemote: async () => remote };
    assert.deepEqual(await reconcileStore(operation, deps), { kind: 'pending', reason: 'ack_required' });
    assert.notEqual((await ledger.read(operation.externalId)).status, 'acked');
    assert.equal((await reconcileStore(operation, { ...deps, ackLocal: async () => { throw new Error('disk full'); } })).kind, 'pending');
    assert.notEqual((await ledger.read(operation.externalId)).status, 'acked');
    assert.deepEqual(await reconcileStore(operation, { ...deps, ackLocal: async () => ({ kind: 'blocked', reason: 'missing_operation' }) }),
      { kind: 'pending', reason: 'local_ack_unconfirmed' });
    assert.notEqual((await ledger.read(operation.externalId)).status, 'acked');
    assert.equal((await reconcileStore(operation, { ...deps, ackLocal: async () => ({ kind: 'acked', operationId: 'other' }) })).kind,
      'pending');
    assert.equal((await reconcileStore(operation, { ...deps, ackLocal: async () => undefined })).kind,
      'pending');
    assert.equal((await reconcileStore(operation, { ...deps, ackLocal: async () => ({ kind: 'acked', operationId: operation.externalId }) })).kind, 'stored');
    assert.equal((await ledger.read(operation.externalId)).status, 'acked');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('canonical persists before activation and a late pending never replaces it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedLedger(root);
  const ledger = createLedger(root, 'writer-a', 1);
  const op = { externalId: 'source-1-policy-1', projectId: 'p', sessionId: 's', text: 'rule', metadata: { origin: 'user_direct', actor: 'owner', source: 'msg1', scope: 'project' } };
  const rows = [];
  let activates = 0;
  const deps = {
    ledger,
    findRemote: async () => rows,
    addViaSdk: async () => { rows.push({ sdkId: 'uuid-b', qdrantId: 'uuid-b', externalId: op.externalId, projectId: 'p', sessionId: 's', metadata: op.metadata, status: 'pending', text: op.text }); },
    activateViaSdk: async (id) => { activates++; assert.equal((await ledger.read(op.externalId)).canonicalId, id); rows.find(r => r.sdkId === id).status = 'active'; },
    readRemote: async (id) => rows.find(r => r.sdkId === id),
    ackLocal: async id => ({ kind: 'acked', operationId: id }),
  };
  assert.equal((await reconcileStore(op, deps)).kind, 'stored');
  rows.push({ sdkId: 'uuid-a', qdrantId: 'uuid-a', externalId: op.externalId, projectId: 'p', sessionId: 's', metadata: op.metadata, status: 'pending', text: op.text });
  assert.equal((await reconcileStore(op, deps)).sdkId, 'uuid-b');
  assert.equal(activates, 1);
  assert.equal(rows.filter(r => r.status === 'active').length, 1);
});

test('timeout remains pending and a second local device can retry the same ledger', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const op = { externalId: 'source-2-policy-1', projectId: 'p', sessionId: 's', text: 'rule' };
  await seedLedger(root);
  const ledger = createLedger(root, 'writer-a', 1);
  const deps = { ledger, findRemote: async () => [], addViaSdk: async () => { throw new Error('timeout'); } };
  assert.deepEqual(await reconcileStore(op, deps), { kind: 'pending', reason: 'remote_error' });
  assert.equal((await ledger.read(op.externalId)).attempts, 1);
  assert.deepEqual(await reconcileStore(op, { ...deps, ledger: createLedger(root, 'writer-b', 1) }),
    { kind: 'pending', reason: 'remote_error' });
});

test('typed add failure is preserved and exact replay observes committed remote row without another add', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedLedger(root);
  const operation = { externalId: 'source-queue-timeout', projectId: 'p',
    sessionId: 's', text: 'rule', metadata: { origin: 'user_direct' } };
  const ledger = createLedger(root, 'writer-a', 1);
  const rows = [];
  let adds = 0;
  const deps = {
    ledger, findRemote: async () => rows,
    addViaSdk: async () => {
      adds++;
      rows.push({ ...operation, sdkId: 'sdk-1', qdrantId: 'q-1', status: 'pending' });
      throw Object.assign(new Error('arbitrary secret'), { code: 'queue_timeout' });
    },
    readRemote: async () => rows[0],
    activateViaSdk: async () => { rows[0].status = 'active'; },
    ackLocal: async externalId => ({ kind: 'acked', operationId: externalId }),
  };
  assert.deepEqual(await reconcileStore(operation, deps),
    { kind: 'pending', reason: 'queue_timeout' });
  assert.equal((await ledger.read(operation.externalId)).lastError, 'queue_timeout');
  assert.equal(await reconcileStore(operation, deps).then(value => value.kind), 'stored');
  assert.equal(adds, 1);
});

test('bridge reauthorizes every operation and never serializes the key', async () => {
  let authorizations = 0;
  const requests = [];
  const options = {
    resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: '/tmp/state', destination: { collection: 'c' } }),
    authorize: async () => { authorizations++; return { kind: 'authorized', key: 'private-secret',
      connection: { url: 'http://localhost:6333/', hostname: 'localhost', address: '127.0.0.1', port: 6333 } }; },
    run: async (_python, _script, request, env, secret) => { requests.push(request); assert.equal(env.CBS_MEMORIA_API_KEY, undefined); assert.equal(secret.toString(), 'private-secret'); return { kind: 'items', items: [] }; },
  };
  await runBridgeOperation('cwd', 's', { op: 'find', projectId: 'p', externalId: 'x' }, () => '', options);
  await runBridgeOperation('cwd', 's', { op: 'find', projectId: 'p', externalId: 'y' }, () => '', options);
  assert.equal(authorizations, 2);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests).includes('private-secret'), false);
});

test('bridge caps numerical threads in the Python child without changing parent environment', async () => {
  const names = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = '64';
    const result = await runBridgeOperation('cwd', 's', { op: 'find', projectId: 'p', externalId: 'x' }, () => '', {
      resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: '/tmp/state', destination: { collection: 'c' } }),
      authorize: async () => ({ kind: 'authorized', key: 'private-secret', connection: {} }),
      run: async (_python, _script, _request, env) => {
        assert.deepEqual(names.map(name => env[name]), ['2', '1', '1']);
        assert.deepEqual(names.map(name => process.env[name]), ['64', '64', '64']);
        return { kind: 'items', items: [] };
      },
    });
    assert.equal(result.kind, 'items');
    assert.deepEqual(names.map(name => process.env[name]), ['64', '64', '64']);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('search derives project identity from frozen session', async () => {
  const requests = [];
  const options = {
    resolve: async () => ({ provider: 'mem0', projectId: 'frozen-project', stateDir: '/tmp/state', destination: { collection: 'c' } }),
    authorize: async () => ({ kind: 'authorized', key: 'private-secret', connection: { url: 'http://localhost:6333/' } }),
    run: async (_python, _script, request) => { requests.push(request); return { kind: 'items', items: [] }; },
  };
  assert.equal((await searchProject({ cwd: 'cwd', sessionId: 's', query: 'release' }, () => '', options)).kind, 'items');
  assert.equal(requests[0].projectId, 'frozen-project');
  assert.equal(requests[0].query, 'release');
  assert.equal((await searchProject({ cwd: 'cwd', sessionId: 's', query: 'release', projectId: 'other' }, () => '', options)).kind, 'blocked');
  assert.equal(requests.length, 1);
});

test('search blocks when session project changes between resolution and bridge', async () => {
  let resolutions = 0;
  let runs = 0;
  const options = {
    resolve: async () => ({ provider: 'mem0', projectId: ++resolutions === 1 ? 'initial' : 'changed',
      stateDir: '/tmp/state', destination: { collection: 'c' } }),
    authorize: async () => ({ kind: 'authorized', key: 'secret', connection: {} }),
    run: async () => { runs++; return { kind: 'items', items: [] }; },
  };
  assert.equal((await searchProject({ cwd: 'cwd', sessionId: 's', query: 'fact' }, () => '', options)).kind, 'blocked');
  assert.equal(runs, 0);
});

test('two corrections of the same version become a conflict', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedLedger(root);
  const ledger = createLedger(root, 'writer-a', 1);
  const base = { projectId: 'p', sessionId: 's', text: 'corrected', metadata: { supersedes_id: 'old-uuid' } };
  assert.equal((await ledger.begin({ ...base, externalId: 'correction-a' })).externalId, 'correction-a');
  assert.deepEqual(await ledger.begin({ ...base, externalId: 'correction-b' }),
    { kind: 'conflict', reason: 'concurrent_correction' });
});

test('external ID depends on source slice and policy', () => {
  const source = { projectId: 'p', originCli: 'claude', sessionId: 's', start: 0,
    end: 12, sliceHash: 'a'.repeat(64), policyVersion: 'v1' };
  assert.equal(externalIdFor(source), externalIdFor({ ...source }));
  assert.notEqual(externalIdFor(source), externalIdFor({ ...source, start: 1 }));
  assert.notEqual(externalIdFor(source), externalIdFor({ ...source, policyVersion: 'v2' }));
  assert.notEqual(externalIdFor({ ...source, candidateKey: 'fact-0' }), externalIdFor({ ...source, candidateKey: 'fact-1' }));
  assert.equal(externalIdFor({ ...source, candidateKey: 'fact-0' }), externalIdFor({ ...source, candidateKey: 'fact-0' }));
  assert.throws(() => externalIdFor({ ...source, candidateKey: '' }), /invalid_source_identity/);
});

test('project lock serializes independent writer processes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const order = [];
  let release;
  let entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const first = withProjectLock(root, async () => {
    order.push('first'); entered(); await new Promise(resolve => { release = resolve; });
  });
  await firstEntered;
  const second = withProjectLock(root, async () => { order.push('second'); });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(order, ['first']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('legacy local transfer is inert and local ledger is not bound to one writer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operation = { projectId: 'p', externalId: 'source-policy', text: 'fact' };
  await seedLedger(root);
  const first = createLedger(root, 'writer-a', 1);
  const record = await first.begin(operation);
  record.canonicalId = 'uuid-canonical';
  await first.save(record);
  assert.deepEqual(await transferWriter(root, { projectId: 'p', fromWriterId: 'writer-a', toWriterId: 'writer-b' }),
    { kind: 'blocked', reason: 'writer_designation_obsolete' });
  assert.deepEqual(await transferWriter(root, { projectId: 'p', fromWriterId: 'writer-a',
    toWriterId: 'writer-b', quiescent: true }), { kind: 'blocked', reason: 'writer_designation_obsolete' });
  assert.equal((await first.begin(operation)).canonicalId, 'uuid-canonical');
  assert.equal((await createLedger(root, 'writer-b', 1).begin(operation)).canonicalId,
    'uuid-canonical');
});
