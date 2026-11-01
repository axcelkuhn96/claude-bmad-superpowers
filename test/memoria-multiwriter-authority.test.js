import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { localDevice } from '../base/memoria/policy.mjs';
import { assertWriter, bootstrapWriter, beginWriterTransfer,
  completeWriterTransfer } from '../base/memoria/authority.mjs';
import { createLedger } from '../base/memoria/ledger.mjs';

test('two local devices use the same authorized collection without a designation or transfer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-multiwriter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  let remote = { cbs_control: 'writer_v1', projectId: 'p', collection: 'cbs-p',
    deviceId: '00000000-0000-0000-0000-000000000001', generation: 1, state: 'active' };
  let version = '1.15.0';
  const server = http.createServer((request, response) => {
    const observed = { method: request.method, url: request.url, key: request.headers['api-key'] };
    requests.push(observed);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      observed.body = body ? JSON.parse(body) : null;
      if (!['write-key', 'readonly-key'].includes(request.headers['api-key']) ||
          request.method === 'PUT' && request.headers['api-key'] !== 'write-key') {
        response.writeHead(403).end(); return;
      }
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version }));
      } else if (request.method === 'POST' && request.url === '/collections/cbs-p/points') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          status: 'ok', result: remote ? [{ id: JSON.parse(body).ids[0], payload: remote }] : [],
        }));
      } else if (request.method === 'PUT' && request.url.startsWith('/collections/cbs-p/points?')) {
        remote = JSON.parse(body).points[0].payload;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          status: 'ok', result: { operation_id: 1, status: 'completed' },
        }));
      } else response.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const serverUrl = `http://localhost:${server.address().port}`;
  const resolution = stateDir => ({ provider: 'mem0', stateDir, projectId: 'p',
    destination: { url: serverUrl, collection: 'cbs-p' } });
  const auth = key => ({ kind: 'authorized', key, connection: {
    url: serverUrl, address: '127.0.0.1' } });
  const dirs = [path.join(root, 'a', 'project'), path.join(root, 'b', 'project')];
  const devices = [];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    devices.push(await localDevice(dir));
  }
  assert.notEqual(devices[0].deviceId, devices[1].deviceId);
  await fs.mkdir(path.join(dirs[0], 'ledger'), { mode: 0o700 });
  await fs.writeFile(path.join(dirs[0], 'ledger', 'writer.json'), JSON.stringify({
    projectId: 'p', collection: 'cbs-p', deviceId: devices[0].deviceId,
    generation: 7, revoked: true }), { mode: 0o600 });
  assert.equal((await assertWriter(resolution(dirs[0]), auth('write-key'))).reason,
    'qdrant_atomic_claims_unavailable');
  assert.equal(remote.cbs_control, 'writer_v1');
  assert.equal(requests.some(row => row.method === 'PUT'), false);
  version = '1.19.1';
  const results = await Promise.all(dirs.map(dir => assertWriter(resolution(dir), auth('write-key'))));
  assert.deepEqual(results.map(row => row.kind), ['writer', 'writer']);
  assert.deepEqual(results.map(row => row.deviceId), devices.map(row => row.deviceId));
  assert.deepEqual(remote, { cbs_control: 'writer_v2', projectId: 'p',
    collection: 'cbs-p', mode: 'database', protocol: 2 });
  assert.equal(remote.cbs_control === 'writer_v1', false);
  const digest = createHash('sha256').update(JSON.stringify(['cbs-writer-v1', 'p', serverUrl, 'cbs-p']))
    .digest('hex').slice(0, 32);
  const markerId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  assert.ok(requests.some(row => row.method === 'POST'));
  assert.ok(requests.filter(row => row.method === 'PUT').every(row => row.body.points[0].id === markerId));
  assert.equal((await assertWriter(resolution(dirs[1]), auth('readonly-key'))).reason,
    'writer_authority_unavailable');
  assert.equal((await assertWriter(resolution(dirs[1]), auth('wrong-key'))).reason,
    'writer_authority_unavailable');
  assert.equal((await assertWriter(resolution(dirs[1]), { kind: 'blocked' })).kind, 'blocked');
  assert.equal((await assertWriter({ ...resolution(dirs[1]), destination: {
    url: 'http://other.invalid/', collection: 'cbs-p' } }, auth('write-key'))).kind, 'blocked');
  remote = { cbs_control: 'writer_v3', projectId: 'p', collection: 'cbs-p' };
  assert.equal((await assertWriter(resolution(dirs[1]), auth('write-key'))).kind, 'blocked');
  assert.equal((await bootstrapWriter()).reason, 'writer_designation_obsolete');
  assert.equal((await beginWriterTransfer()).reason, 'writer_designation_obsolete');
  assert.equal((await completeWriterTransfer()).reason, 'writer_designation_obsolete');
  assert.ok(requests.length >= 6);
  for (const dir of dirs) assert.equal(await fs.access(path.join(dir, 'ledger', 'writer.json'))
    .then(() => true, () => false), dir === dirs[0]);
});

test('local ledger starts consented operations despite absent or revoked legacy writer cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-multiwriter-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operation = { externalId: 'source-1', projectId: 'p', text: 'Fact', metadata: { scope: 'project' } };
  const ledger = createLedger(root, 'audit-device');
  assert.equal((await ledger.begin(operation)).status, 'queued');
  await fs.writeFile(path.join(root, 'ledger', 'writer.json'), JSON.stringify({ revoked: true }));
  assert.equal((await ledger.begin(operation)).status, 'queued');
});

test('legacy writer CLI commands are inert without a project or interactive TTY', () => {
  const cli = new URL('../base/memoria/cli.mjs', import.meta.url).href;
  for (const action of ['writer-bootstrap', 'writer-transfer-start', 'writer-transfer-complete']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { main } from ${JSON.stringify(cli)}; process.exitCode = await main([${JSON.stringify(action)}]);`],
    { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /writer_designation_obsolete/);
  }
});
