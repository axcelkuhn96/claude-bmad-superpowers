import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { extractCheckpoint, storeOperation, validateCandidate } from '../base/memoria/candidates.mjs';
import { publishCheckpointAutomatically } from '../base/memoria/auto-publish.mjs';
import { externalIdFor, reconcileStore } from '../base/memoria/ledger.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { POLICY_VERSION } from '../base/memoria/transcript.mjs';

const source = { origin: 'human', actor: 'user', speakerRole: 'user',
  ownerId: 'owner-123',
  text: 'No projeto, use PostgreSQL para persistência.', messageId: 'm1',
  timestamp: '2026-10-13T10:00:00Z', start: 0, end: 44 };
const consent = { version: 1, enabled: true, projectId: 'p', destinationHash: 'a'.repeat(64),
  ownerId: 'owner-123', deviceId: 'device-123', consentHash: 'b'.repeat(64),
  enabledAt: '2026-10-13T09:00:00Z' };
async function fixture(t, messages = [source], policyVersion = POLICY_VERSION) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-auto-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const outbox = createOutbox(stateDir);
  if (policyVersion === POLICY_VERSION) {
    assert.equal((await outbox.ensureFutureBaseline({ cli: 'claude', sessionId: 'session',
      projectId: 'p', ownerId: consent.ownerId, consentHash: consent.consentHash,
      policyVersion, cutoffEnd: 0 })).kind, 'baselined');
  }
  const row = { cli: 'claude', sessionId: 'session', start: 0, end: 100,
    sliceHash: 'c'.repeat(64), messages };
  const queued = await outbox.enqueueCheckpoint(row, { projectId: 'p', policyVersion });
  assert.equal(queued.kind, 'queued');
  return { outbox, stateDir, row: { ...row, operationId: queued.operationId,
    projectId: 'p', policyVersion } };
}
const choice = text => ({ source_message_id: 'm1', abstain_reason: '', candidates: [
  { text, type: 'rule', scope: 'project' }] });
const resolution = stateDir => ({ provider: 'mem0', projectId: 'p', stateDir, ownerId: consent.ownerId,
  extractor: { autoPublish: true, autoPublishConsent: consent } });
const publish = (row, current, options = {}) => publishCheckpointAutomatically(row, current,
  { readOriginOwner: async () => consent.ownerId, ...options });
async function extract(row, outbox, decisions) {
  return extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async () =>
      ({ kind: 'success', model: 'claude-haiku-5-5', decisions }) });
}

test('automatic candidate keeps only Haiku selected literal claim and semantic type', async t => {
  const { outbox, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  const entry = (await outbox.readManifest(row.operationId)).candidates[0];
  const payload = await outbox.readCandidatePayload(row.operationId, entry.candidateKey);
  assert.equal(payload.text, source.text);
  assert.equal(payload.type, 'rule');
  assert.equal(payload.format_version, 3);
  assert.equal(validateCandidate({ ...payload, source_text_sha256: '0'.repeat(64) }, source).eligible,
    false);
});

test('automatic Haiku prompt asks for a literal durable span', async t => {
  const { outbox, row } = await fixture(t);
  let prompt;
  const result = await extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async input => {
    prompt = JSON.parse(input).instruction;
    return { kind: 'success', model: 'claude-haiku-5-5', decisions: [choice(source.text)] };
  } });
  assert.equal(result.kind, 'manifested');
  assert.match(prompt, /verbatim substring/i);
  assert.match(prompt, /automatic/i);
});

test('automatic Haiku prompt excludes assistant and unknown messages in a mixed checkpoint', async t => {
  const assistant = { ...source, origin: 'assistant', actor: 'assistant',
    speakerRole: 'assistant', messageId: 'm2', start: 45, end: 70,
    text: 'PostgreSQL was deployed.' };
  const unknown = { ...assistant, origin: 'unknown', messageId: 'm3', start: 71, end: 90,
    text: 'Internal summary: deployment complete.' };
  const { outbox, row } = await fixture(t, [source, assistant, unknown]);
  let messages;
  const result = await extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async input => {
    messages = JSON.parse(input).messages;
    return { kind: 'success', model: 'claude-haiku-5-5', decisions: [choice(source.text)] };
  } });
  assert.equal(result.kind, 'manifested');
  assert.deepEqual(messages.map(item => item.message_id), ['m1']);
});

test('automatic gate leaves invented text and assistant source unpromoted', async t => {
  const first = await fixture(t);
  const invented = await extract(first.row, first.outbox,
    [choice('Use MySQL for persistence.')]);
  assert.equal(invented.kind, 'pending');
  assert.equal((await first.outbox.readManifest(first.row.operationId)).reason, 'missing_manifest');
  const assistant = { ...source, origin: 'assistant', actor: 'assistant', speakerRole: 'assistant' };
  const second = await fixture(t, [assistant]);
  assert.equal((await extract(second.row, second.outbox, [choice(source.text)])).kind, 'processed');
  assert.equal((await second.outbox.readDisposition(second.row.operationId)).disposition, 'no_facts');
});

test('automatic gate quarantines question, status and mixed speaker text', async t => {
  for (const text of [
    'Vamos usar PostgreSQL?',
    'Status: hoje terminamos a migração para PostgreSQL.',
    'Assistente: PostgreSQL foi instalado. Usuário: use PostgreSQL.',
  ]) {
    const item = { ...source, text };
    const { outbox, row } = await fixture(t, [item]);
    const result = await extract(row, outbox, [choice(text)]);
    assert.equal(result.kind, 'pending', text);
    assert.equal((await outbox.readManifest(row.operationId)).reason, 'missing_manifest');
  }
});

test('automatic publisher refuses a caller row that differs from the persisted checkpoint', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  const changed = { ...row, messages: [{ ...source, text: 'A different source.' }] };
  const result = await publish(changed, resolution(stateDir), {
    outbox, readAutoPublish: async () => consent,
    store: async () => { throw Error('must not store'); },
  });
  assert.deepEqual(result, { kind: 'blocked', published: 0, pending: 0,
    reason: 'source_policy_unproved' });
});

test('automatic publisher refuses persisted ownerless source before store', async t => {
  const { outbox, stateDir, row } = await fixture(t, [{ ...source, ownerId: null }]);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let stores = 0;
  const result = await publish(row, resolution(stateDir), {
    outbox, readAutoPublish: async () => consent,
    store: async () => { stores++; },
  });
  assert.equal(result.reason, 'source_policy_unproved');
  assert.equal(stores, 0);
});

test('ownerless historical source cannot seal an automatic review directly', async t => {
  const { outbox, row } = await fixture(t, [{ ...source, ownerId: null }]);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  const entry = (await outbox.readManifest(row.operationId)).candidates[0];
  const payload = await outbox.readCandidatePayload(row.operationId, entry.candidateKey);
  const operation = storeOperation(payload, payload.text);
  operation.metadata.review_mode = 'automatic';
  operation.metadata.auto_actor = 'project_auto_publisher';
  operation.metadata.auto_consent_hash = consent.consentHash;
  operation.approval.mode = 'automatic';
  const seal = await outbox.sealReview(row.operationId, entry.candidateKey, {
    decision: 'approve', mode: 'automatic', actor: 'project_auto_publisher',
    consentHash: consent.consentHash, payloadSha256: entry.payloadRef.sha256,
    reviewedAt: '2026-10-13T11:00:00Z', operation,
  });
  assert.deepEqual(seal, { kind: 'blocked', reason: 'automatic_review_unproved' });
});

test('remote source proof rejects an old sealed automatic row whose human owner is absent', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  const entry = (await outbox.readManifest(row.operationId)).candidates[0];
  const payload = await outbox.readCandidatePayload(row.operationId, entry.candidateKey);
  const operation = storeOperation(payload, payload.text);
  operation.metadata.review_mode = 'automatic';
  operation.metadata.auto_actor = 'project_auto_publisher';
  operation.metadata.auto_consent_hash = consent.consentHash;
  operation.approval.mode = 'automatic';
  assert.equal((await outbox.sealReview(row.operationId, entry.candidateKey, {
    decision: 'approve', mode: 'automatic', actor: 'project_auto_publisher',
    consentHash: consent.consentHash, payloadSha256: entry.payloadRef.sha256,
    reviewedAt: '2026-10-13T11:00:00Z', operation,
  })).kind, 'sealed');
  const itemFile = path.join(stateDir, 'outbox', 'items', `${row.operationId}.json`);
  const historical = JSON.parse(await fs.readFile(itemFile, 'utf8'));
  historical.messages[0].ownerId = null;
  await fs.writeFile(itemFile, JSON.stringify(historical) + '\n', { mode: 0o600 });
  assert.equal((await outbox.sourceForRemote(operation)).kind, 'blocked');
});

test('persisted native-v1 checkpoint never becomes an automatic memory, even with valid consent', async t => {
  const { outbox, stateDir, row } = await fixture(t, [source], 'native-v1');
  const extracted = await extract(row, outbox, [choice(source.text)]);
  assert.equal(extracted.kind, 'pending');
  assert.equal((await outbox.readManifest(row.operationId)).reason, 'missing_manifest');
  const current = await fixture(t);
  assert.equal((await extract(current.row, current.outbox, [choice(source.text)])).kind, 'manifested');
  const modernEntry = (await current.outbox.readManifest(current.row.operationId)).candidates[0];
  const modernPayload = await current.outbox.readCandidatePayload(current.row.operationId,
    modernEntry.candidateKey);
  const externalId = externalIdFor({ projectId: 'p', originCli: row.cli,
    sessionId: row.sessionId, start: row.start, end: row.end, sliceHash: row.sliceHash,
    policyVersion: row.policyVersion, candidateKey: modernEntry.candidateKey });
  const legacyPayload = { ...modernPayload, external_id: externalId,
    checkpoint_id: row.operationId, policy_version: row.policyVersion };
  const persisted = await outbox.persistCandidatePayload(row.operationId, legacyPayload);
  assert.equal(persisted.kind, 'persisted');
  assert.equal((await outbox.recordManifest(row.operationId, [{
    candidateKey: modernEntry.candidateKey, externalId,
    evidence: modernEntry.evidence, payloadRef: persisted.payloadRef,
  }])).kind, 'manifested');
  let stores = 0;
  const result = await publish({ ...row, policyVersion: POLICY_VERSION },
    resolution(stateDir), { outbox, readAutoPublish: async () => consent,
      store: async () => { stores++; } });
  assert.deepEqual(result, { kind: 'blocked', published: 0, pending: 0,
    reason: 'source_policy_unproved' });
  assert.equal(stores, 0);
  const operation = storeOperation(legacyPayload, legacyPayload.text);
  operation.metadata.review_mode = 'automatic';
  operation.metadata.auto_actor = 'project_auto_publisher';
  operation.metadata.auto_consent_hash = consent.consentHash;
  operation.approval.mode = 'automatic';
  const sealed = await outbox.sealReview(row.operationId, modernEntry.candidateKey, {
    decision: 'approve', mode: 'automatic', actor: 'project_auto_publisher',
    consentHash: consent.consentHash, payloadSha256: persisted.payloadRef.sha256,
    reviewedAt: '2026-10-13T11:00:00Z', operation,
  });
  assert.deepEqual(sealed, { kind: 'blocked', reason: 'automatic_review_unproved' });
});

test('automatic retry remains ready after five transient failures', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  let last;
  for (let index = 0; index < 6; index++) {
    last = await outbox.markFailed(row.operationId, 'remote_error', { automatic: true });
    assert.equal(last.kind, 'pending');
  }
  assert.equal(last.attempts, 6);
  const restarted = createOutbox(stateDir);
  assert.ok((await restarted.ready(last.retryAt, { automatic: true })).some(item =>
    item.operationId === row.operationId));
  assert.ok(!(await restarted.ready(last.retryAt)).some(item =>
    item.operationId === row.operationId));
});

test('automatic review is sealed as automatic and ACK follows remote confirmation', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let stores = 0;
  let storedOperation;
  const options = { outbox, readAutoPublish: async () => consent,
    store: async (operation, ackLocal) => {
      stores++;
      storedOperation = operation;
      assert.equal(operation.text, source.text);
      assert.equal(operation.metadata.review_mode, 'automatic');
      assert.equal(operation.metadata.auto_consent_hash, consent.consentHash);
      assert.equal(operation.approval.kind, 'approved');
      assert.equal((await outbox.sourceForRemote(operation)).kind, 'local_source');
      const proof = { externalId: operation.externalId, projectId: 'p', status: 'active',
        sdkId: 'sdk-1', qdrantId: 'qdrant-1' };
      await ackLocal(operation.externalId, proof);
      return { kind: 'stored', externalId: operation.externalId };
    } };
  const result = await publish(row, resolution(stateDir), options);
  assert.equal(result.kind, 'published');
  assert.equal(stores, 1);
  const entry = (await outbox.readDisposition(row.operationId)).candidates[0];
  const review = JSON.parse(await fs.readFile(path.join(stateDir, 'candidates', 'reviews',
    `${entry.externalId}.json`), 'utf8'));
  assert.equal(review.review.mode, 'automatic');
  assert.equal(review.review.actor, 'project_auto_publisher');
  assert.equal(review.review.reviewedHuman, undefined);
  assert.equal((await outbox.readDisposition(row.operationId)).candidates[0].status, 'remote_acked');
  assert.equal((await outbox.sourceForRemote(storedOperation)).kind, 'local_source');
  const again = await publish(row, resolution(stateDir), options);
  assert.equal(again.kind, 'published');
  assert.equal(stores, 1);
});

test('legacy remote ACK keeps local source readable without a new baseline', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  const rowFile = path.join(stateDir, 'outbox', 'items', `${row.operationId}.json`);
  const originalRow = await fs.readFile(rowFile);
  let storedOperation;
  assert.equal((await publish(row, resolution(stateDir), { outbox,
    readAutoPublish: async () => consent,
    store: async (operation, ackLocal) => {
      storedOperation = operation;
      await ackLocal(operation.externalId, { externalId: operation.externalId,
        projectId: 'p', status: 'active', sdkId: 'sdk-legacy', qdrantId: 'qdrant-legacy' });
      return { kind: 'stored', externalId: operation.externalId };
    },
  })).kind, 'published');
  const baselineName = `baseline-${createHash('sha256').update(JSON.stringify(['claude', 'session']))
    .digest('hex')}.json`;
  await fs.rm(path.join(stateDir, 'outbox', baselineName));
  const reviewFile = path.join(stateDir, 'candidates', 'reviews', `${storedOperation.externalId}.json`);
  const review = JSON.parse(await fs.readFile(reviewFile, 'utf8'));
  delete review.review.sourceProof.ownerId;
  review.digest = createHash('sha256').update(JSON.stringify(review.review)).digest('hex');
  await fs.writeFile(reviewFile, JSON.stringify(review) + '\n', { mode: 0o600 });
  assert.equal((await outbox.sourceForRemote(storedOperation)).kind, 'blocked');
  assert.equal((await outbox.sourceForRemote(storedOperation,
    { allowLegacyReadOnly: true })).kind, 'local_source');
  const receiptFile = path.join(stateDir, 'outbox', 'processed', `${row.operationId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(rowFile, originalRow, { mode: 0o600 });
  await fs.writeFile(path.join(stateDir, 'outbox', 'items', `${row.operationId}.manifest.json`),
    JSON.stringify({ operationId: row.operationId, projectId: 'p', disposition: 'candidates',
      candidates: receipt.candidates }) + '\n', { mode: 0o600 });
  await fs.rm(receiptFile);
  assert.equal((await outbox.sourceForRemote(storedOperation)).kind, 'blocked');
  assert.equal((await outbox.sourceForRemote(storedOperation,
    { allowLegacyReadOnly: true })).kind, 'local_source');
});

test('revocation and changed destination block automatic store', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let stores = 0;
  for (const live of [null, { ...consent, destinationHash: 'd'.repeat(64) }]) {
    const result = await publish(row, resolution(stateDir),
      { outbox, readAutoPublish: async () => live, store: async () => { stores++; } });
    assert.equal(result.kind, 'blocked');
  }
  assert.equal((await publish(row, resolution(stateDir), {
    outbox, readAutoPublish: async () => { throw new Error('policy_unavailable'); },
    store: async () => { stores++; },
  })).reason, 'auto_publish_revoked');
  assert.equal(stores, 0);
  assert.equal((await publish(row,
    { ...resolution(stateDir), ownerId: 'other-owner' },
    { outbox, readAutoPublish: async () => consent, store: async () => { stores++; } })).kind,
  'blocked');
});

test('origin owner changed after sealing blocks automatic store', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let checks = 0;
  let stores = 0;
  const result = await publish(row, resolution(stateDir), { outbox,
    readAutoPublish: async () => consent,
    readOriginOwner: async () => ++checks < 3 ? consent.ownerId : 'different-owner',
    store: async () => { stores++; } });
  assert.equal(result.reason, 'auto_publish_owner_mismatch');
  assert.equal(stores, 0);
});

test('temporary DNS failure retries sealed automatic operation; destination policy rejection stays blocked', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let stores = 0;
  const options = { outbox, readAutoPublish: async () => consent,
    store: async (operation, ackLocal) => {
      stores++;
      if (stores === 1) return { kind: 'blocked', reason: 'destination_unavailable' };
      const proof = { externalId: operation.externalId, projectId: 'p', status: 'active',
        sdkId: 'sdk-1', qdrantId: 'qdrant-1' };
      await ackLocal(operation.externalId, proof);
      return { kind: 'stored', externalId: operation.externalId };
    } };
  const first = await publish(row, resolution(stateDir), options);
  assert.deepEqual(first, { kind: 'retry', published: 0, pending: 0,
    reason: 'destination_unavailable' });
  assert.equal((await publish(row, resolution(stateDir), options)).kind,
    'published');
  assert.equal(stores, 2);

  const refused = await fixture(t);
  assert.equal((await extract(refused.row, refused.outbox, [choice(source.text)])).kind, 'manifested');
  const policy = await publish(refused.row, resolution(refused.stateDir), {
    outbox: refused.outbox, readAutoPublish: async () => consent,
    store: async () => ({ kind: 'blocked', reason: 'public_destination' }),
  });
  assert.equal(policy.kind, 'blocked');
  assert.equal(policy.reason, 'public_destination');
});

test('temporary broker startup failure retries the same sealed operation without extraction', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let calls = 0;
  const result = await publish(row, resolution(stateDir), {
    outbox, readAutoPublish: async () => consent,
    store: async () => { calls++; return { kind: 'blocked', reason: 'broker_unavailable' }; },
  });
  assert.deepEqual(result, { kind: 'retry', published: 0, pending: 0,
    reason: 'broker_unavailable' });
  assert.equal(calls, 1);
  assert.equal((await outbox.readManifest(row.operationId)).candidates[0].status, 'pending');
});

test('real store refuses revoked consent and an unassigned writer before remote add', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  assert.equal((await extract(row, outbox, [choice(source.text)])).kind, 'manifested');
  let operation;
  await publish(row, resolution(stateDir), {
    outbox, readAutoPublish: async () => consent,
    store: async op => { operation = op; return { kind: 'pending', reason: 'test_pause' }; },
  });
  assert.ok(operation);
  const denied = await storeMemory('/unused', row.sessionId, operation, () => '', {
    resolve: async () => resolution(stateDir), readAutoPublish: async () => null,
    authorize: async () => { throw Error('unexpected remote authorization'); },
    autoPublishConsent: consent,
  });
  assert.deepEqual(denied, { kind: 'blocked', reason: 'auto_publish_unproved' });
  const fenced = await storeMemory('/unused', row.sessionId, operation, () => '', {
    resolve: async () => resolution(stateDir), readAutoPublish: async () => consent,
    authorize: async () => ({ kind: 'authorized', key: 'unused', connection: {} }),
    autoPublishConsent: consent,
  });
  assert.equal(fenced.kind, 'blocked');
  assert.equal(fenced.reason, 'writer_not_designated');
});

test('missing local ACK retries sealed operation without a second remote add or extraction', async t => {
  const { outbox, stateDir, row } = await fixture(t);
  let extractions = 0;
  const extraction = await extractCheckpoint(row, { route: 'haiku', autoPublish: true,
    autoPublishConsent: consent }, { outbox, runCli: async () => {
    extractions++;
    return { kind: 'success', model: 'claude-haiku-5-5', decisions: [choice(source.text)] };
  } });
  assert.equal(extraction.kind, 'manifested');
  let adds = 0;
  let remote;
  let failAck = true;
  const store = (operation, ack) => reconcileStore(operation, {
    findRemote: async () => remote ? [remote] : [],
    addViaSdk: async () => { adds++; remote = { externalId: operation.externalId,
      projectId: operation.projectId, sessionId: operation.sessionId, text: operation.text,
      metadata: operation.metadata, status: 'pending', sdkId: 'sdk-1', qdrantId: 'qdrant-1' }; },
    readRemote: async () => remote,
    activateViaSdk: async () => { remote.status = 'active'; },
    ackLocal: async (id, proof) => failAck ? { kind: 'pending' } : ack(id, proof),
  });
  const options = { outbox, readAutoPublish: async () => consent, store };
  const first = await publish(row, resolution(stateDir), options);
  assert.equal(first.kind, 'retry');
  failAck = false;
  const second = await publish(row, resolution(stateDir), options);
  assert.equal(second.kind, 'published');
  assert.equal(adds, 1);
  assert.equal(extractions, 1);
});
