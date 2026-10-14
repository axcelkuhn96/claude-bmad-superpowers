import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { createWindowsState } from '../base/memoria/windows-state.mjs';
import { extractCheckpoint, storeOperation } from '../base/memoria/candidates.mjs';

const identity = { projectId: 'project', policyVersion: 'native-v2' };
const slice = (n, origin, event) => ({
  cli: 'codex', sessionId: 'conversation', start: n * 10, end: (n + 1) * 10,
  sliceHash: n.toString(16).padStart(64, '0'),
  messages: [{ cli: 'codex', sessionId: 'conversation', start: n * 10,
    end: (n + 1) * 10, messageId: `message-${n}`, origin,
    speakerRole: origin === 'human' ? 'user' : 'assistant', actor: origin === 'human' ? 'user' : 'assistant',
    text: `${origin}-${n}`, timestamp: `2026-10-14T12:00:${String(n).padStart(2, '0')}Z`,
    ...(origin === 'human' ? { ownerId: 'axcel' } : {}),
    ...(event === 'Stop' ? { finalVisible: true } : {}) }],
});

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-conversation-'));
  try { await fn(createOutbox(root), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function readExtractionCounter(root) {
  const digest = createHash('sha256').update(JSON.stringify(['codex', 'conversation']))
    .digest('hex');
  const file = path.join(root, 'outbox', `extract-${digest}.json`);
  return process.platform === 'win32' ? createWindowsState(file).read()
    : JSON.parse(await fs.readFile(file, 'utf8'));
}

test('five completed exchanges make one durable checkpoint and only then permit extraction', async () => {
  await fixture(async (box, root) => {
    for (let n = 0; n < 10; n++) {
      const event = n % 2 ? 'Stop' : 'UserPromptSubmit';
      const result = await box.enqueueConversationSlice(slice(n, n % 2 ? 'assistant' : 'human', event),
        identity, { event });
      assert.equal(result.kind, n === 9 ? 'queued' : 'staged');
      assert.equal((await createOutbox(root).cursor('codex', 'conversation')).queuedEnd, (n + 1) * 10);
      assert.equal((await box.pending()).length, n === 9 ? 1 : 0);
    }
    const [row] = await box.pending();
    assert.equal(row.conversationBatch, true);
    assert.equal(row.conversationPairs, 5);
    assert.equal(row.messages.length, 10);
    assert.equal(row.start, 0);
    assert.equal(row.end, 100);
  });
});

test('four exchanges wait until a final event flushes them without resetting the cursor', async () => {
  await fixture(async (box, root) => {
    for (let n = 0; n < 8; n++) {
      const event = n % 2 ? 'Stop' : 'UserPromptSubmit';
      await box.enqueueConversationSlice(slice(n, n % 2 ? 'assistant' : 'human', event),
        identity, { event });
    }
    assert.equal((await box.pending()).length, 0);
    const result = await createOutbox(root).flushConversationStage({ cli: 'codex',
      sessionId: 'conversation', projectId: 'project', policyVersion: 'native-v2',
      event: 'PreCompact' });
    assert.equal(result.kind, 'queued');
    assert.equal((await box.pending())[0].conversationPairs, 4);
    assert.equal((await box.cursor('codex', 'conversation')).queuedEnd, 80);
    assert.equal((await box.flushConversationStage({ cli: 'codex', sessionId: 'conversation',
      projectId: 'project', policyVersion: 'native-v2', event: 'PreCompact' })).kind, 'no_complete_pairs');
    assert.equal((await box.pending()).length, 1);
  });
});

test('final event retains an unpaired human message without fabricating a source', async () => {
  await fixture(async (box, root) => {
    await box.enqueueConversationSlice(slice(0, 'human', 'UserPromptSubmit'),
      identity, { event: 'UserPromptSubmit' });
    const resumed = createOutbox(root);
    assert.equal((await resumed.flushConversationStage({ cli: 'codex',
      sessionId: 'conversation', projectId: 'project', policyVersion: 'native-v2',
      event: 'SessionEnd' })).kind, 'no_complete_pairs');
    assert.equal((await resumed.cursor('codex', 'conversation')).queuedEnd, 10);
    assert.equal((await resumed.pending()).length, 0);
    const stages = await resumed.listConversationStages({ cli: 'codex', projectId: 'project' });
    assert.equal(stages.stages[0].sessionId, 'conversation');
  });
});

test('abrupt exit leaves staged pairs for verified recovery in a new process', async () => {
  await fixture(async (box, root) => {
    const consentHash = 'a'.repeat(64);
    await box.ensureFutureBaseline({ cli: 'codex', sessionId: 'conversation',
      projectId: 'project', ownerId: 'axcel', consentHash,
      policyVersion: 'native-v2', cutoffEnd: 0, initialSize: 0 });
    for (let n = 0; n < 8; n++) {
      const event = n % 2 ? 'Stop' : 'UserPromptSubmit';
      await box.enqueueConversationSlice(slice(n, n % 2 ? 'assistant' : 'human', event),
        identity, { event });
    }
    const resumed = createOutbox(root);
    assert.equal((await resumed.readFutureBaseline({ cli: 'codex', sessionId: 'conversation',
      projectId: 'project', ownerId: 'axcel', consentHash: 'b'.repeat(64),
      policyVersion: 'native-v2' })).kind, 'blocked');
    const list = await resumed.listConversationStages({ cli: 'codex', projectId: 'project' });
    assert.deepEqual(list.stages.map(stage => [stage.sessionId, stage.completedPairs]),
      [['conversation', 4]]);
    assert.equal(Number.isFinite(list.stages[0].updatedAtMs), true);
    assert.equal((await resumed.flushConversationStage({ cli: 'codex',
      sessionId: 'conversation', projectId: 'project', policyVersion: 'native-v2',
      event: 'Recovery' })).kind, 'queued');
    assert.equal((await resumed.pending())[0].conversationPairs, 4);
  });
});

test('replay after item write and no-facts compaction never recreates the same batch', async () => {
  await fixture(async (_, root) => {
    let failed = false;
    const faulted = createOutbox(root, { onDurable: async file => {
      if (!failed && path.basename(path.dirname(file)) === 'items' &&
          /^src-[a-f0-9]{64}\.json$/.test(path.basename(file))) {
        failed = true;
        throw new Error('simulated crash after durable item');
      }
    } });
    const messages = Array.from({ length: 10 }, (_, n) => slice(n,
      n % 2 ? 'assistant' : 'human', n % 2 ? 'Stop' : 'UserPromptSubmit').messages[0]);
    await assert.rejects(faulted.enqueueConversationSlice({ cli: 'codex',
      sessionId: 'conversation', start: 0, end: 100, sliceHash: 'a'.repeat(64),
      messages }, identity, { event: 'Stop' }), /simulated crash/);
    const box = createOutbox(root);
    const [row] = await box.pending();
    await box.recordManifest(row.operationId, []);
    assert.equal((await box.completeCheckpoint(row.operationId)).kind, 'processed');
    const cursorHash = createHash('sha256').update(JSON.stringify(['codex', 'conversation']))
      .digest('hex');
    const summary = { cli: 'codex', sessionId: 'conversation', projectId: 'project',
      policyVersion: 'native-v2', queuedEnd: 100, ackedEnd: 0, processedEnd: 100,
      processedAudit: '0'.repeat(64), processedCount: 1, entries: [] };
    await fs.writeFile(path.join(root, 'outbox', `cursor-${cursorHash}.json`),
      JSON.stringify(summary) + '\n', { mode: 0o600 });
    await fs.rm(path.join(root, 'outbox', 'processed', `${row.operationId}.json`));
    const result = await box.flushConversationStage({ cli: 'codex',
      sessionId: 'conversation', projectId: 'project', policyVersion: 'native-v2',
      event: 'Recovery' });
    assert.equal(result.kind, 'processed');
    assert.equal((await box.pending()).length, 0);
    assert.equal((await box.listConversationStages({ cli: 'codex', projectId: 'project' })).stages.length, 0);
  });
});

test('existing four extraction claims continue under the raised per-session budget', async () => {
  await fixture(async box => {
    const row = slice(0, 'human', 'UserPromptSubmit');
    assert.equal((await box.enqueueCheckpoint(row, identity)).kind, 'queued');
    const [queued] = await box.pending();
    for (let n = 1; n <= 4; n++) {
      assert.equal((await box.claimExtraction(queued.operationId)).calls, n);
    }
    assert.equal((await box.claimExtraction(queued.operationId)).reason, 'extraction_call_limit');
    assert.equal((await box.claimExtraction(queued.operationId, 100)).calls, 5);
  });
});

test('legacy checkpoint cannot overlap a conversation slice already staged durably', async () => {
  await fixture(async box => {
    const first = slice(0, 'human', 'UserPromptSubmit');
    assert.equal((await box.enqueueConversationSlice(first, identity,
      { event: 'UserPromptSubmit' })).kind, 'staged');
    assert.equal((await box.enqueueCheckpoint(first, identity)).reason, 'conversation_stage_active');
    assert.equal((await box.cursor('codex', 'conversation')).queuedEnd, 10);
  });
});

test('pre-upgrade pending checkpoint keeps legacy Haiku schema under the new schedule', async () => {
  await fixture(async box => {
    const old = slice(0, 'human', 'UserPromptSubmit');
    await box.enqueueCheckpoint(old, identity);
    const [row] = await box.pending();
    const result = await extractCheckpoint(row, { route: 'haiku', mode: 'conversation',
      maxCallsPerSession: 100, autoPublish: true,
      autoPublishConsent: { consentHash: 'a'.repeat(64) } },
    { outbox: box, runCli: async (_prompt, policy) => policy.mode === 'conversation'
      ? { kind: 'error', reason: 'wrong_schema' }
      : { kind: 'success', model: 'claude-haiku-5-5', usage: {},
        decisions: [{ source_message_id: 'message-0', abstain_reason: '',
          candidates: [{ text: 'human-0', type: 'rule', scope: 'project' }] }] } });
    assert.equal(result.kind, 'manifested', JSON.stringify(result));
    const manifest = await box.readManifest(row.operationId);
    const payload = await box.readCandidatePayload(row.operationId, manifest.candidates[0].candidateKey);
    assert.equal(payload.format_version, 3);
  });
});

test('session end drains twelve completed pairs from one captured slice into three batches', async () => {
  await fixture(async box => {
    const messages = Array.from({ length: 24 }, (_, n) => slice(n, n % 2 ? 'assistant' : 'human',
      n % 2 ? 'Stop' : 'UserPromptSubmit').messages[0]);
    const result = await box.enqueueConversationSlice({ cli: 'codex', sessionId: 'conversation',
      start: 0, end: 240, sliceHash: 'a'.repeat(64), messages }, identity,
    { event: 'SessionEnd' });
    assert.equal(result.kind, 'queued');
    const rows = await box.pending();
    assert.deepEqual(rows.map(row => row.conversationPairs), [5, 5, 2]);
    assert.deepEqual(rows.map(row => [row.start, row.end]), [[0, 100], [100, 200], [200, 240]]);
    assert.equal((await box.cursor('codex', 'conversation')).queuedEnd, 240);
  });
});

test('Haiku sees both conversation roles once and persists a proven v4 summary', async () => {
  await fixture(async box => {
    const consentHash = 'a'.repeat(64);
    assert.equal((await box.ensureFutureBaseline({ cli: 'codex', sessionId: 'conversation',
      projectId: 'project', ownerId: 'axcel', consentHash, policyVersion: 'native-v2',
      cutoffEnd: 0, initialSize: 0 })).kind, 'baselined');
    for (let n = 0; n < 10; n++) {
      const event = n % 2 ? 'Stop' : 'UserPromptSubmit';
      await box.enqueueConversationSlice(slice(n, n % 2 ? 'assistant' : 'human', event),
        identity, { event });
    }
    const [row] = await box.pending();
    const prompts = [];
    const result = await extractCheckpoint(row, { route: 'haiku', mode: 'conversation',
      maxCallsPerSession: 100, autoPublish: true, autoPublishConsent: { consentHash: 'a'.repeat(64) } },
    { outbox: box, runCli: async prompt => {
      prompts.push(JSON.parse(prompt));
      return { kind: 'success', no_facts: false, model: 'claude-haiku-5-5',
        candidates: [{ text: 'Foi definida e aplicada uma regra do projeto.',
          type: 'decision', scope: 'project', evidence: [
            { source_message_id: 'message-0', excerpt: 'human-0' },
            { source_message_id: 'message-1', excerpt: 'assistant-1' }],
        }], usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 } };
    } });
    assert.equal(result.kind, 'manifested', JSON.stringify(result));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].project_id, 'project');
    assert.equal(prompts[0].messages.length, 10);
    const manifest = await box.readManifest(row.operationId);
    assert.equal(manifest.candidates.length, 1);
    const payload = await box.readCandidatePayload(row.operationId, manifest.candidates[0].candidateKey);
    assert.equal(payload.format_version, 4);
    assert.equal(payload.origin, 'conversation_summary');
    assert.equal(payload.source_refs.length, 2);
    const operation = storeOperation(payload, payload.text);
    Object.assign(operation.metadata, { review_mode: 'automatic',
      auto_actor: 'project_auto_publisher', auto_consent_hash: consentHash });
    operation.approval.mode = 'automatic';
    const sealed = await box.sealReview(row.operationId, manifest.candidates[0].candidateKey,
      { decision: 'approve', mode: 'automatic', actor: 'project_auto_publisher',
        consentHash, reviewedAt: '2026-10-14T12:01:00Z',
        payloadSha256: manifest.candidates[0].payloadRef.sha256, operation });
    assert.equal(sealed.kind, 'sealed', JSON.stringify(sealed));
    const localSource = await box.sourceForRemote({ ...operation, status: 'candidate' });
    assert.equal(localSource.kind, 'local_source', JSON.stringify(localSource));
    assert.equal(localSource.metadata.generated, true);
    assert.equal(localSource.metadata.source_refs.length, 2);
    const forged = structuredClone(operation);
    forged.metadata.source_refs[1].excerpt = 'forged assistant report';
    assert.equal((await box.sourceForRemote({ ...forged, status: 'candidate' })).kind, 'blocked');
    const duplicateOf = { externalId: `src-${'b'.repeat(64)}`,
      sdkId: 'existing-sdk-id', qdrantId: 'existing-qdrant-id', status: 'active' };
    assert.equal((await box.duplicateCandidate(row.operationId, manifest.candidates[0].candidateKey,
      { projectId: 'project', dedupKey: '0'.repeat(64), duplicateOf,
        evidenceDigest: 'c'.repeat(64) })).kind, 'blocked');
    const duplicate = await box.duplicateCandidate(row.operationId, manifest.candidates[0].candidateKey,
      { projectId: 'project', dedupKey: payload.dedup_key, duplicateOf,
        evidenceDigest: 'c'.repeat(64) });
    assert.equal(duplicate.kind, 'duplicate');
    assert.equal((await box.completeCheckpoint(row.operationId)).kind, 'processed');
    const receipt = await box.readDisposition(row.operationId);
    assert.equal(receipt.candidates[0].status, 'duplicate');
    assert.equal(receipt.candidates[0].sdkId, undefined);
  });
});

test('conversation context guides one Haiku call while transient CBS status is omitted', async () => {
  await fixture(async (box, root) => {
    const human = { ...slice(0, 'human', 'UserPromptSubmit').messages[0],
      text: 'Nesta sessão a memória CBS ficou somente leitura. Use PostgreSQL para persistência.' };
    const assistant = { ...slice(1, 'assistant', 'Stop').messages[0],
      text: 'At the time of this session, the CBS Qdrant memory for this project was read-only (automaticWriteConfigured: false). PostgreSQL is the persistence database.' };
    assert.equal((await box.enqueueConversationSlice({ cli: 'codex', sessionId: 'conversation',
      start: 0, end: 20, sliceHash: 'a'.repeat(64), messages: [human, assistant] },
    identity, { event: 'SessionEnd' })).kind, 'queued');
    const [row] = await box.pending();
    const consent = { enabled: true, ownerId: 'axcel', consentHash: 'a'.repeat(64) };
    const prior = 'Compile A, B, C, D and E in this order.';
    let calls = 0;
    let scrolls = 0;
    const result = await extractCheckpoint(row, { route: 'haiku', mode: 'conversation',
      maxCallsPerSession: 100, autoPublish: true, autoPublishConsent: consent }, {
      outbox: box, contextCwd: '/project',
      resolveProject: async () => ({ provider: 'mem0', projectId: 'project', ownerId: 'axcel',
        extractor: { autoPublishConsent: consent }, destination: { collection: 'c' } }),
      authorize: async () => ({ kind: 'authorized', connection: {}, key: 'private' }),
      scroll: async () => {
        scrolls++;
        return { kind: 'ready', scanned: 1, points: [
          { id: 'old', payload: { project_id: 'project', user_id: 'project',
            status: 'active', scope: 'project', data: prior } },
        ] };
      },
      runCli: async prompt => {
        calls++;
        const parsed = JSON.parse(prompt);
        assert.equal(parsed.existing_memories[0].text, prior);
        assert.equal(Object.hasOwn(parsed.existing_memories[0], 'memory_id'), false);
        assert.match(parsed.instruction, /fully covers the same subject, condition, negation/i);
        return { kind: 'success', no_facts: false, model: 'claude-haiku-5-5',
          usage: {}, candidates: [
            { text: 'At the time of this session, the CBS Qdrant memory for this project was read-only (automaticWriteConfigured: false).',
              type: 'fact', scope: 'project', evidence: [
                { source_message_id: human.messageId, excerpt: 'memória CBS ficou somente leitura' },
                { source_message_id: assistant.messageId,
                  excerpt: 'CBS Qdrant memory for this project was read-only' }] },
            { text: 'PostgreSQL is the persistence database.',
              type: 'decision', scope: 'project', evidence: [
                { source_message_id: human.messageId, excerpt: 'Use PostgreSQL para persistência' },
                { source_message_id: assistant.messageId, excerpt: 'PostgreSQL is the persistence database' }] },
          ] };
      },
    });
    assert.equal(result.kind, 'manifested', JSON.stringify(result));
    assert.deepEqual(result.context, { kind: 'ready', scanned: 1, selected: 1 });
    const counter = await readExtractionCounter(root);
    assert.deepEqual(counter.results[0].context, { kind: 'ready', scanned: 1, selected: 1 });
    const resumed = createOutbox(root);
    assert.equal((await resumed.extractionUsage('codex', 'conversation')).calls, 1);
    assert.equal(calls, 1);
    assert.equal(scrolls, 1);
    const manifest = await box.readManifest(row.operationId);
    assert.equal(manifest.candidates.length, 1);
    assert.equal((await box.readCandidatePayload(row.operationId,
      manifest.candidates[0].candidateKey)).text, 'PostgreSQL is the persistence database.');
  });
});

test('extraction diagnostics keep only bounded context status in durable outbox', async () => {
  await fixture(async (box, root) => {
    const human = { ...slice(0, 'human', 'UserPromptSubmit').messages[0],
      text: 'Use PostgreSQL for storage.' };
    const assistant = { ...slice(1, 'assistant', 'Stop').messages[0],
      text: 'Use PostgreSQL for storage.', finalVisible: true };
    assert.equal((await box.enqueueConversationSlice({ cli: 'codex', sessionId: 'conversation',
      start: 0, end: 20, sliceHash: 'b'.repeat(64), messages: [human, assistant] },
    identity, { event: 'SessionEnd' })).kind, 'queued');
    const [row] = await box.pending();
    const claimed = await box.claimExtraction(row.operationId, 4);
    assert.equal(claimed.kind, 'claimed');
    const result = await box.recordExtractionUsage(row.operationId, claimed.calls, {}, 1,
      { kind: 'unavailable', reason: 'private key abc', scanned: 900,
        selected: 900, text: 'secret text', memory_id: 'remote-id' });
    assert.equal(result.kind, 'recorded');
    const persisted = await readExtractionCounter(root);
    assert.deepEqual(persisted.results[0].context,
      { kind: 'unavailable', scanned: 64, selected: 8 });
    assert.doesNotMatch(JSON.stringify(persisted.results[0]), /private key|secret text|remote-id/);
  });
});
