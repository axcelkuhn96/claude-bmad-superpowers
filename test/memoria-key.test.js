import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readQdrantSecret } from '../base/memoria/qdrant-key.mjs';
import { authorizeDestination } from '../base/memoria/trust.mjs';

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-memoria-key-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const directory = path.join(homeDir, '.config', 'cbs', 'memoria');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'qdrant-api-key');
  fs.writeFileSync(file, 'fixture-secret\n', { mode: 0o600 });
  return { homeDir, directory, file };
}

test('chave privada persistente abre somente para env padrão e trust exato', t => {
  const { homeDir } = fixture(t);
  const read = name => readQdrantSecret(name, { homeDir, env: {} });
  const resolution = { provider: 'mem0', projectRoot: '/fixture', projectId: 'fixture',
    destination: { url: 'https://qdrant.example', collection: 'fixture',
      apiKeyEnv: 'CBS_MEMORIA_QDRANT_KEY', address: '10.8.0.3' } };
  const trust = { version: 1, projectRoot: '/fixture', projectId: 'fixture',
    url: 'https://qdrant.example', collection: 'fixture',
    apiKeyEnv: 'CBS_MEMORIA_QDRANT_KEY', address: '10.8.0.3' };
  assert.deepEqual(authorizeDestination(resolution, trust, read),
    { kind: 'authorized', key: 'fixture-secret' });
  assert.deepEqual(authorizeDestination(resolution, { ...trust, address: '10.8.0.4' }, read),
    { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(read('CUSTOM_KEY'), undefined);
  assert.equal(readQdrantSecret('CBS_MEMORIA_QDRANT_KEY',
    { homeDir, env: { CBS_MEMORIA_QDRANT_KEY: 'env-secret' } }), 'env-secret');
});

test('chave persistente falha fechada em arquivo permissivo, symlink e diretório inseguro', t => {
  const { homeDir, directory, file } = fixture(t);
  const read = () => readQdrantSecret('CBS_MEMORIA_QDRANT_KEY', { homeDir, env: {} });
  fs.chmodSync(file, 0o644);
  assert.equal(read(), undefined);
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, `${file}.real`);
  fs.symlinkSync(`${file}.real`, file);
  assert.equal(read(), undefined);
  fs.unlinkSync(file);
  fs.renameSync(`${file}.real`, file);
  fs.chmodSync(path.dirname(directory), 0o775);
  assert.equal(read(), undefined);
});

test('chave persistente rejeita valor grande e não UTF-8', t => {
  const { homeDir, file } = fixture(t);
  const read = () => readQdrantSecret('CBS_MEMORIA_QDRANT_KEY', { homeDir, env: {} });
  fs.writeFileSync(file, 'x'.repeat(8193), { mode: 0o600 });
  assert.equal(read(), undefined);
  fs.writeFileSync(file, Buffer.from([0xff]), { mode: 0o600 });
  assert.equal(read(), undefined);
});
