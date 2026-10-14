import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { initializeSession, inspectConfiguration, resolveProject } from '../base/memoria/provider.mjs';
import { authorizeDestination, readLocalTrust, writeLocalTrust } from '../base/memoria/trust.mjs';
import { pinDestination, validateDestination } from '../base/memoria/activation.mjs';
import { activateProject, authorizeCurrentDestination } from '../base/memoria/setup.mjs';
import { runBridgeOperation } from '../base/memoria/bridge.mjs';
import { applyNativeExclusion, restoreNativeExclusion } from '../base/memoria/native.mjs';
import { runtimeEnvironment, verifyRuntimeArtifacts } from '../base/memoria/runtime.mjs';
import { provisionRuntime } from '../base/memoria/provision.mjs';

const config = (id = 'project-one', collection = 'cbs-project-one') => ({
  provider: 'mem0', project_id: id,
  qdrant: { url: 'https://qdrant.internal', collection, api_key_env: 'CBS_MEMORIA_TEST_KEY' },
  embedding: { model: 'multilingual-e5-small', dimension: 384,
    fingerprint: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
});
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-memoria-provider-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(root);
  git(root, 'init', '-q');
  return { dir, root, stateRoot };
}
async function putConfig(root, value = config()) {
  const file = path.join(root, '.cbs', 'memoria.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
const options = (stateRoot) => ({ event: 'SessionStart', stateRoot });

test('default sem config usa claude-mem e não cria estado opcional', async (t) => {
  const { root, stateRoot } = await fixture(t);
  const r = await resolveProject(root, 'default-session', { stateRoot });
  assert.equal(r.provider, 'claude-mem');
  await initializeSession(root, 'default-session', options(stateRoot));
  await assert.rejects(fs.access(stateRoot), { code: 'ENOENT' });
});

test('Mem0 só inicia em SessionStart; sessão desconhecida exige sessão nova', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  assert.deepEqual(await resolveProject(root, 'unknown', { stateRoot }), { provider: 'blocked', reason: 'fresh_session' });
  assert.deepEqual(await initializeSession(root, 'one', { event: 'UserPromptSubmit', stateRoot }), { provider: 'blocked', reason: 'fresh_session' });
  const started = await initializeSession(root, 'one', options(stateRoot));
  assert.equal(started.provider, 'mem0');
  assert.equal((await resolveProject(root, 'one', { stateRoot })).projectId, 'project-one');
  assert.ok(Object.isFrozen(started));
  assert.ok(Object.isFrozen(started.destination));
});

test('config permits explicit HTTP 127.0.0.1 only, while rejecting other plaintext URLs', async t => {
  const { root, stateRoot } = await fixture(t);
  for (const [url, allowed] of [
    ['http://127.0.0.1:6333', true],
    ['http://localhost:6333', false],
    ['http://10.0.0.1:6333', false],
    ['http://127.0.0.1.evil:6333', false],
    ['http://user:password@127.0.0.1:6333', false],
    ['http://127.0.0.1:6333/path', false],
  ]) {
    await putConfig(root, { ...config(), qdrant: { ...config().qdrant, url } });
    const result = await initializeSession(root, `url-${url}`, options(stateRoot));
    assert.equal(result.provider, allowed ? 'mem0' : 'blocked', url);
    if (!allowed) assert.equal(result.reason, 'invalid_config', url);
  }
});

test('identidade explícita é igual na raiz, subdir, symlink e worktree mapeada', async (t) => {
  const { dir, root, stateRoot } = await fixture(t);
  await putConfig(root);
  git(root, 'add', '.cbs/memoria.json');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'config');
  const worktree = path.join(dir, 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'fixture-worktree', worktree);
  const sub = path.join(root, 'sub');
  const workSub = path.join(worktree, 'sub');
  await fs.mkdir(sub);
  await fs.mkdir(workSub);
  const link = path.join(dir, 'link');
  await fs.symlink(root, link);
  await initializeSession(root, 'shared', options(stateRoot));
  for (const cwd of [root, sub, worktree, workSub, link]) {
    const r = await resolveProject(cwd, 'shared', { stateRoot });
    assert.equal(r.projectId, 'project-one', cwd);
    assert.equal(r.projectRoot, await fs.realpath(root), cwd);
  }
});

test('Git herdado não desvia cwd de A para identidade e trust de B', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  await putConfig(b.root, config('trusted-b', 'b-collection'));
  const before = { ...process.env };
  process.env.GIT_DIR = path.join(b.root, '.git');
  process.env.GIT_WORK_TREE = b.root;
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
  process.env.GIT_CONFIG_VALUE_0 = b.root;
  try {
    const result = await resolveProject(a.root, 'foreign', { stateRoot: a.stateRoot });
    assert.deepEqual(result, { provider: 'claude-mem' });
  } finally {
    for (const key of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) delete process.env[key];
    for (const [key, value] of Object.entries(before).filter(([key]) => key.startsWith('GIT_'))) process.env[key] = value;
  }
});

test('worktree sem seleção local bloqueia; seleção equivalente por semântica compartilha estado', async (t) => {
  const { dir, root, stateRoot } = await fixture(t);
  await putConfig(root);
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'initial');
  const worktree = path.join(dir, 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'separate', worktree);
  await initializeSession(root, 'shared', options(stateRoot));
  assert.deepEqual(await resolveProject(worktree, 'shared', { stateRoot }),
    { provider: 'blocked', reason: 'worktree_config_changed' });
  await fs.mkdir(path.join(worktree, '.cbs'));
  const equivalent = config();
  await fs.writeFile(path.join(worktree, '.cbs', 'memoria.json'), JSON.stringify({
    embedding: { fingerprint: equivalent.embedding.fingerprint, dimension: 384, model: equivalent.embedding.model },
    qdrant: { api_key_env: equivalent.qdrant.api_key_env, collection: equivalent.qdrant.collection,
      url: equivalent.qdrant.url }, project_id: equivalent.project_id, provider: equivalent.provider,
  }, null, 2));
  const shared = await resolveProject(worktree, 'shared', { stateRoot });
  assert.equal(shared.provider, 'mem0');
  assert.equal(shared.projectRoot, root);
  await putConfig(worktree, config('different'));
  assert.deepEqual(await resolveProject(worktree, 'shared', { stateRoot }),
    { provider: 'blocked', reason: 'worktree_config_changed' });
});

test('worktree sem seleção continua default quando principal não selecionou Mem0', async (t) => {
  const { dir, root, stateRoot } = await fixture(t);
  await putConfig(root, { provider: 'claude-mem' });
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'initial');
  const worktree = path.join(dir, 'default-worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'default-branch', worktree);
  assert.deepEqual(await resolveProject(worktree, 'default', { stateRoot }), { provider: 'claude-mem' });
  await assert.rejects(fs.access(stateRoot), { code: 'ENOENT' });
});

test('duas máquinas sintéticas usam o ID explícito mas estado e trust locais distintos', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  await putConfig(a.root);
  await putConfig(b.root);
  const x = await initializeSession(a.root, 'machine-a', options(a.stateRoot));
  const y = await initializeSession(b.root, 'machine-b', options(b.stateRoot));
  assert.equal(x.projectId, y.projectId);
  assert.notEqual(x.projectRoot, y.projectRoot);
  assert.notEqual(x.stateDir, y.stateDir);
});

test('Git aninhado não herda configuração nem identidade do pai', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  git(nested, 'init', '-q');
  assert.equal((await resolveProject(nested, 'child', { stateRoot })).provider, 'claude-mem');
  await putConfig(nested, config('child-id', 'cbs-child-id'));
  const child = await initializeSession(nested, 'child', options(stateRoot));
  assert.equal(child.projectId, 'child-id');
  assert.equal(child.projectRoot, await fs.realpath(nested));
});

test('config inválida bloqueia sem fallback nem estado', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root, { ...config(), project_id: '' });
  assert.deepEqual(await initializeSession(root, 'bad', options(stateRoot)), { provider: 'blocked', reason: 'invalid_config' });
  await assert.rejects(fs.access(stateRoot), { code: 'ENOENT' });
});

test('endereço privado explícito entra na sessão e bloqueia mudança de pin', async t => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root, { ...config(), qdrant: { ...config().qdrant, address: '10.8.0.3' } });
  const started = await initializeSession(root, 'pinned', options(stateRoot));
  assert.equal(started.destination.address, '10.8.0.3');
  await putConfig(root, { ...config(), qdrant: { ...config().qdrant, address: '10.8.0.4' } });
  assert.deepEqual(await resolveProject(root, 'pinned', { stateRoot }),
    { provider: 'blocked', reason: 'session_changed' });
});

test('config rejeita address público, loopback com HTTPS e formas não IPv4', async t => {
  const { root, stateRoot } = await fixture(t);
  for (const address of ['157.230.226.207', '127.0.0.1', '::1', '10.8.0.3:443', '10.8.0.03']) {
    await putConfig(root, { ...config(), qdrant: { ...config().qdrant, address } });
    assert.deepEqual(await initializeSession(root, `invalid-${address}`, options(stateRoot)),
      { provider: 'blocked', reason: 'invalid_config' });
  }
});

test('pin explícito privado usa IP fixo sem DNS e preserva hostname TLS', async () => {
  const pin = await pinDestination('https://documentos.sigamina.com.br:48677', {
    address: '10.8.0.3', lookup: () => { throw new Error('DNS must not run'); },
  });
  assert.equal(pin.kind, 'pinned');
  assert.equal(pin.connection.address, '10.8.0.3');
  assert.equal(pin.connection.servername, 'documentos.sigamina.com.br');
  assert.equal(pin.connection.port, 48677);
  assert.deepEqual(await pinDestination('https://documentos.sigamina.com.br:48677',
    { address: '157.230.226.207' }), { kind: 'blocked', reason: 'public_destination' });
});

test('ativação e operação posterior propagam pin explícito sem DNS', async t => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root, { ...config(), qdrant: { ...config().qdrant, address: '10.8.0.3' } });
  const session = await initializeSession(root, 'explicit-pin', options(stateRoot));
  const tuple = { version: 1, projectRoot: session.projectRoot, projectId: session.projectId,
    url: session.destination.url, collection: session.destination.collection,
    apiKeyEnv: session.destination.apiKeyEnv, address: '10.8.0.3' };
  const fingerprint = config().embedding.fingerprint;
  const validated = await validateDestination(session, fingerprint, {
    approve: async () => tuple, readSecret: () => 'fixture-key',
    lookup: () => { throw new Error('DNS must not run'); },
    probeCollection: async (_url, _collection, key, address) => {
      assert.equal(address, '10.8.0.3');
      return key ? { statusCode: 200, body: { result: { config: {
        params: { vectors: { size: 384, distance: 'Cosine' } },
        metadata: { cbs_embedding_fingerprint: fingerprint },
      } } } } : { statusCode: 401 };
    },
  });
  assert.equal(validated.kind, 'authorized');
  await writeLocalTrust(session.stateDir, tuple);
  const later = await authorizeCurrentDestination(root, 'explicit-pin', () => 'fixture-key', {
    stateRoot, lookup: () => { throw new Error('DNS must not run'); },
  });
  assert.equal(later.kind, 'authorized');
  assert.equal(later.connection.address, '10.8.0.3');
});

test('trust com pin antigo não autoriza nova configuração sem pin', () => {
  const resolution = { provider: 'mem0', projectRoot: '/fixture', projectId: 'fixture',
    destination: { url: 'https://qdrant.example', collection: 'fixture',
      apiKeyEnv: 'CBS_MEMORIA_TEST_KEY' } };
  const trust = { version: 1, projectRoot: '/fixture', projectId: 'fixture',
    url: 'https://qdrant.example', collection: 'fixture',
    apiKeyEnv: 'CBS_MEMORIA_TEST_KEY', address: '10.8.0.3' };
  assert.deepEqual(authorizeDestination(resolution, trust, () => {
    throw new Error('secret read must not run');
  }), { kind: 'blocked', reason: 'trust_changed' });
});

test('mudança de provedor, identidade ou destino na sessão bloqueia sem novo segredo', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  await initializeSession(root, 'locked', options(stateRoot));
  for (const changed of [
    { ...config(), provider: 'claude-mem' },
    config('other-id'),
    config('project-one', 'other-collection'),
  ]) {
    await putConfig(root, changed);
    assert.deepEqual(await resolveProject(root, 'locked', { stateRoot }), { provider: 'blocked', reason: 'session_changed' });
  }
});

test('default → Mem0 durante sessão não ativa Mem0 sem novo SessionStart', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await initializeSession(root, 'old', options(stateRoot));
  await putConfig(root);
  assert.deepEqual(await resolveProject(root, 'old', { stateRoot }), { provider: 'blocked', reason: 'fresh_session' });
});

test('trust versionado compara root, ID, URL, coleção e env antes de ler segredo', () => {
  const destination = { url: 'https://qdrant.internal', collection: 'cbs-p', apiKeyEnv: 'CBS_MEMORIA_TEST_KEY' };
  const resolution = { provider: 'mem0', projectRoot: '/projects/p', projectId: 'p', destination, stateDir: '/tmp/p-state' };
  const trusted = { version: 1, projectRoot: '/projects/p', projectId: 'p', url: destination.url,
    collection: destination.collection, apiKeyEnv: destination.apiKeyEnv };
  let reads = 0;
  const readSecret = () => { reads++; return 'synthetic-secret'; };
  assert.deepEqual(authorizeDestination(resolution, trusted, readSecret), { kind: 'authorized', key: 'synthetic-secret' });
  assert.equal(reads, 1);
  for (const change of [
    { projectRoot: '/projects/other' }, { projectId: 'other' }, { url: 'https://other.internal' },
    { collection: 'other' }, { apiKeyEnv: 'OTHER_KEY' }, { projectId: undefined }, { version: 0 },
  ]) {
    reads = 0;
    assert.deepEqual(authorizeDestination(resolution, { ...trusted, ...change }, readSecret), { kind: 'blocked', reason: 'trust_changed' });
    assert.equal(reads, 0);
  }
  reads = 0;
  assert.deepEqual(authorizeDestination(resolution, trusted, () => { reads++; return ''; }), { kind: 'blocked', reason: 'missing_key' });
  assert.equal(reads, 1);
});

test('ativação só lê segredo e conecta após aprovação local da identidade e destino exatos', async () => {
  const resolution = { provider: 'mem0', projectRoot: '/projects/p', projectId: 'p',
    destination: { url: 'https://qdrant.internal', collection: 'cbs-p', apiKeyEnv: 'CBS_MEMORIA_TEST_KEY' } };
  let reads = 0;
  let connections = 0;
  const expectedFingerprint = config().embedding.fingerprint;
  const deps = {
    readSecret: () => { reads++; return 'synthetic-secret'; },
    lookup: async () => ['10.4.5.6'],
    probeCollection: async (_url, _collection, key) => { connections++; return key ? { statusCode: 200, body: { result: { config: {
      params: { vectors: { size: 384, distance: 'Cosine' } },
      metadata: { cbs_embedding_fingerprint: expectedFingerprint },
    } } } } : { statusCode: 401 }; },
  };
  const tuple = { version: 1, projectRoot: resolution.projectRoot, projectId: resolution.projectId,
    url: resolution.destination.url, collection: resolution.destination.collection,
    apiKeyEnv: resolution.destination.apiKeyEnv };
  assert.deepEqual(await validateDestination(resolution, expectedFingerprint,
    { ...deps, approve: async () => ({ ...tuple, collection: 'wrong' }) }), { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(reads, 0);
  assert.equal(connections, 0);
  const valid = await validateDestination(resolution, expectedFingerprint, { ...deps, approve: async () => tuple });
  assert.equal(valid.kind, 'authorized');
  assert.equal(reads, 1);
  assert.equal(connections, 2);
});

test('ativação bloqueia URL pública, key ausente, coleção ausente e embedding incompatível', async () => {
  const destination = { url: 'https://qdrant.internal', collection: 'cbs-p', apiKeyEnv: 'CBS_MEMORIA_TEST_KEY' };
  const resolution = { provider: 'mem0', projectRoot: '/projects/p', projectId: 'p', destination };
  const fingerprint = config().embedding.fingerprint;
  const tuple = { version: 1, projectRoot: resolution.projectRoot, projectId: resolution.projectId,
    url: destination.url, collection: destination.collection, apiKeyEnv: destination.apiKeyEnv };
  let calls = 0;
  const deps = { approve: async () => tuple, readSecret: () => 'synthetic-secret',
    lookup: async () => ['8.8.8.8'], probeCollection: async (_url, _collection, key) => {
      calls++; return key ? { statusCode: 200, body: {} } : { statusCode: 401 }; } };
  assert.deepEqual(await validateDestination(resolution, fingerprint, deps), { kind: 'blocked', reason: 'public_destination' });
  assert.equal(calls, 0);
  assert.deepEqual(await validateDestination(resolution, fingerprint, { ...deps, lookup: async () => ['10.0.0.1'],
    readSecret: () => '' }), { kind: 'blocked', reason: 'missing_key' });
  assert.equal(calls, 0);
  for (const response of [null, { status: 'error' },
    { result: { config: { params: { vectors: { size: 1024 } }, metadata: { cbs_embedding_fingerprint: fingerprint } } } },
    { result: { config: { params: { vectors: { size: 384 } }, metadata: { cbs_embedding_fingerprint: 'wrong' } } } },
  ]) {
    const result = await validateDestination(resolution, fingerprint, { ...deps, lookup: async () => ['10.0.0.1'],
      probeCollection: async (_url, _collection, key) => key ? { statusCode: 200, body: response } : { statusCode: 401 } });
    assert.equal(result.kind, 'blocked');
  }
});

test('ativação recusa servidor local que responde à coleção sem chave', async (t) => {
  const fingerprint = config().embedding.fingerprint;
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { config: { params: { vectors: { size: 384, distance: 'Cosine' } },
      metadata: { cbs_embedding_fingerprint: fingerprint } } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const destination = { url: `http://127.0.0.1:${server.address().port}`, collection: 'cbs-p', apiKeyEnv: 'CBS_MEMORIA_TEST_KEY' };
  const resolution = { provider: 'mem0', projectRoot: '/projects/p', projectId: 'p', destination };
  const tuple = { version: 1, projectRoot: resolution.projectRoot, projectId: resolution.projectId,
    url: destination.url, collection: destination.collection, apiKeyEnv: destination.apiKeyEnv };
  const result = await validateDestination(resolution, fingerprint,
    { approve: async () => tuple, readSecret: () => 'fixture-key' });
  assert.deepEqual(result, { kind: 'blocked', reason: 'unprotected_destination' });
});

test('autorização posterior bloqueia DNS público antes de ler chave e entrega endereço pinado se privado', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const session = await initializeSession(root, 'dns', options(stateRoot));
  await writeLocalTrust(session.stateDir, { version: 1, projectRoot: session.projectRoot, projectId: session.projectId,
    url: session.destination.url, collection: session.destination.collection,
    apiKeyEnv: session.destination.apiKeyEnv });
  let reads = 0;
  const readSecret = () => { reads++; return 'fixture-key'; };
  const optionsPrivate = { stateRoot, lookup: async () => ['10.1.2.3'] };
  const pinned = await authorizeCurrentDestination(root, 'dns', readSecret, optionsPrivate);
  assert.equal(pinned.kind, 'authorized');
  assert.equal(pinned.connection.address, '10.1.2.3');
  assert.equal(pinned.connection.hostname, 'qdrant.internal');
  assert.equal(reads, 1);
  const publicNow = await authorizeCurrentDestination(root, 'dns', readSecret,
    { stateRoot, lookup: async () => ['8.8.8.8'] });
  assert.deepEqual(publicNow, { kind: 'blocked', reason: 'public_destination' });
  assert.equal(reads, 1);
});

test('operação de store sem deadline chega ao SDK; deadline numérico vencido bloqueia', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const session = await initializeSession(root, 'manual-review', options(stateRoot));
  await writeLocalTrust(session.stateDir, { version: 1, projectRoot: session.projectRoot,
    projectId: session.projectId, url: session.destination.url,
    collection: session.destination.collection, apiKeyEnv: session.destination.apiKeyEnv });
  const requests = [];
  const base = { stateRoot, lookup: async () => ['10.1.2.3'],
    run: async (_python, _script, request) => { requests.push(request); return { kind: 'items', items: [] }; } };
  const request = { op: 'find', projectId: session.projectId, externalId: 'reviewed-candidate' };
  for (const deadlineAt of [undefined, null]) {
    const result = await runBridgeOperation(root, 'manual-review', request, () => 'fixture-key',
      { ...base, deadlineAt });
    assert.equal(result.kind, 'items', JSON.stringify(result));
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(await runBridgeOperation(root, 'manual-review', request, () => 'fixture-key',
    { ...base, deadlineAt: 0 }), { kind: 'blocked', reason: 'deadline' });
  assert.deepEqual(await runBridgeOperation(root, 'manual-review', request, () => 'fixture-key',
    { ...base, deadlineMs: 0 }), { kind: 'blocked', reason: 'deadline' });
  assert.equal(requests.length, 2);
  assert.deepEqual(await authorizeCurrentDestination(root, 'manual-review', () => 'fixture-key',
    { ...base, deadlineAt: Date.now() - 1 }), { kind: 'blocked', reason: 'deadline' });
});

test('mudança de config ou trust durante DNS bloqueia antes de ler chave', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const session = await initializeSession(root, 'race', options(stateRoot));
  const tuple = { version: 1, projectRoot: session.projectRoot, projectId: session.projectId,
    url: session.destination.url, collection: session.destination.collection,
    apiKeyEnv: session.destination.apiKeyEnv };
  await writeLocalTrust(session.stateDir, tuple);
  let reads = 0;
  const readSecret = () => { reads++; return 'fixture-key'; };
  const configChanged = await authorizeCurrentDestination(root, 'race', readSecret, { stateRoot,
    lookup: async () => { await putConfig(root, config('changed')); return ['10.1.2.3']; } });
  assert.deepEqual(configChanged, { kind: 'blocked', reason: 'session_changed' });
  await putConfig(root);
  const trustChanged = await authorizeCurrentDestination(root, 'race', readSecret, { stateRoot,
    lookup: async () => { await writeLocalTrust(session.stateDir, { ...tuple, collection: 'changed' });
      return ['10.1.2.3']; } });
  assert.deepEqual(trustChanged, { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(reads, 0);
});

test('ativação só persiste trust após preflight e revalida config antes do segredo', async (t) => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const preflight = { lookup: async () => ['10.1.2.3'], readSecret: () => 'fixture-key',
    probeCollection: async (_url, _collection, key) => key ? { statusCode: 200, body: { result: { config: {
      params: { vectors: { size: 384, distance: 'Cosine' } },
      metadata: { cbs_embedding_fingerprint: config().embedding.fingerprint },
    } } } } : { statusCode: 401 } };
  const denied = await activateProject(root, { stateRoot, ...preflight, approve: async () => false,
    applyNative: async () => { throw new Error('native mutation before approval'); } });
  assert.equal(denied.reason, 'trust_changed');
  let nativeCalls = 0;
  const activated = await activateProject(root, { stateRoot, ...preflight,
    approve: async (tuple) => tuple, applyNative: async () => { nativeCalls++; } });
  assert.equal(activated.kind, 'activated');
  assert.equal(nativeCalls, 1);
  const session = await initializeSession(root, 'fresh', options(stateRoot));
  let reads = 0;
  const readSecret = () => { reads++; return 'fixture-key'; };
  assert.equal((await authorizeCurrentDestination(root, 'fresh', readSecret,
    { stateRoot, lookup: async () => ['10.1.2.3'] })).kind, 'authorized');
  assert.equal(reads, 1);
  await putConfig(root, config('project-one', 'changed'));
  assert.deepEqual(await authorizeCurrentDestination(root, 'fresh', readSecret, { stateRoot }),
    { kind: 'blocked', reason: 'session_changed' });
  assert.equal(reads, 1);
  assert.equal(session.provider, 'mem0');
});

test('ativação pública registra MCP após trust e relata indisponibilidade', async t => {
  const { root, stateRoot } = await fixture(t);
  await putConfig(root);
  const preflight = { stateRoot, cli: 'claude', lookup: async () => ['10.1.2.3'],
    readSecret: () => 'fixture-key', approve: async tuple => tuple,
    probeCollection: async (_url, _collection, key) => key ? ({ statusCode: 200, body: { result: { config: {
      params: { vectors: { size: 384, distance: 'Cosine' } },
      metadata: { cbs_embedding_fingerprint: config().embedding.fingerprint },
    } } } }) : ({ statusCode: 401 }), applyNative: async () => ({ kind: 'applied' }) };
  let registered = false;
  const result = await activateProject(root, { ...preflight,
    registerMcp: async (projectRoot, cli) => {
      assert.equal(projectRoot, root);
      assert.equal(cli, 'claude');
      const current = await inspectConfiguration(root, { stateRoot });
      assert.ok(await readLocalTrust(current.stateDir));
      registered = true;
      return { kind: 'unavailable', reason: 'mcp_cli_unavailable', action: 'Install Claude CLI.' };
    } });
  assert.equal(registered, true, JSON.stringify(result));
  assert.deepEqual(result, { kind: 'blocked', reason: 'mcp_cli_unavailable', action: 'Install Claude CLI.' });
});

test('Claude local snapshot restaura ausência e preserva outras keys', async (t) => {
  const { root, stateRoot } = await fixture(t);
  const settings = path.join(root, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ enabledPlugins: { 'other@plugin': true }, custom: 7 }));
  const applied = await applyNativeExclusion(root, { cli: 'claude', stateRoot });
  assert.equal(applied.kind, 'applied');
  let current = JSON.parse(await fs.readFile(settings, 'utf8'));
  assert.equal(current.enabledPlugins['claude-mem@thedotmack'], false);
  assert.equal(current.enabledPlugins['other@plugin'], true);
  current.custom = 8;
  await fs.writeFile(settings, JSON.stringify(current));
  assert.equal((await restoreNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'restored');
  current = JSON.parse(await fs.readFile(settings, 'utf8'));
  assert.equal('claude-mem@thedotmack' in current.enabledPlugins, false);
  assert.equal(current.custom, 8);
});

test('native exclusion recusa symlink, tracked config e alteração concorrente', async (t) => {
  const { root, dir, stateRoot } = await fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(local));
  await fs.symlink(path.join(dir, 'target'), local);
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).reason, 'unsafe_native_config');
  await fs.rm(local);
  await fs.writeFile(local, '{}');
  git(root, 'add', '-f', '.claude/settings.local.json');
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).reason, 'tracked_native_config');
  git(root, 'rm', '--cached', '-q', '.claude/settings.local.json');
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'applied');
  const current = JSON.parse(await fs.readFile(local, 'utf8'));
  current.enabledPlugins['claude-mem@thedotmack'] = true;
  await fs.writeFile(local, JSON.stringify(current));
  assert.equal((await restoreNativeExclusion(root, { cli: 'claude', stateRoot })).reason, 'native_config_changed');
});

test('Codex local override restaura ausência sem tocar em outras tabelas', async (t) => {
  const { root, stateRoot } = await fixture(t);
  const file = path.join(root, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, '[features]\nhooks = true\n');
  assert.equal((await applyNativeExclusion(root, { cli: 'codex', stateRoot, installedPlugin: true })).kind, 'applied');
  assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', '.codex/config.toml']).status, 0);
  let current = await fs.readFile(file, 'utf8');
  assert.match(current, /\[plugins\."claude-mem@claude-mem-local"\]\s*enabled = false/);
  current += '\n[other]\nvalue = 2\n';
  await fs.writeFile(file, current);
  assert.equal((await restoreNativeExclusion(root, { cli: 'codex', stateRoot })).kind, 'restored');
  current = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(current, /claude-mem@claude-mem-local/);
  assert.match(current, /\[other\]/);
  assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', '.codex/config.toml']).status, 1);
});

test('runtime opt-in valida hashes e prepara ambiente antes de import Python', async (t) => {
  const { dir } = await fixture(t);
  const model = path.join(dir, 'model.onnx');
  const tokenizer = path.join(dir, 'tokenizer.json');
  await fs.writeFile(model, 'wrong-model');
  await fs.writeFile(tokenizer, 'wrong-tokenizer');
  assert.equal((await verifyRuntimeArtifacts(model, tokenizer)).reason, 'artifact_mismatch');
  const env = runtimeEnvironment(path.join(dir, 'state'), { HOME: path.join(dir, 'home'), OPENAI_API_KEY: 'fixture-openai' });
  assert.equal(env.MEM0_TELEMETRY, '0');
  assert.equal(env.MEM0_DIR, path.join(dir, 'state', 'mem0'));
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('fingerprint de embedding fora dos pins bloqueia config', async (t) => {
  const { root, stateRoot } = await fixture(t);
  const wrong = config();
  wrong.embedding.fingerprint = `${'0'.repeat(64)}:${'1'.repeat(64)}`;
  await putConfig(root, wrong);
  assert.deepEqual(await initializeSession(root, 'bad-fingerprint', options(stateRoot)),
    { provider: 'blocked', reason: 'invalid_config' });
});

test('trust local rejeita arquivo e diretório symlink', async (t) => {
  const { dir } = await fixture(t);
  const state = path.join(dir, 'state');
  const elsewhere = path.join(dir, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, state);
  await assert.rejects(writeLocalTrust(state, { version: 1 }), /unsafe/);
  assert.equal(await readLocalTrust(state), null);
  await fs.rm(state);
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(path.join(elsewhere, 'trust.json'), '{}');
  await fs.symlink(path.join(elsewhere, 'trust.json'), path.join(state, 'trust.json'));
  await assert.rejects(writeLocalTrust(state, { version: 1 }), /unsafe/);
  assert.equal(await readLocalTrust(state), null);
});

test('non-Git com Mem0 no ancestral recusa opt-in no subdiretório', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-memoria-nongit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await putConfig(dir);
  const sub = path.join(dir, 'sub');
  await fs.mkdir(sub);
  assert.deepEqual(await resolveProject(sub, 'one', { stateRoot: path.join(dir, 'state') }),
    { provider: 'blocked', reason: 'unsupported_git' });
});

test('provisão Python exige trust local e hashes antes de chamar instalador', async (t) => {
  const { root, dir, stateRoot } = await fixture(t);
  await putConfig(root);
  let calls = 0;
  const runPython = async () => { calls++; };
  const model = path.join(dir, 'wrong.onnx');
  const tokenizer = path.join(dir, 'wrong.json');
  await fs.writeFile(model, 'wrong');
  await fs.writeFile(tokenizer, 'wrong');
  assert.equal((await provisionRuntime(root, model, tokenizer, { stateRoot, runPython })).reason, 'trust_changed');
  assert.equal(calls, 0);
  const r = await initializeSession(root, 'tmp', options(stateRoot));
  await writeLocalTrust(r.stateDir, { version: 1, projectRoot: r.projectRoot, projectId: r.projectId,
    url: r.destination.url, collection: r.destination.collection, apiKeyEnv: r.destination.apiKeyEnv });
  assert.equal((await provisionRuntime(root, model, tokenizer, { stateRoot, runPython })).reason, 'artifact_mismatch');
  assert.equal(calls, 0);
});
