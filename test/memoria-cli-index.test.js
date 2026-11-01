import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
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

test('index CLI establishes legacy-ID writer marker before first text index', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-index-writer-'));
  const stateDir = path.join(root, 'project');
  await fs.mkdir(stateDir, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let marker;
  let version = '1.15.0';
  let key = 'write-key';
  let puts = 0;
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      const body = text ? JSON.parse(text) : null;
      const send = (status, value) => res.writeHead(status,
        { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (!['write-key', 'readonly-key'].includes(req.headers['api-key'])) return send(403, {});
      if (req.method === 'GET' && req.url === '/') return send(200, { version });
      if (req.method === 'POST' && req.url === '/collections/cbs-p/points') {
        return send(200, { status: 'ok', result: marker ? [marker] : [] });
      }
      if (req.method === 'PUT' && req.url.startsWith('/collections/cbs-p/points?')) {
        if (req.headers['api-key'] !== 'write-key') return send(403, {});
        puts++;
        marker = body.points[0];
        return send(200, { status: 'ok', result: { status: 'completed' } });
      }
      return send(404, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rawUrl = `http://localhost:${server.address().port}`;
  const current = { ...resolution, stateDir, destination: { ...resolution.destination,
    url: rawUrl } };
  const calls = [];
  const options = { inspect: async () => current, trust: async () => trustTuple(current),
    identify: deps.identify, pin: async () => ({ kind: 'pinned', connection: {
      url: `${rawUrl}/`, address: '127.0.0.1' } }), readSecret: () => key,
    run: async request => { calls.push(request); return { kind: 'indexed', field: 'data' }; } };
  assert.equal((await indexTextProject('/project', options)).reason,
    'qdrant_atomic_claims_unavailable');
  assert.equal(puts, 0);
  version = '1.19.1';
  assert.equal((await indexTextProject('/project', options)).kind, 'indexed');
  assert.equal(puts, 1);
  assert.equal(calls.length, 1);
  const hex = createHash('sha256').update(JSON.stringify(['cbs-writer-v1', 'p', rawUrl, 'cbs-p']))
    .digest('hex').slice(0, 32);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.equal(marker.id, id);
  assert.equal(calls[0].connection.controlPointId, id);
  marker = undefined;
  key = 'readonly-key';
  assert.equal((await indexTextProject('/project', options)).reason,
    'writer_authority_unavailable');
  assert.equal(calls.length, 1);
  key = 'bad-key';
  assert.equal((await indexTextProject('/project', options)).reason,
    'writer_authority_unavailable');
  assert.equal(calls.length, 1);
});
