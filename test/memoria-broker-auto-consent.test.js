import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeAutomaticBrokerWrite, authorizeAutomaticOrigin,
  brokerPath, readBrokerRequest } from '../base/memoria/broker.mjs';
import { createBrokerWorker } from '../base/memoria/broker-worker.mjs';
import { runBridgeOperation } from '../base/memoria/bridge.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';
import { localDevice } from '../base/memoria/policy.mjs';

const fixture = fileURLToPath(new URL('./memoria-broker-worker-fixture.mjs', import.meta.url));
const consent = { version: 1, enabled: true, projectId: 'project',
  destinationHash: 'a'.repeat(64), ownerId: 'owner-123', deviceId: 'device-123',
  consentHash: 'b'.repeat(64), enabledAt: '2026-10-13T09:00:00Z' };
const resolution = { provider: 'mem0', projectId: 'project', ownerId: 'owner-123',
  extractor: { autoPublish: true, autoPublishConsent: consent } };
const add = { op: 'add', metadata: { review_mode: 'automatic',
  auto_actor: 'project_auto_publisher', auto_consent_hash: consent.consentHash,
  format_version: 3 }, approval: { kind: 'approved', mode: 'automatic' } };

test('broker gate rejects revoked or mismatched automatic consent and preserves manual writes', async () => {
  const read = async () => consent;
  assert.equal((await authorizeAutomaticBrokerWrite(resolution, add, consent, read)).kind, 'allowed');
  assert.deepEqual(await authorizeAutomaticBrokerWrite(resolution, add, consent, async () => null),
    { kind: 'blocked', reason: 'auto_publish_revoked' });
  for (const key of ['ownerId', 'deviceId', 'destinationHash', 'consentHash']) {
    const changed = { ...consent, [key]: `changed-${key}` };
    assert.deepEqual(await authorizeAutomaticBrokerWrite(resolution, add, consent,
      async () => changed), { kind: 'blocked', reason: 'auto_publish_revoked' });
  }
  assert.deepEqual(await authorizeAutomaticBrokerWrite(resolution, add, null, read),
    { kind: 'blocked', reason: 'auto_publish_unproved' });
  assert.deepEqual(await authorizeAutomaticBrokerWrite({ ...resolution, ownerId: 'other-owner' },
    add, consent, read), { kind: 'blocked', reason: 'auto_publish_revoked' });
  assert.deepEqual(await authorizeAutomaticBrokerWrite({ ...resolution,
    extractor: { autoPublish: true,
      autoPublishConsent: { ...consent, deviceId: 'other-device' } } }, add, consent, read),
  { kind: 'blocked', reason: 'auto_publish_revoked' });
  assert.equal((await authorizeAutomaticBrokerWrite(resolution,
    { op: 'activate' }, null, read)).kind, 'allowed');
  assert.equal((await authorizeAutomaticBrokerWrite(resolution,
    { op: 'add', approval: { kind: 'approved' }, metadata: { review_mode: 'human' } },
    null, read)).kind, 'allowed');
  assert.equal((await authorizeAutomaticBrokerWrite(resolution,
    { op: 'activate' }, consent, read)).kind, 'allowed');
  assert.deepEqual(await authorizeAutomaticBrokerWrite(resolution,
    { op: 'activate' }, consent, async () => null),
  { kind: 'blocked', reason: 'auto_publish_revoked' });
});

test('broker accepts conversation summaries only with explicit generated origin', async () => {
  const summary = { ...add, metadata: { ...add.metadata, format_version: 4,
    origin: 'conversation_summary', speaker_role: 'mixed', actor: 'conversation',
    source_refs: [{ origin: 'human' }, { origin: 'assistant' }],
    dedup_key: 'c'.repeat(64) } };
  assert.equal((await authorizeAutomaticBrokerWrite(resolution, summary, consent,
    async () => consent)).kind, 'allowed');
  for (const metadata of [
    { ...summary.metadata, origin: 'user_direct' },
    { ...summary.metadata, speaker_role: 'user' },
    { ...summary.metadata, actor: 'user' },
    { ...summary.metadata, source_refs: [] },
    { ...summary.metadata, dedup_key: null },
    { ...summary.metadata, format_version: 5 },
  ]) assert.deepEqual(await authorizeAutomaticBrokerWrite(resolution,
    { ...summary, metadata }, consent, async () => consent),
  { kind: 'blocked', reason: 'auto_publish_unproved' });
});

test('broker checks the private origin checkout again before automatic dispatch', async () => {
  const current = { ...resolution, stateDir: '/state', projectRoot: '/project' };
  const checkout = { kind: 'bound', nativeRoot: '/worktree', projectRoot: '/project',
    projectId: 'project', profile: '/profiles/origin' };
  let ownerId = 'owner-123';
  const readCheckout = async (_state, cli) => cli === 'claude' ? checkout :
    { kind: 'blocked', reason: 'missing_session_checkout' };
  const readProfileOwner = async () => ({ ownerId });
  const options = { readCheckout, readProfileOwner };
  const sourceIdentity = { originCli: 'claude', sessionId: 'session', projectId: 'project' };
  assert.equal((await authorizeAutomaticOrigin(current, '/worktree', 'session',
    { ...add, sourceIdentity }, options)).kind, 'allowed');
  assert.equal((await authorizeAutomaticOrigin(current, '/worktree', 'session',
    { op: 'activate' }, options)).kind, 'allowed');
  ownerId = 'other-owner';
  assert.deepEqual(await authorizeAutomaticOrigin(current, '/worktree', 'session',
    { op: 'activate' }, options), { kind: 'blocked', reason: 'auto_origin_changed' });
  assert.deepEqual(await authorizeAutomaticOrigin(current, '/worktree', 'session',
    { ...add, sourceIdentity: { ...sourceIdentity, originCli: 'codex' } }, options),
  { kind: 'blocked', reason: 'auto_origin_changed' });
  ownerId = 'owner-123';
  assert.deepEqual(await authorizeAutomaticOrigin(current, '/worktree', 'session',
    { op: 'activate' }, { ...options, readCheckout: async () => checkout }),
  { kind: 'blocked', reason: 'auto_origin_changed' });
});

test('bridge carries consent proof for both SDK writes and omits it for manual writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-consent-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'project');
  const ledger = path.join(stateDir, 'ledger');
  await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
  const device = await localDevice(stateDir);
  assert.equal(device.kind, 'device');
  await fs.writeFile(path.join(ledger, 'writer.json'), JSON.stringify({
    projectId: 'project', collection: 'collection', deviceId: device.deviceId,
    generation: 1 }) + '\n', { mode: 0o600 });
  const seen = [];
  const server = net.createServer(socket => readBrokerRequest(socket, frame => {
    seen.push(frame.value);
    frame.secret.fill(0);
    socket.end(encodeFrame({ kind: 'item' }, undefined, true));
  }));
  await new Promise(resolve => server.listen(brokerPath(root), resolve));
  await fs.chmod(brokerPath(root), 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const current = { ...resolution, stateDir, destination: { collection: 'collection' } };
  const options = { stateRoot: root, resolve: async () => current,
    authorize: async () => ({ kind: 'authorized', key: 'key', connection: {} }),
    readAutoPublish: async () => consent,
    control: async () => ({ kind: 'protocol' }),
  };
  await runBridgeOperation('/project', 'session', { ...add, projectId: 'project' },
    () => 'key', { ...options, autoPublishConsent: consent });
  await runBridgeOperation('/project', 'session', { op: 'activate', projectId: 'project' },
    () => 'key', { ...options, autoPublishConsent: consent });
  await runBridgeOperation('/project', 'session', { op: 'activate', projectId: 'project' },
    () => 'key', options);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].autoPublishConsent, consent);
  assert.deepEqual(seen[1].autoPublishConsent, consent);
  assert.equal(seen[2].autoPublishConsent, undefined);
});

test('revocation while worker restarts blocks queued add and activate before dispatch', async () => {
  for (const operation of [add, { op: 'activate' }]) {
    let starts = 0;
    const worker = createBrokerWorker(() => spawn(process.execPath,
      [fixture, ++starts === 2 ? '250' : '0'], { stdio: ['pipe', 'pipe', 'ignore'] }),
    { coldMs: 1000 });
    try {
      assert.deepEqual(await worker.start(), { kind: 'ready' });
      assert.deepEqual(await worker.request({ hang: true }, Buffer.from('key'), Date.now() + 60),
        { kind: 'unavailable', reason: 'deadline' });
      let live = consent;
      const queued = worker.request({ id: operation.op }, Buffer.from('key'), Date.now() + 2000,
        () => authorizeAutomaticBrokerWrite(resolution, operation, consent, async () => live));
      await new Promise(resolve => setTimeout(resolve, 80));
      live = null;
      assert.deepEqual(await queued, { kind: 'blocked', reason: 'auto_publish_revoked' });
      assert.deepEqual(await worker.request({ id: 'manual' }, Buffer.from('key'), Date.now() + 1000),
        { kind: 'result', id: 'manual', secretLength: 3 });
    } finally { await worker.close(); }
  }
});
