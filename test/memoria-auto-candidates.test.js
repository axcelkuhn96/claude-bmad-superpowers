import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { extractCheckpoint, validateCandidate } from '../base/memoria/candidates.mjs';
import { publishCheckpointAutomatically } from '../base/memoria/auto-publish.mjs';
import { POLICY_VERSION } from '../base/memoria/transcript.mjs';

const consent = { version: 1, enabled: true, projectId: 'p', destinationHash: 'a'.repeat(64),
  ownerId: 'owner-123', deviceId: 'device-123', consentHash: 'b'.repeat(64),
  enabledAt: '2026-10-13T09:00:00Z' };
const base = { origin: 'human', actor: 'user', speakerRole: 'user', messageId: 'm1',
  timestamp: '2026-10-13T10:00:00Z', start: 0, end: 900 };

async function fixture(t, text, origin = 'human') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-auto-candidates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const outbox = createOutbox(stateDir);
  const source = { ...base, text, origin };
  const row = { cli: 'claude', sessionId: 'session', start: 0, end: 900,
    sliceHash: 'c'.repeat(64), messages: [source] };
  const queued = await outbox.enqueueCheckpoint(row, { projectId: 'p', policyVersion: POLICY_VERSION });
  assert.equal(queued.kind, 'queued');
  return { outbox, stateDir, source, row: { ...row, operationId: queued.operationId,
    projectId: 'p', policyVersion: POLICY_VERSION } };
}

async function extract(row, outbox, candidates) {
  return extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async () => ({ kind: 'success',
      model: 'claude-haiku-5-5', decisions: [{ source_message_id: 'm1',
        abstain_reason: '', candidates }] }) });
}

test('long human message publishes only its short literal durable span', async t => {
  const fact = 'Use PostgreSQL para persistência do projeto.';
  const text = `${fact}\n${'Contexto adicional de arquitetura. '.repeat(24)}`;
  assert.ok(Buffer.byteLength(text, 'utf8') > 512);
  const { outbox, row, source } = await fixture(t, text);
  assert.equal((await extract(row, outbox, [{ text: fact, type: 'rule', scope: 'project' }])).kind,
    'manifested');
  const manifest = await outbox.readManifest(row.operationId);
  assert.equal(manifest.candidates.length, 1);
  const payload = await outbox.readCandidatePayload(row.operationId, manifest.candidates[0].candidateKey);
  assert.equal(payload.text, fact);
  assert.equal(payload.format_version, 3);
  assert.equal(validateCandidate(payload, source).eligible, true);
  assert.ok(!JSON.stringify(payload).includes('Contexto adicional de arquitetura'));
  const forged = { ...payload, text: source.text,
    claim_sha256: createHash('sha256').update(JSON.stringify([
      source.text, 'rule', 'project', null, null, null])).digest('hex') };
  assert.equal(validateCandidate(forged, source).eligible, false);
  assert.equal((await extract(row, outbox, [{ text: fact, type: 'rule', scope: 'project' }])).kind,
    'manifested');
  assert.equal((await outbox.readManifest(row.operationId)).candidates.length, 1);
});

test('two durable facts from one message become distinct publishable candidates', async t => {
  const first = 'Use PostgreSQL para persistência.';
  const second = 'Use Qdrant para busca vetorial.';
  const { outbox, stateDir, source, row } = await fixture(t, `${first} ${second}`);
  assert.equal((await extract(row, outbox, [
    { text: first, type: 'rule', scope: 'project' },
    { text: second, type: 'decision', scope: 'project' },
  ])).kind, 'manifested');
  const manifest = await outbox.readManifest(row.operationId);
  assert.equal(manifest.candidates.length, 2);
  assert.notEqual(manifest.candidates[0].candidateKey, manifest.candidates[1].candidateKey);
  assert.notEqual(manifest.candidates[0].externalId, manifest.candidates[1].externalId);
  const payloads = await Promise.all(manifest.candidates.map(item =>
    outbox.readCandidatePayload(row.operationId, item.candidateKey)));
  assert.deepEqual(payloads.map(item => item.text), [first, second]);
  assert.ok(payloads.every(item => validateCandidate(item, source).eligible));
  const stored = [];
  const result = await publishCheckpointAutomatically(row, { provider: 'mem0',
    projectId: 'p', stateDir, ownerId: consent.ownerId,
    extractor: { autoPublish: true, autoPublishConsent: consent } }, {
    outbox, readAutoPublish: async () => consent,
    store: async (operation, ackLocal) => {
      stored.push(operation.text);
      const ack = await ackLocal(operation.externalId, { externalId: operation.externalId,
        projectId: 'p', status: 'active', sdkId: `sdk-${stored.length}`,
        qdrantId: `qdrant-${stored.length}` });
      assert.equal(ack.kind, 'acked');
      return { kind: 'stored', externalId: operation.externalId };
    },
  });
  assert.equal(result.kind, 'published');
  assert.deepEqual(stored, [first, second]);
  assert.equal((await outbox.readDisposition(row.operationId)).candidates.length, 2);
});

test('automatic extraction quarantines a selected span over 512 UTF-8 bytes', async t => {
  const text = 'Regra de arquitetura '.repeat(34);
  assert.ok(Buffer.byteLength(text, 'utf8') > 512);
  const { outbox, row } = await fixture(t, text);
  assert.equal((await extract(row, outbox, [{ text, type: 'rule', scope: 'project' }])).kind,
    'pending');
  assert.equal((await outbox.readManifest(row.operationId)).reason, 'missing_manifest');
});

test('repeated identical Haiku selections produce one candidate', async t => {
  const text = 'Use PostgreSQL para persistência.';
  const { outbox, row } = await fixture(t, text);
  const item = { text, type: 'rule', scope: 'project' };
  assert.equal((await extract(row, outbox, [item, item])).kind, 'manifested');
  assert.equal((await outbox.readManifest(row.operationId)).candidates.length, 1);
});

test('automatic checkpoint with only unknown origin completes without a paid extraction', async t => {
  const { outbox, row } = await fixture(t, 'Internal summary: use PostgreSQL.', 'unknown');
  let calls = 0;
  const result = await extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async () => { calls++; throw Error('unexpected'); } });
  assert.equal(result.kind, 'processed');
  assert.equal(calls, 0);
  assert.equal((await outbox.readDisposition(row.operationId)).disposition, 'no_facts');
  assert.equal((await outbox.extractionUsage(row.cli, row.sessionId)).calls, 0);
});
