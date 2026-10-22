import test from 'node:test';
import assert from 'node:assert/strict';
import { indexTextProject } from '../base/memoria/provision.mjs';
import { trustTuple } from '../base/memoria/trust.mjs';

const resolution = { provider: 'mem0', projectRoot: '/project', projectId: 'p',
  stateDir: '/state', embeddingFingerprint: 'fingerprint', destination: {
    url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
    collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
const deps = { inspect: async () => resolution, trust: async () => trustTuple(resolution),
  identify: async () => ({ kind: 'git', activeRoot: '/project', projectRoot: '/project' }),
  pin: async () => ({ kind: 'pinned', connection: { url: 'https://example.org/' } }),
  readSecret: () => 'secret' };

test('index CLI dispatches one authorized operation for trusted project and collection', async () => {
  const calls = [];
  const result = await indexTextProject('/project', { ...deps,
    run: async (request, secret) => { calls.push({ request, secret });
      return { kind: 'indexed', field: 'data' }; } });
  assert.equal(result.kind, 'indexed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request, { op: 'index_text', projectId: 'p',
    collection: 'cbs-p', connection: { url: 'https://example.org/' } });
  assert.equal(calls[0].secret, 'secret');
});

test('index CLI refuses changed trust or project before contacting remote', async () => {
  let calls = 0;
  const run = async () => { calls++; return { kind: 'indexed' }; };
  assert.equal((await indexTextProject('/project', { ...deps, trust: async () => null, run })).reason,
    'trust_changed');
  assert.equal((await indexTextProject('/project', { ...deps,
    identify: async () => ({ kind: 'git', activeRoot: '/other', projectRoot: '/project' }),
    run })).reason, 'unsupported_git');
  assert.equal(calls, 0);
});
