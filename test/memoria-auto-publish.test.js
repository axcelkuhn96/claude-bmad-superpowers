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
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';
import { transientDevelopmentReviewStatus } from '../base/memoria/curation-policy.mjs';

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

test('pre-existing v4 manifest with temporary CBS status is rejected before store', async () => {
  const row = { operationId: 'src-' + 'a'.repeat(64), projectId: 'p',
    cli: 'claude', sessionId: 'session', policyVersion: POLICY_VERSION,
    start: 0, end: 100, sliceHash: 'c'.repeat(64), messages: [source] };
  const statusText = 'At the time of this session, the CBS Qdrant memory for this project was read-only (automaticWriteConfigured: false).';
  let disposed = 0;
  const result = await publish(row, resolution('/private-state'), {
    outbox: {
      pending: async () => [row],
      futureSourceAllowed: async () => ({ kind: 'allowed' }),
      readManifest: async () => ({ kind: 'manifested', candidates: [
        { status: 'pending', candidateKey: 'temporary',
          payloadRef: { sha256: 'a'.repeat(64) } }] }),
      readCandidatePayload: async () => ({ format_version: 4, text: statusText }),
      disposeCandidate: async (_operationId, _key, status, reason) => {
        disposed++;
        assert.equal(status, 'rejected');
        assert.equal(reason, 'transient_cbs_runtime_status');
        return { kind: 'disposed' };
      },
      completeCheckpoint: async () => ({ kind: 'processed' }),
    },
    readAutoPublish: async () => consent,
    store: async () => { throw Error('temporary status reached Qdrant'); },
  });
  assert.equal(result.kind, 'published');
  assert.equal(result.published, 0);
  assert.equal(disposed, 1);
});

test('temporary development review fact is rejected without suppressing durable findings', () => {
  const temporary = 'Deploy compile order for the HML package, still pending final review (not compiled yet). Files are A.prw then B.tlpp. A was approved, B is under review, and the assistant asked to wait for the final list.';
  assert.equal(transientDevelopmentReviewStatus(temporary, 'fact'), true);
  assert.equal(transientDevelopmentReviewStatus(temporary, 'decision'), false);
  assert.equal(transientDevelopmentReviewStatus('Known limitation: the first imported signature is not counted by the portal; the issue is still open.', 'fact'), false);
  assert.equal(transientDevelopmentReviewStatus('AP invoice is pending business review before payment.', 'fact'), false);
  assert.equal(transientDevelopmentReviewStatus('The compiler requires a final review before publishing a release.', 'rule'), false);
});

test('pre-existing v4 manifest with temporary development review fact is rejected before store', async () => {
  const row = { operationId: 'src-' + 'a'.repeat(64), projectId: 'p',
    cli: 'claude', sessionId: 'session', policyVersion: POLICY_VERSION,
    start: 0, end: 100, sliceHash: 'c'.repeat(64), messages: [source] };
  let disposed = 0;
  const result = await publish(row, resolution('/private-state'), {
    outbox: {
      pending: async () => [row],
      futureSourceAllowed: async () => ({ kind: 'allowed' }),
      readManifest: async () => ({ kind: 'manifested', candidates: [
        { status: 'pending', candidateKey: 'temporary', payloadRef: { sha256: 'a'.repeat(64) } }] }),
      readCandidatePayload: async () => ({ format_version: 4, type: 'fact',
        text: 'HML package is pending final review (not compiled yet). A.prw was approved, B.tlpp is under review. Wait for the final list.' }),
      disposeCandidate: async (_operationId, _key, status, reason) => {
        disposed++;
        assert.equal(status, 'rejected');
        assert.equal(reason, 'transient_development_review_status');
        return { kind: 'disposed' };
      },
      completeCheckpoint: async () => ({ kind: 'processed' }),
    },
    readAutoPublish: async () => consent,
    store: async () => { throw Error('temporary status reached Qdrant'); },
  });
  assert.equal(result.kind, 'published');
  assert.equal(result.published, 0);
  assert.equal(disposed, 1);
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

test('bridge rejects an automatic conversation summary without a sealed local source', async t => {
  const { stateDir, row } = await fixture(t);
  const identity = { projectId: 'p', originCli: row.cli, sessionId: row.sessionId,
    start: row.start, end: row.end, sliceHash: row.sliceHash,
    policyVersion: POLICY_VERSION, candidateKey: 'summary-0' };
  const operation = { externalId: externalIdFor(identity), projectId: 'p',
    sessionId: row.sessionId, sourceIdentity: identity, text: 'A conversa definiu PostgreSQL.',
    approval: { kind: 'approved', mode: 'automatic' }, metadata: {
      source: 'm1', source_offsets: { start: source.start, end: source.end },
      checkpoint_id: row.operationId, actor: 'conversation', origin: 'conversation_summary',
      speaker_role: 'mixed', scope: 'project', evidence_at: source.timestamp,
      format_version: 4, review_mode: 'automatic', auto_actor: 'project_auto_publisher',
      auto_consent_hash: consent.consentHash, type: 'decision',
      dedup_key: dedupKeyFor({ projectId: 'p', scope: 'project', ownerId: null,
        type: 'decision', text: 'A conversa definiu PostgreSQL.' }),
    } };
  let authorized = 0;
  const result = await storeMemory('/project', row.sessionId, operation, () => 'secret', {
    resolve: async () => resolution(stateDir), readAutoPublish: async () => consent,
    autoPublishConsent: consent,
    authorize: async () => { authorized++; throw Error('unproved write reached destination'); },
  });
  assert.deepEqual(result, { kind: 'blocked', reason: 'source_review_unproved' });
  assert.equal(authorized, 0);
});

test('real v4 outbox publishes a paraphrased conversation with local multi-source proof', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-auto-conversation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outbox = createOutbox(root);
  assert.equal((await outbox.ensureFutureBaseline({ cli: 'claude', sessionId: 'session',
    projectId: 'p', ownerId: consent.ownerId, consentHash: consent.consentHash,
    policyVersion: POLICY_VERSION, cutoffEnd: 0, initialSize: 0 })).kind, 'baselined');
  const messages = [
    { ...source, cli: 'claude', sessionId: 'session', origin: 'human',
      speakerRole: 'user', start: 0, end: 44 },
    { ...source, cli: 'claude', sessionId: 'session', origin: 'assistant',
      actor: 'assistant', speakerRole: 'assistant',
      ownerId: null, start: 45, end: 100, messageId: 'm2', finalVisible: true,
      text: 'PostgreSQL was configured for persistence.' },
  ];
  assert.equal((await outbox.enqueueConversationSlice({ cli: 'claude', sessionId: 'session',
    start: 0, end: 100, sliceHash: 'c'.repeat(64), messages },
  { projectId: 'p', policyVersion: POLICY_VERSION }, { event: 'SessionEnd' })).kind, 'queued');
  const [row] = await outbox.pending();
  const summarized = 'The conversation chose PostgreSQL for persistence.';
  const extracted = await extractCheckpoint(row, { route: 'haiku', mode: 'conversation',
    maxCallsPerSession: 100, autoPublish: true, autoPublishConsent: consent }, {
    outbox, runCli: async () => ({ kind: 'success', no_facts: false,
      model: 'claude-haiku-5-5', usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 },
      candidates: [{ text: summarized, type: 'decision', scope: 'project', evidence: [
        { source_message_id: 'm1', excerpt: source.text },
        { source_message_id: 'm2', excerpt: 'PostgreSQL was configured' },
      ] }] }) });
  assert.equal(extracted.kind, 'manifested', JSON.stringify(extracted));
  const revoked = await publish(row, resolution(root), { outbox,
    readAutoPublish: async () => null,
    store: async () => { throw Error('revoked summary reached remote store'); } });
  assert.equal(revoked.reason, 'auto_publish_revoked');
  let stored;
  const result = await publish(row, resolution(root), { outbox,
    readAutoPublish: async () => consent,
    store: async (operation, ackLocal) => {
      stored = operation;
      const ack = await ackLocal(operation.externalId, { externalId: operation.externalId,
        projectId: 'p', sdkId: 'sdk-conversation', qdrantId: 'q-conversation',
        status: 'active' });
      assert.equal(ack.kind, 'acked');
      return { kind: 'stored' };
    } });
  assert.equal(result.kind, 'published', JSON.stringify(result));
  assert.equal(result.published, 1);
  assert.equal(stored.text, summarized);
  assert.equal(stored.metadata.origin, 'conversation_summary');
  assert.equal(stored.metadata.source_refs.length, 2);
  assert.equal((await outbox.sourceForRemote({ ...stored, status: 'active' })).kind, 'local_source');
  assert.equal((await outbox.ensureFutureBaseline({ cli: 'claude', sessionId: 'later',
    projectId: 'p', ownerId: consent.ownerId, consentHash: consent.consentHash,
    policyVersion: POLICY_VERSION, cutoffEnd: 0, initialSize: 0 })).kind, 'baselined');
  const laterMessages = messages.map(message => ({ ...message, sessionId: 'later' }));
  assert.equal((await outbox.enqueueConversationSlice({ cli: 'claude', sessionId: 'later',
    start: 0, end: 100, sliceHash: 'd'.repeat(64), messages: laterMessages },
  { projectId: 'p', policyVersion: POLICY_VERSION }, { event: 'SessionEnd' })).kind, 'queued');
  const later = (await outbox.pending()).find(item => item.sessionId === 'later');
  assert.equal((await extractCheckpoint(later, { route: 'haiku', mode: 'conversation',
    maxCallsPerSession: 100, autoPublish: true, autoPublishConsent: consent }, {
    outbox, runCli: async () => ({ kind: 'success', no_facts: false,
      model: 'claude-haiku-5-5', usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 },
      candidates: [{ text: summarized, type: 'decision', scope: 'project', evidence: [
        { source_message_id: 'm1', excerpt: source.text },
        { source_message_id: 'm2', excerpt: 'PostgreSQL was configured' },
      ] }] }) })).kind, 'manifested');
  let duplicateStores = 0;
  const repeated = await publish(later, resolution(root), { outbox,
    readAutoPublish: async () => consent,
    store: async operation => {
      duplicateStores++;
      assert.equal(operation.metadata.dedup_key, stored.metadata.dedup_key);
      return { kind: 'duplicate', dedupKey: operation.metadata.dedup_key,
        duplicateOf: { externalId: stored.externalId, sdkId: 'sdk-conversation',
          qdrantId: 'q-conversation', status: 'active' }, evidenceDigest: 'b'.repeat(64) };
    } });
  assert.equal(repeated.kind, 'published', JSON.stringify(repeated));
  assert.equal(repeated.published, 0);
  assert.equal(duplicateStores, 1);
  const disposition = await outbox.readDisposition(later.operationId);
  assert.equal(disposition.candidates[0].status, 'duplicate');
  assert.equal(disposition.candidates[0].sdkId, undefined);
  assert.equal((await publish(later, resolution(root), { outbox,
    readAutoPublish: async () => consent,
    store: async () => { throw Error('terminal duplicate replayed'); } })).kind, 'published');
  assert.equal(duplicateStores, 1);
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
