import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeSession } from '../base/memoria/provider.mjs';
import { pinDestination, validateDestination } from '../base/memoria/activation.mjs';
import { authorizeDestination, trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';
import { authorizeCurrentDestination } from '../base/memoria/setup.mjs';

const url = 'https://documentos.sigamina.com.br:48677';
const address = '157.230.226.207';
const fingerprint = 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39';
async function fixture(t, qdrant) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-public-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'fixture', qdrant: {
      url, collection: 'fixture', api_key_env: 'CBS_MEMORIA_QDRANT_KEY', ...qdrant,
    }, embedding: { model: 'multilingual-e5-small', dimension: 384, fingerprint },
  }));
  return { root, stateRoot };
}

test('public mode requires explicit boolean, static global IPv4 and HTTPS DNS name', async t => {
  for (const [qdrant, valid] of [
    [{ address }, false],
    [{ address, allow_public: true }, true],
    [{ address, allow_public: 'true' }, false],
    [{ address, allow_public: false }, false],
    [{ address: '10.8.0.3', allow_public: true }, false],
    [{ address: '100.64.0.1', allow_public: true }, false],
    [{ address: '169.254.169.254', allow_public: true }, false],
    [{ address: '203.0.113.8', allow_public: true }, false],
    [{ address: '224.0.0.1', allow_public: true }, false],
    [{ address: '192.31.196.1', allow_public: true }, false],
    [{ address: '192.52.193.1', allow_public: true }, false],
    [{ address: '192.175.48.1', allow_public: true }, false],
    [{ allow_public: true }, false],
    [{ address, allow_public: true, url: 'http://documentos.sigamina.com.br:48677/' }, false],
    [{ address, allow_public: true, url: 'https://127.0.0.1:48677/' }, false],
    [{ address, allow_public: true, url: 'https://localhost:48677/' }, false],
  ]) {
    const { root, stateRoot } = await fixture(t, qdrant);
    const result = await initializeSession(root, 's', { stateRoot, event: 'SessionStart' });
    assert.equal(result.provider, valid ? 'mem0' : 'blocked', JSON.stringify(qdrant));
    if (valid) {
      assert.equal(result.destination.allowPublic, true);
      assert.equal(result.destination.address, address);
    }
  }
});

test('public pin bypasses DNS only for explicit trusted global IPv4 and preserves TLS name', async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; throw Error('DNS must not run'); };
  assert.deepEqual(await pinDestination(url, { address, lookup }),
    { kind: 'blocked', reason: 'public_destination' });
  const pin = await pinDestination(url, { address, allowPublic: true, lookup });
  assert.equal(pin.kind, 'pinned');
  assert.equal(pin.connection.address, address);
  assert.equal(pin.connection.servername, 'documentos.sigamina.com.br');
  assert.equal(pin.connection.allowPublic, true);
  assert.equal(lookups, 0);
  for (const bad of ['100.64.0.1', '169.254.169.254', '203.0.113.1', '224.0.0.1', '10.0.0.1']) {
    assert.deepEqual(await pinDestination(url, { address: bad, allowPublic: true, lookup }),
      { kind: 'blocked', reason: 'public_destination' });
  }
  for (const bad of ['http://example.com:48677/', 'https://127.0.0.1:48677/', 'https://localhost:48677/']) {
    assert.notEqual((await pinDestination(bad, { address, allowPublic: true, lookup })).kind, 'pinned');
  }
  assert.equal(lookups, 0);
});

test('private trust cannot gain public mode without a new approval', async t => {
  const { root, stateRoot } = await fixture(t, { address: '10.8.0.3' });
  const resolution = await initializeSession(root, 's', { stateRoot, event: 'SessionStart' });
  const tuple = trustTuple(resolution);
  let reads = 0;
  assert.deepEqual(authorizeDestination(resolution, { ...tuple, allowPublic: true },
    () => { reads++; return 'secret'; }), { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(reads, 0);
});

test('public destination trust rejects removed mode or pin before secret or network', async t => {
  const { root, stateRoot } = await fixture(t, { address, allow_public: true });
  const resolution = await initializeSession(root, 's', { stateRoot, event: 'SessionStart' });
  const tuple = trustTuple(resolution);
  assert.equal(tuple.allowPublic, true);
  let reads = 0;
  for (const stale of [{ ...tuple, allowPublic: undefined }, { ...tuple, address: undefined },
    { ...tuple, address: '157.230.226.208' }, { ...tuple, url: 'https://other.example.com/' }]) {
    assert.deepEqual(authorizeDestination(resolution, stale, () => { reads++; return 'secret'; }),
      { kind: 'blocked', reason: 'trust_changed' });
  }
  assert.equal(reads, 0);
  await writeLocalTrust(resolution.stateDir, tuple);
  let lookups = 0;
  const auth = await authorizeCurrentDestination(root, 's', () => { reads++; return 'secret'; },
    { stateRoot, lookup: async () => { lookups++; throw Error('DNS must not run'); } });
  assert.equal(auth.kind, 'authorized');
  assert.equal(auth.connection.allowPublic, true);
  assert.equal(lookups, 0);
  assert.equal(reads, 1);
  await writeLocalTrust(resolution.stateDir, { ...tuple, allowPublic: undefined });
  assert.deepEqual(await authorizeCurrentDestination(root, 's', () => { reads++; return 'secret'; },
    { stateRoot, lookup: async () => { lookups++; throw Error('DNS must not run'); } }),
  { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(reads, 1);
  assert.equal(lookups, 0);
});

test('public activation validates trusted pin and collection metadata', async t => {
  const { root, stateRoot } = await fixture(t, { address, allow_public: true });
  const resolution = await initializeSession(root, 's', { stateRoot, event: 'SessionStart' });
  let probes = 0;
  const result = await validateDestination(resolution, fingerprint, {
    approve: async tuple => tuple, readSecret: () => 'secret',
    lookup: async () => { throw Error('DNS must not run'); },
    probeCollection: async (_url, _collection, key) => {
      probes++;
      return key ? { statusCode: 200, body: { result: { config: {
        params: { vectors: { size: 384, distance: 'Cosine' } },
        metadata: { cbs_embedding_fingerprint: fingerprint },
      } } } } : { statusCode: 401 };
    },
  });
  assert.equal(result.kind, 'authorized');
  assert.equal(probes, 2);
});
