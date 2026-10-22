import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportSnapshot, historySnapshot, encodeRelativeLink, exportProject } from '../base/memoria/export.mjs';
import { execFileSync } from 'node:child_process';
import { trustTuple } from '../base/memoria/trust.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const item = (n, extra = {}) => ({ qdrantId: id(n), projectId: 'p', status: 'active', historyState: 'active',
  text: `Rule ${n}`, metadata: { type: 'decision', source: 's', actor: 'human',
    origin: 'user_direct', speaker_role: 'user', evidence_at: '2026-10-20T00:00:00Z',
    scope: 'project', ...extra } });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-export-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const output = path.join(home, 'private');
  await fs.mkdir(output, { mode: 0o700 });
  return output;
}
const base = output => ({ output, projectId: 'p', ownerId: null, collectionFingerprint: 'fp' });
const pageOf = (...items) => async () => ({ kind: 'page', items, scanned: items.length, nextOffset: null });

test('exports OKF bundle with stable bytes, encoded links and private modes', async t => {
  const output = await fixture(t);
  const row = item(1, { type: 'work rule', extension: { x: 1 }, status: 'active',
    'odd:key': 'safe' });
  const first = await exportSnapshot({ ...base(output), page: pageOf(row) });
  const second = await exportSnapshot({ ...base(output), page: pageOf(row) });
  assert.equal(first.kind, 'exported');
  assert.equal(first.sha256, second.sha256);
  const index = await fs.readFile(path.join(first.bundleDir, 'index.md'), 'utf8');
  const concept = await fs.readFile(path.join(first.bundleDir, `${id(1)}.md`), 'utf8');
  assert.match(index, /okf_version: "0.2"/);
  assert.match(index, new RegExp(`${id(1)}\\.md`));
  assert.match(concept, /type: "work rule"/);
  assert.match(concept, /status: "stable"/);
  assert.match(concept, /extension:/);
  const parsed = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: concept.slice(4, concept.indexOf('\n---', 4)), encoding: 'utf8' }));
  assert.equal(parsed.type, 'work rule');
  assert.equal(parsed.status, 'stable');
  assert.deepEqual(parsed.extension, { x: 1 });
  assert.equal(parsed['odd:key'], 'safe');
  assert.equal(encodeRelativeLink('folder 1/100%.md'), 'folder%201/100%25.md');
  assert.throws(() => encodeRelativeLink('../index.md'), { code: 'invalid_link' });
  assert.equal((await fs.stat(path.join(first.bundleDir, 'index.md'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(first.bundleDir)).mode & 0o777, 0o700);
  assert.ok((await fs.lstat(path.join(output, 'current.json'))).isFile());
});

test('64+1 pages finish; repeated cursor and later failure preserve old pointer', async t => {
  const output = await fixture(t);
  await exportSnapshot({ ...base(output), page: pageOf(item(1)) });
  const pointer = await fs.readFile(path.join(output, 'current.json'), 'utf8');
  const many = Array.from({ length: 64 }, (_, n) => item(n + 1));
  const good = await exportSnapshot({ ...base(output), page: async offset => offset === null
    ? { kind: 'page', items: many, scanned: 64, nextOffset: id(64) }
    : { kind: 'page', items: [item(65)], scanned: 1, nextOffset: null } });
  assert.equal(good.count, 65);
  const pointer65 = await fs.readFile(path.join(output, 'current.json'), 'utf8');
  await assert.rejects(exportSnapshot({ ...base(output), page: async () =>
    ({ kind: 'page', items: many, scanned: 64, nextOffset: id(64) }) }), { code: 'cursor_repeated' });
  assert.equal(await fs.readFile(path.join(output, 'current.json'), 'utf8'), pointer65);
  await assert.rejects(exportSnapshot({ ...base(output), page: async offset => offset === null
    ? { kind: 'page', items: many, scanned: 64, nextOffset: id(64) }
    : { kind: 'blocked', reason: 'read_failed' } }), { code: 'read_failed' });
  await assert.rejects(exportSnapshot({ ...base(output), page: async offset => {
    if (offset === null) return { kind: 'page', items: many, scanned: 64, nextOffset: id(64) };
    throw Error('connection lost');
  } }), { code: 'read_failed' });
  assert.equal(await fs.readFile(path.join(output, 'current.json'), 'utf8'), pointer65);
  assert.notEqual(pointer, pointer65);
});

test('rejects page oversize, limit and unsafe output', async t => {
  const output = await fixture(t);
  await assert.rejects(exportSnapshot({ ...base(output), page: pageOf(item(1, { x: 'x'.repeat(4 * 1024 * 1024) })) }), { code: 'page_oversized' });
  await assert.rejects(exportSnapshot({ ...base(output), page: async (offset, limit) =>
    ({ kind: 'page', items: Array.from({ length: limit }, (_, n) => item(Number(offset ?? 0) * 64 + n + 1)),
      scanned: limit, nextOffset: String(Number(offset ?? 0) + 1) }) }), { code: 'limit_exceeded' });
  const publicDir = path.join(path.dirname(output), 'public');
  await fs.mkdir(publicDir, { mode: 0o755 });
  await assert.rejects(exportSnapshot({ ...base(publicDir), page: pageOf(item(1)) }), { code: 'unsafe_output' });
  const link = path.join(path.dirname(output), 'link');
  await fs.symlink(output, link);
  await assert.rejects(exportSnapshot({ ...base(link), page: pageOf(item(1)) }), { code: 'unsafe_output' });
});

test('history exposes corrections and detects stale, missing and cycles', async t => {
  const output = await fixture(t);
  const a = item(1, { superseded_by: id(2) }); a.status = 'superseded'; a.historyState = 'superseded';
  const b = item(2, { supersedes_id: id(1), valid_to: '2026-10-21T00:00:00Z' }); b.historyState = 'expired';
  const made = await exportSnapshot({ ...base(output), page: pageOf(a, b) });
  const result = await historySnapshot({ snapshot: made.bundleDir, id: id(1),
    projectId: 'p', ownerId: null, fetchCurrent: async key => key === id(1) ? a : b });
  assert.equal(result.kind, 'history');
  assert.deepEqual(result.chain.map(x => x.historyState), ['superseded', 'expired']);
  assert.equal(result.freshness, 'fresh');
  const stale = await historySnapshot({ snapshot: made.bundleDir, id: id(1),
    projectId: 'p', ownerId: null, fetchCurrent: async key => key === id(1) ? a : ({ ...b, text: 'changed' }) });
  assert.equal(stale.freshness, 'stale');
  const missing = await exportSnapshot({ ...base(output), page: pageOf(a) });
  assert.equal((await historySnapshot({ snapshot: missing.bundleDir, id: id(1), projectId: 'p' })).integrity, 'missing_link');
  const cycle = await exportSnapshot({ ...base(output), page: pageOf(a, { ...b, metadata: { ...b.metadata, superseded_by: id(1) } }) });
  assert.equal((await historySnapshot({ snapshot: cycle.bundleDir, id: id(1), projectId: 'p' })).integrity, 'cycle');
  const broken = await exportSnapshot({ ...base(output), page: pageOf(a, { ...b, metadata: { ...b.metadata, supersedes_id: id(3) } }) });
  assert.equal((await historySnapshot({ snapshot: broken.bundleDir, id: id(1), projectId: 'p' })).integrity, 'inconsistent_link');
  await fs.appendFile(path.join(made.bundleDir, `${id(1)}.md`), 'changed');
  await assert.rejects(historySnapshot({ snapshot: made.bundleDir, id: id(1), projectId: 'p' }),
    { code: 'snapshot_corrupt' });
});

test('trusted project binds owner, collection and destination without starting an encoder', async t => {
  const output = await fixture(t);
  const project = path.dirname(output);
  const resolution = { provider: 'mem0', projectRoot: project, projectId: 'p',
    stateDir: output, embeddingFingerprint: 'fp', destination: {
      url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
      collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
  const calls = [];
  const deps = { cli: 'codex', profile: project, inspect: async () => resolution,
    trust: async () => trustTuple(resolution),
    identify: async () => ({ kind: 'git', activeRoot: project, projectRoot: project }),
    pin: async () => ({ kind: 'pinned', connection: { url: 'https://example.org/' } }),
    readSecret: () => 'secret', readOwner: async () => ({ ownerId: 'mine' }),
    run: async (request, secret) => { calls.push({ request, secret });
      return { kind: 'page', scanned: 2, nextOffset: null, items: [
        item(1, { scope: 'personal', owner_id: 'mine' }),
        item(2, { scope: 'personal', owner_id: 'other' })] }; } };
  const result = await exportProject(project, output, deps);
  assert.equal(result.count, 1);
  assert.equal(calls[0].request.collection, 'cbs-p');
  assert.equal(calls[0].request.ownerId, 'mine');
  assert.equal(calls[0].request.op, 'history_page');
  assert.equal(calls[0].secret, 'secret');
  assert.deepEqual((await fs.readdir(result.bundleDir)).filter(name => name.endsWith('.md')).sort(),
    [`${id(1)}.md`, 'index.md']);
  await assert.rejects(exportProject(project, output, { ...deps, trust: async () => null }),
    { code: 'trust_changed' });
});

test('redacts known secrets and PII from facts and unknown extension fields', async t => {
  const output = await fixture(t);
  const row = item(1, { extension: 'reach me@example.org; token=supersecret' });
  row.text = 'AKIAABCDEFGHIJKLMNOP and +55 11 99999-8888';
  const made = await exportSnapshot({ ...base(output), page: pageOf(row) });
  const content = await fs.readFile(path.join(made.bundleDir, `${id(1)}.md`), 'utf8');
  assert.doesNotMatch(content, /AKIAABCDEFGHIJKLMNOP|me@example\.org|supersecret|99999-8888/);
  assert.match(content, /\[REDACTED\]/);
});
