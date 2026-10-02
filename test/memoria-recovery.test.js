import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readCompleteJsonl, parsePersistedSlice } from '../base/memoria/transcript.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { captureEvent } from '../base/memoria/checkpoint.mjs';
import { applyNativeExclusion, restoreNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';
import { reconcileStore } from '../base/memoria/ledger.mjs';
import { externalIdFor } from '../base/memoria/ledger.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';

const fixture = name => path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'fixtures', name);
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mem0-recovery-'));
const run = promisify(execFile);
async function writeCandidateRef(dir, parentId, projectId, candidate, text = 'approved fact') {
  const folder = path.join(dir, 'candidates', 'payloads');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const payload = { external_id: candidate.externalId, project_id: projectId, checkpoint_id: parentId,
    source_message_id: candidate.evidence.messageId,
    source_offsets: { start: candidate.evidence.start, end: candidate.evidence.end }, text };
  const bytes = Buffer.from(JSON.stringify(payload) + '\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(folder, `${candidate.externalId}.${sha256}.json`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return { sha256, file };
}

test('reader stops before incomplete UTF-8 record and counts CRLF bytes', () => {
  const first = Buffer.from('{"role":"user","text":"ação"}\r\n');
  const partial = Buffer.concat([Buffer.from('{"role":"assistant","text":"'), Buffer.from('ç').subarray(0, 1)]);
  const parsed = readCompleteJsonl(Buffer.concat([first, partial]), 19);
  assert.equal(parsed.lastCompleteByte, 19 + first.length);
  assert.deepEqual(parsed.records.map(r => [r.start, r.end, r.value.text]), [[19, 19 + first.length, 'ação']]);
});

test('sidechain user role and unproved Codex source never become direct human', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claude = JSON.parse((await fs.readFile(fixture('memoria-native-claude.jsonl'), 'utf8')).split('\n')[0]);
  claude.isSidechain = true;
  const cp = path.join(dir, 'claude.jsonl'); await fs.writeFile(cp, JSON.stringify(claude) + '\n');
  const sidechain = await parsePersistedSlice({ cli: 'claude', transcriptPath: cp, sessionId: 'native-session' });
  assert.notEqual(sidechain.messages[0].origin, 'human');
  const codex = (await fs.readFile(fixture('memoria-native-codex.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  codex[0].payload.thread_source = 'unknown';
  const xp = path.join(dir, 'codex.jsonl'); await fs.writeFile(xp, codex.map(x => JSON.stringify(x)).join('\n') + '\n');
  const unknown = await parsePersistedSlice({ cli: 'codex', transcriptPath: xp, sessionId: 'native-session' });
  assert.notEqual(unknown.messages[0].origin, 'human');
});

test('native Codex VS Code root user is human only with matching session metadata', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lines = (await fs.readFile(fixture('memoria-native-codex-vscode.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const file = path.join(dir, 'rollout-native-session.jsonl');
  await fs.writeFile(file, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal((await parsePersistedSlice({ cli: 'codex', transcriptPath: file, sessionId: 'native-session' })).messages[0].origin, 'human');
  lines[0].payload.session_id = 'other';
  await fs.writeFile(file, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(parsePersistedSlice({ cli: 'codex', transcriptPath: file, sessionId: 'native-session' }), /transcript_session_mismatch/);
});

test('parser rejects transcript symlink and bounded window resumes over 4 MiB', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'native-session.jsonl');
  const first = (await fs.readFile(fixture('memoria-native-claude.jsonl'))).subarray(0);
  await fs.writeFile(file, Buffer.concat([first, Buffer.from(' '.repeat(4 * 1024 * 1024) + '\n')]));
  const link = path.join(dir, 'link.jsonl'); await fs.symlink(file, link);
  await assert.rejects(parsePersistedSlice({ cli: 'claude', transcriptPath: link, sessionId: 'native-session' }), /unsafe_transcript|ELOOP/);
  const parsed = await parsePersistedSlice({ cli: 'claude', transcriptPath: file, sessionId: 'native-session' });
  assert.equal(parsed.lastCompleteByte, first.length);
  const original = await fs.lstat(file);
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, first);
  await assert.rejects(parsePersistedSlice({ cli: 'claude', transcriptPath: file,
    sessionId: 'native-session', expectedFile: original }), /unsafe_transcript/);
  await fs.rename(`${file}.old`, file);
  await assert.rejects(parsePersistedSlice({ cli: 'claude', transcriptPath: file, start: first.length,
    sessionId: 'native-session' }), /oversized_transcript_record/);
});

for (const [cli, filename] of [['claude', 'memoria-native-claude.jsonl'], ['codex', 'memoria-native-codex.jsonl']]) {
  test(`${cli} native messages retain role, actor, timestamp, ID and byte offsets`, async () => {
    const parsed = await parsePersistedSlice({ cli, transcriptPath: fixture(filename), start: 0,
      sessionId: 'native-session' });
    assert.deepEqual(parsed.messages.map(m => m.origin), ['human', 'tool', 'tool', 'assistant']);
    assert.equal(parsed.messages[2].actor === 'user', false);
    assert.match(parsed.messages[2].text, /User decided:/);
    assert.equal(parsed.messages[0].sessionId, 'native-session');
    for (const m of parsed.messages) {
      assert.ok(m.messageId);
      assert.match(m.timestamp, /^2026-/);
      assert.ok(m.end > m.start);
      assert.equal(m.policyVersion, 'native-v1');
    }
    assert.equal(parsed.messages.at(-1).end, parsed.lastCompleteByte);
  });
}

test('outbox persists one operation per project, CLI, session and interval, ACK only with proof', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const bytes = await fs.readFile(fixture('memoria-native-claude.jsonl'));
  const parsed = await parsePersistedSlice({ cli: 'claude', transcriptPath: fixture('memoria-native-claude.jsonl'), start: 0, sessionId: 'native-session' });
  const slice = { cli: 'claude', sessionId: 'native-session', start: 0, end: parsed.lastCompleteByte,
    sliceHash: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), messages: parsed.messages };
  const first = await outbox.enqueueCheckpoint(slice, { projectId: 'project-a', policyVersion: 'native-v1' });
  assert.equal(first.kind, 'queued');
  assert.equal((await outbox.enqueueCheckpoint(slice, { projectId: 'project-a', policyVersion: 'native-v1' })).operationId, first.operationId);
  assert.equal((await createOutbox(dir).pending()).length, 1);
  assert.equal((await outbox.cursor('claude', 'native-session')).ackedEnd, 0);
  assert.equal((await outbox.ackVerified(first.operationId, {})).kind, 'blocked');
  assert.equal((await outbox.cursor('claude', 'native-session')).ackedEnd, 0);
  assert.equal((await outbox.ackVerified(first.operationId, { externalId: first.operationId, sdkId: 'sdk-1', qdrantId: 'q-1', projectId: 'project-a', status: 'active' })).kind, 'acked');
  assert.equal((await outbox.ackVerified(first.operationId, {})).kind, 'blocked');
  assert.equal((await outbox.ackVerified(first.operationId, { externalId: first.operationId, sdkId: 'sdk-1', qdrantId: 'q-1', projectId: 'project-a', status: 'active' })).kind, 'acked');
  assert.equal((await createOutbox(dir).cursor('claude', 'native-session')).ackedEnd, slice.end);
  const second = await outbox.enqueueCheckpoint({ ...slice, sessionId: 's2',
    messages: slice.messages.map(message => ({ ...message, sessionId: 's2' })) },
  { projectId: 'project-a', policyVersion: 'native-v1' });
  assert.notEqual(first.operationId, second.operationId);
});

test('Task3 verified reconciliation callback advances ACK after remote read', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const queued = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 9,
    sliceHash: 'a'.repeat(64), messages: [{ origin: 'human', text: 'ação' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const operation = { externalId: queued.operationId, projectId: 'p' };
  let reads = 0;
  const remote = { externalId: queued.operationId, projectId: 'p', sdkId: 'sdk-1', qdrantId: 'q-1', status: 'active' };
  const result = await reconcileStore(operation, { findRemote: async () => null,
    addViaSdk: async () => {}, readRemote: async () => { reads++; return remote; },
    ackLocal: (id, proof) => outbox.ackVerified(id, proof),
  });
  assert.notEqual(result.kind, 'stored');
  assert.equal(reads, 0);
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 0);
  const verified = await reconcileStore(operation, { findRemote: async () => remote,
    addViaSdk: async () => { throw new Error('duplicate'); },
    ackLocal: (id, proof) => outbox.ackVerified(id, proof),
  });
  assert.equal(verified.kind, 'stored');
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 9);
});

test('checkpoint manifest resolves two child facts only after exact remote ACKs', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const source = { projectId: 'p', originCli: 'codex', sessionId: 's', start: 0, end: 9,
    sliceHash: 'b'.repeat(64), policyVersion: 'native-v1' };
  const parent = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: 0, end: 9,
    sliceHash: source.sliceHash, messages: [{ messageId: 'm1', start: 0, end: 9, text: 'two facts' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const children = ['fact-0', 'fact-1'].map(candidateKey => ({ candidateKey, evidence: { messageId: 'm1', start: 0, end: 9 },
    externalId: externalIdFor({ ...source, candidateKey }) }));
  for (const child of children) child.payloadRef = await writeCandidateRef(dir, parent.operationId, 'p', child);
  for (const child of children) delete child.payloadRef.file;
  assert.equal((await outbox.recordManifest(parent.operationId, children)).kind, 'manifested');
  assert.deepEqual((await outbox.recordManifest(parent.operationId, children)).kind, 'manifested');
  await assert.rejects(outbox.recordManifest(parent.operationId, children.slice(0, 1)), /manifest_conflict/);
  assert.equal((await outbox.recordManifest(parent.operationId,
    [{ ...children[0], evidence: { messageId: 'other', start: 0, end: 9 } }, children[1]])).kind, 'blocked');
  assert.deepEqual(await outbox.completeCheckpoint(parent.operationId), { kind: 'blocked', reason: 'unresolved_candidates' });
  const proof = externalId => ({ externalId, projectId: 'p', sdkId: `sdk-${externalId}`, qdrantId: `q-${externalId}`, status: 'active' });
  assert.equal((await outbox.ackCandidate(parent.operationId, 'fact-0', proof(children[1].externalId))).kind, 'blocked');
  assert.equal((await reconcileStore({ externalId: children[0].externalId, projectId: 'p' }, {
    findRemote: async () => proof(children[0].externalId),
    ackLocal: (id, remote) => outbox.ackCandidate(parent.operationId, 'fact-0', remote),
  })).kind, 'stored');
  assert.equal((await outbox.ackCandidate(parent.operationId, 'fact-0', proof(children[1].externalId))).kind, 'blocked');
  assert.equal((await outbox.ackCandidate(parent.operationId, 'fact-0', proof(children[0].externalId))).kind, 'acked');
  assert.equal((await createOutbox(dir).cursor('codex', 's')).processedEnd, 0);
  assert.equal((await outbox.ackCandidate(parent.operationId, 'fact-1', proof(children[1].externalId))).kind, 'acked');
  assert.equal((await outbox.completeCheckpoint(parent.operationId)).kind, 'processed');
  assert.equal((await createOutbox(dir).cursor('codex', 's')).processedEnd, 9);
  assert.equal((await outbox.cursor('codex', 's')).ackedEnd, 0);
  assert.equal((await createOutbox(dir).pending()).length, 0);
});

test('manifest survives restart and binds child IDs to protected payload bytes', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = { projectId: 'p', originCli: 'codex', sessionId: 's', start: 0, end: 9,
    sliceHash: 'b'.repeat(64), policyVersion: 'native-v1' };
  const outbox = createOutbox(dir);
  const parent = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: 0, end: 9,
    sliceHash: source.sliceHash, messages: [{ messageId: 'm1', start: 0, end: 9 }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const child = { candidateKey: 'fact-0', externalId: externalIdFor({ ...source, candidateKey: 'fact-0' }),
    evidence: { messageId: 'm1', start: 0, end: 9 } };
  assert.equal((await outbox.recordManifest(parent.operationId, [child])).reason, 'invalid_manifest');
  const { file, ...payloadRef } = await writeCandidateRef(dir, parent.operationId, 'p', child);
  child.payloadRef = payloadRef;
  assert.equal((await outbox.recordManifest(parent.operationId,
    [{ ...child, payloadRef: { ...payloadRef, path: file } }])).reason, 'invalid_manifest');
  assert.equal((await outbox.recordManifest(parent.operationId, [child])).kind, 'manifested');
  const loaded = await createOutbox(dir).readManifest(parent.operationId);
  assert.equal(loaded.candidates[0].externalId, child.externalId);
  assert.deepEqual(loaded.candidates[0].payloadRef, payloadRef);
  const manifestFile = path.join(dir, 'outbox', 'items', `${parent.operationId}.manifest.json`);
  const original = await fs.readFile(manifestFile);
  const corrupt = JSON.parse(original);
  corrupt.candidates[0].externalId = 'src-' + 'f'.repeat(64);
  await fs.writeFile(manifestFile, JSON.stringify(corrupt));
  assert.deepEqual(await createOutbox(dir).readManifest(parent.operationId),
    { kind: 'blocked', reason: 'corrupt_manifest' });
  await fs.writeFile(manifestFile, original);
  await fs.writeFile(file, '{"text":"changed"}\n');
  assert.deepEqual(await createOutbox(dir).readManifest(parent.operationId),
    { kind: 'blocked', reason: 'candidate_payload_mismatch' });
  await fs.rm(file);
  await fs.symlink(path.join(dir, 'other.json'), file);
  assert.deepEqual(await createOutbox(dir).readManifest(parent.operationId),
    { kind: 'blocked', reason: 'candidate_payload_mismatch' });
});

test('root snapshot temp is cleaned after crash before rename', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 65000 });
  for (let n = 0; n < 3; n++) {
    const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [{ text: 'x' }] },
    { projectId: 'p', policyVersion: 'native-v1' });
    await outbox.ackVerified(queued.operationId, { externalId: queued.operationId,
      projectId: 'p', sdkId: 's', qdrantId: 'q', status: 'active' });
  }
  const root = path.join(dir, 'outbox');
  const stale = path.join(root, '.00000000-0000-0000-0000-000000000000.tmp');
  await fs.writeFile(stale, 'x'.repeat(8192));
  const before = await outbox.usage();
  assert.equal((await fs.readdir(root)).includes(path.basename(stale)), false);
  assert.ok(before < 8192 + 65000);
});

test('repeated no-facts compact to source-bound processed highwater and replay safely', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 65536 });
  let firstReceipt;
  let firstId;
  for (let n = 0; n < 30; n++) {
    const slice = { cli: 'codex', sessionId: 's', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [] };
    const queued = await outbox.enqueueCheckpoint(slice, { projectId: 'p', policyVersion: 'native-v1' });
    assert.equal(queued.kind, 'queued', `enqueue ${n}: ${JSON.stringify(queued)}`);
    assert.equal((await outbox.recordManifest(queued.operationId, [])).kind, 'manifested');
    assert.equal((await outbox.completeCheckpoint(queued.operationId)).kind, 'processed');
    if (n === 0) {
      firstId = queued.operationId;
      firstReceipt = await fs.readFile(path.join(dir, 'outbox', 'processed', `${firstId}.json`));
    }
  }
  await fs.writeFile(path.join(dir, 'outbox', 'processed', `${firstId}.json`), firstReceipt);
  assert.deepEqual(await createOutbox(dir, { maxBytes: 65536 }).cursor('codex', 's'),
    { queuedEnd: 30, ackedEnd: 0, processedEnd: 30 });
  assert.equal((await fs.readdir(path.join(dir, 'outbox', 'processed'))).includes(`${firstId}.json`), false);
  assert.equal((await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: 0, end: 1,
    sliceHash: 'f'.repeat(64), messages: [] }, { projectId: 'p', policyVersion: 'native-v1' })).kind, 'blocked');
  assert.ok((await fs.readdir(path.join(dir, 'outbox', 'processed'))).length < 10);
  assert.ok(await outbox.usage() <= 65536);
  const cursors = (await fs.readdir(path.join(dir, 'outbox'))).filter(name => name.startsWith('cursor-'));
  assert.equal(cursors.length, 1);
  const summary = JSON.parse(await fs.readFile(path.join(dir, 'outbox', cursors[0])));
  assert.equal(summary.projectId, 'p');
  assert.equal(summary.policyVersion, 'native-v1');
  assert.equal(summary.processedCount + (await fs.readdir(path.join(dir, 'outbox', 'processed'))).length, 30);
  assert.match(summary.processedAudit, /^[a-f0-9]{64}$/);
});

test('terminal candidate receipt stays auditable while later no-facts compact', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const limit = 98304;
  const outbox = createOutbox(dir, { maxBytes: limit });
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const first = { cli: 'codex', sessionId: 'mixed', start: 0, end: 1,
    sliceHash: 'a'.repeat(64), messages: [{ messageId: 'm', start: 0, end: 1 }] };
  const parent = await outbox.enqueueCheckpoint(first, identity);
  assert.equal(parent.kind, 'queued');
  const children = ['rejected', 'duplicate', 'remote_acked'].map(candidateKey => ({
    candidateKey, evidence: { messageId: 'm', start: 0, end: 1 },
    externalId: externalIdFor({ projectId: 'p', originCli: 'codex', sessionId: 'mixed',
      start: 0, end: 1, sliceHash: first.sliceHash, policyVersion: 'native-v1', candidateKey }) }));
  for (const child of children) {
    const { file, ...ref } = await writeCandidateRef(dir, parent.operationId, 'p', child);
    child.payloadRef = ref;
  }
  assert.equal((await outbox.recordManifest(parent.operationId, children)).kind, 'manifested');
  assert.equal((await outbox.disposeCandidate(parent.operationId, 'rejected', 'rejected', 'unsupported_claim')).kind, 'disposed');
  assert.equal((await outbox.disposeCandidate(parent.operationId, 'duplicate', 'duplicate', 'existing_fact')).kind, 'disposed');
  const proof = { externalId: children[2].externalId, projectId: 'p', status: 'active', sdkId: 'sdk-1', qdrantId: 'q-1' };
  assert.equal((await outbox.ackCandidate(parent.operationId, 'remote_acked', proof)).kind, 'acked');
  assert.equal((await outbox.completeCheckpoint(parent.operationId)).kind, 'processed');
  const receiptFile = path.join(dir, 'outbox', 'processed', `${parent.operationId}.json`);
  const receipt = await fs.readFile(receiptFile);
  const audited = [[parent.operationId, first.sliceHash, 0, 1]];
  for (let n = 1; n <= 30; n++) {
    const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'mixed', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [] }, identity);
    assert.equal(queued.kind, 'queued', `enqueue ${n}: ${JSON.stringify(queued)}`);
    assert.equal((await outbox.recordManifest(queued.operationId, [])).kind, 'manifested');
    assert.equal((await outbox.completeCheckpoint(queued.operationId)).kind, 'processed');
    audited.push([queued.operationId, n.toString(16).padStart(64, '0'), n, n + 1]);
  }
  const restarted = createOutbox(dir, { maxBytes: limit });
  assert.deepEqual(await restarted.cursor('codex', 'mixed'), { queuedEnd: 31, ackedEnd: 0, processedEnd: 31 });
  assert.deepEqual(await fs.readFile(receiptFile), receipt);
  assert.deepEqual((await restarted.readDisposition(parent.operationId)).candidates.map(c => c.status),
    ['rejected', 'duplicate', 'remote_acked']);
  const cursors = (await fs.readdir(path.join(dir, 'outbox'))).filter(name => name.startsWith('cursor-'));
  assert.equal(cursors.length, 1);
  const summary = JSON.parse(await fs.readFile(path.join(dir, 'outbox', cursors[0])));
  assert.equal(summary.projectId, 'p');
  assert.equal(summary.policyVersion, 'native-v1');
  assert.ok(summary.processedEnd > 1);
  assert.equal(summary.processedCount, summary.processedEnd - 1);
  assert.equal(summary.processedCount + (await fs.readdir(path.join(dir, 'outbox', 'processed'))).length, 31);
  const expectedAudit = audited.slice(0, summary.processedEnd).reduce((digest, [id, sliceHash, start, end]) =>
    createHash('sha256').update(JSON.stringify([digest, id, sliceHash, start, end])).digest('hex'), '0'.repeat(64));
  assert.equal(summary.processedAudit, expectedAudit);
  assert.equal((await restarted.enqueueCheckpoint(first, identity)).kind, 'processed');
  assert.equal((await restarted.enqueueCheckpoint({ ...first, start: 1, end: 2,
    sliceHash: 'f'.repeat(64), messages: [] }, identity)).kind, 'blocked');
  assert.equal((await restarted.ackVerified(parent.operationId, proof)).kind, 'blocked');
  assert.equal((await restarted.enqueueCheckpoint({ cli: 'codex', sessionId: 'mixed', start: 31, end: 32,
    sliceHash: '1'.repeat(64), messages: [] }, { projectId: 'foreign', policyVersion: 'native-v1' })).reason,
    'cursor_source_mismatch');
  assert.ok((await restarted.usage()) <= limit);
});

test('pending candidate and cursor gap stop no-facts highwater', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 98304 });
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const first = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'pending', start: 0, end: 1,
    sliceHash: 'a'.repeat(64), messages: [{ messageId: 'm', start: 0, end: 1 }] }, identity);
  const candidate = { candidateKey: 'fact', evidence: { messageId: 'm', start: 0, end: 1 },
    externalId: externalIdFor({ projectId: 'p', originCli: 'codex', sessionId: 'pending', start: 0, end: 1,
      sliceHash: 'a'.repeat(64), policyVersion: 'native-v1', candidateKey: 'fact' }) };
  const { file, ...ref } = await writeCandidateRef(dir, first.operationId, 'p', candidate);
  candidate.payloadRef = ref;
  assert.equal((await outbox.recordManifest(first.operationId, [candidate])).kind, 'manifested');
  assert.equal((await outbox.disposeCandidate(first.operationId, 'fact', 'rejected', 'unsupported_claim')).kind, 'disposed');
  assert.equal((await outbox.completeCheckpoint(first.operationId)).kind, 'processed');
  assert.equal((await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'pending', start: 2, end: 3,
    sliceHash: 'b'.repeat(64), messages: [] }, identity)).reason, 'cursor_gap');
  const second = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'pending', start: 1, end: 2,
    sliceHash: 'c'.repeat(64), messages: [{ messageId: 'm2', start: 1, end: 2 }] }, identity);
  assert.equal(second.kind, 'queued');
  const pending = { candidateKey: 'fact', evidence: { messageId: 'm2', start: 1, end: 2 },
    externalId: externalIdFor({ projectId: 'p', originCli: 'codex', sessionId: 'pending', start: 1, end: 2,
      sliceHash: 'c'.repeat(64), policyVersion: 'native-v1', candidateKey: 'fact' }) };
  const { file: pendingFile, ...pendingRef } = await writeCandidateRef(dir, second.operationId, 'p', pending);
  pending.payloadRef = pendingRef;
  assert.equal((await outbox.recordManifest(second.operationId, [pending])).kind, 'manifested');
  assert.equal((await outbox.completeCheckpoint(second.operationId)).reason, 'unresolved_candidates');
  let processed = 0;
  for (let n = 2; n < 20; n++) {
    const next = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'pending', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [] }, identity);
    if (next.kind === 'full') break;
    assert.equal(next.kind, 'queued');
    if ((await outbox.recordManifest(next.operationId, [])).kind === 'full') break;
    if ((await outbox.completeCheckpoint(next.operationId)).kind === 'full') break;
    processed++;
  }
  assert.ok(processed > 0);
  const cursor = await createOutbox(dir).cursor('codex', 'pending');
  assert.ok(cursor.queuedEnd >= 2 + processed);
  assert.equal(cursor.ackedEnd, 0);
  assert.equal(cursor.processedEnd, 1);
  assert.equal((await fs.readdir(path.join(dir, 'outbox'))).some(name => name.startsWith('cursor-')), false);
  assert.equal((await createOutbox(dir).readManifest(second.operationId)).candidates[0].status, 'pending');
});

test('tiny files consume allocated blocks in quota and stop before physical limit', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 32768 });
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const first = { cli: 'codex', sessionId: 's', start: 0, end: 1,
    sliceHash: 'a'.repeat(64), messages: [] };
  assert.equal((await outbox.enqueueCheckpoint(first, identity)).kind, 'queued');
  const used = await outbox.usage();
  const firstFile = (await fs.readdir(path.join(dir, 'outbox', 'items')))[0];
  const stat = await fs.stat(path.join(dir, 'outbox', 'items', firstFile));
  assert.ok(used > stat.size * 10, `allocated=${used} logical=${stat.size}`);
  assert.equal((await outbox.enqueueCheckpoint({ ...first, start: 1, end: 2,
    sliceHash: 'b'.repeat(64) }, identity)).kind, 'full');
  assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 1);
});

test('no facts and rejected or duplicate candidates close locally without fake remote ACK', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const source = { projectId: 'p', originCli: 'claude', sessionId: 's', start: 0, end: 4,
    sliceHash: 'c'.repeat(64), policyVersion: 'native-v1' };
  const first = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 4,
    sliceHash: source.sliceHash, messages: [] }, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal((await outbox.recordManifest(first.operationId, [])).kind, 'manifested');
  assert.equal((await outbox.completeCheckpoint(first.operationId)).kind, 'processed');
  const second = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 4, end: 8,
    sliceHash: 'd'.repeat(64), messages: [{ messageId: 'm2', start: 4, end: 8, text: 'claim' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const children = ['rejected', 'duplicate'].map(candidateKey => ({ candidateKey, evidence: { messageId: 'm2', start: 4, end: 8 },
    externalId: externalIdFor({ ...source, start: 4, end: 8, sliceHash: 'd'.repeat(64), candidateKey }) }));
  for (const child of children) child.payloadRef = await writeCandidateRef(dir, second.operationId, 'p', child);
  for (const child of children) delete child.payloadRef.file;
  await outbox.recordManifest(second.operationId, children);
  assert.equal((await outbox.disposeCandidate(second.operationId, 'rejected', 'rejected', 'unsupported_claim')).kind, 'disposed');
  assert.equal((await outbox.disposeCandidate(second.operationId, 'duplicate', 'duplicate', 'existing_fact')).kind, 'disposed');
  assert.equal((await outbox.completeCheckpoint(second.operationId)).kind, 'processed');
  assert.deepEqual(await outbox.cursor('claude', 's'), { queuedEnd: 8, ackedEnd: 0, processedEnd: 8 });
  assert.equal((await outbox.ackVerified(second.operationId, {})).kind, 'blocked');
  assert.equal((await outbox.readDisposition(second.operationId)).candidates[0].status, 'rejected');
  assert.deepEqual(await outbox.readDisposition('../../foreign'), { kind: 'blocked', reason: 'invalid_operation' });
});

test('remote outage records bounded retry state while bytes and ACK remain pending', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const queued = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 9,
    sliceHash: 'f'.repeat(64), messages: [{ text: 'safe' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const before = Date.now();
  const failed = await outbox.markFailed(queued.operationId, 'remote_unavailable');
  assert.equal(failed.kind, 'pending');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.retryAt > before);
  assert.equal((await createOutbox(dir).pending())[0].lastError, 'remote_unavailable');
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 0);
  assert.equal((await outbox.ready(before)).length, 0);
  assert.equal((await outbox.ready(failed.retryAt)).length, 1);
  for (let n = 1; n < 5; n++) await outbox.markFailed(queued.operationId, 'remote_unavailable');
  assert.equal((await outbox.ready(Date.now() + 1000000)).length, 0);
  assert.equal((await outbox.pending()).length, 1);
});

test('capacity rejects without advancing queued cursor; replay follows freed capacity', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 48000 });
  const one = { cli: 'codex', sessionId: 's', start: 0, end: 4, sliceHash: 'a'.repeat(64), messages: [{ text: 'x'.repeat(9000) }] };
  const queued = await outbox.enqueueCheckpoint(one, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(queued.kind, 'queued');
  assert.equal(queued.alert, true);
  const full = await outbox.enqueueCheckpoint({ ...one, start: 4, end: 8, sliceHash: 'b'.repeat(64) }, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(full.kind, 'full');
  assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 4);
  await outbox.ackVerified(queued.operationId, { externalId: queued.operationId, sdkId: 's', qdrantId: 'q', projectId: 'p', status: 'active' });
  assert.ok(await outbox.usage() > 0, 'ACK and cursor summary consume disk quota');
  const replay = await createOutbox(dir, { maxBytes: 48000 }).enqueueCheckpoint({ ...one, start: 4, end: 8, sliceHash: 'b'.repeat(64) }, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(replay.kind, 'queued');
  assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 8);
  assert.equal((await outbox.enqueueCheckpoint(one, { projectId: 'p', policyVersion: 'native-v1' })).kind,
    'acked', 'an identical old operation remains idempotent');
  assert.equal((await outbox.enqueueCheckpoint({ ...one, sliceHash: 'c'.repeat(64) },
    { projectId: 'p', policyVersion: 'native-v1' })).kind, 'blocked');
});

test('six MiB backlog resumes at complete lines after full queue and restart', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const row = JSON.parse((await fs.readFile(fixture('memoria-native-claude.jsonl'), 'utf8')).split('\n')[0]);
  row.message.content = [{ type: 'text', text: 'x'.repeat(1024 * 1024) }];
  const file = path.join(dir, 'native-session.jsonl');
  const lines = Array.from({ length: 6 }, (_, n) => JSON.stringify({ ...row, uuid: `large-${n}` }) + '\n');
  await fs.writeFile(file, lines.join(''));
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const first = await parsePersistedSlice({ cli: 'claude', transcriptPath: file, sessionId: 'native-session' });
  assert.equal(first.messages.length, 3);
  const outbox = createOutbox(dir, { maxBytes: 4 * 1024 * 1024 });
  const a = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 'native-session', start: 0,
    end: first.lastCompleteByte, sliceHash: (await import('node:crypto')).createHash('sha256').update(first.completeBytes).digest('hex'),
    messages: first.messages }, identity);
  assert.equal(a.kind, 'queued');
  const next = await parsePersistedSlice({ cli: 'claude', transcriptPath: file,
    start: first.lastCompleteByte, sessionId: 'native-session' });
  assert.equal(next.messages.length, 3);
  const rest = { cli: 'claude', sessionId: 'native-session', start: first.lastCompleteByte,
    end: next.lastCompleteByte, sliceHash: (await import('node:crypto')).createHash('sha256').update(next.completeBytes).digest('hex'),
    messages: next.messages };
  assert.equal((await outbox.enqueueCheckpoint(rest, identity)).kind, 'full');
  assert.equal((await createOutbox(dir).cursor('claude', 'native-session')).queuedEnd, first.lastCompleteByte);
  await outbox.ackVerified(a.operationId, { externalId: a.operationId, projectId: 'p', sdkId: 'sdk', qdrantId: 'q', status: 'active' });
  assert.equal((await createOutbox(dir, { maxBytes: 4 * 1024 * 1024 }).enqueueCheckpoint(rest, identity)).kind, 'queued');
  assert.equal((await outbox.cursor('claude', 'native-session')).queuedEnd, (await fs.stat(file)).size);
});

test('receipt compaction keeps cursor and project binding before removing old receipts', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 48000 });
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  let first;
  for (let n = 0; n < 3; n++) {
    const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [{ text: 'x' }] }, identity);
    assert.equal(queued.kind, 'queued');
    if (n === 0) first = queued;
    assert.equal((await outbox.ackVerified(queued.operationId, { externalId: queued.operationId,
      projectId: 'p', sdkId: 's', qdrantId: 'q', status: 'active' })).kind, 'acked');
  }
  const next = { cli: 'codex', sessionId: 's', start: 3, end: 4,
    sliceHash: '3'.padStart(64, '0'), messages: [{ text: 'x'.repeat(9000) }] };
  assert.equal((await outbox.enqueueCheckpoint(next, identity)).kind, 'queued');
  assert.deepEqual((await createOutbox(dir).cursor('codex', 's')), { queuedEnd: 4, ackedEnd: 3, processedEnd: 3 });
  assert.equal((await outbox.enqueueCheckpoint({ ...next, start: 0, end: 1, sliceHash: '0'.repeat(64) }, identity)).kind,
    'acked', 'an exact compacted operation remains idempotent');
  assert.equal((await outbox.ackVerified(first.operationId, { externalId: first.operationId,
    projectId: 'p', sdkId: 's', qdrantId: 'q', status: 'active' })).kind, 'acked');
  assert.equal((await outbox.ackVerified(first.operationId, { externalId: first.operationId,
    projectId: 'p', sdkId: 'wrong', qdrantId: 'q', status: 'active' })).kind, 'blocked');
  assert.equal((await outbox.enqueueCheckpoint({ ...next, start: 4, end: 5, sliceHash: '4'.padStart(64, '0') },
    { projectId: 'foreign', policyVersion: 'native-v1' })).kind, 'blocked');
  assert.ok(first.operationId);
});

test('SIGKILL during highwater compaction resumes without duplicate or lost cursor', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const outbox = createOutbox(dir, { maxBytes: 48000 });
    const identity = { projectId: 'p', policyVersion: 'native-v1' };
    for (let n = 0; n < 3; n++) {
      const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: n, end: n + 1,
        sliceHash: n.toString(16).padStart(64, '0'), messages: [{ text: 'x' }] }, identity);
      await outbox.ackVerified(queued.operationId, { externalId: queued.operationId,
        projectId: 'p', sdkId: 'sdk', qdrantId: 'q', status: 'active' });
    }
    const next = { cli: 'codex', sessionId: 's', start: 3, end: 4,
      sliceHash: '3'.padStart(64, '0'), messages: [{ text: 'x'.repeat(9000) }] };
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
const outbox = createOutbox(process.argv[1], { maxBytes: 48000, fault: stage => {
  if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL');
} });
await outbox.enqueueCheckpoint(JSON.parse(process.argv[3]), { projectId: 'p', policyVersion: 'native-v1' });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, boundary,
      JSON.stringify(next)], { stdio: 'ignore' });
    const signal = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (_code, exitSignal) => resolve(exitSignal));
    });
    assert.equal(signal, 'SIGKILL');
    assert.equal((await createOutbox(dir).cursor('codex', 's')).ackedEnd, 3);
    assert.equal((await fs.readdir(path.join(dir, 'outbox'))).some(name => name.endsWith('.tmp')), false);
    const replay = await createOutbox(dir, { maxBytes: 48000 }).enqueueCheckpoint(next, identity);
    assert.equal(replay.kind, 'queued', JSON.stringify(replay));
    assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 4);
  }
});

test('two simultaneous reclaimers preserve a stale legacy owner inode', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const kind of ['file', 'directory']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'outbox');
    await fs.mkdir(root, { mode: 0o700 });
    const legacy = path.join(root, 'lock');
    if (kind === 'file') await fs.writeFile(legacy, '999999999', { mode: 0o600 });
    else {
      await fs.mkdir(legacy, { mode: 0o700 });
      await fs.writeFile(path.join(legacy, 'pid'), '999999999', { mode: 0o600 });
    }
    const before = await fs.lstat(legacy);
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
process.stdout.write('ready\\n');
process.stdin.once('data', async () => {
  try { await createOutbox(process.argv[1]).usage(); process.stdout.write('entered\\n'); }
  catch (error) { process.stdout.write(error.message + '\\n'); }
});`;
    const children = [0, 1].map(() => spawn(process.execPath,
      ['--input-type=module', '-e', source, dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }));
    const outputs = children.map(child => new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; if (output.includes('ready\n')) resolve(output); });
      child.once('error', reject);
    }));
    await Promise.all(outputs);
    const results = children.map(child => new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    }));
    for (const child of children) child.stdin.end('go\n');
    for (const result of await Promise.all(results)) {
      assert.equal(result.code, 0);
      assert.match(result.output, /outbox_legacy_lock/);
      assert.doesNotMatch(result.output, /entered/);
    }
    assert.equal((await fs.lstat(legacy)).ino, before.ino);
    assert.equal((await fs.lstat(legacy)).dev, before.dev);
  }
});

test('ENOSPC and SIGKILL during kernel lock preparation leave replay available', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const failure of ['ENOSPC', 'MARKER_ENOSPC', 'SIGKILL', 'MARKER_SIGKILL']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
const source = `import fs from 'node:fs/promises';
import { createOutbox } from ${JSON.stringify(moduleUrl)};
const open = fs.open;
fs.open = async (file, ...args) => {
  if (process.argv[2] === 'ENOSPC' && String(file).endsWith('/.kernel-lock'))
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const handle = await open(file, ...args);
  if (process.argv[2] === 'SIGKILL' && String(file).endsWith('/.kernel-lock'))
    process.kill(process.pid, 'SIGKILL');
  if (['MARKER_ENOSPC', 'MARKER_SIGKILL'].includes(process.argv[2]) &&
      String(file).includes('/outbox/.') && String(file).endsWith('.tmp')) {
    handle.writeFile = async () => {
      if (process.argv[2] === 'MARKER_SIGKILL') process.kill(process.pid, 'SIGKILL');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
  }
  return handle;
};
try {
  await createOutbox(process.argv[1]).enqueueCheckpoint({ cli: 'codex', sessionId: 'lock', start: 0,
    end: 1, sliceHash: 'a'.repeat(64), messages: [] }, { projectId: 'p', policyVersion: 'native-v1' });
  process.exitCode = 2;
} catch (error) { if (error.code !== 'ENOSPC') process.exitCode = 3; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, failure], { stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, failure.includes('SIGKILL') ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null });
    const root = path.join(dir, 'outbox');
    const names = await fs.readdir(root);
    assert.equal(names.includes('lock'), false, failure);
    if (failure !== 'MARKER_SIGKILL') assert.equal(names.some(name => name.endsWith('.tmp')), false, failure);
    assert.equal((await fs.readdir(path.join(root, 'items'))).length, 0);
    const replay = await createOutbox(dir).enqueueCheckpoint({ cli: 'codex', sessionId: 'lock', start: 0,
      end: 1, sliceHash: 'a'.repeat(64), messages: [] }, { projectId: 'p', policyVersion: 'native-v1' });
    assert.equal(replay.kind, 'queued', failure);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false, failure);
    assert.deepEqual(await createOutbox(dir).cursor('codex', 'lock'),
      { queuedEnd: 1, ackedEnd: 0, processedEnd: 0 });
  }
});

test('unknown, live and dead legacy owners remain unchanged', async t => {
  for (const owner of ['missing', 'live', 'dead']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const outbox = createOutbox(dir);
    await fs.mkdir(path.join(dir, 'outbox'), { mode: 0o700 });
    const lock = path.join(dir, 'outbox', 'lock');
    await fs.mkdir(lock, { mode: 0o700 });
    if (owner === 'live') await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
    if (owner === 'dead') await fs.writeFile(path.join(lock, 'pid'), '999999999');
    const old = new Date(Date.now() - 60000);
    await fs.utimes(lock, old, old);
    const inode = (await fs.lstat(lock)).ino;
    await assert.rejects(outbox.usage(), /outbox_legacy_lock/);
    assert.equal((await fs.lstat(lock)).ino, inode);
  }
});

test('kernel lock survives flock child exit, blocks a second process, and SIGKILL releases it', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  const row = { cli: 'codex', sessionId: 'kernel', start: 0, end: 5,
    sliceHash: 'a'.repeat(64), messages: [{ text: 'held' }] };
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
await createOutbox(process.argv[1], { fault: async stage => {
  if (stage === 'after_write') {
    process.stdout.write('held\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
} }).enqueueCheckpoint(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));`;
  const a = spawn(process.execPath, ['--input-type=module', '-e', source, dir,
    JSON.stringify(row), JSON.stringify(identity)], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  t.after(() => a.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    a.stdout.on('data', data => { if (String(data).includes('held\n')) resolve(); });
    a.once('error', reject);
    a.once('close', () => reject(new Error('holder exited before mutation barrier')));
  });
  const root = path.join(dir, 'outbox');
  const lock = path.join(root, '.kernel-lock');
  const before = await fs.lstat(lock);
  const temporary = (await fs.readdir(path.join(root, 'items'))).find(name => name.endsWith('.tmp'));
  assert.ok(temporary);
  const contender = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
try { await createOutbox(process.argv[1]).usage(); process.stdout.write('entered'); }
catch (error) { process.stdout.write(error.message); }`;
  const b = await run(process.execPath, ['--input-type=module', '-e', contender, dir],
    { env: { PATH: '/usr/bin:/bin' }, timeout: 3000 });
  assert.equal(b.stdout, 'outbox_lock_timeout');
  assert.equal((await fs.lstat(lock)).ino, before.ino);
  assert.ok((await fs.readdir(path.join(root, 'items'))).includes(temporary));
  assert.equal((await fs.readdir(path.join(root, 'acks'))).length, 0);
  const closed = new Promise(resolve => a.once('close', resolve));
  a.kill('SIGKILL');
  await closed;
  const fresh = createOutbox(dir);
  assert.deepEqual(await fresh.cursor('codex', 'kernel'), { queuedEnd: 0, ackedEnd: 0, processedEnd: 0 });
  const queued = await fresh.enqueueCheckpoint(row, identity);
  assert.equal(queued.kind, 'queued');
  assert.equal((await createOutbox(dir).enqueueCheckpoint(row, identity)).operationId, queued.operationId);
  assert.equal((await fresh.pending()).length, 1);
  assert.deepEqual(await fresh.cursor('codex', 'kernel'), { queuedEnd: 5, ackedEnd: 0, processedEnd: 0 });
  assert.equal((await fs.lstat(lock)).ino, before.ino);
});

test('concurrent callers in one process cannot enter the same protected mutation', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const row = { cli: 'codex', sessionId: 'same-process', start: 0, end: 1,
    sliceHash: 'b'.repeat(64), messages: [] };
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  let release;
  let entered;
  const atWrite = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const first = createOutbox(dir, { fault: async stage => {
    if (stage === 'after_write') { entered(); await barrier; }
  } }).enqueueCheckpoint(row, identity);
  await atWrite;
  let secondEntered = false;
  const second = createOutbox(dir).enqueueCheckpoint(row, identity).then(result => {
    secondEntered = true; return result;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(secondEntered, false);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.kind, 'queued');
  assert.equal(two.operationId, one.operationId);
  assert.equal((await createOutbox(dir).pending()).length, 1);
});

test('unsuitable flock utility, filesystem and changed inode fail before mutation', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const failure of ['utility', 'filesystem', 'identity']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = `import fs from 'node:fs/promises';
import { createOutbox } from ${JSON.stringify(moduleUrl)};
const kind = process.argv[2];
if (kind === 'filesystem') {
  const statfs = fs.statfs;
  fs.statfs = async (...args) => ({ ...await statfs(...args), type: 0x6969 });
}
const lstat = fs.lstat;
let checks = 0;
fs.lstat = async (file, ...args) => {
  if (kind === 'identity' && String(file).endsWith('/.kernel-lock') && ++checks === 2) {
    await fs.rename(file, file + '.retired');
    await fs.writeFile(file, '', { mode: 0o600 });
  }
  const stat = await lstat(file, ...args);
  if (kind === 'utility' && file === '/usr/bin/flock') stat.mode |= 0o002;
  return stat;
};
try {
  await createOutbox(process.argv[1]).enqueueCheckpoint({ cli: 'codex', sessionId: 'guard',
    start: 0, end: 1, sliceHash: 'a'.repeat(64), messages: [] },
  { projectId: 'p', policyVersion: 'native-v1' });
  process.stdout.write('entered');
} catch (error) { process.stdout.write(error.message); }`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source, dir, failure],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 3000 });
    assert.equal(stdout, failure === 'utility' ? 'outbox_lock_utility_unavailable' :
      failure === 'filesystem' ? 'outbox_lock_unsupported' : 'outbox_lock_identity_changed');
    const root = path.join(dir, 'outbox');
    assert.equal((await fs.readdir(path.join(root, 'items'))).length, 0);
    assert.equal((await fs.readdir(path.join(root, 'acks'))).length, 0);
    assert.equal((await fs.readdir(root)).includes('lock'), false);
    if (failure === 'identity') {
      assert.equal((await createOutbox(dir).enqueueCheckpoint({ cli: 'codex', sessionId: 'guard', start: 0,
        end: 1, sliceHash: 'a'.repeat(64), messages: [] },
      { projectId: 'p', policyVersion: 'native-v1' })).kind, 'queued');
    }
  }
});

test('persistent marker rejects replacement or disappearance of the kernel inode', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  await outbox.usage();
  const root = path.join(dir, 'outbox');
  const kernel = path.join(root, '.kernel-lock');
  const marker = path.join(root, 'lock');
  assert.equal((await fs.lstat(kernel)).mode & 0o777, 0o600);
  assert.equal((await fs.lstat(marker)).mode & 0o777, 0o600);
  const markerBefore = await fs.readFile(marker, 'utf8');
  await fs.rename(kernel, `${kernel}.retired`);
  await assert.rejects(outbox.usage(), /outbox_lock_identity_changed/);
  assert.equal((await fs.readFile(marker, 'utf8')), markerBefore);
  assert.equal((await fs.readdir(root)).includes('.kernel-lock'), false);
  await fs.writeFile(kernel, '', { mode: 0o600 });
  await assert.rejects(createOutbox(dir).usage(), /outbox_lock_identity_changed/);
  assert.equal((await fs.readFile(marker, 'utf8')), markerBefore);
});

test('flock spawn error, nonzero exit and hung child close descriptors without mutation', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const failure of ['spawn', 'exit', 'hung']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const realSpawn = cp.spawn;
cp.spawn = (_file, _args, options) => realSpawn(
  process.argv[2] === 'spawn' ? '/missing/cbs-flock' :
  process.argv[2] === 'exit' ? '/usr/bin/flock' : '/usr/bin/sleep',
  process.argv[2] === 'exit' ? ['--invalid-cbs-option'] :
  process.argv[2] === 'hung' ? ['5'] : [], options);
syncBuiltinESMExports();
const { createOutbox } = await import(${JSON.stringify(moduleUrl)});
try { await createOutbox(process.argv[1]).usage(); process.stdout.write('entered'); }
catch (error) { process.stdout.write(error.message); }`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source, dir, failure],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 3000 });
    assert.equal(stdout, 'outbox_lock_utility_unavailable');
    assert.equal((await fs.readdir(path.join(dir, 'outbox'))).includes('lock'), false);
    assert.equal((await createOutbox(dir).usage()) >= 0, true);
  }
});

test('default 256 MiB quota alerts, stops, and replays after ACK', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const text = 'x'.repeat(32 * 1024 * 1024);
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  let first;
  for (let n = 0; n < 7; n++) {
    const row = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'large', start: n, end: n + 1,
      sliceHash: n.toString(16).padStart(64, '0'), messages: [{ text }] }, identity);
    assert.equal(row.kind, 'queued');
    if (n === 0) first = row;
    if (n === 6) assert.equal(row.alert, true);
  }
  const eighth = { cli: 'codex', sessionId: 'large', start: 7, end: 8,
    sliceHash: '7'.padStart(64, '0'), messages: [{ text }] };
  assert.equal((await outbox.enqueueCheckpoint(eighth, identity)).kind, 'full');
  assert.equal((await outbox.cursor('codex', 'large')).queuedEnd, 7);
  assert.ok((await outbox.usage()) <= 256 * 1024 * 1024);
  await outbox.ackVerified(first.operationId, { externalId: first.operationId, projectId: 'p',
    sdkId: 'sdk', qdrantId: 'q', status: 'active' });
  assert.equal((await createOutbox(dir).enqueueCheckpoint(eighth, identity)).kind, 'queued');
  assert.equal((await outbox.cursor('codex', 'large')).queuedEnd, 8);
});

test('unconfigured capture is a default pass-through and never starts optional state', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateRoot = path.join(dir, 'state');
  const result = await captureEvent({ cli: 'claude', event: 'SessionStart', payload: {
    cwd: dir, session_id: 's', transcript_path: fixture('memoria-native-claude.jsonl'),
    hook_event_name: 'SessionStart',
  }, stateRoot });
  assert.equal(result.kind, 'pass_through');
  await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' });
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} capture requires a locally applied native exclusion and exact hooks`, async t => {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await run('git', ['init', '-q', dir]);
    const stateRoot = path.join(dir, 'state');
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot })).kind, 'blocked');
    assert.equal((await applyNativeExclusion(dir, { cli, stateRoot, installedPlugin: true })).kind, 'applied');
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot, installedPlugin: true })).kind, 'verified');
    const nativePath = path.join(dir, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
    if (cli === 'claude') {
      const data = JSON.parse(await fs.readFile(nativePath, 'utf8'));
      data.enabledPlugins['claude-mem@thedotmack'] = true;
      await fs.writeFile(nativePath, JSON.stringify(data));
    } else {
      await fs.writeFile(nativePath, (await fs.readFile(nativePath, 'utf8')).replace('enabled = false', 'enabled = true'));
    }
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot, installedPlugin: true })).kind, 'blocked');
  });
}

for (const cli of ['claude', 'codex']) {
  test(`${cli} tracked native config blocks capture under forged GIT_DIR and GIT_WORK_TREE`, async t => {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'project'); await fs.mkdir(root); await run('git', ['init', '-q', root]);
    const foreign = path.join(dir, 'foreign'); await fs.mkdir(foreign); await run('git', ['init', '-q', foreign]);
    const stateRoot = path.join(dir, 'state');
    await fs.mkdir(path.join(root, '.cbs'));
    await fs.writeFile(path.join(root, '.cbs/memoria.json'), JSON.stringify({ provider: 'mem0',
      project_id: 'project-one', qdrant: { url: 'https://qdrant.internal', collection: 'cbs-project-one',
        api_key_env: 'CBS_MEMORIA_TEST_KEY' }, embedding: { model: 'multilingual-e5-small', dimension: 384,
        fingerprint: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' } }));
    const transcriptPath = path.join(dir, cli === 'claude' ? 'native-session.jsonl' : 'rollout-native-session.jsonl');
    await fs.copyFile(fixture(`memoria-native-${cli}.jsonl`), transcriptPath);
    assert.equal((await applyNativeExclusion(root, { cli, stateRoot, installedPlugin: true })).kind, 'applied');
    const resolution = await inspectConfiguration(root, { stateRoot });
    await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
    const payload = { cwd: root, session_id: 'native-session', transcript_path: transcriptPath,
      hook_event_name: 'SessionStart' };
    const args = { cli, event: 'SessionStart', payload, stateRoot, installedPlugin: true };
    assert.equal((await captureEvent(args)).kind, 'queued');
    const nativePath = path.join(root, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
    await run('git', ['-C', root, 'add', '-f', '--', path.relative(root, nativePath)]);
    const nativeLine = (await fs.readFile(transcriptPath, 'utf8')).split('\n')[0];
    await fs.appendFile(transcriptPath, nativeLine + '\n');
    const outbox = createOutbox(resolution.stateDir);
    const prior = (await outbox.pending()).length;
    assert.equal((await verifyNativeCapture(root, { cli, stateRoot, installedPlugin: true })).reason, 'unsafe_native_config');
    const moduleUrl = new URL('../base/memoria/checkpoint.mjs', import.meta.url).href;
    const script = `import { captureEvent } from ${JSON.stringify(moduleUrl)};
const result = await captureEvent(JSON.parse(process.argv[1]));
process.stdout.write(JSON.stringify(result));`;
    const stop = { ...args, event: 'Stop', payload: { ...payload, hook_event_name: 'Stop' } };
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(stop)],
      { env: { ...process.env, GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: root } });
    assert.deepEqual(JSON.parse(stdout), { kind: 'blocked', reason: 'unsafe_native_config' });
    assert.equal((await outbox.pending()).length, prior);
  });
}

test('legacy Codex exclusion snapshot still restores without a Task4 hook file', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); await fs.mkdir(root); await run('git', ['init', '-q', root]);
  const stateRoot = path.join(dir, 'state');
  await applyNativeExclusion(root, { cli: 'codex', stateRoot, installedPlugin: true });
  const snap = path.join(stateRoot, (await import('node:crypto')).createHash('sha256').update(root).digest('hex'), 'native-codex.json');
  const saved = JSON.parse(await fs.readFile(snap, 'utf8'));
  for (const key of ['capturePath', 'captureExisted', 'captureExclude', 'pluginChecked']) delete saved[key];
  await fs.writeFile(snap, JSON.stringify(saved));
  await fs.rm(path.join(root, '.codex/hooks.json'));
  assert.equal((await restoreNativeExclusion(root, { cli: 'codex', stateRoot })).kind, 'restored');
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} SessionStart guard captures persisted bytes once and rejects live config mutation`, async t => {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'project'); await fs.mkdir(root); await run('git', ['init', '-q', root]);
    const stateRoot = path.join(dir, 'state');
    const config = { provider: 'mem0', project_id: 'project-one',
      qdrant: { url: 'https://qdrant.internal', collection: 'cbs-project-one', api_key_env: 'CBS_MEMORIA_TEST_KEY' },
      embedding: { model: 'multilingual-e5-small', dimension: 384,
        fingerprint: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' } };
    await fs.mkdir(path.join(root, '.cbs'));
    await fs.writeFile(path.join(root, '.cbs/memoria.json'), JSON.stringify(config));
    const transcriptPath = path.join(dir, cli === 'claude' ? 'native-session.jsonl' : 'rollout-native-session.jsonl');
    await fs.copyFile(fixture(`memoria-native-${cli}.jsonl`), transcriptPath);
    const payload = { cwd: root, session_id: 'native-session', transcript_path: transcriptPath,
      hook_event_name: 'SessionStart' };
    const args = { cli, event: 'SessionStart', payload, stateRoot, installedPlugin: true };
    assert.equal((await captureEvent(args)).kind, 'blocked');
    await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' });
    await applyNativeExclusion(root, { cli, stateRoot, installedPlugin: true });
    assert.equal((await captureEvent(args)).reason, 'trust_changed');
    const resolution = await inspectConfiguration(root, { stateRoot });
    await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
    const first = await captureEvent(args);
    assert.equal(first.kind, 'queued');
    const repeated = await captureEvent(args);
    assert.equal(repeated.kind, 'no_complete_bytes');
    const outbox = createOutbox(path.join(stateRoot, (await import('node:crypto')).createHash('sha256').update(root).digest('hex')));
    assert.equal((await outbox.pending()).length, 1);
    for (let n = 0; n < 20; n++) {
      assert.equal((await captureEvent({ ...args, event: 'PostToolUse', payload: { ...payload, hook_event_name: 'PostToolUse' } })).kind, 'blocked');
    }
    assert.equal((await outbox.pending()).length, 1);
    const nativeRows = (await fs.readFile(fixture(`memoria-native-${cli}.jsonl`), 'utf8')).trimEnd().split('\n').map(JSON.parse);
    const large = structuredClone(cli === 'claude' ? nativeRows[0] : nativeRows[1]);
    if (cli === 'claude') large.message.content = [{ type: 'text', text: 'x'.repeat(1024 * 1024) }];
    else large.payload.content = [{ type: 'input_text', text: 'x'.repeat(1024 * 1024) }];
    const appended = Array.from({ length: 6 }, (_, n) => {
      const line = structuredClone(large);
      if (cli === 'claude') line.uuid = `appended-${n}`; else line.payload.id = `appended-${n}`;
      return JSON.stringify(line) + '\n';
    });
    await fs.appendFile(transcriptPath, appended.join(''));
    assert.equal((await captureEvent({ ...args, event: 'Stop', payload: { ...payload, hook_event_name: 'Stop' } })).kind,
      'queued');
    assert.equal((await outbox.pending()).length, 3);
    config.project_id = 'changed';
    await fs.writeFile(path.join(root, '.cbs/memoria.json'), JSON.stringify(config));
    assert.equal((await captureEvent({ ...args, event: 'Stop', payload: { ...payload, hook_event_name: 'Stop' } })).kind, 'blocked');
  });
}

test('fault at each item file boundary never acknowledges and replays at most one ID', async t => {
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const row = { cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'c'.repeat(64), messages: [{ text: 'durable' }] };
    const identity = { projectId: 'p', policyVersion: 'native-v1' };
    const broken = createOutbox(dir, { fault: stage => { if (stage === boundary) throw new Error('injected'); } });
    await assert.rejects(broken.enqueueCheckpoint(row, identity), /injected/);
    const recovered = createOutbox(dir);
    const pending = await recovered.pending();
    assert.ok(pending.length <= 1);
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, 0);
    const replay = await recovered.enqueueCheckpoint(row, identity);
    assert.equal(replay.kind, 'queued');
    assert.equal((await recovered.pending()).length, 1);
  }
});

test('injected ENOSPC keeps source cursor and replays after capacity returns', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const row = { cli: 'codex', sessionId: 's', start: 0, end: 4,
    sliceHash: 'f'.repeat(64), messages: [{ text: 'persisted' }] };
  const identity = { projectId: 'p', policyVersion: 'native-v1' };
  const failed = createOutbox(dir, { fault: stage => {
    if (stage === 'after_write') { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; }
  } });
  await assert.rejects(failed.enqueueCheckpoint(row, identity), { code: 'ENOSPC' });
  assert.deepEqual(await createOutbox(dir).cursor('codex', 's'), { queuedEnd: 0, ackedEnd: 0, processedEnd: 0 });
  assert.equal((await createOutbox(dir).enqueueCheckpoint(row, identity)).kind, 'queued');
  assert.equal((await createOutbox(dir).pending()).length, 1);
});

test('real SIGKILL at item boundaries replays the durable operation once', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
const box = createOutbox(process.argv[1], { fault: stage => { if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });
await box.enqueueCheckpoint({cli:'codex',sessionId:'crash',start:0,end:4,sliceHash:'d'.repeat(64),messages:[{text:'durable'}]}, {projectId:'p',policyVersion:'native-v1'});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, boundary], { stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, 'SIGKILL', `${boundary}: ${JSON.stringify(result)}`);
    const outbox = createOutbox(dir);
    const before = await outbox.pending();
    assert.equal(before.length, boundary === 'after_write' || boundary === 'after_file_sync' ? 0 : 1);
    assert.equal((await outbox.cursor('codex', 'crash')).ackedEnd, 0);
    const replay = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'd'.repeat(64), messages: [{ text: 'durable' }] },
    { projectId: 'p', policyVersion: 'native-v1' });
    assert.equal(replay.kind, 'queued');
    assert.equal((await outbox.pending()).length, 1);
  }
});

test('real SIGKILL at ACK boundaries never advances before durable receipt', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const outbox = createOutbox(dir);
    const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'e'.repeat(64), messages: [{ text: 'durable' }] },
    { projectId: 'p', policyVersion: 'native-v1' });
    const proof = { externalId: queued.operationId, projectId: 'p', sdkId: 'sdk-1', qdrantId: 'q-1', status: 'active' };
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
const box = createOutbox(process.argv[1], { fault: stage => { if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });
await box.ackVerified(process.argv[3], JSON.parse(process.argv[4]));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, boundary,
      queued.operationId, JSON.stringify(proof)], { stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, 'SIGKILL', `${boundary}: ${JSON.stringify(result)}`);
    const recovered = createOutbox(dir);
    const expected = boundary === 'after_write' || boundary === 'after_file_sync' ? 0 : 4;
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, expected);
    assert.equal((await recovered.ackVerified(queued.operationId, proof)).kind, 'acked');
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, 4);
    assert.equal((await recovered.pending()).length, 0);
  }
});
