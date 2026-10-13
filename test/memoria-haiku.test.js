import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { extractCheckpoint, approveCandidate, validateCandidate } from '../base/memoria/candidates.mjs';
import { validateHaikuOutput } from '../base/memoria/extract-contract.mjs';
import { spawn } from 'node:child_process';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { externalIdFor } from '../base/memoria/ledger.mjs';
import { runHaikuExtraction } from '../base/memoria/extract-cli.mjs';
import { configureExtractor, readExtractor } from '../base/memoria/policy.mjs';

const message = { origin: 'human', actor: 'user', speakerRole: 'user',
  text: 'Reutilize o orquestrador atual para a revisão.', messageId: 'm1',
  timestamp: '2026-10-13T10:00:00Z', start: 0, end: 48 };
const decision = { source_message_id: 'm1', abstain_reason: '', candidates: [
  { text: 'O usuário pediu para reutilizar o orquestrador atual na revisão.',
    type: 'rule', scope: 'project' } ] };

async function fixture(t, messages = [message]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-haiku-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  await fs.mkdir(state, { mode: 0o700 });
  const outbox = createOutbox(state);
  const row = { cli: 'claude', sessionId: 's', start: 0, end: 48,
    sliceHash: 'a'.repeat(64), messages };
  const queued = await outbox.enqueueCheckpoint(row, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(queued.kind, 'queued');
  return { state, outbox, checkpoint: { ...row, projectId: 'p', policyVersion: 'native-v1',
    operationId: queued.operationId } };
}

test('Haiku requires one decision per local message and enforces the global cap', () => {
  assert.equal(validateHaikuOutput({ decisions: [decision] }, ['m1']), true);
  assert.equal(validateHaikuOutput({ decisions: [] }, ['m1']), false);
  assert.equal(validateHaikuOutput({ decisions: [decision, decision] }, ['m1']), false);
  assert.equal(validateHaikuOutput({ decisions: [{ ...decision, source_message_id: 'invented' }] }, ['m1']), false);
  assert.equal(validateHaikuOutput({ decisions: [{ ...decision, candidates: [], abstain_reason: 'no durable fact' }] }, ['m1']), true);
  assert.equal(validateHaikuOutput({ decisions: [{ ...decision, candidates: [] }] }, ['m1']), false);
  assert.equal(validateHaikuOutput({ decisions: [{ ...decision, candidates: Array(6).fill(decision.candidates[0]) }] }, ['m1']), false);
});

test('explicit Haiku policy is frozen and CLI enforces isolated model and schema', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-haiku-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(profile, { mode: 0o700 });
  const executable = path.join(root, 'claude');
  await fs.writeFile(executable, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2); const schema=JSON.parse(a[a.indexOf('--json-schema')+1]);\n` +
    `if (!a.includes('--safe-mode') || a[a.indexOf('--tools')+1]!=='' ||\n` +
    `a[a.indexOf('--model')+1]!=='claude-haiku-5-5' ||\n` +
    `!schema.properties.decisions || process.env.OPENAI_API_KEY) process.exit(9);\n` +
    `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({\n` +
    `subtype:'success',structured_output:{decisions:[{source_message_id:'m1',candidates:[],abstain_reason:'no fact'}]},\n` +
    `modelUsage:{haiku:{canonicalModel:'claude-haiku-5-5'}},usage:{input_tokens:2,output_tokens:3}})));`,
  { mode: 0o700 });
  const resolution = { projectId: 'p', destination: { url: 'https://example.invalid', collection: 'p' },
    embeddingFingerprint: 'fixture', stateDir };
  assert.equal((await configureExtractor(resolution, { route: 'haiku', profile, executable })).kind, 'selected');
  assert.equal((await readExtractor(resolution)).route, 'haiku');
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-secret';
  try {
    const result = await runHaikuExtraction('{}', { route: 'haiku', profile, executable });
    assert.equal(result.kind, 'success');
    assert.equal(result.model, 'claude-haiku-5-5');
    assert.equal(result.decisions[0].abstain_reason, 'no fact');
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});

test('Haiku abstention is explicit and an invented nested secret leaves no manifest', async t => {
  const { outbox, checkpoint } = await fixture(t);
  const abstained = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [
      { source_message_id: 'm1', candidates: [], abstain_reason: 'no durable claim' } ] }) });
  assert.equal(abstained.kind, 'processed');
  const next = await fixture(t);
  const secret = ['sk', 'synthetic12345678901234567890'].join('-');
  const poisoned = await extractCheckpoint(next.checkpoint, { route: 'haiku' }, { outbox: next.outbox,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [
      { ...decision, candidates: [{ ...decision.candidates[0], nested: [secret] }] } ] }) });
  assert.equal(poisoned.reason, 'sensitive_content');
  assert.equal((await next.outbox.readManifest(next.checkpoint.operationId)).reason, 'missing_manifest');
});

test('terminal review seals normalized claim and replay binds remote source to approved text', async t => {
  const { state, outbox, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [decision] }) })).kind,
  'manifested');
  const entry = (await outbox.readManifest(checkpoint.operationId)).candidates[0];
  const runner = path.join(state, 'review-runner.mjs');
  await fs.writeFile(runner, `import { createOutbox } from ${JSON.stringify(new URL('../base/memoria/outbox.mjs', import.meta.url).href)};\n` +
    `import { reviewCandidateOnTerminal } from ${JSON.stringify(new URL('../base/memoria/candidates.mjs', import.meta.url).href)};\n` +
    `const box = createOutbox(${JSON.stringify(state)});\n` +
    `const result = await reviewCandidateOnTerminal(${JSON.stringify(checkpoint.operationId)}, ${JSON.stringify(entry.candidateKey)}, { outbox: box, store: async op => {\n` +
    `  const source = await box.sourceForRemote({ externalId: op.externalId, projectId: op.projectId, sessionId: op.sessionId, text: op.text, metadata: op.metadata });\n` +
    `  if (source.kind !== 'local_source') return source;\n` +
    `  return box.ackCandidate(${JSON.stringify(checkpoint.operationId)}, ${JSON.stringify(entry.candidateKey)}, { externalId: op.externalId, projectId: op.projectId, status: 'active', sdkId: 'uuid-1', qdrantId: 'uuid-1' });\n` +
    `} });\nconsole.log('RESULT=' + JSON.stringify(result));\n`);
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', `${process.execPath} ${runner}`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let step = 0;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (step === 0 && output.includes('Action (accept/reject/duplicate/edit/correct): ')) {
      step++; child.stdin.write('accept\n');
    } else if (step === 1 && output.includes('Confirm accept for ')) {
      step++; child.stdin.write('yes\n');
    } else if (step === 2 && output.includes('Confirm complete claim, metadata and source (yes): ')) {
      step++; child.stdin.write('yes\n');
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /RESULT=\{"kind":"processed"/);
  assert.ok(output.includes(message.text));
  assert.ok(output.includes(decision.candidates[0].text));
  const receipt = await outbox.readDisposition(checkpoint.operationId);
  const review = JSON.parse(await fs.readFile(path.join(state, 'candidates', 'reviews',
    `${receipt.candidates[0].externalId}.json`), 'utf8'));
  assert.equal(review.review.operation.metadata.format_version, 2);
  const op = review.review.operation;
  const variants = [
    { ...op, text: `${op.text} alterado` },
    { ...op, metadata: { ...op.metadata, source: 'other-message' } },
    { ...op, metadata: { ...op.metadata, type: 'fact' } },
    { ...op, metadata: { ...op.metadata, scope: 'personal' } },
    { ...op, metadata: { ...op.metadata, source_text_sha256: '0'.repeat(64) } },
    { ...op, metadata: { ...op.metadata, claim_sha256: '0'.repeat(64) } },
    { ...op, sourceIdentity: { ...op.sourceIdentity, candidateKey: 'other_candidate' } },
  ];
  for (const forged of variants) {
    const result = await storeMemory(process.cwd(), 's', forged, () => '', {
      resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: state }),
      authorize: async () => { throw Error('destination reached'); },
    });
    assert.equal(result.kind, 'blocked');
    assert.ok(['source_review_unproved', 'invalid_store', 'source_identity_mismatch'].includes(result.reason));
  }
});

test('Haiku prompt is project generic and an invalid decision stays pending', async t => {
  const { outbox, checkpoint } = await fixture(t);
  let prompt;
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async input => { prompt = input; return { kind: 'success', model: 'claude-haiku-5-5', decisions: [] }; } });
  assert.equal(result.kind, 'pending');
  assert.equal((await outbox.readManifest(checkpoint.operationId)).reason, 'missing_manifest');
  assert.ok(prompt.includes('Reutilize o orquestrador'));
  assert.doesNotMatch(prompt, /CBS|Mem0|AMD|NVIDIA|Windows|Linux/);
});

test('Haiku omits blank messages from prompt and accepts decisions for the remaining IDs', async t => {
  const blank = { ...message, messageId: 'blank', text: '  \n  ' };
  const { outbox, checkpoint } = await fixture(t, [blank, message]);
  let supplied;
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async prompt => {
      supplied = JSON.parse(prompt).messages;
      return { kind: 'success', model: 'claude-haiku-5-5', decisions: [decision] };
    } });
  assert.deepEqual(supplied.map(item => item.message_id), ['m1']);
  assert.equal(result.kind, 'manifested');
  assert.equal((await outbox.readManifest(checkpoint.operationId)).candidates.length, 1);
});

test('Haiku rejects decisions for blank or unknown source IDs', async t => {
  const blank = { ...message, messageId: 'blank', text: '' };
  for (const sourceId of ['blank', 'invented']) {
    const { outbox, checkpoint } = await fixture(t, [blank, message]);
    const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
      runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [
        { ...decision, source_message_id: sourceId } ] }) });
    assert.equal(result.reason, 'extractor_schema_invalid');
    assert.equal((await outbox.readManifest(checkpoint.operationId)).reason, 'missing_manifest');
  }
});

test('Haiku completes an all-blank checkpoint without a model call', async t => {
  const blank = { ...message, text: ' \n ' };
  const { outbox, checkpoint } = await fixture(t, [blank]);
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => { throw Error('blank source reached model'); } });
  assert.equal(result.kind, 'processed');
  assert.equal((await outbox.readDisposition(checkpoint.operationId)).disposition, 'no_facts');
});

test('Haiku does not treat missing source text as a no-facts checkpoint', async t => {
  const invalid = { ...message, text: undefined };
  const { outbox, checkpoint } = await fixture(t, [invalid]);
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => { throw Error('invalid source reached model'); } });
  assert.equal(result.reason, 'no_eligible_source');
  assert.equal((await outbox.readManifest(checkpoint.operationId)).reason, 'missing_manifest');
});

test('assistant and tool claims stay attributed reports', async t => {
  const assistant = { ...message, messageId: 'a1', origin: 'assistant', actor: 'assistant',
    speakerRole: 'assistant', text: 'Integrei o validador.' };
  const tool = { ...message, messageId: 't1', origin: 'tool', actor: 'tool:build',
    speakerRole: 'tool', text: 'Build concluído.' };
  const { outbox, checkpoint } = await fixture(t, [assistant, tool]);
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [
      { source_message_id: 'a1', abstain_reason: '', candidates: [
        { text: 'O validador foi integrado.', type: 'fact', scope: 'project' } ] },
      { source_message_id: 't1', abstain_reason: '', candidates: [
        { text: 'O build foi concluído.', type: 'fact', scope: 'project' } ] },
    ] }) });
  assert.equal(result.kind, 'manifested');
  const entries = (await outbox.readManifest(checkpoint.operationId)).candidates;
  const payloads = await Promise.all(entries.map(item =>
    outbox.readCandidatePayload(checkpoint.operationId, item.candidateKey)));
  assert.deepEqual(payloads.map(item => item.origin), ['assistant_report', 'tool_observation']);
  assert.deepEqual(payloads.map(item => item.type), ['report', 'report']);
  assert.match(payloads[0].text, /^O assistente relatou:/);
  assert.match(payloads[1].text, /^A ferramenta observou:/);
});

test('normalized Haiku claim remains draft and rejects source or claim tampering', async t => {
  const { outbox, checkpoint } = await fixture(t);
  const result = await extractCheckpoint(checkpoint, { route: 'haiku' }, { outbox,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5', decisions: [decision] }) });
  assert.equal(result.kind, 'manifested');
  const entry = (await outbox.readManifest(checkpoint.operationId)).candidates[0];
  const payload = await outbox.readCandidatePayload(checkpoint.operationId, entry.candidateKey);
  assert.equal(payload.format_version, 2);
  assert.equal(validateCandidate(payload, message).eligible, true);
  assert.equal(validateCandidate({ ...payload, text: 'O código já reutiliza o orquestrador.' }, message).eligible, false);
  assert.equal(validateCandidate({ ...payload, type: 'fact' }, message).eligible, false);
  assert.equal(validateCandidate({ ...payload, source_text_sha256: '0'.repeat(64) }, message).eligible, false);
  assert.equal((await approveCandidate(checkpoint.operationId, entry.candidateKey,
    { outbox, reviewGrant: { decision: 'approve', payloadSha256: entry.payloadRef.sha256 },
      store: () => { throw Error('published'); } })).reason, 'owner_approval_required');
  assert.equal((await outbox.sealReview(checkpoint.operationId, entry.candidateKey,
    { decision: 'approve', actor: 'caller', reviewedAt: new Date().toISOString(),
      payloadSha256: entry.payloadRef.sha256, operation: { approval: { kind: 'approved' } } })).kind, 'blocked');
});

test('store rejects a forged v2 approval before destination access', async t => {
  const { state, checkpoint } = await fixture(t);
  const sourceIdentity = { projectId: 'p', originCli: 'claude',
      sessionId: 's', start: 0, end: 48, sliceHash: 'a'.repeat(64),
      policyVersion: 'native-v1', candidateKey: 'm_test' };
  const operation = { externalId: externalIdFor(sourceIdentity), projectId: 'p', sessionId: 's',
    text: decision.candidates[0].text, sourceIdentity,
    metadata: { source: 'm1', checkpoint_id: checkpoint.operationId,
      source_offsets: { start: 0, end: 48 }, actor: 'user', origin: 'user_direct',
      scope: 'project', evidence_at: message.timestamp, format_version: 2,
      source_text_sha256: 'a'.repeat(64), claim_sha256: 'b'.repeat(64) },
    approval: { kind: 'approved' } };
  const result = await storeMemory(process.cwd(), 's', operation, () => '', {
    resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: state }),
    authorize: async () => { throw Error('destination reached'); },
  });
  assert.equal(result.reason, 'source_review_unproved');
});
