import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, externalIdFor, reconcileStore, transferWriter, withProjectLock } from '../base/memoria/ledger.mjs';
import { runBridgeOperation, searchProject } from '../base/memoria/bridge.mjs';

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
    const ledger = createLedger(root, 'writer-a');
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
  const ledger = createLedger(root, 'writer-a');
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

test('timeout remains pending and cross writer is blocked', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const op = { externalId: 'source-2-policy-1', projectId: 'p', sessionId: 's', text: 'rule' };
  const ledger = createLedger(root, 'writer-a');
  const deps = { ledger, findRemote: async () => [], addViaSdk: async () => { throw new Error('timeout'); } };
  assert.deepEqual(await reconcileStore(op, deps), { kind: 'pending', reason: 'remote_error' });
  assert.equal((await ledger.read(op.externalId)).attempts, 1);
  assert.deepEqual(await reconcileStore(op, { ...deps, ledger: createLedger(root, 'writer-b') }),
    { kind: 'pending', reason: 'writer_mismatch' });
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
  const ledger = createLedger(root, 'writer-a');
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

test('writer handoff requires an explicit quiescent transfer and keeps canonical ledger', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operation = { projectId: 'p', externalId: 'source-policy', text: 'fact' };
  const first = createLedger(root, 'writer-a');
  const record = await first.begin(operation);
  record.canonicalId = 'uuid-canonical';
  await first.save(record);
  assert.deepEqual(await transferWriter(root, { projectId: 'p', fromWriterId: 'writer-a', toWriterId: 'writer-b' }),
    { kind: 'pending', reason: 'quiescent_handoff_required' });
  assert.deepEqual(await transferWriter(root, { projectId: 'p', fromWriterId: 'writer-a',
    toWriterId: 'writer-b', quiescent: true }), { kind: 'transferred', writerId: 'writer-b' });
  assert.deepEqual(await first.begin(operation), { kind: 'pending', reason: 'writer_mismatch' });
  assert.equal((await createLedger(root, 'writer-b').begin(operation)).canonicalId, 'uuid-canonical');
});
