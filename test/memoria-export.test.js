import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportSnapshot, historySnapshot, encodeRelativeLink, exportProject, historyProject } from '../base/memoria/export.mjs';
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
  assert.doesNotMatch(concept, /extension:|odd:key/);
  const parsed = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: concept.slice(4, concept.indexOf('\n---', 4)), encoding: 'utf8' }));
  assert.equal(parsed.type, 'work rule');
  assert.equal(parsed.status, 'stable');
  assert.equal(parsed.extension, undefined);
  assert.equal(parsed['odd:key'], undefined);
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
  const profile = path.join(project, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const oldProfile = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profile;
  t.after(() => oldProfile === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = oldProfile);
  const resolution = { provider: 'mem0', projectRoot: project, projectId: 'p',
    stateDir: output, embeddingFingerprint: 'fp', destination: {
      url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
      collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
  const calls = [];
  const deps = { cli: 'codex', profile, inspect: async () => resolution,
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

test('requested profile B cannot select personal owner B from native profile A', async t => {
  const output = await fixture(t);
  const project = path.dirname(output);
  const profileA = path.join(project, 'profile-a');
  const profileB = path.join(project, 'profile-b');
  await fs.mkdir(profileA, { mode: 0o700 });
  await fs.mkdir(profileB, { mode: 0o700 });
  const oldProfile = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profileA;
  t.after(() => oldProfile === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = oldProfile);
  const resolution = { provider: 'mem0', projectRoot: project, projectId: 'p',
    stateDir: output, embeddingFingerprint: 'fp', destination: {
      url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
      collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
  const deps = { cli: 'codex', profile: profileB, inspect: async () => resolution,
    trust: async () => trustTuple(resolution),
    identify: async () => ({ kind: 'git', activeRoot: project, projectRoot: project }),
    pin: async () => ({ kind: 'pinned', connection: {} }), readSecret: () => 'secret',
    readOwner: async (_resolution, _cli, profile) => ({ ownerId: profile === profileA ? 'owner-A' : 'owner-B' }),
    run: async () => ({ kind: 'page', scanned: 1, nextOffset: null,
      items: [item(1, { scope: 'personal', owner_id: 'owner-B' })] }) };
  await assert.rejects(exportProject(project, output, deps), { code: 'owner_profile_mismatch' });
});

test('CLI selector cannot switch from active Codex owner to Claude owner', async t => {
  const output = await fixture(t);
  const project = path.dirname(output);
  const codex = path.join(project, 'codex');
  const claude = path.join(project, 'claude');
  await fs.mkdir(codex, { mode: 0o700 });
  await fs.mkdir(claude, { mode: 0o700 });
  const old = [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR,
    process.env.CODEX_THREAD_ID, process.env.CLAUDECODE];
  process.env.CODEX_HOME = codex;
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_THREAD_ID = 'native-session';
  t.after(() => {
    for (const [key, value] of [['CODEX_HOME', old[0]], ['CLAUDE_CONFIG_DIR', old[1]],
      ['CODEX_THREAD_ID', old[2]], ['CLAUDECODE', old[3]]])
      value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const resolution = { provider: 'mem0', projectRoot: project, projectId: 'p',
    stateDir: output, embeddingFingerprint: 'fp', destination: {
      url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
      collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
  const deps = { cli: 'claude', profile: claude, inspect: async () => resolution,
    trust: async () => trustTuple(resolution),
    identify: async () => ({ kind: 'git', activeRoot: project, projectRoot: project }),
    pin: async () => ({ kind: 'pinned', connection: {} }), readSecret: () => 'secret',
    readOwner: async (_resolution, selected) => ({ ownerId: selected === 'codex' ? 'owner-A' : 'owner-B' }),
    run: async () => ({ kind: 'page', scanned: 1, nextOffset: null,
      items: [item(1, { scope: 'personal', owner_id: 'owner-B' })] }) };
  await assert.rejects(exportProject(project, output, deps), { code: 'owner_profile_mismatch' });
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDECODE;
  const unbound = await exportProject(project, output, { ...deps,
    readOwner: async (_resolution, selected) => selected === 'claude' ? { ownerId: 'owner-B' } : null,
    run: async () => ({ kind: 'page', scanned: 2, nextOffset: null,
      items: [item(1), item(2, { scope: 'personal', owner_id: 'owner-B' })] }) });
  assert.equal(unbound.count, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(unbound.bundleDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.exportScope, 'project_only');
});

test('derived bundle omits raw excerpts and unrelated metadata while retaining provenance ids and hashes', async t => {
  const output = await fixture(t);
  const sha = 'a'.repeat(64);
  const row = item(1, { source_refs: [{ message_id: 'message-1', source_text_sha256: sha,
    role: 'user', origin: 'human', actor: 'Mariana Cedar Lane',
    excerpt: 'Mariana lives at 42 Cedar Lane, password=private123' }],
    transcript_path: '/private/transcripts/mariana.jsonl', tool_args: { password: 'private123' },
    claim_sha256: 'b'.repeat(64) });
  const made = await exportSnapshot({ ...base(output), page: pageOf(row) });
  const markdown = await fs.readFile(path.join(made.bundleDir, `${id(1)}.md`), 'utf8');
  const history = await fs.readFile(path.join(made.bundleDir, 'history.json'), 'utf8');
  for (const data of [markdown, history]) {
    assert.doesNotMatch(data, /Mariana|Cedar Lane|private123|transcript_path|tool_args|excerpt/);
    assert.match(data, /message-1/);
    assert.match(data, new RegExp(sha));
  }
});

test('unbound owner exports explicitly project-only scope', async t => {
  const output = await fixture(t);
  const made = await exportSnapshot({ ...base(output), page: pageOf(
    item(1), item(2, { scope: 'episode', valid_to: '2026-10-25T00:00:00Z' }),
    item(3, { scope: 'personal', owner_id: 'owner-B' })) });
  const manifest = JSON.parse(await fs.readFile(path.join(made.bundleDir, 'manifest.json'), 'utf8'));
  const rows = JSON.parse(await fs.readFile(path.join(made.bundleDir, 'history.json'), 'utf8'));
  assert.equal(manifest.exportScope, 'project_only');
  assert.deepEqual(rows.map(row => row.qdrantId), [id(1)]);
});

test('nested metadata key order keeps bytes, hash and remote freshness stable', async t => {
  const output = await fixture(t);
  const ref = { message_id: 'm1', source_text_sha256: 'a'.repeat(64), role: 'user',
    origin: 'human', actor: 'conversation', excerpt: 'raw source' };
  const first = item(1, { source_refs: [ref], claim_sha256: 'b'.repeat(64) });
  const second = { ...first, metadata: { claim_sha256: 'b'.repeat(64), source_refs: [{
    excerpt: 'raw source', actor: 'conversation', origin: 'human', role: 'user',
    source_text_sha256: 'a'.repeat(64), message_id: 'm1' }],
    scope: 'project', evidence_at: first.metadata.evidence_at, speaker_role: 'user',
    origin: 'user_direct', actor: 'human', source: 's', type: 'decision' } };
  const a = await exportSnapshot({ ...base(output), page: pageOf(first) });
  const b = await exportSnapshot({ ...base(output), page: pageOf(second) });
  assert.equal(a.sha256, b.sha256);
  for (const name of [`${id(1)}.md`, 'history.json'])
    assert.equal(await fs.readFile(path.join(a.bundleDir, name), 'utf8'),
      await fs.readFile(path.join(b.bundleDir, name), 'utf8'));
  const result = await historySnapshot({ snapshot: a.bundleDir, id: id(1), projectId: 'p',
    fetchCurrent: async () => second });
  assert.equal(result.freshness, 'fresh');
});

test('local history remains readable without key or DNS while wrong project remains denied', async t => {
  const output = await fixture(t);
  const project = path.dirname(output);
  await exportSnapshot({ ...base(output), page: pageOf(item(1)) });
  const resolution = { provider: 'mem0', projectRoot: project, projectId: 'p',
    stateDir: output, embeddingFingerprint: 'fp', destination: {
      url: 'https://example.org/', address: '1.2.3.4', allowPublic: true,
      collection: 'cbs-p', apiKeyEnv: 'TEST_KEY' } };
  const deps = { inspect: async () => resolution, trust: async () => trustTuple(resolution),
    identify: async () => ({ kind: 'git', activeRoot: project, projectRoot: project }),
    readOwner: async () => null, readSecret: () => undefined,
    pin: async () => ({ kind: 'blocked', reason: 'destination_unavailable' }) };
  const local = await historyProject(project, output, id(1), deps);
  assert.equal(local.freshness, 'freshness_unverified');
  assert.deepEqual(local.chain.map(row => row.qdrantId), [id(1)]);
  const missingKey = await historyProject(project, output, id(1), { ...deps,
    pin: async () => ({ kind: 'pinned', connection: {} }) });
  assert.equal(missingKey.freshness, 'freshness_unverified');
  assert.deepEqual(missingKey.chain.map(row => row.qdrantId), [id(1)]);
  const wrong = { ...resolution, projectId: 'other' };
  await assert.rejects(historyProject(project, output, id(1), { ...deps,
    inspect: async () => wrong, trust: async () => trustTuple(wrong) }), { code: 'snapshot_identity' });
  await exportSnapshot({ ...base(output), ownerId: 'owner-A',
    page: pageOf(item(2, { scope: 'personal', owner_id: 'owner-A' })) });
  const profile = path.join(project, 'profile-owner');
  await fs.mkdir(profile, { mode: 0o700 });
  const old = [process.env.CODEX_HOME, process.env.CODEX_THREAD_ID];
  process.env.CODEX_HOME = profile;
  process.env.CODEX_THREAD_ID = 'native-session';
  t.after(() => {
    for (const [key, value] of [['CODEX_HOME', old[0]], ['CODEX_THREAD_ID', old[1]]])
      value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  await assert.rejects(historyProject(project, output, id(2), { ...deps,
    readOwner: async () => ({ ownerId: 'owner-B' }) }), { code: 'snapshot_identity' });
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
