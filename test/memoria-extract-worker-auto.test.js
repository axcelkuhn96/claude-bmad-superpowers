import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as worker from '../base/memoria/extract-worker.mjs';
import { inspectConfiguration, initializeSession, resolveProject,
  refreshSessionPolicyForCapture } from '../base/memoria/provider.mjs';
import { registerOwner, configureExtractor, enableAutoPublish, localDevice,
  readAutoPublish, disableAutoPublish, configureExtractionSchedule } from '../base/memoria/policy.mjs';
import { registerExtractionReplay } from '../base/memoria/policy.mjs';
import { publishCheckpointAutomatically } from '../base/memoria/auto-publish.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { recordSessionCheckout } from '../base/memoria/session-checkout.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { POLICY_VERSION } from '../base/memoria/transcript.mjs';
import { captureEvent } from '../base/memoria/checkpoint.mjs';

test('detached consumer retries a transient publish until it succeeds without a new hook', async () => {
  let clock = 1000;
  let calls = 0;
  const waits = [];
  const result = await worker.runScheduledConsumer({
    consume: async () => ++calls === 1
      ? { kind: 'consumed', manifested: 1, pending: 1, nextRetryAt: 2000 }
      : { kind: 'consumed', manifested: 1, pending: 0 },
    now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(result, { kind: 'consumed', manifested: 1, pending: 0 });
});

test('detached consumer stops on revoked scope and does not spin after its deadline', async () => {
  let clock = 1000;
  let calls = 0;
  const result = await worker.runScheduledConsumer({
    consume: async () => ++calls === 1
      ? { kind: 'consumed', manifested: 0, pending: 1, nextRetryAt: 3000 }
      : { kind: 'blocked', reason: 'trust_changed' },
    now: () => clock,
    wait: async ms => { clock += ms; },
    maxDurationMs: 3000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { kind: 'blocked', reason: 'trust_changed' });

  calls = 0;
  clock = 1000;
  await worker.runScheduledConsumer({
    consume: async () => { calls++; return { kind: 'consumed', nextRetryAt: 5000 }; },
    now: () => clock,
    wait: async ms => { clock += ms; },
    maxDurationMs: 2000,
  });
  assert.equal(calls, 1);
});

test('stale retry timestamp cannot create an empty busy loop', async () => {
  let clock = 1000;
  const waits = [];
  let calls = 0;
  await worker.runScheduledConsumer({
    consume: async () => ++calls === 1
      ? { kind: 'consumed', nextRetryAt: 1000 }
      : { kind: 'consumed' },
    now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.deepEqual(waits, [1000]);
});

test('detached retry releases owner lock while waiting so a new batch can run', async t => {
  const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-retry-owner-'));
  t.after(() => fs.rm(ownerRoot, { recursive: true, force: true }));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let waiting;
  const entered = new Promise(resolve => { waiting = resolve; });
  let firstCalls = 0;
  const first = worker.runExclusiveConsumer({ ownerRoot,
    consume: async () => ++firstCalls === 1
      ? { kind: 'consumed', nextRetryAt: 2000 } : { kind: 'consumed' },
    now: () => 1000,
    wait: async () => { waiting(); await held; },
  });
  await entered;
  let duplicateCalls = 0;
  try {
    const duplicate = await worker.runExclusiveConsumer({ ownerRoot,
      consume: async () => { duplicateCalls++; return { kind: 'consumed' }; },
      lockTimeoutMs: 150,
    });
    assert.deepEqual(duplicate, { kind: 'consumed' });
    assert.equal(duplicateCalls, 1);
  } finally {
    release();
    await first;
  }
});

test('transient publication failure persists an automatic retry; permanent rejection does not', async () => {
  const marked = [];
  const outbox = { markFailed: async (...args) => {
    marked.push(args);
    return { kind: 'pending', retryAt: 2500, attempts: 1 };
  } };
  const row = { operationId: 'operation-1' };
  const resolution = { extractor: { autoPublish: true, autoPublishConsent: { consentHash: 'consent' } } };
  let publishedFrom;
  const retry = await worker.publishManifestIfEnabled(row, resolution, { outbox, cwd: '/worktree',
    publishCheckpoint: async (_row, _resolution, options) => {
      publishedFrom = options.cwd;
      return { kind: 'retry', reason: 'transport_unavailable' };
    } });
  assert.deepEqual(retry, { kind: 'retry', nextRetryAt: 2500 });
  assert.equal(publishedFrom, '/worktree');
  assert.deepEqual(marked, [['operation-1', 'transport_unavailable', { automatic: true }]]);

  const blocked = await worker.publishManifestIfEnabled(row, resolution, { outbox,
    publishCheckpoint: async () => ({ kind: 'blocked', reason: 'consent_revoked' }) });
  assert.deepEqual(blocked, { kind: 'blocked', reason: 'consent_revoked' });
  assert.equal(marked.length, 1);
  assert.equal(await worker.publishManifestIfEnabled(row, { extractor: { autoPublish: false } }, {
    outbox, publishCheckpoint: async () => { throw new Error('unexpected publication'); },
  }), null);
});

async function automaticConsumerFixture(t, { startUnowned = false,
  startWithOwnerBeforeConsent = false, originProfileDistinct = false, seedRow = true,
  cli = 'claude', maxCallsPerSession } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-consumer-auto-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  const profile = path.join(home, 'profile');
  const originProfile = originProfileDistinct ? path.join(home, 'origin-profile') : profile;
  const stateRoot = path.join(home, 'state');
  await fs.mkdir(path.join(project, '.cbs'), { recursive: true });
  await fs.mkdir(profile, { mode: 0o700 });
  if (originProfileDistinct) await fs.mkdir(originProfile, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
  await fs.writeFile(path.join(project, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'fixture-project',
    qdrant: { url: 'https://qdrant.internal', collection: 'fixture-memory', api_key_env: 'CBS_AUTO_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const resolution = await inspectConfiguration(project, { stateRoot });
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  if (startUnowned) {
    const old = await initializeSession(project, 's', { event: 'SessionStart', stateRoot,
      cli, profile });
    assert.equal(old.ownerId, null);
  }
  assert.equal((await configureExtractor(resolution, { route: 'haiku', profile,
    executable: process.execPath })).kind, 'selected');
  if (maxCallsPerSession !== undefined) assert.equal((await configureExtractionSchedule(resolution,
    { maxCallsPerSession, mode: 'conversation', conversationTurns: 5 })).kind, 'configured');
  assert.equal((await registerOwner(resolution, cli, profile, 'fixture-owner', true)).kind, 'registered');
  if (originProfileDistinct) {
    assert.equal((await registerOwner(resolution, cli, originProfile,
      'fixture-owner', true)).kind, 'registered');
  }
  if (startWithOwnerBeforeConsent) {
    const old = await initializeSession(project, 's', { event: 'SessionStart', stateRoot,
      cli, profile });
    assert.equal(old.ownerId, 'fixture-owner');
    assert.equal(old.extractor.autoPublish, false);
  }
  const device = await localDevice(resolution.stateDir);
  const ledger = path.join(resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: resolution.projectId, collection: resolution.destination.collection,
    deviceId: device.deviceId, generation: 1,
  }), { mode: 0o600 });
  assert.equal((await enableAutoPublish(resolution, { ownerId: 'fixture-owner',
    cli, profile })).kind, 'enabled');
  assert.equal((await applyNativeExclusion(project, { cli, stateRoot,
    installedPlugin: true })).kind, 'applied');
  const session = await initializeSession(project, 's', { event: 'SessionStart', stateRoot,
    cli, profile: originProfile });
  assert.equal(session.extractor?.autoPublish ?? false,
    !startUnowned && !startWithOwnerBeforeConsent);
  assert.equal((await recordSessionCheckout(session, cli, 's', project,
    originProfile)).kind, 'bound');
  const box = createOutbox(resolution.stateDir);
  if (!startUnowned && !startWithOwnerBeforeConsent) {
    assert.equal((await box.ensureFutureBaseline({ cli, sessionId: 's',
      projectId: resolution.projectId, ownerId: 'fixture-owner',
      consentHash: session.extractor.autoPublishConsent.consentHash,
      policyVersion: POLICY_VERSION, cutoffEnd: 0 })).kind, 'baselined');
  }
  if (seedRow) assert.equal((await box.enqueueCheckpoint({ cli, sessionId: 's', start: 0, end: 32,
    sliceHash: 'a'.repeat(64), messages: [{ messageId: 'm1', role: 'user', speakerRole: 'user',
      actor: 'fixture-owner', origin: 'human',
      ...(startUnowned ? {} : { ownerId: 'fixture-owner' }),
      text: 'A release checklist is required.',
      timestamp: '2026-10-01T00:00:00Z', start: 0, end: 32 }] },
  { projectId: 'fixture-project', policyVersion: POLICY_VERSION })).kind, 'queued');
  return { project, profile, originProfile, stateRoot, box, resolution };
}

test('five completed Claude exchanges stage without Haiku until fifth Stop', async t => {
  const { project, profile, stateRoot, box } = await automaticConsumerFixture(t,
    { seedRow: false });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior; });
  const transcriptPath = path.join(project, 's.jsonl');
  await fs.writeFile(transcriptPath, '');
  const payload = { cwd: project, session_id: 's', transcript_path: transcriptPath };
  assert.equal((await captureEvent({ cli: 'claude', event: 'SessionStart',
    payload: { ...payload, hook_event_name: 'SessionStart' }, stateRoot })).kind,
  'no_complete_bytes');
  let calls = 0;
  const consume = () => worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => {
      calls++; return { kind: 'error', reason: 'cli_unavailable' };
    } });
  for (let n = 1; n <= 5; n++) {
    await fs.appendFile(transcriptPath, JSON.stringify({ type: 'user', uuid: `u${n}`,
      timestamp: `2026-10-14T13:0${n}:00Z`, sessionId: 's', isSidechain: false,
      userType: 'external', message: { role: 'user', content: `Pedido ${n}` } }) + '\n');
    assert.equal((await captureEvent({ cli: 'claude', event: 'UserPromptSubmit',
      payload: { ...payload, hook_event_name: 'UserPromptSubmit' }, stateRoot })).kind, 'staged');
    await fs.appendFile(transcriptPath, JSON.stringify({ type: 'assistant', uuid: `a${n}`,
      timestamp: `2026-10-14T13:0${n}:01Z`, sessionId: 's', isSidechain: false,
      message: { role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: `Resposta ${n}` }] } }) + '\n');
    const stopped = await captureEvent({ cli: 'claude', event: 'Stop',
      payload: { ...payload, hook_event_name: 'Stop' }, stateRoot });
    assert.equal(stopped.kind, n < 5 ? 'staged' : 'queued');
    if (n < 5) assert.equal((await box.pending()).length, 0);
    await consume();
    assert.equal(calls, n < 5 ? 0 : 1);
  }
  const [batch] = await box.pending();
  assert.equal(batch.conversationBatch, true);
  assert.equal(batch.conversationPairs, 5);
});

test('Codex Interrupt with null transcript flushes only a staged, baselined exchange', async t => {
  const { project, profile, stateRoot, resolution, box } = await automaticConsumerFixture(t,
    { cli: 'codex', seedRow: false });
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profile;
  t.after(() => { if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior; });
  const transcriptPath = path.join(project, 'rollout-s.jsonl');
  await fs.writeFile(transcriptPath, '');
  const payload = { cwd: project, session_id: 's', transcript_path: transcriptPath };
  assert.equal((await captureEvent({ cli: 'codex', event: 'SessionStart',
    payload: { ...payload, hook_event_name: 'SessionStart' }, stateRoot,
    installedPlugin: true })).kind, 'no_complete_bytes');
  const lines = [
    { type: 'session_meta', payload: { source: 'exec', thread_source: 'user',
      session_id: 's', id: 's' } },
    { type: 'response_item', timestamp: '2026-10-14T13:00:00Z', payload: {
      type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Preserve a regra.' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
    { type: 'response_item', timestamp: '2026-10-14T13:00:01Z', payload: {
      type: 'message', id: 'a1', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'A regra foi preservada.' }] } },
  ];
  await fs.appendFile(transcriptPath, lines.map(line => JSON.stringify(line) + '\n').join(''));
  assert.equal((await captureEvent({ cli: 'codex', event: 'Stop',
    payload: { ...payload, hook_event_name: 'Stop' }, stateRoot,
    installedPlugin: true })).kind, 'staged');
  const baselineName = (await fs.readdir(path.join(resolution.stateDir, 'outbox')))
    .find(name => name.startsWith('baseline-'));
  assert.ok(baselineName);
  const baselinePath = path.join(resolution.stateDir, 'outbox', baselineName);
  const baselineBytes = await fs.readFile(baselinePath);
  await fs.rm(baselinePath);
  const interrupted = { cwd: project, session_id: 's', transcript_path: null,
    hook_event_name: 'Interrupt' };
  assert.equal((await captureEvent({ cli: 'codex', event: 'Interrupt',
    payload: interrupted, stateRoot, installedPlugin: true })).reason,
  'future_baseline_unavailable');
  assert.equal((await box.pending()).length, 0);
  await fs.writeFile(baselinePath, baselineBytes, { mode: 0o600 });
  const flushed = await captureEvent({ cli: 'codex', event: 'Interrupt',
    payload: interrupted, stateRoot, installedPlugin: true });
  assert.equal(flushed.kind, 'queued');
  assert.equal((await box.pending())[0].conversationPairs, 1);
});

test('new SessionStart consumer recovers a completed exchange from an abruptly closed session', async t => {
  const { project, profile, stateRoot, box } = await automaticConsumerFixture(t,
    { seedRow: false });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior; });
  const previousTranscript = path.join(project, 's.jsonl');
  const lines = [
    { type: 'user', uuid: 'old-u', timestamp: '2026-10-14T13:00:00Z',
      sessionId: 's', isSidechain: false, userType: 'external',
      message: { role: 'user', content: 'Manter a regra antiga.' } },
    { type: 'assistant', uuid: 'old-a', timestamp: '2026-10-14T13:00:01Z',
      sessionId: 's', isSidechain: false, message: { role: 'assistant',
        stop_reason: 'end_turn', content: [{ type: 'text', text: 'Regra mantida.' }] } },
  ];
  await fs.writeFile(previousTranscript, lines.map(line => JSON.stringify(line) + '\n').join(''));
  assert.equal((await captureEvent({ cli: 'claude', event: 'Stop', payload: {
    cwd: project, session_id: 's', transcript_path: previousTranscript,
    hook_event_name: 'Stop' }, stateRoot })).kind, 'staged');
  assert.equal((await box.pending()).length, 0);
  const nextTranscript = path.join(project, 'new.jsonl');
  await fs.writeFile(nextTranscript, '');
  assert.equal((await captureEvent({ cli: 'claude', event: 'SessionStart', payload: {
    cwd: project, session_id: 'new', transcript_path: nextTranscript,
    hook_event_name: 'SessionStart' }, stateRoot })).kind, 'no_complete_bytes');
  let calls = 0;
  const fresh = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 'new', stateRoot, runCli: async () => {
      calls++; return { kind: 'error', reason: 'cli_unavailable' };
    } });
  assert.equal(calls, 0);
  assert.equal(fresh.nextRetryAt, undefined);
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 'new', stateRoot,
    now: () => Date.now() + 31 * 60 * 1000,
    runCli: async () => { calls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(calls, 1);
  const [batch] = await box.pending();
  assert.equal(batch.sessionId, 's');
  assert.equal(batch.conversationPairs, 1);
});

test('abandoned conversation cannot recover after consent revocation', async t => {
  const { project, profile, stateRoot, resolution, box } = await automaticConsumerFixture(t,
    { seedRow: false });
  const messages = [
    { cli: 'claude', sessionId: 's', messageId: 'u1', timestamp: '2026-10-14T13:00:00Z',
      origin: 'human', speakerRole: 'user', ownerId: 'fixture-owner',
      text: 'Preservar este acordo.', start: 0, end: 20 },
    { cli: 'claude', sessionId: 's', messageId: 'a1', timestamp: '2026-10-14T13:00:01Z',
      origin: 'assistant', speakerRole: 'assistant', finalVisible: true,
      text: 'Acordo preservado.', start: 20, end: 40 },
  ];
  assert.equal((await box.enqueueConversationSlice({ cli: 'claude', sessionId: 's',
    start: 0, end: 40, sliceHash: 'a'.repeat(64), messages },
  { projectId: resolution.projectId, policyVersion: POLICY_VERSION },
  { event: 'Stop' })).kind, 'staged');
  assert.equal((await disableAutoPublish(resolution)).kind, 'disabled');
  const next = await initializeSession(project, 'new', { event: 'SessionStart',
    stateRoot, cli: 'claude', profile });
  assert.equal((await recordSessionCheckout(next, 'claude', 'new', project, profile)).kind, 'bound');
  let calls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 'new', stateRoot,
    now: () => Date.now() + 31 * 60 * 1000,
    runCli: async () => { calls++; return { kind: 'error', reason: 'unexpected' }; } });
  assert.equal(calls, 0);
  assert.equal((await box.pending()).length, 0);
  assert.equal((await box.listConversationStages({ cli: 'claude',
    projectId: resolution.projectId })).stages.length, 1);
});

test('trusted capture adopts null session policy once and blocks later owner change or revoked consent', async t => {
  const { project, profile, stateRoot, resolution } = await automaticConsumerFixture(t,
    { startUnowned: true });
  const before = await resolveProject(project, 's', { stateRoot });
  assert.equal(before.ownerId, null);
  assert.equal(before.extractor, null);
  const adopted = await refreshSessionPolicyForCapture(project, 's', { cli: 'claude',
    profile, stateRoot });
  assert.equal(adopted.ownerId, 'fixture-owner');
  assert.equal(adopted.extractor.autoPublish, true);
  assert.equal((await resolveProject(project, 's', { stateRoot })).ownerId, 'fixture-owner');
  assert.equal((await refreshSessionPolicyForCapture(project, 's', { cli: 'claude',
    profile, stateRoot })).ownerId, 'fixture-owner');
  assert.equal((await registerOwner(resolution, 'claude', profile, 'different-owner', true)).kind,
    'registered');
  assert.equal((await refreshSessionPolicyForCapture(project, 's', { cli: 'claude',
    profile, stateRoot })).reason, 'owner_binding_changed');
  assert.equal((await registerOwner(resolution, 'claude', profile, 'fixture-owner', true)).kind,
    'registered');
  assert.equal((await disableAutoPublish(resolution)).kind, 'disabled');
  assert.equal((await refreshSessionPolicyForCapture(project, 's', { cli: 'claude',
    profile, stateRoot })).reason, 'auto_publish_revoked');
});

test('first trusted hook skips old transcript and stages the next exchange for batch extraction', async t => {
  const { project, profile, stateRoot, box } = await automaticConsumerFixture(t,
    { startUnowned: true });
  const previousProfile = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (previousProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousProfile; });
  const transcriptPath = path.join(project, 's.jsonl');
  const payload = { cwd: project, session_id: 's', transcript_path: transcriptPath,
    hook_event_name: 'UserPromptSubmit' };
  assert.equal((await captureEvent({ cli: 'claude', event: 'UserPromptSubmit', payload,
    stateRoot })).kind, 'no_complete_bytes');
  assert.equal((await resolveProject(project, 's', { stateRoot })).ownerId, 'fixture-owner');
  const old = { type: 'user', uuid: 'old', timestamp: '2026-10-01T00:00:00Z',
    sessionId: 's', message: { role: 'user', content: 'historical preference' },
    isSidechain: false, userType: 'external' };
  const partialOld = JSON.stringify({ ...old, uuid: 'partial-old' });
  const split = Math.floor(partialOld.length / 2);
  await fs.writeFile(transcriptPath, JSON.stringify(old) + '\n' + partialOld.slice(0, split));
  const first = await captureEvent({ cli: 'claude', event: 'UserPromptSubmit', payload, stateRoot });
  assert.equal(first.kind, 'no_complete_bytes');
  assert.equal((await box.pending()).length, 1);
  const fresh = { ...old, uuid: 'fresh', message: { role: 'user', content: 'Use a release checklist.' } };
  await fs.appendFile(transcriptPath, partialOld.slice(split) + '\n' + JSON.stringify(fresh) + '\n');
  const next = await captureEvent({ cli: 'claude', event: 'UserPromptSubmit', payload, stateRoot });
  assert.equal(next.kind, 'staged');
  assert.equal((await box.pending()).length, 1);
  const answer = { type: 'assistant', uuid: 'a-fresh', timestamp: '2026-10-01T00:00:01Z',
    sessionId: 's', isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A lista será usada.' }] } };
  await fs.appendFile(transcriptPath, JSON.stringify(answer) + '\n');
  assert.equal((await captureEvent({ cli: 'claude', event: 'Stop',
    payload: { ...payload, hook_event_name: 'Stop' }, stateRoot })).kind, 'staged');
  const flushed = await captureEvent({ cli: 'claude', event: 'SessionEnd',
    payload: { ...payload, hook_event_name: 'SessionEnd' }, stateRoot });
  assert.equal(flushed.kind, 'queued');
  const rows = await box.pending();
  assert.equal(rows.length, 2);
  const batch = rows.find(row => row.operationId === flushed.operationId);
  assert.deepEqual(batch.messages.map(message => message.messageId), ['fresh', 'a-fresh']);
  assert.equal(batch.messages[0].ownerId, 'fixture-owner');
  assert.equal(batch.conversationPairs, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 0);
  let calls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
    runCli: async () => { calls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(calls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 1);
  assert.equal((await box.readManifest(rows.find(row => row.operationId !== flushed.operationId).operationId)).reason,
    'missing_manifest');
});

test('revoked live consent stops queued automatic row before a paid extraction call', async t => {
  const { project, stateRoot, box, resolution } = await automaticConsumerFixture(t);
  assert.equal((await disableAutoPublish(resolution)).kind, 'disabled');
  let calls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
    runCli: async () => { calls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(calls, 0);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 0);
});

test('invalid extractor output is recorded and does not spend another call on the same checkpoint', async t => {
  const { project, stateRoot, box, resolution } = await automaticConsumerFixture(t,
    { seedRow: false });
  const messages = [
    { cli: 'claude', sessionId: 's', messageId: 'u1', timestamp: '2026-10-14T13:00:00Z',
      origin: 'human', speakerRole: 'user', ownerId: 'fixture-owner',
      text: 'Preservar este acordo.', start: 0, end: 20 },
    { cli: 'claude', sessionId: 's', messageId: 'a1', timestamp: '2026-10-14T13:00:01Z',
      origin: 'assistant', speakerRole: 'assistant', finalVisible: true,
      text: 'Acordo preservado.', start: 20, end: 40 },
  ];
  assert.equal((await box.enqueueConversationSlice({ cli: 'claude', sessionId: 's',
    start: 0, end: 40, sliceHash: 'a'.repeat(64), messages },
  { projectId: resolution.projectId, policyVersion: POLICY_VERSION },
  { event: 'Stop' })).kind, 'staged');
  assert.equal((await box.flushConversationStage({ cli: 'claude', sessionId: 's',
    projectId: resolution.projectId, policyVersion: POLICY_VERSION,
    event: 'SessionEnd', conversationTurns: 5 })).kind, 'queued');
  let calls = 0;
  const consume = () => worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => {
      calls++;
      return { kind: 'success', model: 'claude-haiku-5-5',
        candidates: [], no_facts: false,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    } });
  const firstRun = await consume();
  assert.equal(firstRun.nextRetryAt, undefined);
  const [first] = await box.pending();
  assert.equal(first.lastError, 'extract_failure_extractor_schema_invalid');
  await consume();
  assert.equal(calls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 1);
});

test('a previous outbox-full extraction resumes after space is available without losing its checkpoint', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t);
  const [row] = await box.pending();
  assert.equal((await box.markFailed(row.operationId, 'extract_failure_outbox_full',
    { automatic: true })).kind, 'pending');
  let calls = 0;
  const retry = (await box.pending())[0].retryAt;
  const originalNow = Date.now;
  let result;
  try {
    Date.now = () => retry - 1;
    const before = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
      sessionId: 's', stateRoot,
      runCli: async () => { calls++; return { kind: 'error', reason: 'cli_failed' }; } });
    assert.equal(calls, 0);
    assert.equal(before.nextRetryAt, retry);
    Date.now = () => retry + 1;
    result = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
      sessionId: 's', stateRoot,
      runCli: async () => { calls++; return { kind: 'error', reason: 'cli_failed' }; } });
  } finally { Date.now = originalNow; }
  assert.equal(calls, 1);
  assert.ok(Number.isSafeInteger(result.nextRetryAt));
  assert.equal((await box.pending())[0].lastError, 'cli_failed');
});

test('changing the capture profile owner blocks paid extraction while signed consent remains valid', async t => {
  const { project, originProfile, stateRoot, box, resolution } = await automaticConsumerFixture(t,
    { originProfileDistinct: true });
  assert.equal((await registerOwner(resolution, 'claude', originProfile,
    'different-owner', true)).kind, 'registered');
  assert.equal((await readAutoPublish(resolution)).consentHash,
    (await resolveProject(project, 's', { stateRoot })).extractor.autoPublishConsent.consentHash);
  let calls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
    runCli: async () => { calls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(calls, 0);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 0);
});

test('trusted hook starts a new capture epoch for the same owner after live consent', async t => {
  const { project, profile, stateRoot, box } = await automaticConsumerFixture(t,
    { startWithOwnerBeforeConsent: true });
  const previousProfile = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (previousProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousProfile; });
  const transcriptPath = path.join(project, 's.jsonl');
  const payload = { cwd: project, session_id: 's', transcript_path: transcriptPath,
    hook_event_name: 'UserPromptSubmit' };
  assert.equal((await captureEvent({ cli: 'claude', event: 'UserPromptSubmit', payload,
    stateRoot })).kind, 'no_complete_bytes');
  const upgraded = await resolveProject(project, 's', { stateRoot });
  assert.equal(upgraded.ownerId, 'fixture-owner');
  assert.equal(upgraded.extractor.autoPublish, true);
  const historical = { type: 'user', uuid: 'historical', timestamp: '2026-10-01T00:00:00Z',
    sessionId: 's', message: { role: 'user', content: 'old preference' },
    isSidechain: false, userType: 'external' };
  await fs.writeFile(transcriptPath, JSON.stringify(historical) + '\n');
  assert.equal((await captureEvent({ cli: 'claude', event: 'UserPromptSubmit', payload,
    stateRoot })).kind, 'no_complete_bytes');
  assert.equal((await box.pending()).length, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 0);
});

test('consumer resumes a manifested Haiku checkpoint after transient publication failure', async t => {
  const { project, stateRoot } = await automaticConsumerFixture(t);
  let extracted = 0;
  let published = 0;
  let clock = Date.now();
  const realNow = Date.now;
  let result;
  try {
    Date.now = () => clock;
    result = await worker.runScheduledConsumer({
      now: () => clock,
      wait: async ms => { clock += ms; },
      consume: () => worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
        runCli: async () => { extracted++; return { kind: 'success', model: 'claude-haiku-5-5',
          decisions: [{ source_message_id: 'm1', abstain_reason: '', candidates: [{
            text: 'A release checklist is required.', type: 'rule', scope: 'project' }] }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; },
        publishCheckpoint: async () => ++published === 1
          ? { kind: 'retry', reason: 'transport_unavailable' }
          : { kind: 'published', published: 1, pending: 0 },
      }),
    });
  } finally { Date.now = realNow; }
  assert.equal(result.kind, 'consumed');
  assert.equal(extracted, 1);
  assert.equal(published, 2);
});

test('consumer retries transient Haiku failure and publishes after SessionEnd without a new hook', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t);
  let calls = 0;
  let published = 0;
  let clock = Date.now();
  const realNow = Date.now;
  try {
    Date.now = () => clock;
    const result = await worker.runScheduledConsumer({
      now: () => clock,
      wait: async ms => { clock += ms; },
      consume: () => worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
        runCli: async () => ++calls === 1
          ? { kind: 'error', reason: 'cli_unavailable' }
          : { kind: 'success', model: 'claude-haiku-5-5',
            decisions: [{ source_message_id: 'm1', abstain_reason: '', candidates: [{
              text: 'A release checklist is required.', type: 'rule', scope: 'project' }] }],
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } },
        publishCheckpoint: async () => { published++; return { kind: 'published', published: 1, pending: 0 }; },
      }),
    });
    assert.equal(result.kind, 'consumed');
  } finally { Date.now = realNow; }
  assert.equal(calls, 2);
  assert.equal(published, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 2);
});

test('automatic retry remains scheduled after four calls when live session budget is higher', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t);
  const [row] = await box.pending();
  for (let n = 0; n < 4; n++) {
    assert.equal((await box.claimExtraction(row.operationId, 100)).kind, 'claimed');
  }
  let calls = 0;
  const result = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => {
      calls++; return { kind: 'error', reason: 'cli_unavailable' };
    } });
  assert.equal(calls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 5);
  assert.ok(Number.isSafeInteger(result.nextRetryAt));
});

test('automatic extraction limit defers to UTC midnight and a raised cap reopens a saved row', async t => {
  const { project, stateRoot, box, resolution } = await automaticConsumerFixture(t,
    { maxCallsPerSession: 2 });
  const [row] = await box.pending();
  for (let n = 0; n < 2; n++) {
    assert.equal((await box.claimExtraction(row.operationId, 2,
      { automaticDaily: true })).kind, 'claimed');
  }
  let paidCalls = 0;
  const exhausted = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => { paidCalls++; throw Error('unexpected'); } });
  const nextMidnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
  assert.equal(paidCalls, 0);
  assert.equal(exhausted.nextRetryAt, nextMidnight);
  assert.equal((await box.pending())[0].lastError, 'extraction_call_limit');
  assert.equal((await box.extractionUsage('claude', 's')).calls, 2);
  assert.equal((await configureExtractionSchedule(resolution,
    { maxCallsPerSession: 3, mode: 'conversation', conversationTurns: 5 })).kind,
  'configured');
  const resumed = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => {
      paidCalls++;
      return { kind: 'error', reason: 'cli_unavailable' };
    } });
  assert.equal(paidCalls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 3);
  assert.ok(Number.isSafeInteger(resumed.nextRetryAt));
});

test('a later hook resumes a deferred row after UTC midnight without resetting lifetime calls', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t,
    { maxCallsPerSession: 1 });
  const [row] = await box.pending();
  assert.equal((await box.claimExtraction(row.operationId, 1,
    { automaticDaily: true })).kind, 'claimed');
  const limited = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => { throw Error('before midnight'); } });
  assert.ok(Number.isSafeInteger(limited.nextRetryAt));
  let paidCalls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
    now: () => limited.nextRetryAt + 1000,
    runCli: async () => { paidCalls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(paidCalls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 2);
});

test('an old terminal extraction limit reopens under the automatic daily policy', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t,
    { maxCallsPerSession: 3 });
  const [row] = await box.pending();
  assert.equal((await box.markFailed(row.operationId,
    'extract_failure_extraction_call_limit', { automatic: true })).kind, 'pending');
  let paidCalls = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's', stateRoot,
    now: () => Date.now() + 10000,
    runCli: async () => { paidCalls++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(paidCalls, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 1);
});

test('a prepared manifest publishes while the automatic extraction budget is exhausted', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t,
    { maxCallsPerSession: 1 });
  const [row] = await box.pending();
  assert.equal((await box.claimExtraction(row.operationId, 1,
    { automaticDaily: true })).kind, 'claimed');
  assert.equal((await box.recordManifest(row.operationId, [])).kind, 'manifested');
  let publications = 0;
  const result = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot,
    runCli: async () => { throw Error('must not spend another call'); },
    publishCheckpoint: async () => {
      publications++;
      return { kind: 'published', published: 0, pending: 0 };
    } });
  assert.equal(result.manifested, 1);
  assert.equal(publications, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 1);
});

test('consumer resumes DNS failure after SessionEnd and stores without another extraction', async t => {
  const { project, stateRoot } = await automaticConsumerFixture(t);
  let calls = 0;
  let stores = 0;
  let clock = Date.now();
  const realNow = Date.now;
  try {
    Date.now = () => clock;
    await worker.runScheduledConsumer({
      now: () => clock,
      wait: async ms => { clock += ms; },
      consume: () => worker.consumeCheckpoints({ cli: 'claude', cwd: project,
        sessionId: 's', stateRoot,
        runCli: async () => { calls++; return { kind: 'success', model: 'claude-haiku-5-5',
          decisions: [{ source_message_id: 'm1', abstain_reason: '', candidates: [{
            text: 'A release checklist is required.', type: 'rule', scope: 'project' }] }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; },
        publishCheckpoint: (row, resolution, options) => publishCheckpointAutomatically(
          row, resolution, { ...options, readAutoPublish,
            store: async (operation, ackLocal) => {
              stores++;
              if (stores === 1) return { kind: 'blocked', reason: 'destination_unavailable' };
              await ackLocal(operation.externalId, { externalId: operation.externalId,
                projectId: row.projectId, status: 'active', sdkId: 'sdk-1', qdrantId: 'qdrant-1' });
              return { kind: 'stored', externalId: operation.externalId };
            } }),
      }),
    });
  } finally { Date.now = realNow; }
  assert.equal(calls, 1);
  assert.equal(stores, 2);
});

test('automatic consumer passes its custom state root through publisher and store broker startup', async t => {
  const { project, stateRoot, box } = await automaticConsumerFixture(t);
  const device = await localDevice((await inspectConfiguration(project, { stateRoot })).stateDir);
  let resolved = 0;
  let brokerStarts = 0;
  const result = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot,
    runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5',
      decisions: [{ source_message_id: 'm1', abstain_reason: '', candidates: [{
        text: 'A release checklist is required.', type: 'rule', scope: 'project' }] }],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }),
    publishCheckpoint: (row, resolution, options) => publishCheckpointAutomatically(
      row, resolution, { ...options, readAutoPublish,
        resolve: async (cwd, sessionId, storeOptions) => {
          assert.equal(storeOptions.stateRoot, stateRoot);
          resolved++;
          return resolveProject(cwd, sessionId, storeOptions);
        },
        authorize: async () => ({ kind: 'authorized', key: 'fixture-key',
          connection: { url: 'https://qdrant.internal' } }),
        control: async () => ({ kind: 'authority', record: { state: 'active',
          deviceId: device.deviceId, generation: 1 } }),
        ensureBrokerReady: async (_cwd, brokerOptions) => {
          assert.equal(brokerOptions.stateRoot, stateRoot);
          brokerStarts++;
          return { kind: 'blocked', reason: 'broker_unavailable' };
        },
      }),
  });
  assert.equal(result.kind, 'consumed');
  assert.equal(resolved, 1);
  assert.equal(brokerStarts, 1);
  assert.equal((await box.pending()).length, 1);
});

test('configured four-call budget stops transient Haiku retries and leaves schema errors for review', async t => {
  for (const response of [
    { kind: 'error', reason: 'cli_timeout' },
    { kind: 'error', reason: 'cli_failed' },
    { kind: 'error', reason: 'cli_not_enrolled' },
    { kind: 'error', reason: 'cli_invalid_json' },
    { kind: 'error', reason: 'cli_invalid_schema' },
    { kind: 'error', reason: 'cli_profile_untrusted' },
  ]) {
    const { project, stateRoot, box } = await automaticConsumerFixture(t,
      { maxCallsPerSession: 4 });
    let calls = 0;
    let clock = Date.now();
    const realNow = Date.now;
    try {
      Date.now = () => clock;
      await worker.runScheduledConsumer({
        now: () => clock,
        wait: async ms => { clock += ms; },
        consume: () => worker.consumeCheckpoints({ cli: 'claude', cwd: project,
          sessionId: 's', stateRoot, runCli: async () => { calls++; return response; } }),
      });
    } finally { Date.now = realNow; }
    assert.equal(calls, ['cli_timeout', 'cli_failed', 'cli_not_enrolled'].includes(response.reason) ? 4 : 1);
    assert.equal((await box.extractionUsage('claude', 's')).calls, calls);
  }
});

test('attested replay uses selected execution profile once without changing frozen capture or resetting usage', async t => {
  const { project, profile, stateRoot, box, resolution } = await automaticConsumerFixture(t,
    { maxCallsPerSession: 1 });
  const [row] = await box.pending();
  const first = await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, runCli: async () => ({ kind: 'error', reason: 'cli_unavailable' }) });
  assert.equal(first.kind, 'consumed');
  assert.equal((await box.extractionUsage('claude', 's')).calls, 1);
  const selected = path.join(path.dirname(profile), 'selected-profile');
  await fs.mkdir(selected, { mode: 0o700 });
  const file = path.join(resolution.stateDir, 'extractor.json');
  const live = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...live, profile: selected }));
  assert.deepEqual(await registerExtractionReplay(resolution, { runId: 'run-1',
    cli: 'claude', profile: selected, ownerId: 'fixture-owner',
    operationIds: [row.operationId] }, false),
  { kind: 'blocked', reason: 'replay_attestation_required' });
  assert.equal((await registerExtractionReplay(resolution, { runId: 'run-1',
    cli: 'claude', profile: selected, ownerId: 'fixture-owner',
    operationIds: [row.operationId] }, true)).kind, 'registered');
  let invoked = 0;
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's',
    stateRoot, replayRunId: 'run-1', maxExtractionCalls: 1,
    runCli: async (_prompt, policy) => {
      invoked++;
      assert.equal(policy.profile, selected);
      return { kind: 'error', reason: 'cli_unavailable' };
    } });
  assert.equal(invoked, 1);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 2);
  const counterFile = (await fs.readdir(path.join(resolution.stateDir, 'outbox')))
    .find(name => name.startsWith('extract-'));
  const counter = JSON.parse(await fs.readFile(path.join(resolution.stateDir,
    'outbox', counterFile), 'utf8'));
  assert.equal(counter.results.at(-1).executionProfile, selected);
  assert.equal(counter.results.at(-1).frozenProfile, profile);
  assert.equal(counter.results.at(-1).replayRunId, 'run-1');
  await worker.consumeCheckpoints({ cli: 'claude', cwd: project, sessionId: 's',
    stateRoot, replayRunId: 'run-1', maxExtractionCalls: 1,
    runCli: async () => { invoked++; return { kind: 'error', reason: 'cli_unavailable' }; } });
  assert.equal(invoked, 1);
  const after = await resolveProject(project, 's', { stateRoot });
  assert.equal(after.extractor.profile, profile);
  await fs.writeFile(file, JSON.stringify(live));
  assert.equal((await worker.consumeCheckpoints({ cli: 'claude', cwd: project,
    sessionId: 's', stateRoot, replayRunId: 'run-1',
    runCli: async () => { throw new Error('stale replay ran'); } })).reason,
  'replay_selection_changed');
});

test('Claude replay credential can extract a Codex-origin checkpoint without changing its owner', async t => {
  const { project, profile, stateRoot, box, resolution } = await automaticConsumerFixture(t,
    { cli: 'codex' });
  const [row] = await box.pending();
  const selected = path.join(path.dirname(profile), 'claude-execution');
  await fs.mkdir(selected, { mode: 0o700 });
  const file = path.join(resolution.stateDir, 'extractor.json');
  const live = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...live, profile: selected }));
  assert.equal((await registerExtractionReplay(resolution, { runId: 'codex-replay',
    cli: 'claude', profile: selected, ownerId: 'fixture-owner',
    operationIds: [row.operationId] }, true)).kind, 'registered');
  let calls = 0;
  const result = await worker.consumeCheckpoints({ cli: 'codex', cwd: project,
    sessionId: 's', stateRoot, replayRunId: 'codex-replay', maxExtractionCalls: 1,
    runCli: async (_prompt, policy) => {
      calls++;
      assert.equal(policy.profile, selected);
      return { kind: 'error', reason: 'cli_unavailable' };
    } });
  assert.equal(result.kind, 'consumed');
  assert.equal(calls, 1);
  assert.equal((await box.extractionUsage('codex', 's')).calls, 1);
  assert.equal((await resolveProject(project, 's', { stateRoot })).ownerId, 'fixture-owner');
});
