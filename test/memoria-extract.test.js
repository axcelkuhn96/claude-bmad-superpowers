import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { validateCandidate, extractCheckpoint, approveCandidate, rejectCandidate,
  markDuplicateCandidate } from '../base/memoria/candidates.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { runSonnetExtraction } from '../base/memoria/extract-cli.mjs';

const source = { origin: 'human', actor: 'user', speakerRole: 'user', text: 'Fable faz só revisão final; Mira implementa.',
  messageId: 'm1', timestamp: '2024-02-03T10:00:00Z', start: 0, end: 80, sessionId: 's', cli: 'claude' };
const candidate = { candidate_key: 'fable_review', project_id: 'p', text: 'Fable faz só revisão final; Mira implementa.',
  type: 'rule', actor: 'user', speaker_role: 'user', origin: 'user_direct',
  evidence_at: source.timestamp, scope: 'project', source_message_id: 'm1',
  source_offsets: { start: 0, end: 80 }, status: 'candidate', condition: 'revisão final' };
const slice = { cli: 'claude', sessionId: 's', start: 0, end: 80, sliceHash: 'a'.repeat(64), messages: [source] };

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
    speaker_role: 'assistant', origin: 'assistant_report', type: 'report' }, assistant).eligible, true);
});

test('historical evidence and condition are required, transient episodes stay inactive', () => {
  assert.equal(validateCandidate(candidate, source).eligible, true);
  assert.ok(validateCandidate({ ...candidate, evidence_at: '2026-10-01T00:00:00Z' }, source).reasons.includes('evidence_date_mismatch'));
  assert.ok(validateCandidate({ ...candidate, condition: '' }, source).reasons.includes('unsupported_claim'));
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
    outbox: box, runCli: async input => { prompt = input; return { kind: 'success', candidates: [
      { ...candidate, text: aws },
    ] }; },
  });
  assert.equal(prompt.includes(aws), false);
  assert.equal(prompt.includes(jwt), false);
  assert.equal(result.reason, 'sensitive_content');
  assert.equal((await box.readManifest(checkpoint.operationId)).kind, 'blocked');
});

test('two complementary facts persist separate payloads and reload after restart', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  const second = { ...candidate, candidate_key: 'mira_implement', text: 'Mira implementa.' };
  const result = await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate, second], usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01 } }),
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
      outbox: createOutbox(dir), runCli: async () => ({ kind: 'success', candidates: [] }),
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
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
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
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
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
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
  })).kind, 'manifested');
  const manifest = await box.readManifest(checkpoint.operationId);
  const child = manifest.candidates[0];
  let operation;
  const result = await approveCandidate(checkpoint.operationId, child.candidateKey, {
    outbox: box, review: async item => ({ decision: 'approve', payloadSha256: child.payloadRef.sha256,
      text: item.text }),
    store: async op => { operation = op; return box.ackCandidate(checkpoint.operationId, child.candidateKey,
      { externalId: op.externalId, projectId: 'p', status: 'active', sdkId: 'uuid-1', qdrantId: 'uuid-1' }); },
  });
  assert.equal(result.kind, 'processed');
  assert.equal(operation.text, candidate.text);
  assert.equal(operation.externalId, child.externalId);
  assert.equal(operation.approval.kind, 'approved');
  const audit = JSON.parse(await fs.readFile(path.join(dir, 'candidates', 'reviews', `${child.externalId}.json`)));
  assert.equal(audit.review.actor, 'local_owner');
  assert.ok(Number.isFinite(Date.parse(audit.review.reviewedAt)));
  assert.equal(audit.review.operation.text, candidate.text);
  assert.equal((await createOutbox(dir).cursor('claude', 's')).processedEnd, 80);
});

test('review directory symlink blocks approval before reading a planted decision', async t => {
  const { dir, box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
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
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
  })).kind, 'manifested');
  const result = await rejectCandidate(checkpoint.operationId, 'fable_review', 'unsupported_claim', {
    outbox: box, review: async (_item, sha) => ({ decision: 'reject', payloadSha256: sha }),
  });
  assert.equal(result.kind, 'processed');
  assert.equal((await box.readDisposition(checkpoint.operationId)).candidates[0].status, 'rejected');
});

test('duplicate disposition requires verified active reference and keeps separate source identity', async t => {
  const { box, checkpoint } = await fixture(t);
  assert.equal((await extractCheckpoint(checkpoint, { route: 'sonnet', account: 'claude2' }, {
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
  })).kind, 'manifested');
  const duplicate = { outbox: box, review: async (_item, sha) => ({ decision: 'duplicate', payloadSha256: sha }),
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
    outbox: box, runCli: async () => ({ kind: 'success', candidates: [candidate] }),
  })).kind, 'manifested');
  const child = (await box.readManifest(checkpoint.operationId)).candidates[0];
  const remote = [];
  let adds = 0;
  let ackFails = true;
  let reviews = 0;
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
  const options = { outbox: box, review: async () => { reviews++; return { decision: 'approve',
    payloadSha256: child.payloadRef.sha256 }; },
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
  assert.equal(reviews, 1);
});

test('CLI route excludes inherited API secrets and rejects an unexpected model', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-cli-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
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
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.CBS_MEMORIA_API_KEY = 'fixture-secret';
    process.env.OPENAI_API_KEY = 'fixture-secret';
    assert.deepEqual(await runSonnetExtraction('{}', { route: 'sonnet', account: 'claude2' }),
      { kind: 'error', reason: 'cli_model_mismatch' });
  } finally {
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.CBS_MEMORIA_API_KEY;
    else process.env.CBS_MEMORIA_API_KEY = oldKey;
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAI;
  }
});
