import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { extractCheckpoint } from '../base/memoria/candidates.mjs';
import { publishCheckpointAutomatically } from '../base/memoria/auto-publish.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import { brokerEndpointStatus, brokerPath, readBrokerRequest } from '../base/memoria/broker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';
import { localDevice } from '../base/memoria/policy.mjs';
import { POLICY_VERSION } from '../base/memoria/transcript.mjs';

const consent = { version: 1, enabled: true, projectId: 'project',
  destinationHash: 'a'.repeat(64), ownerId: 'owner-123', deviceId: 'device-123',
  consentHash: 'b'.repeat(64), enabledAt: '2026-10-13T09:00:00Z' };
const message = { origin: 'human', actor: 'user', speakerRole: 'user',
  ownerId: consent.ownerId,
  text: 'No projeto, use PostgreSQL para persistência.', messageId: 'm1',
  timestamp: '2026-10-13T10:00:00Z', start: 0, end: 44 };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-auto-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'project-state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const device = await localDevice(stateDir);
  assert.equal(device.kind, 'device');
  await fs.mkdir(path.join(stateDir, 'ledger'), { mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'ledger', 'writer.json'), JSON.stringify({
    projectId: 'project', collection: 'collection', deviceId: device.deviceId, generation: 1,
  }) + '\n', { mode: 0o600 });
  const outbox = createOutbox(stateDir);
  assert.equal((await outbox.ensureFutureBaseline({ cli: 'claude', sessionId: 'session',
    projectId: 'project', ownerId: consent.ownerId, consentHash: consent.consentHash,
    policyVersion: POLICY_VERSION, cutoffEnd: 0 })).kind, 'baselined');
  const row = { cli: 'claude', sessionId: 'session', start: 0, end: 100,
    sliceHash: 'c'.repeat(64), messages: [message] };
  const queued = await outbox.enqueueCheckpoint(row,
    { projectId: 'project', policyVersion: POLICY_VERSION });
  assert.equal(queued.kind, 'queued');
  const checkpoint = { ...row, operationId: queued.operationId,
    projectId: 'project', policyVersion: POLICY_VERSION };
  const extracted = await extractCheckpoint(checkpoint,
    { route: 'haiku', autoPublish: true, autoPublishConsent: consent },
    { outbox, runCli: async () => ({ kind: 'success', model: 'claude-haiku-5-5',
      decisions: [{ source_message_id: 'm1', abstain_reason: '', candidates: [
        { text: message.text, type: 'rule', scope: 'project' }] }] }) });
  assert.equal(extracted.kind, 'manifested');
  const resolution = { provider: 'mem0', stateDir, projectId: 'project',
    ownerId: consent.ownerId, destination: { collection: 'collection' },
    extractor: { autoPublish: true, autoPublishConsent: consent } };
  let operation;
  await publishCheckpointAutomatically(checkpoint, resolution, {
    outbox, readAutoPublish: async () => consent,
    readOriginOwner: async () => consent.ownerId,
    store: async value => { operation = value; return { kind: 'pending', reason: 'fixture_pause' }; },
  });
  assert.ok(operation);
  const entry = (await outbox.readManifest(checkpoint.operationId)).candidates[0];
  const options = { stateRoot: root, resolve: async () => resolution,
    authorize: async () => ({ kind: 'authorized', key: 'fixture-key', connection: {} }),
    control: async () => ({ kind: 'authority', record: {
      state: 'active', deviceId: device.deviceId, generation: 1 } }),
    readAutoPublish: async () => consent, autoPublishConsent: consent,
    ackLocal: (id, proof) => id === entry.externalId
      ? outbox.ackCandidate(checkpoint.operationId, entry.candidateKey, proof)
      : { kind: 'blocked', reason: 'child_id_mismatch' },
  };
  return { root, operation, options };
}

test('automatic store starts a missing broker before its first remote find and reaches ACK', async t => {
  const { root, operation, options } = await fixture(t);
  let server;
  let remote;
  const seen = [];
  const ready = async (cwd, { stateRoot, bootstrapSessionId }) => {
    assert.equal(cwd, '/project');
    assert.equal(stateRoot, root);
    assert.equal(bootstrapSessionId, 'session');
    assert.equal(await brokerEndpointStatus(root), 'missing');
    server = net.createServer(socket => readBrokerRequest(socket, frame => {
      const op = frame.value.operation;
      seen.push(op.op);
      let response;
      if (op.op === 'find') response = { kind: 'items', items: remote ? [remote] : [] };
      else if (op.op === 'add') {
        remote = { ...op, sdkId: 'sdk-1', qdrantId: 'qdrant-1', status: 'pending' };
        response = { kind: 'pending' };
      } else if (op.op === 'read') response = { kind: 'item', item: remote };
      else if (op.op === 'activate') {
        remote.status = 'active';
        response = { kind: 'item', item: remote };
      }
      frame.secret.fill(0);
      socket.end(encodeFrame(response, undefined, true));
    }));
    await new Promise(resolve => server.listen(brokerPath(root), resolve));
    await fs.chmod(brokerPath(root), 0o600);
    return { kind: 'ready' };
  };
  t.after(() => server && new Promise(resolve => server.close(resolve)));
  const result = await storeMemory('/project', 'session', operation, () => 'fixture-key',
    { ...options, ensureBrokerReady: ready });
  assert.equal(result.kind, 'stored', JSON.stringify(result));
  assert.deepEqual(seen, ['find', 'add', 'find', 'read', 'activate', 'read']);
});

test('automatic store checks consent and writer before trying to start the broker', async t => {
  const { operation, options } = await fixture(t);
  let starts = 0;
  const start = async () => { starts++; return { kind: 'ready' }; };
  const revoked = await storeMemory('/project', 'session', operation, () => '', {
    ...options, readAutoPublish: async () => null, ensureBrokerReady: start,
  });
  assert.deepEqual(revoked, { kind: 'blocked', reason: 'auto_publish_unproved' });
  const fenced = await storeMemory('/project', 'session', operation, () => '', {
    ...options, control: async () => ({ kind: 'missing' }), ensureBrokerReady: start,
  });
  assert.deepEqual(fenced, { kind: 'blocked', reason: 'writer_authority_missing' });
  assert.equal(starts, 0);
});

test('a transient cold-start failure leaves the sealed operation ready for retry', async t => {
  const { operation, options } = await fixture(t);
  let starts = 0;
  const result = await storeMemory('/project', 'session', operation, () => '', {
    ...options, ensureBrokerReady: async () => {
      starts++;
      return { kind: 'blocked', reason: 'broker_unavailable' };
    },
  });
  assert.deepEqual(result, { kind: 'blocked', reason: 'broker_unavailable' });
  assert.equal(starts, 1);
});
