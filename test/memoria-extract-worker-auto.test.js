import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as worker from '../base/memoria/extract-worker.mjs';
import { inspectConfiguration, initializeSession, resolveProject } from '../base/memoria/provider.mjs';
import { registerOwner, configureExtractor, enableAutoPublish, localDevice,
  readAutoPublish } from '../base/memoria/policy.mjs';
import { publishCheckpointAutomatically } from '../base/memoria/auto-publish.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { recordSessionCheckout } from '../base/memoria/session-checkout.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { POLICY_VERSION } from '../base/memoria/transcript.mjs';

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

test('owner keeps one detached retry consumer while concurrent hook child exits', async t => {
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
  const duplicate = await worker.runExclusiveConsumer({ ownerRoot,
    consume: async () => { duplicateCalls++; return { kind: 'consumed' }; },
    lockTimeoutMs: 150,
  });
  assert.deepEqual(duplicate, { kind: 'blocked', reason: 'consumer_busy' });
  assert.equal(duplicateCalls, 0);
  release();
  await first;
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

async function automaticConsumerFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-consumer-auto-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  const profile = path.join(home, 'profile');
  const stateRoot = path.join(home, 'state');
  await fs.mkdir(path.join(project, '.cbs'), { recursive: true });
  await fs.mkdir(profile, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
  await fs.writeFile(path.join(project, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'fixture-project',
    qdrant: { url: 'https://qdrant.internal', collection: 'fixture-memory', api_key_env: 'CBS_AUTO_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const resolution = await inspectConfiguration(project, { stateRoot });
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  assert.equal((await configureExtractor(resolution, { route: 'haiku', profile,
    executable: process.execPath })).kind, 'selected');
  assert.equal((await registerOwner(resolution, 'claude', profile, 'fixture-owner', true)).kind, 'registered');
  const device = await localDevice(resolution.stateDir);
  const ledger = path.join(resolution.stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: resolution.projectId, collection: resolution.destination.collection,
    deviceId: device.deviceId, generation: 1,
  }), { mode: 0o600 });
  assert.equal((await enableAutoPublish(resolution, { ownerId: 'fixture-owner',
    cli: 'claude', profile })).kind, 'enabled');
  assert.equal((await applyNativeExclusion(project, { cli: 'claude', stateRoot })).kind, 'applied');
  const session = await initializeSession(project, 's', { event: 'SessionStart', stateRoot,
    cli: 'claude', profile });
  assert.equal(session.extractor.autoPublish, true);
  assert.equal((await recordSessionCheckout(session, 'claude', 's', project)).kind, 'bound');
  const box = createOutbox(resolution.stateDir);
  assert.equal((await box.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 32,
    sliceHash: 'a'.repeat(64), messages: [{ messageId: 'm1', role: 'user', speakerRole: 'user',
      actor: 'fixture-owner', origin: 'human', text: 'A release checklist is required.',
      timestamp: '2026-10-01T00:00:00Z', start: 0, end: 32 }] },
  { projectId: 'fixture-project', policyVersion: POLICY_VERSION })).kind, 'queued');
  return { project, stateRoot, box };
}

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

test('consumer stops after four transient Haiku calls and leaves schema errors for review', async t => {
  for (const response of [
    { kind: 'error', reason: 'cli_timeout' },
    { kind: 'error', reason: 'cli_invalid_schema' },
    { kind: 'error', reason: 'cli_profile_untrusted' },
  ]) {
    const { project, stateRoot, box } = await automaticConsumerFixture(t);
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
    assert.equal(calls, response.reason === 'cli_timeout' ? 4 : 1);
    assert.equal((await box.extractionUsage('claude', 's')).calls, calls);
  }
});
