import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { validateCandidate, extractCheckpoint, approveCandidate, rejectCandidate,
  markDuplicateCandidate } from '../base/memoria/candidates.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { runSonnetExtraction } from '../base/memoria/extract-cli.mjs';
import { extractionSchema, validateExtractionOutput } from '../base/memoria/extract-contract.mjs';
import { parsePersistedSlice } from '../base/memoria/transcript.mjs';

const source = { origin: 'human', actor: 'user', speakerRole: 'user', text: 'Fable faz só revisão final; Mira implementa.',
  messageId: 'm1', timestamp: '2024-02-03T10:00:00Z', start: 0, end: 80, sessionId: 's', cli: 'claude' };
const candidate = { candidate_key: 'fable_review', project_id: 'p', text: 'Fable faz só revisão final; Mira implementa.',
  type: 'rule', actor: 'user', speaker_role: 'user', origin: 'user_direct',
  evidence_at: source.timestamp, scope: 'project', source_message_id: 'm1',
  source_offsets: { start: 0, end: 80 }, status: 'candidate', condition: 'revisão final' };
const slice = { cli: 'claude', sessionId: 's', start: 0, end: 80, sliceHash: 'a'.repeat(64), messages: [source] };
const syntheticToken = ['sk', 'synthetic12345678901234567890'].join('-');
const syntheticKeyBody = ['abcPRIVATE', 'KEYbody123'].join('');
const beginPrivateKey = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const modelCandidate = { candidate_key: 'fable_review', source_message_id: 'm1',
  text: source.text, type: 'rule', scope: 'project', condition: 'revisão final' };
const modelFact = { candidate_key: 'fable_review', source_message_id: 'm1',
  text: source.text, type: 'fact', scope: 'project' };

async function fixture(t, messages = [source]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-candidates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const box = createOutbox(dir);
  const item = { ...slice, messages };
  const queued = await box.enqueueCheckpoint(item, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(queued.kind, 'queued');
  return { dir, box, checkpoint: { ...item, operationId: queued.operationId,
    projectId: 'p', policyVersion: 'native-v1' } };
}

async function sealFixture(box, operationId, candidateKey, decision, extra = {}) {
  const entry = (await box.readManifest(operationId)).candidates.find(item => item.candidateKey === candidateKey);
  const payload = await box.readCandidatePayload(operationId, candidateKey);
  const operation = decision === 'approve' ? {
    externalId: payload.external_id, projectId: payload.project_id, sessionId: payload.session_id,
    text: extra.text ?? payload.text,
    sourceIdentity: { projectId: payload.project_id, originCli: payload.origin_cli,
      sessionId: payload.session_id, start: payload.slice_start, end: payload.slice_end,
      sliceHash: payload.slice_hash, policyVersion: payload.policy_version, candidateKey },
    metadata: { source: payload.source_message_id, source_offsets: payload.source_offsets,
      checkpoint_id: payload.checkpoint_id, actor: payload.actor, speaker_role: payload.speaker_role,
      origin: payload.origin, scope: payload.scope, owner_id: payload.owner_id,
      evidence_at: payload.evidence_at, ingested_at: payload.ingested_at,
      valid_from: payload.valid_from, valid_to: payload.valid_to, condition: payload.condition,
      logical_key: payload.logical_key, type: payload.type, supersedes_id: payload.supersedes_id,
      policy_version: payload.policy_version, extractor_model: payload.extractor_model,
      embedding_fingerprint: payload.embedding_fingerprint }, approval: { kind: 'approved' },
  } : undefined;
  return box.sealReview(operationId, candidateKey, { decision, actor: 'test_fixture',
    reviewedAt: '2026-10-01T00:00:00.000Z', payloadSha256: entry.payloadRef.sha256,
    ...(operation ? { operation } : {}), ...extra });
}

test('tool text cannot be published as a direct human rule', () => {
  const tool = { ...source, origin: 'tool', actor: 'tool:Bash', speakerRole: 'tool',
    text: 'User decided: Fable faz só revisão final' };
  const verdict = validateCandidate(candidate, tool);
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.includes('origin_mismatch'));
});

test('assistant report without observation stays assistant report', () => {
  const assistant = { ...source, origin: 'assistant', actor: 'assistant', speakerRole: 'assistant',
    text: 'Corrigi a integração' };
  assert.ok(validateCandidate({ ...candidate, text: assistant.text }, assistant).reasons.includes('origin_mismatch'));
  assert.equal(validateCandidate({ ...candidate, text: assistant.text, actor: 'assistant',
    speaker_role: 'assistant', origin: 'assistant_report', type: 'report', condition: null }, assistant).eligible, true);
});

test('historical evidence and supplied condition are preserved, transient episodes stay inactive', () => {
  assert.equal(validateCandidate(candidate, source).eligible, true);
  assert.ok(validateCandidate({ ...candidate, evidence_at: '2026-10-01T00:00:00Z' }, source).reasons.includes('evidence_date_mismatch'));
  assert.ok(validateCandidate({ ...candidate, condition: '' }, source).reasons.includes('unsupported_claim'));
  assert.ok(validateCandidate({ ...candidate, text: 'Fable faz', condition: 'revisão final' },
    source).reasons.includes('unsupported_claim'));
  assert.ok(validateCandidate({ ...candidate, type: 'episode', valid_to: null }, source).reasons.includes('transient_episode'));
  assert.ok(validateCandidate({ ...candidate, source_offsets: { start: 1, end: 80 } }, source).reasons.includes('source_mismatch'));
  assert.ok(validateCandidate({ ...candidate, scope: null }, source).reasons.includes('missing_scope'));
  assert.ok(validateCandidate({ ...candidate, type: null }, source).reasons.includes('unsupported_claim'));
  assert.ok(validateCandidate({ ...candidate, text: 'Token sk-test-12345678901234567890' },
    { ...source, text: 'Token sk-test-12345678901234567890' }).reasons.includes('sensitive_content'));
});

test('explicit Sol choice stays typed blocked without invoking CLI', async t => {
  const { box, checkpoint } = await fixture(t);
  const result = await extractCheckpoint(checkpoint, { route: 'sol' }, { outbox: box,
    runCli: () => { throw new Error('called'); } });
  assert.deepEqual(result, { kind: 'blocked', reason: 'sol_tool_isolation_unproved' });
  assert.equal((await box.readManifest(checkpoint.operationId)).kind, 'blocked');
});

test('sanitized Sonnet input omits secrets and leaves failed extraction pending', async t => {
  const { box, checkpoint } = await fixture(t,
    [{ ...source, text: 'Token sk-test-12345678901234567890; Fable faz só revisão final' }]);
  let input;
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async prompt => { input = prompt; return { kind: 'error', reason: 'cli_failed' }; },
  });
  assert.equal(result.kind, 'pending');
  assert.equal(JSON.stringify(input).includes('sk-test-12345678901234567890'), false);
  assert.equal((await box.readManifest(checkpoint.operationId)).kind, 'blocked');
});

test('AWS key and JWT are absent from CLI input and cannot become candidates', async t => {
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'abcdefghijklmnopqrstuv'].join('.');
  const sensitiveSource = { ...source, text: `${source.text} ${aws} ${jwt}` };
  const { box, checkpoint } = await fixture(t, [sensitiveSource]);
  let prompt;
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async input => { prompt = input; return { kind: 'success', no_facts: false, candidates: [
      { ...modelCandidate, text: aws },
    ] }; },
  });
  assert.equal(prompt.includes(aws), false);
  assert.equal(prompt.includes(jwt), false);
  assert.equal(result.reason, 'sensitive_content');
  assert.equal((await box.readManifest(checkpoint.operationId)).kind, 'blocked');
});

test('complete private keys and quoted or multiline passwords never reach CLI', async t => {
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nabcPRIVATEKEYbody123\n-----END OPENSSH PRIVATE KEY-----';
  const password = 'alpha beta gamma';
  const multiline = 'first line\nsecond secret line';
  const message = { ...source, text: `${source.text}\n${privateKey}\npassword: "${password}"\nsecret: "${multiline}"` };
  const { box, checkpoint } = await fixture(t, [message]);
  let prompt;
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async input => { prompt = input; return { kind: 'error', reason: 'cli_failed' }; },
  });
  assert.equal(result.kind, 'pending');
  assert.ok(prompt);
  for (const value of ['abcPRIVATEKEYbody123', password, multiline]) assert.equal(prompt.includes(value), false);
  assert.equal(prompt.includes('Fable faz só revisão final'), true);
});

test('safe fact beside source secrets reaches remote payload without secret bytes', async t => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-material-123\n-----END PRIVATE KEY-----';
  const password = 'alpha beta gamma';
  const { box, checkpoint } = await fixture(t, [{ ...source,
    text: `${source.text}\npassword: "${password}"\n${privateKey}` }]);
  let prompt, operation;
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async input => { prompt = input; return { kind: 'success', no_facts: false,
      candidates: [modelCandidate] }; },
  })).kind, 'manifested');
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'approve')).kind, 'sealed');
  assert.equal((await approveCandidate(checkpoint.operationId, 'fable_review', {
    outbox: box, store: async op => { operation = op; return box.ackCandidate(checkpoint.operationId,
      'fable_review', { externalId: op.externalId, projectId: 'p', status: 'active',
        sdkId: 'uuid-1', qdrantId: 'uuid-1' }); },
  })).kind, 'processed');
  const exposed = prompt + JSON.stringify(operation);
  assert.equal(exposed.includes(privateKey), false);
  assert.equal(exposed.includes('private-material-123'), false);
  assert.equal(exposed.includes(password), false);
  assert.equal(operation.text, candidate.text);
});

test('space-separated quoted password cannot reach prompt, candidate or sealed store', async t => {
  const fact = 'Fable faz revisão.';
  const value = ['alpha', 'beta', 'gamma'].join(' ');
  const message = { ...source, text: `${fact} ${['pass', 'word'].join('')} "${value}"` };
  const { dir, box, checkpoint } = await fixture(t, [message]);
  let prompt;
  const poisoned = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async input => { prompt = input; return { kind: 'success', no_facts: false, candidates: [
      { ...modelFact, text: 'beta gamma' },
    ] }; },
  });
  assert.equal(prompt.includes(value), false);
  assert.equal(prompt.includes('beta gamma'), false);
  assert.equal(prompt.includes(fact), true);
  assert.equal(poisoned.reason, 'sensitive_content');
  assert.equal((await box.readManifest(checkpoint.operationId)).reason, 'missing_manifest');

  const clean = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [
      { ...modelFact, text: fact },
    ] }),
  });
  assert.equal(clean.kind, 'manifested');
  const payload = await box.readCandidatePayload(checkpoint.operationId, 'fable_review');
  assert.equal(JSON.stringify(payload).includes(value), false);
  assert.equal(payload.text, fact);
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'approve')).kind, 'sealed');
  let operation;
  const stored = await approveCandidate(checkpoint.operationId, 'fable_review', {
    outbox: box, store: async op => { operation = op; return box.ackCandidate(checkpoint.operationId,
      'fable_review', { externalId: op.externalId, projectId: 'p', status: 'active',
        sdkId: 'uuid-1', qdrantId: 'uuid-1' }); },
  });
  assert.equal(stored.kind, 'processed');
  assert.equal(JSON.stringify(operation).includes(value), false);
  assert.equal(operation.text, fact);
  const entry = (await box.readDisposition(checkpoint.operationId)).candidates[0];
  const sealed = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews',
    `${entry.externalId}.json`)));
  assert.equal(JSON.stringify(sealed).includes(value), false);
  assert.equal(sealed.review.operation.text, fact);
});

test('unquoted password with spaces cannot reach prompt, candidate, review seal or store', async t => {
  const fact = 'Fable faz revisão.';
  const value = ['alpha', 'beta', 'gamma'].join(' ');
  const tail = 'beta gamma';
  const message = { ...source, text: `${fact} password: ${value}\nMira implementa.` };
  const { dir, box, checkpoint } = await fixture(t, [message]);
  let prompt;
  const poisoned = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async input => { prompt = input; return { kind: 'success', no_facts: false, candidates: [
      { ...modelFact, text: tail },
    ] }; },
  });
  assert.equal(prompt.includes(tail), false);
  assert.equal(prompt.includes(value), false);
  assert.equal(prompt.includes(fact), true);
  assert.equal(prompt.includes('Mira implementa.'), true);
  assert.equal(poisoned.reason, 'sensitive_content');
  assert.equal((await box.readManifest(checkpoint.operationId)).reason, 'missing_manifest');

  const clean = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [
      { ...modelFact, text: fact },
    ] }),
  });
  assert.equal(clean.kind, 'manifested');
  const payload = await box.readCandidatePayload(checkpoint.operationId, 'fable_review');
  assert.equal(JSON.stringify(payload).includes(tail), false);
  assert.equal(payload.text, fact);
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'approve')).kind, 'sealed');
  let operation;
  const stored = await approveCandidate(checkpoint.operationId, 'fable_review', {
    outbox: box, store: async op => { operation = op; return box.ackCandidate(checkpoint.operationId,
      'fable_review', { externalId: op.externalId, projectId: 'p', status: 'active',
        sdkId: 'uuid-1', qdrantId: 'uuid-1' }); },
  });
  assert.equal(stored.kind, 'processed');
  assert.equal(JSON.stringify(operation).includes(tail), false);
  assert.equal(operation.text, fact);
  const entry = (await box.readDisposition(checkpoint.operationId)).candidates[0];
  const sealed = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews',
    `${entry.externalId}.json`)));
  assert.equal(JSON.stringify(sealed).includes(tail), false);
  assert.equal(sealed.review.operation.text, fact);
});

test('each detected label separator consumes complete unquoted value through line end', async t => {
  const fact = 'Fable faz revisão.';
  const value = ['alpha', 'beta', 'gamma'].join(' ');
  for (const separator of [' ', ': ', '= ']) {
    const { box, checkpoint } = await fixture(t, [{ ...source,
      text: `${fact} password${separator}${value}\nMira implementa.` }]);
    let prompt;
    const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: box, runCli: async input => { prompt = input; return { kind: 'error', reason: 'cli_failed' }; },
    });
    assert.equal(result.reason, 'cli_failed');
    assert.equal(prompt.includes(value), false, separator);
    assert.equal(prompt.includes('beta gamma'), false, separator);
    assert.equal(prompt.includes(fact), true, separator);
    assert.equal(prompt.includes('Mira implementa.'), true, separator);
  }
});

test('each detected label separator consumes complete single, double and multiline quoted values', async t => {
  const fact = 'Fable faz revisão.';
  const value = ['alpha', 'beta', 'gamma'].join(' ');
  const cases = [
    { separator: ' ', quote: '"', value },
    { separator: ' ', quote: "'", value },
    { separator: ': ', quote: '"', value: `alpha\nbeta gamma` },
    { separator: '= ', quote: "'", value: `alpha\nbeta gamma` },
  ];
  for (const item of cases) {
    const message = { ...source, text: `${fact} ${['pass', 'word'].join('')}${item.separator}` +
      `${item.quote}${item.value}${item.quote} Mira implementa.` };
    const { box, checkpoint } = await fixture(t, [message]);
    let prompt;
    const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: box, runCli: async input => { prompt = input; return { kind: 'error', reason: 'cli_failed' }; },
    });
    assert.equal(result.reason, 'cli_failed');
    assert.equal(prompt.includes(item.value), false);
    assert.equal(prompt.includes('beta gamma'), false);
    assert.equal(prompt.includes(fact), true);
    assert.equal(prompt.includes('Mira implementa.'), true);
  }
});

test('space-separated escaped or unterminated quoted secrets block CLI', async t => {
  const cases = [`"alpha\\" beta gamma"`, "'alpha\\' beta gamma'", '"alpha beta gamma'];
  for (const value of cases) {
    const { box, checkpoint } = await fixture(t, [{ ...source,
      text: `Fable faz revisão. ${['pass', 'word'].join('')} ${value}` }]);
    let calls = 0;
    const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: box, runCli: async () => { calls++; throw new Error('unexpected CLI call'); },
    });
    assert.equal(result.reason, 'unsafe_source_secret');
    assert.equal(calls, 0);
  }
});

test('incomplete private key blocks CLI before any call', async t => {
  const { box, checkpoint } = await fixture(t, [{ ...source,
    text: `${source.text}\n${beginPrivateKey}\n${syntheticKeyBody}` }]);
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => { throw new Error('called'); },
  });
  assert.equal(result.reason, 'unsafe_source_secret');
});

test('model-controlled metadata with secret cannot be persisted or published', async t => {
  const { box, checkpoint } = await fixture(t);
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [{ ...modelCandidate,
      logical_key: syntheticToken }] }),
  });
  assert.equal(result.reason, 'sensitive_content');
  assert.equal((await box.readManifest(checkpoint.operationId)).kind, 'blocked');
  assert.equal(validateCandidate({ ...candidate, logical_key: syntheticToken },
    source).reasons.includes('sensitive_content'), true);
});

test('private-key body substring is rejected even without PEM markers in candidate', () => {
  const pemSource = { ...source, text: `${source.text}\n-----BEGIN OPENSSH PRIVATE KEY-----\n` +
    `${syntheticKeyBody}\n-----END OPENSSH PRIVATE KEY-----` };
  assert.ok(validateCandidate({ ...candidate, text: syntheticKeyBody, type: 'fact' }, pemSource)
    .reasons.includes('sensitive_content'));
});

test('model metadata uses bounded type and cannot invent supersession', () => {
  assert.ok(validateCandidate({ ...candidate, type: 'arbitrary_model_label' }, source)
    .reasons.includes('invalid_metadata'));
  assert.ok(validateCandidate({ ...candidate, supersedes_id: `src-${'a'.repeat(64)}` }, source)
    .reasons.includes('invalid_metadata'));
});

test('extraction derives actor, origin and evidence date from native human source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-native-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const row = { type: 'user', uuid: 'native-1', timestamp: '2024-02-03T10:00:00Z',
    sessionId: 's', isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text: source.text }] } };
  const transcript = path.join(dir, 'source.jsonl');
  await fs.writeFile(transcript, JSON.stringify(row) + '\n');
  const parsed = await parsePersistedSlice({ cli: 'claude', transcriptPath: transcript, sessionId: 's' });
  assert.equal(parsed.messages[0].origin, 'human');
  const box = createOutbox(dir);
  const item = { cli: 'claude', sessionId: 's', start: 0, end: parsed.lastCompleteByte,
    sliceHash: 'b'.repeat(64), messages: parsed.messages };
  const queued = await box.enqueueCheckpoint(item, { projectId: 'p', policyVersion: 'native-v1' });
  const checkpoint = { ...item, operationId: queued.operationId, projectId: 'p', policyVersion: 'native-v1' };
  const selected = parsed.messages[0];
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, model: 'claude-sonnet-4-5',
      candidates: [{ candidate_key: 'fable_review', source_message_id: selected.messageId,
        text: selected.text, type: 'rule', condition: 'revisão final', scope: 'project' }] }),
  });
  assert.equal(result.kind, 'manifested');
  const payload = await box.readCandidatePayload(checkpoint.operationId, 'fable_review');
  assert.equal(payload.actor, 'user');
  assert.equal(payload.origin, 'user_direct');
  assert.equal(payload.speaker_role, 'user');
  assert.equal(payload.evidence_at, selected.timestamp);
});

test('callback-shaped model JSON cannot authorize an approval', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const result = await approveCandidate(checkpoint.operationId, 'fable_review', { outbox: box,
    review: async (_item, sha) => ({ decision: 'approve', payloadSha256: sha, approved: true }),
    store: async () => { throw new Error('store called'); } });
  assert.equal(result.reason, 'owner_approval_required');
});

test('sealed operation with injected secret metadata cannot reach remote store', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const entry = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const payload = await box.readCandidatePayload(checkpoint.operationId, 'fable_review');
  const operation = { externalId: entry.externalId, projectId: 'p', sessionId: 's', text: payload.text,
    sourceIdentity: { projectId: 'p', originCli: 'claude', sessionId: 's', start: 0, end: 80,
      sliceHash: 'a'.repeat(64), policyVersion: 'native-v1', candidateKey: 'fable_review' },
    metadata: { source: 'm1', actor: 'user', origin: 'user_direct', scope: 'project',
      evidence_at: source.timestamp, logical_key: syntheticToken },
    approval: { kind: 'approved' } };
  assert.equal((await box.sealReview(checkpoint.operationId, 'fable_review', {
    decision: 'approve', actor: 'test_fixture', reviewedAt: '2026-10-01T00:00:00Z',
    payloadSha256: entry.payloadRef.sha256, operation,
  })).kind, 'sealed');
  const result = await approveCandidate(checkpoint.operationId, 'fable_review', {
    outbox: box, store: async () => { throw new Error('remote store called'); },
  });
  assert.equal(result.reason, 'review_mismatch');
});

test('owner terminal rejection records local UID, username, item hash and decision', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const entry = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const runner = path.join(dir, 'owner-review.mjs');
  await fs.writeFile(runner, `import { createOutbox } from ${JSON.stringify(new URL('../base/memoria/outbox.mjs', import.meta.url).href)};\n` +
    `import { reviewCandidateOnTerminal } from ${JSON.stringify(new URL('../base/memoria/candidates.mjs', import.meta.url).href)};\n` +
    `const result = await reviewCandidateOnTerminal(${JSON.stringify(checkpoint.operationId)}, 'fable_review', ` +
    `{ outbox: createOutbox(${JSON.stringify(dir)}) });\nconsole.log('RESULT=' + JSON.stringify(result));\n`);
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', `${process.execPath} ${runner}`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let step = 0;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (step === 0 && output.includes('Action (accept/reject/duplicate/edit): ')) {
      step++; child.stdin.write('reject\n');
    } else if (step === 1 && output.includes('Reason code: ')) {
      step++; child.stdin.write('unsupported_claim\n');
    } else if (step === 2 && output.includes('Confirm reject for ')) {
      step++; child.stdin.write('yes\n');
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /RESULT=\{"kind":"processed"/);
  assert.ok(output.includes(entry.payloadRef.sha256));
  assert.ok(output.includes(candidate.text));
  assert.ok(output.includes(`Source ${JSON.stringify(source.text)}`));
  const audit = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews', `${entry.externalId}.json`)));
  assert.equal(audit.review.actor, `uid:${process.getuid()}:${os.userInfo().username}`);
  assert.equal(audit.review.decision, 'reject');
  assert.equal(audit.review.payloadSha256, entry.payloadRef.sha256);
});

test('owner terminal acceptance seals review before one verified child ACK', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const runner = path.join(dir, 'owner-accept.mjs');
  await fs.writeFile(runner, `import { createOutbox } from ${JSON.stringify(new URL('../base/memoria/outbox.mjs', import.meta.url).href)};\n` +
    `import { reviewCandidateOnTerminal } from ${JSON.stringify(new URL('../base/memoria/candidates.mjs', import.meta.url).href)};\n` +
    `const box = createOutbox(${JSON.stringify(dir)});\n` +
    `const result = await reviewCandidateOnTerminal(${JSON.stringify(checkpoint.operationId)}, 'fable_review', ` +
    `{ outbox: box, store: op => box.ackCandidate(${JSON.stringify(checkpoint.operationId)}, 'fable_review', ` +
    `{ externalId: op.externalId, projectId: op.projectId, status: 'active', sdkId: 'uuid-1', qdrantId: 'uuid-1' }) });\n` +
    `console.log('RESULT=' + JSON.stringify(result));\n`);
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', `${process.execPath} ${runner}`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let step = 0;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (step === 0 && output.includes('Action (accept/reject/duplicate/edit): ')) {
      step++; child.stdin.write('accept\n');
    } else if (step === 1 && output.includes('Confirm accept for ')) {
      step++; child.stdin.write('yes\n');
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /RESULT=\{"kind":"processed"/);
  const receipt = await box.readDisposition(checkpoint.operationId);
  assert.equal(receipt.candidates[0].status, 'remote_acked');
  const review = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews',
    `${receipt.candidates[0].externalId}.json`)));
  assert.equal(review.review.actor, `uid:${process.getuid()}:${os.userInfo().username}`);
  assert.equal(review.review.operation.text, candidate.text);
});

test('first child ACK returns success while sibling remains pending', async t => {
  const { box, checkpoint } = await fixture(t);
  const second = { ...modelFact, candidate_key: 'mira_implement', text: 'Mira implementa.' };
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate, second] }),
  })).kind, 'manifested');
  const manifest = await box.readManifest(checkpoint.operationId);
  let adds = 0;
  for (const child of manifest.candidates) assert.equal((await sealFixture(box, checkpoint.operationId,
    child.candidateKey, 'approve')).kind, 'sealed');
  const options = { outbox: box,
    store: async op => { adds++; return box.ackCandidate(checkpoint.operationId, op.sourceIdentity.candidateKey,
      { externalId: op.externalId, projectId: 'p', status: 'active', sdkId: `sdk-${adds}`, qdrantId: `sdk-${adds}` }); } };
  const first = await approveCandidate(checkpoint.operationId, manifest.candidates[0].candidateKey, options);
  assert.equal(first.kind, 'acked');
  assert.equal((await box.readManifest(checkpoint.operationId)).candidates[1].status, 'pending');
  assert.equal((await approveCandidate(checkpoint.operationId, manifest.candidates[1].candidateKey, options)).kind, 'processed');
  assert.equal(adds, 2);
});

test('claimed store success without durable child ACK remains pending', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'approve')).kind, 'sealed');
  const entry = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const result = await approveCandidate(checkpoint.operationId, 'fable_review', {
    outbox: box, store: async () => ({ kind: 'stored', externalId: entry.externalId }),
  });
  assert.equal(result.reason, 'store_unconfirmed');
  assert.equal((await box.readManifest(checkpoint.operationId)).candidates[0].status, 'pending');
});

test('terminal child replay completes parent after receipt ENOSPC without another add', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const child = (await box.readManifest(checkpoint.operationId)).candidates[0];
  assert.equal((await sealFixture(box, checkpoint.operationId, child.candidateKey, 'approve')).kind, 'sealed');
  let adds = 0;
  let failReceipt = true;
  const firstBox = { ...box, completeCheckpoint: async id => failReceipt ? { kind: 'full', operationId: id } : box.completeCheckpoint(id) };
  const options = { outbox: firstBox,
    store: async op => { adds++; return box.ackCandidate(checkpoint.operationId, child.candidateKey,
      { externalId: op.externalId, projectId: 'p', status: 'active', sdkId: 'uuid-1', qdrantId: 'uuid-1' }); } };
  assert.equal((await approveCandidate(checkpoint.operationId, child.candidateKey, options)).kind, 'full');
  failReceipt = false;
  const replay = await approveCandidate(checkpoint.operationId, child.candidateKey,
    { ...options, outbox: createOutbox(dir), store: async () => { throw new Error('second add'); } });
  assert.equal(replay.kind, 'processed');
  assert.equal(adds, 1);
});

test('two-child final ACK survives parent receipt ENOSPC and restart without reextraction', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  const second = { ...modelFact, candidate_key: 'mira_implement', text: 'Mira implementa.' };
  let extracts = 0;
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => { extracts++; return { kind: 'success', no_facts: false, candidates: [modelCandidate, second] }; },
  })).kind, 'manifested');
  const children = (await box.readManifest(checkpoint.operationId)).candidates;
  for (const child of children) assert.equal((await sealFixture(box, checkpoint.operationId,
    child.candidateKey, 'approve')).kind, 'sealed');
  let adds = 0;
  let failReceipt = true;
  const fullAfterFinal = { ...box, completeCheckpoint: async id => {
    const manifest = await box.readManifest(id);
    return failReceipt && manifest.candidates.every(item => item.status !== 'pending')
      ? { kind: 'full', operationId: id } : box.completeCheckpoint(id);
  } };
  const options = { outbox: fullAfterFinal, store: async op => {
    adds++;
    return box.ackCandidate(checkpoint.operationId, op.sourceIdentity.candidateKey,
      { externalId: op.externalId, projectId: 'p', status: 'active', sdkId: `uuid-${adds}`,
        qdrantId: `uuid-${adds}` });
  } };
  assert.equal((await approveCandidate(checkpoint.operationId, children[0].candidateKey, options)).kind, 'acked');
  assert.equal((await approveCandidate(checkpoint.operationId, children[1].candidateKey, options)).kind, 'full');
  failReceipt = false;
  const replay = await approveCandidate(checkpoint.operationId, children[1].candidateKey,
    { outbox: createOutbox(dir), store: async () => { throw new Error('repeat add'); } });
  assert.equal(replay.kind, 'processed');
  assert.equal(adds, 2);
  assert.equal(extracts, 1);
});

test('rejected and duplicate terminal children replay parent receipt without renewed review', async t => {
  for (const disposition of ['rejected', 'duplicate']) {
    const { dir, box, checkpoint } = await fixture(t);
    assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
    })).kind, 'manifested');
    const key = 'fable_review';
    assert.equal((await sealFixture(box, checkpoint.operationId, key,
      disposition === 'rejected' ? 'reject' : 'duplicate', disposition === 'rejected'
        ? { reason: 'unsupported_claim' } : { duplicateRef: 'older-source' })).kind, 'sealed');
    const fullBox = { ...box, completeCheckpoint: async id => ({ kind: 'full', operationId: id }) };
    const call = disposition === 'rejected'
      ? options => rejectCandidate(checkpoint.operationId, key, 'unsupported_claim', options)
      : options => markDuplicateCandidate(checkpoint.operationId, key, 'older-source', options);
    const firstOptions = { outbox: fullBox, verifyDuplicate: async () =>
      ({ externalId: 'older-source', projectId: 'p', status: 'active' }) };
    assert.equal((await call(firstOptions)).kind, 'full');
    assert.equal((await call({ outbox: createOutbox(dir) })).kind, 'processed');
  }
});

test('two complementary facts persist separate payloads and reload after restart', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  const second = { ...modelFact, candidate_key: 'mira_implement', text: 'Mira implementa.' };
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelFact, second], usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01 } }),
  });
  assert.equal(result.kind, 'manifested');
  const manifest = await createOutbox(dir).readManifest(checkpoint.operationId);
  assert.equal(manifest.candidates.length, 2);
  assert.notEqual(manifest.candidates[0].externalId, manifest.candidates[1].externalId);
  assert.ok(manifest.candidates.every(row => /^[a-f0-9]{64}$/.test(row.payloadRef.sha256)));
  assert.equal((await box.cursor('claude', 's')).processedEnd, 0);
});

test('four calls are durable across restart; an empty success never closes the checkpoint', async t => {
  const { dir, checkpoint } = await fixture(t);
  for (let n = 0; n < 4; n++) {
    const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: createOutbox(dir), runCli: async () => ({ kind: 'success', no_facts: false, candidates: [] }),
    });
    assert.equal(result.reason, 'extractor_schema_invalid');
  }
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: createOutbox(dir), runCli: async () => { throw new Error('fifth_call'); },
  });
  assert.equal(result.reason, 'extraction_call_limit');
  assert.equal((await createOutbox(dir).cursor('claude', 's')).processedEnd, 0);
});

test('ENOSPC during extraction accounting leaves checkpoint pending with typed result', async t => {
  const { dir, checkpoint } = await fixture(t);
  const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const box = createOutbox(dir, { fault: stage => { if (stage === 'after_write') throw error; } });
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => { throw new Error('must not call'); },
  });
  assert.equal(result.reason, 'outbox_full');
  assert.equal((await createOutbox(dir).cursor('claude', 's')).processedEnd, 0);
});

test('valid no-facts disposition is local and keeps remote ACK separate', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [], no_facts: true,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } }),
  });
  assert.equal(result.kind, 'processed');
  assert.equal((await box.readDisposition(checkpoint.operationId)).disposition, 'no_facts');
  assert.equal((await createOutbox(dir).cursor('claude', 's')).ackedEnd, 0);
  assert.deepEqual(await createOutbox(dir).extractionUsage('claude', 's'),
    { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
});

test('payload tampering blocks review and checkpoint completion', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const manifest = await box.readManifest(checkpoint.operationId);
  const child = manifest.candidates[0];
  const file = path.join(dir, 'candidates', 'payloads', `${child.externalId}.${child.payloadRef.sha256}.json`);
  await fs.writeFile(file, '{}');
  assert.equal((await createOutbox(dir).readManifest(checkpoint.operationId)).reason, 'candidate_payload_mismatch');
  assert.equal((await box.completeCheckpoint(checkpoint.operationId)).reason, 'candidate_payload_mismatch');
});

test('rehash cannot detach candidate payload from source CLI and policy', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const manifest = await box.readManifest(checkpoint.operationId);
  const entry = manifest.candidates[0];
  const original = path.join(dir, 'candidates', 'payloads', `${entry.externalId}.${entry.payloadRef.sha256}.json`);
  const payload = JSON.parse(await fs.readFile(original, 'utf8'));
  payload.origin_cli = 'codex';
  const bytes = JSON.stringify(payload) + '\n';
  const digest = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(dir, 'candidates', 'payloads', `${entry.externalId}.${digest}.json`), bytes, { mode: 0o600 });
  const manifestFile = path.join(dir, 'outbox', 'items', `${checkpoint.operationId}.manifest.json`);
  manifest.candidates[0].payloadRef.sha256 = digest;
  await fs.writeFile(manifestFile, JSON.stringify(manifest) + '\n');
  assert.equal((await createOutbox(dir).readManifest(checkpoint.operationId)).reason, 'candidate_payload_mismatch');
});

test('approved item seals exact operation, stores through canonical facade and ACKs its child', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const manifest = await box.readManifest(checkpoint.operationId);
  const child = manifest.candidates[0];
  assert.equal((await sealFixture(box, checkpoint.operationId, child.candidateKey, 'approve')).kind, 'sealed');
  let operation;
  const result = await approveCandidate(checkpoint.operationId, child.candidateKey, {
    outbox: box,
    store: async op => { operation = op; return box.ackCandidate(checkpoint.operationId, child.candidateKey,
      { externalId: op.externalId, projectId: 'p', status: 'active', sdkId: 'uuid-1', qdrantId: 'uuid-1' }); },
  });
  assert.equal(result.kind, 'processed');
  assert.equal(operation.text, candidate.text);
  assert.equal(operation.externalId, child.externalId);
  assert.equal(operation.approval.kind, 'approved');
  const audit = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews', `${child.externalId}.json`)));
  assert.equal(audit.review.actor, 'test_fixture');
  assert.ok(Number.isFinite(Date.parse(audit.review.reviewedAt)));
  assert.equal(audit.review.operation.text, candidate.text);
  assert.equal((await createOutbox(dir).cursor('claude', 's')).processedEnd, 80);
});

test('review directory symlink blocks approval before reading a planted decision', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const child = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const foreign = path.join(dir, 'foreign');
  await fs.mkdir(foreign, { mode: 0o700 });
  await fs.writeFile(path.join(foreign, `${child.externalId}.json`), '{}', { mode: 0o600 });
  await fs.symlink(foreign, path.join(dir, 'candidates', 'reviews'));
  const result = await approveCandidate(checkpoint.operationId, child.candidateKey, {
    outbox: box, review: async () => { throw new Error('review called'); },
    store: async () => { throw new Error('store called'); },
  });
  assert.equal(result.reason, 'unsafe_review_dir');
});

test('review rejection is auditable local disposition and never calls remote store', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'reject',
    { reason: 'unsupported_claim' })).kind, 'sealed');
  const result = await rejectCandidate(checkpoint.operationId, 'fable_review', 'unsupported_claim', {
    outbox: box,
  });
  assert.equal(result.kind, 'processed');
  assert.equal((await box.readDisposition(checkpoint.operationId)).candidates[0].status, 'rejected');
});

test('duplicate disposition requires verified active reference and keeps separate source identity', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  assert.equal((await sealFixture(box, checkpoint.operationId, 'fable_review', 'duplicate',
    { duplicateRef: 'older-source' })).kind, 'sealed');
  const duplicate = { outbox: box,
    verifyDuplicate: async () => ({ externalId: 'older-source', projectId: 'p', status: 'active' }) };
  assert.equal((await markDuplicateCandidate(checkpoint.operationId, 'fable_review',
    'older-source', duplicate)).kind, 'processed');
  const receipt = await box.readDisposition(checkpoint.operationId);
  assert.equal(receipt.candidates[0].status, 'duplicate');
  assert.notEqual(receipt.candidates[0].externalId, 'older-source');
  assert.equal((await box.cursor('claude', 's')).ackedEnd, 0);
});

test('canonical store reuses remote commit after failed local child ACK', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', no_facts: false, candidates: [modelCandidate] }),
  })).kind, 'manifested');
  const child = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const remote = [];
  let adds = 0;
  let ackFails = true;
  assert.equal((await sealFixture(box, checkpoint.operationId, child.candidateKey, 'approve')).kind, 'sealed');
  const bridge = { writerId: 'writer-a', resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: dir,
      destination: { collection: 'private' } }), authorize: async () => ({ kind: 'authorized', key: 'fixture-key',
      connection: { url: 'http://127.0.0.1:6333/' } }),
    run: async (_python, _program, request) => {
      if (request.op === 'find') return { kind: 'items', items: remote.filter(row => row.externalId === request.externalId) };
      if (request.op === 'add') {
        adds++;
        remote.push({ externalId: request.externalId, projectId: request.projectId,
          sessionId: request.sessionId, text: request.text,
          metadata: { ...request.metadata, status: 'pending', source_record_id: request.externalId,
            project_id: request.projectId }, status: 'pending', sdkId: 'uuid-1', qdrantId: 'uuid-1' });
        return { kind: 'pending' };
      }
      if (request.op === 'read') return { kind: 'item', item: remote[0] };
      if (request.op === 'activate') { remote[0].status = 'active'; remote[0].metadata.status = 'active';
        return { kind: 'item', item: remote[0] }; }
      throw new Error('unexpected operation');
    } };
  const options = { outbox: box,
    store: op => storeMemory('project', 's', op, () => '', { ...bridge,
      ackLocal: (id, proof) => ackFails ? { kind: 'blocked', reason: 'disk_full' } :
        box.ackCandidate(checkpoint.operationId, child.candidateKey, proof) }),
  };
  assert.equal((await approveCandidate(checkpoint.operationId, child.candidateKey, options)).reason, 'store_unconfirmed');
  assert.equal((await box.cursor('claude', 's')).processedEnd, 0);
  ackFails = false;
  assert.equal((await approveCandidate(checkpoint.operationId, child.candidateKey, options)).kind, 'processed');
  assert.equal((await box.cursor('claude', 's')).processedEnd, 80);
  assert.equal(adds, 1);
});

test('CLI route excludes inherited API secrets and rejects an unexpected model', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-cli-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (process.env.CBS_MEMORIA_API_KEY || process.env.OPENAI_API_KEY ||
!args.includes('--safe-mode') || args[args.indexOf('--tools')+1] !== '' ||
!args.includes('--no-session-persistence') || args[args.indexOf('--permission-mode')+1] !== 'dontAsk') process.exit(17);\n
process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({
subtype:'success', is_error:false, structured_output:{candidates:[],no_facts:true},
modelUsage:{'unexpected':{canonicalModel:'unexpected'}}, usage:{input_tokens:1,output_tokens:1}})));`;
  await fs.writeFile(path.join(dir, 'claude'), script, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldKey = process.env.CBS_MEMORIA_API_KEY;
  const oldOpenAI = process.env.OPENAI_API_KEY;
  const oldProfile = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.CLAUDE_CONFIG_DIR = profile;
    process.env.CBS_MEMORIA_API_KEY = 'fixture-secret';
    process.env.OPENAI_API_KEY = 'fixture-secret';
    assert.deepEqual(await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' }),
      { kind: 'error', reason: 'cli_model_mismatch' });
    await fs.writeFile(path.join(dir, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();\n` +
      `process.stdin.on('end', () => process.stdout.write('null'));`, { mode: 0o700 });
    assert.deepEqual(await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' }),
      { kind: 'error', reason: 'cli_invalid_schema' });
  } finally {
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.CBS_MEMORIA_API_KEY;
    else process.env.CBS_MEMORIA_API_KEY = oldKey;
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldProfile;
  }
});

test('structured schema and local guard reject invalid fields before any manifest', async t => {
  const item = extractionSchema.properties.candidates.items;
  assert.deepEqual(item.properties.scope.enum, ['project', 'personal', 'episode']);
  assert.deepEqual(item.properties.type.enum, ['rule', 'fact', 'preference', 'decision', 'report', 'episode']);
  assert.equal(item.additionalProperties, false);
  assert.equal('owner_id' in item.properties, false);
  assert.equal('supersedes_id' in item.properties, false);
  const bad = [
    { ...modelCandidate, scope: 'organization' },
    { ...modelCandidate, candidate_key: 'Bad Key' },
    { ...modelCandidate, logical_key: 'Bad Key' },
    { ...modelCandidate, type: 'unknown' },
    { ...modelCandidate, text: '' },
    { ...modelCandidate, source_message_id: '' },
    { ...modelCandidate, owner_id: 'model-user' },
    { ...modelCandidate, supersedes_id: 'old' },
    { ...modelCandidate, unknown: 'injected' },
    { ...modelCandidate, condition: '' },
    { ...modelCandidate, valid_from: 'yesterday' },
    { ...modelCandidate, valid_to: '2026-02-30T00:00:00Z' },
    { ...modelCandidate, valid_to: '2026-10-03T24:00:00Z' },
    { ...modelCandidate, type: 'episode' },
    { ...modelCandidate, scope: 'episode' },
    { ...modelCandidate, source_message_id: 'missing' },
  ];
  for (const malformed of bad) {
    const { box, checkpoint } = await fixture(t);
    let captured, payloadWrites = 0, stores = 0;
    const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: { ...box, persistCandidatePayload: async () => { payloadWrites++; throw new Error('unexpected payload'); } },
      store: async () => { stores++; throw new Error('unexpected store'); },
      runCli: async () => { captured = { kind: 'success', candidates: [malformed], no_facts: false };
        return captured; },
    });
    assert.equal(result.kind, 'pending', JSON.stringify(malformed));
    assert.equal((await box.readManifest(checkpoint.operationId)).reason, 'missing_manifest');
    assert.equal(captured.candidates[0], malformed);
    assert.equal(payloadWrites, 0);
    assert.equal(stores, 0);
  }
  for (const field of ['candidate_key', 'source_message_id', 'text', 'type', 'scope']) {
    const missing = { ...modelCandidate };
    delete missing[field];
    assert.equal(validateExtractionOutput({ candidates: [missing], no_facts: false }), false, field);
  }
  assert.equal(validateExtractionOutput({ candidates: [modelCandidate, modelCandidate], no_facts: false }), false);
  assert.equal(validateExtractionOutput({ candidates: [
    { ...modelCandidate, valid_to: '2026-10-03T24:00:00Z' }], no_facts: false }), false);
  assert.equal(validateExtractionOutput({ candidates: [modelCandidate], no_facts: true }), false);
  assert.equal(validateExtractionOutput({ candidates: [modelCandidate], no_facts: false, extra: true }), false);
  assert.equal(validateExtractionOutput({ candidates: Array(6).fill(modelCandidate), no_facts: false }), false);
});

test('two independent facts derive provenance and keep source identity', async t => {
  const { box, checkpoint } = await fixture(t);
  const facts = [
    { candidate_key: 'fable_review', source_message_id: 'm1', text: 'Fable faz só revisão final', type: 'fact', scope: 'project' },
    { candidate_key: 'mira_implement', source_message_id: 'm1', text: 'Mira implementa.', type: 'fact', scope: 'project' },
  ];
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: facts, no_facts: false }),
  });
  assert.equal(result.kind, 'manifested');
  for (const fact of facts) {
    const payload = await box.readCandidatePayload(checkpoint.operationId, fact.candidate_key);
    assert.equal(payload.project_id, 'p');
    assert.equal(payload.session_id, 's');
    assert.equal(payload.actor, 'user');
    assert.equal(payload.origin, 'user_direct');
    assert.equal(payload.evidence_at, source.timestamp);
    assert.deepEqual(payload.source_offsets, { start: 0, end: 80 });
  }
});

test('rule without explicit condition remains eligible; episode requires grounded expiry', async t => {
  const unconditional = { ...source, text: 'Mira implementa.' };
  const { box, checkpoint } = await fixture(t, [unconditional]);
  const rule = { candidate_key: 'mira_rule', source_message_id: 'm1',
    text: unconditional.text, type: 'rule', scope: 'project' };
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [rule], no_facts: false }),
  })).kind, 'manifested');
  const dated = { ...source, text: 'Deploy freeze until 2026-10-03T00:00:00Z.' };
  const episode = { candidate_key: 'freeze', source_message_id: 'm1', text: dated.text,
    type: 'episode', scope: 'episode', valid_to: '2026-10-03T00:00:00Z' };
  const pass = await fixture(t, [dated]);
  assert.equal((await extractCheckpoint(pass.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: pass.box, runCli: async () => ({ kind: 'success', candidates: [episode], no_facts: false }),
  })).kind, 'manifested');
  const fail = await fixture(t, [source]);
  assert.equal((await extractCheckpoint(fail.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: fail.box, runCli: async () => ({ kind: 'success', candidates: [episode], no_facts: false }),
  })).kind, 'pending');
});

test('validity timestamps require exact support in the quoted claim', async t => {
  const dated = { ...source, text: 'Policy applies from 2026-10-03T00:00:00Z.' };
  const supported = { candidate_key: 'policy_start', source_message_id: 'm1', text: dated.text,
    type: 'fact', scope: 'project', valid_from: '2026-10-03T00:00:00Z' };
  const accepted = await fixture(t, [dated]);
  assert.equal((await extractCheckpoint(accepted.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: accepted.box, runCli: async () => ({ kind: 'success', candidates: [supported], no_facts: false }),
  })).kind, 'manifested');
  const invented = await fixture(t, [dated]);
  const result = await extractCheckpoint(invented.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: invented.box, runCli: async () => ({ kind: 'success', candidates: [
      { ...supported, valid_from: '2026-10-04T00:00:00Z' }], no_facts: false }),
  });
  assert.equal(result.reason, 'invalid_metadata');
  assert.equal((await invented.box.readManifest(invented.checkpoint.operationId)).reason, 'missing_manifest');
  const unrelated = { ...source, text: 'Meeting on 2026-10-03T00:00:00Z. Policy applies indefinitely.' };
  const other = await fixture(t, [unrelated]);
  const unrelatedResult = await extractCheckpoint(other.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: other.box, runCli: async () => ({ kind: 'success', candidates: [
      { ...supported, text: unrelated.text }], no_facts: false }),
  });
  assert.equal(unrelatedResult.reason, 'invalid_metadata');
});

test('personal scope uses trusted owner only and no_facts is exclusive', async t => {
  const personal = { candidate_key: 'pref', source_message_id: 'm1', text: source.text,
    type: 'preference', scope: 'personal' };
  const missing = await fixture(t);
  const result = await extractCheckpoint(missing.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: missing.box, runCli: async () => ({ kind: 'success', candidates: [personal], no_facts: false }),
  });
  assert.equal(result.reason, 'missing_scope');
  assert.equal((await missing.box.readManifest(missing.checkpoint.operationId)).reason, 'missing_manifest');
  const blank = await fixture(t, [{ ...source, ownerId: ' ' }]);
  assert.equal((await extractCheckpoint(blank.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: blank.box, runCli: async () => ({ kind: 'success', candidates: [personal], no_facts: false }),
  })).reason, 'missing_scope');
  const owned = await fixture(t, [{ ...source, ownerId: 'trusted-owner' }]);
  assert.equal((await extractCheckpoint(owned.checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: owned.box, runCli: async () => ({ kind: 'success', candidates: [personal], no_facts: false }),
  })).kind, 'manifested');
  assert.equal((await owned.box.readCandidatePayload(owned.checkpoint.operationId, 'pref')).owner_id, 'trusted-owner');
  assert.equal(validateExtractionOutput({ candidates: [personal], no_facts: true }), false);
  assert.equal(validateExtractionOutput({ candidates: [], no_facts: false }), false);
  assert.equal(validateExtractionOutput({ candidates: [], no_facts: true }), true);
});

test('CLI keeps available cache-token categories and derives the outbox input total', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-cli-usage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\n` +
    `const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);\n` +
    `if (!schema.properties.candidates.items.properties.scope.enum.includes('episode') ||\n` +
    `    'owner_id' in schema.properties.candidates.items.properties) process.exit(18);\n` +
    `let prompt=''; process.stdin.on('data', chunk => prompt+=chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({\n` +
    `subtype:'success', is_error:false, structured_output:{candidates:[],no_facts:true},\n` +
    `modelUsage:{sonnet:{canonicalModel:'claude-sonnet-5-5'}},\n` +
    `usage:prompt==='uncached-only' ? {input_tokens:2,output_tokens:3} :\n` +
    `{input_tokens:2,cache_read_input_tokens:7,cache_creation_input_tokens:11,output_tokens:3},\n` +
    `total_cost_usd:0.01})));`;
  await fs.writeFile(path.join(dir, 'claude'), script, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldProfile = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.CLAUDE_CONFIG_DIR = profile;
    const result = await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' });
    assert.equal(result.kind, 'success');
    assert.deepEqual(result.usage, { inputTokens: 20, inputUncachedTokens: 2,
      inputCacheReadTokens: 7, inputCacheCreationTokens: 11, outputTokens: 3, costUsd: 0.01 });
    const { box, checkpoint } = await fixture(t);
    const extraction = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
      outbox: box, runCli: async () => result,
    });
    assert.equal(extraction.kind, 'processed');
    assert.deepEqual(await box.extractionUsage('claude', 's'),
      { calls: 1, inputTokens: 20, outputTokens: 3, costUsd: 0.01 });
    const partial = await runSonnetExtraction('uncached-only', { route: 'sonnet', account: 'claude2' });
    assert.deepEqual(partial.usage, { inputTokens: 2, inputUncachedTokens: 2,
      inputCacheReadTokens: null, inputCacheCreationTokens: null, outputTokens: 3, costUsd: 0.01 });
  } finally {
    process.env.PATH = oldPath;
    if (oldProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldProfile;
  }
});

test('CLI requires an explicit trusted local profile and ignores a model or policy path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-cli-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'claude'), `#!${process.execPath}\n` +
    `if (process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(profile)}) process.exit(18);\n` +
    `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({\n` +
    `subtype:'success',is_error:false,structured_output:{candidates:[],no_facts:true},\n` +
    `modelUsage:{sonnet:{canonicalModel:'claude-sonnet-5-5'}}})));`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldProfile = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.deepEqual(await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2',
      profileDir: profile }), { kind: 'error', reason: 'cli_profile_unselected' });
    process.env.CLAUDE_CONFIG_DIR = process.cwd();
    assert.deepEqual(await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' }),
      { kind: 'error', reason: 'cli_profile_untrusted' });
    process.env.CLAUDE_CONFIG_DIR = profile;
    assert.equal((await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' })).kind, 'success');
    assert.equal((await runSonnetExtraction('{}', { route: 'sonnet', account: 'other-local-profile' })).kind, 'success');
  } finally {
    process.env.PATH = oldPath;
    if (oldProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldProfile;
  }
});
