import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FrameReader, encodeFrame } from '../base/memoria/frame.mjs';
import { EventEmitter } from 'node:events';
import { createMcp } from '../base/memoria/mcp.mjs';
import { scheduleExtraction, consumeCheckpoints } from '../base/memoria/extract-worker.mjs';
import { recordSessionCheckout } from '../base/memoria/session-checkout.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { withProjectLock } from '../base/memoria/ledger.mjs';
import { createLaunch, bindLaunch, resolveBoundLaunch } from '../base/memoria/launch.mjs';
import { inspectConfiguration, initializeSession } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { applyNativeExclusion, restoreNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';
import { RUNTIME_PINS, runtimePython, openArtifactIdentity } from '../base/memoria/runtime.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-memoria-m6-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'main');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(root);
  git(root, 'init', '-q');
  await fs.writeFile(path.join(root, 'README'), 'fixture\n');
  git(root, 'add', 'README');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  return { dir, root, stateRoot };
}

test('binary frames handle fragments and keep the secret out of JSON', () => {
  const secret = Buffer.from('private-sentinel');
  const frame = encodeFrame({ op: 'search', query: 'fact' }, secret);
  assert.equal(frame.includes(secret), true);
  const jsonLength = frame.readUInt32BE(5);
  assert.equal(frame.subarray(13, 13 + jsonLength).includes(secret), false);
  const reader = new FrameReader();
  assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
  assert.deepEqual(reader.push(frame.subarray(2, 13)), []);
  const parsed = reader.push(frame.subarray(13));
  assert.equal(parsed[0].secret.toString(), 'private-sentinel');
  assert.equal(parsed[0].value.op, 'search');
  reader.end();
  assert.throws(() => new FrameReader().push(Buffer.from('M0BW\x01\xff\xff\xff\xff\x00\x00\x00\x00', 'binary')), /frame_oversized/);
  const partial = new FrameReader();
  partial.push(frame.subarray(0, 15));
  assert.throws(() => partial.end(), /frame_partial_eof/);
});

test('warm artifact identity rejects replacement or mutation between operations', async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'model');
  await fs.writeFile(file, 'pinned');
  const identity = await openArtifactIdentity([file]);
  assert.equal(identity.kind, 'opened');
  assert.equal(await identity.unchanged(), true);
  await fs.writeFile(file, 'changed');
  assert.equal(await identity.unchanged(), false);
  await identity.close();
  const link = path.join(dir, 'symlink');
  await fs.symlink(file, link);
  assert.equal((await openArtifactIdentity([link])).reason, 'artifact_changed');
});

test('MCP refuses unbound calls before search and never accepts JSON approval', async () => {
  let calls = 0;
  const unbound = createMcp({ launchId: undefined, cli: 'claude',
    resolve: async () => ({ kind: 'blocked', reason: 'unbound' }),
    search: async () => { calls++; return { kind: 'items', items: [] }; } });
  assert.deepEqual(await unbound.call('search', { query: 'secret' }), { kind: 'unavailable', reason: 'unbound' });
  assert.equal(calls, 0);
  const bound = createMcp({ launchId: 'token', cli: 'claude',
    resolve: async () => ({ kind: 'bound', projectId: 'p', cwd: '/fixture', nativeSessionId: 'session', stateDir: '/fixture/state' }),
    search: async (args) => { calls++; assert.equal(args.projectId, undefined); return { kind: 'items', items: [] }; } });
  assert.deepEqual(await bound.call('approve', { approved: true, actor: 'owner' }),
    { kind: 'blocked', reason: 'trusted_review_required',
      route: 'Run review.mjs <caller-cli> <caller-checkout> <current-native-session-id> <checkpoint-id> <candidate-key> in the owner terminal.' });
  assert.equal(calls, 0);
  assert.deepEqual(await bound.call('search', { query: 'negative', project_id: 'other' }), { kind: 'abstain' });
  assert.equal(calls, 1);
});

test('MCP recall deadline includes native binding time', async () => {
  const instance = createMcp({ launchId: 'token', cli: 'claude',
    resolve: async () => {
      await new Promise(resolve => setTimeout(resolve, 450));
      return { kind: 'bound', projectId: 'p', cwd: '/fixture', nativeSessionId: 's' };
    },
    search: async () => {
      await new Promise(resolve => setTimeout(resolve, 900));
      return { kind: 'items', items: [] };
    } });
  const began = performance.now();
  const result = await instance.call('search', { query: 'fact' });
  assert.equal(result.kind, 'unavailable');
  assert.ok(performance.now() - began < 1150);
});

test('bound caller may propose protected historical checkpoints from the same project', async t => {
  const { dir } = await fixture(t);
  const stateDir = path.join(dir, 'memoria-state');
  const box = createOutbox(stateDir);
  await box.enqueueCheckpoint({ cli: 'claude', sessionId: 'prior', start: 0, end: 10,
    sliceHash: 'd'.repeat(64), messages: [{ messageId: 'm', role: 'user', speakerRole: 'user',
      actor: 'owner', origin: 'human', text: 'Rule X.', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 10 }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  await box.enqueueCheckpoint({ cli: 'claude', sessionId: 'foreign', start: 0, end: 10,
    sliceHash: 'e'.repeat(64), messages: [{ messageId: 'f', role: 'user', speakerRole: 'user',
      actor: 'other', origin: 'human', text: 'Other.', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 10 }] },
  { projectId: 'other', policyVersion: 'native-v1' });
  const mcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', projectId: 'p', nativeSessionId: 'current', stateDir }) });
  const proposals = await mcp.call('propose');
  assert.equal(proposals.kind, 'pending_review');
  assert.equal(proposals.checkpoints.length, 1);
  assert.equal(proposals.checkpoints[0].sourceSessionId, 'prior');
  const historical = (await box.pending()).find(row => row.projectId === 'p');
  const sourceMcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', projectId: 'p', nativeSessionId: 'current', stateDir,
      cwd: '/trusted-checkout' }),
    read: async () => ({ kind: 'item', item: { projectId: 'p', sessionId: 'prior',
      metadata: { source: 'm', checkpoint_id: historical.operationId, policy_version: 'native-v1' } } }) });
  assert.equal((await sourceMcp.call('source', { memory_id: 'historical' })).kind, 'local_source');
});

test('two explicit launches bind interleaved native sessions once', async t => {
  const { root, stateRoot } = await fixture(t);
  await fs.mkdir(path.join(root, '.cbs'));
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const current = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  const first = await createLaunch(root, 'claude', { stateRoot });
  const second = await createLaunch(root, 'claude', { stateRoot });
  assert.equal(first.kind, 'created');
  assert.equal(second.kind, 'created');
  assert.notEqual(first.token, second.token);
  await initializeSession(root, 's2', { event: 'SessionStart', stateRoot });
  await initializeSession(root, 's1', { event: 'SessionStart', stateRoot });
  assert.equal((await bindLaunch(second.token, 'claude', root, 's2', { stateRoot })).kind, 'bound');
  assert.equal((await bindLaunch(first.token, 'claude', root, 's1', { stateRoot })).kind, 'bound');
  assert.equal((await bindLaunch(first.token, 'claude', root, 's2', { stateRoot })).reason, 'already_bound');
  const third = await createLaunch(root, 'claude', { stateRoot });
  assert.equal((await bindLaunch(third.token, 'claude', root, 's1', { stateRoot })).reason, 'already_bound');
  assert.equal((await resolveBoundLaunch(first.token, 'claude', { stateRoot })).nativeSessionId, 's1');
  assert.equal((await resolveBoundLaunch(second.token, 'claude', { stateRoot })).nativeSessionId, 's2');
  assert.equal((await resolveBoundLaunch('forged', 'claude', { stateRoot })).reason, 'unbound');
});

test('Codex worktrees own native config independently and share exclude safely', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  const worktree = path.join(dir, 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'm6-worktree', worktree);
  const options = { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root };
  assert.equal((await applyNativeExclusion(root, options)).kind, 'applied');
  assert.equal((await applyNativeExclusion(worktree, options)).kind, 'applied');
  assert.equal((await verifyNativeCapture(root, options)).kind, 'verified');
  assert.equal((await verifyNativeCapture(worktree, options)).kind, 'verified');
  assert.equal((await restoreNativeExclusion(root, options)).kind, 'restored');
  assert.equal((await verifyNativeCapture(worktree, options)).kind, 'verified');
  const excludePath = git(root, 'rev-parse', '--git-path', 'info/exclude');
  assert.ok((await fs.readFile(path.resolve(root, excludePath), 'utf8')).includes('/.codex/config.toml'));
  assert.equal((await restoreNativeExclusion(worktree, options)).kind, 'restored');
  assert.equal((await fs.readFile(path.resolve(root, excludePath), 'utf8')).includes('# cbs-memoria codex'), false);
});

test('Windows venv uses Scripts/python.exe without changing POSIX path', () => {
  assert.equal(runtimePython('C:\\state', 'win32'), path.join('C:\\state', 'runtime', 'Scripts', 'python.exe'));
  assert.equal(runtimePython('/state', 'linux'), '/state/runtime/bin/python');
});

test('capture scheduler dispatches only verified checkpoint boundaries and keeps secrets out of child env', () => {
  const calls = [];
  const spawnChild = (program, args, options) => {
    calls.push({ program, args, options });
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const input = { cli: 'claude', payload: { cwd: '/checkout', session_id: 's' },
    result: { kind: 'queued' }, spawnChild };
  assert.equal(scheduleExtraction({ ...input, event: 'UserPromptSubmit' }), false);
  assert.equal(scheduleExtraction({ ...input, event: 'Stop', result: { kind: 'pass_through' } }), false);
  assert.equal(scheduleExtraction({ ...input, event: 'SessionStart', result: { kind: 'blocked' } }), false);
  for (const event of ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']) {
    assert.equal(scheduleExtraction({ ...input, event }), true);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.options.cwd === '/checkout' &&
    call.options.env.CBS_MEMORIA_API_KEY === undefined && call.options.detached === true));
});

test('consumer processes a protected checkpoint once, then recovery skips its manifest', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  await fs.mkdir(path.join(root, '.cbs'));
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const profile = path.join(dir, 'owner-profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior; });
  const current = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'applied');
  await initializeSession(root, 's', { event: 'SessionStart', stateRoot });
  assert.equal((await recordSessionCheckout(current, 'claude', 's', root)).kind, 'bound');
  const box = createOutbox(current.stateDir);
  const source = { messageId: 'm1', role: 'user', speakerRole: 'user', actor: 'owner', origin: 'human',
    text: 'A release checklist is required.', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 32 };
  const row = { cli: 'claude', sessionId: 's', start: 0, end: 32,
    sliceHash: 'a'.repeat(64), messages: [source] };
  assert.equal((await box.enqueueCheckpoint(row, { projectId: 'p', policyVersion: 'native-v1' })).kind, 'queued');
  let calls = 0;
  const runCli = async () => { calls++; return { kind: 'success', candidates: [], no_facts: true,
    model: 'claude-sonnet-5-5', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; };
  assert.deepEqual(await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot, runCli }),
    { kind: 'consumed', manifested: 1, pending: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot, runCli }),
    { kind: 'consumed', manifested: 0, pending: 0 });
  assert.equal(calls, 1);
  const retrySource = { ...source, messageId: 'm2', start: 32, end: 64 };
  assert.equal((await box.enqueueCheckpoint({ ...row, start: 32, end: 64, sliceHash: 'b'.repeat(64),
    messages: [retrySource] }, { projectId: 'p', policyVersion: 'native-v1' })).kind, 'queued');
  assert.deepEqual(await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot,
    runCli: async () => { calls++; return { kind: 'error', reason: 'cli_unavailable' }; } }),
  { kind: 'consumed', manifested: 0, pending: 1 });
  assert.equal((await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot, runCli })).manifested, 1);
  assert.equal(calls, 3);
  assert.equal((await box.extractionUsage('claude', 's')).calls, 3);
  await initializeSession(root, 'ended', { event: 'SessionStart', stateRoot });
  assert.equal((await recordSessionCheckout(current, 'claude', 'ended', root)).kind, 'bound');
  assert.equal((await box.enqueueCheckpoint({ ...row, sessionId: 'ended', sliceHash: 'f'.repeat(64) },
    { projectId: 'p', policyVersion: 'native-v1' })).kind, 'queued');
  assert.equal((await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot,
    runCli })).manifested, 1);
  assert.equal(calls, 4);
  const third = path.join(dir, 'third-checkout');
  await fs.mkdir(third);
  git(third, 'init', '-q');
  process.env.CLAUDE_CONFIG_DIR = third;
  assert.equal((await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's', stateRoot, runCli })).reason,
    'cli_profile_untrusted');
  assert.equal(calls, 4);
});

test('owner extraction lock serializes independent consumers without capture lock', async t => {
  const { stateRoot } = await fixture(t);
  let active = 0;
  let peak = 0;
  await Promise.all([0, 1].map(() => withProjectLock(stateRoot, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 60));
    active--;
  }, 'extract.lock')));
  assert.equal(peak, 1);
});

test('consumer binds pending checkpoint to the exact trusted worktree', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  const worktree = path.join(dir, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'linked', worktree);
  const config = JSON.stringify({ provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } });
  for (const checkout of [root, worktree]) {
    await fs.mkdir(path.join(checkout, '.cbs'));
    await fs.writeFile(path.join(checkout, '.cbs', 'memoria.json'), config);
  }
  const current = await inspectConfiguration(worktree, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  assert.equal((await applyNativeExclusion(worktree,
    { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root })).kind, 'applied');
  await initializeSession(worktree, 'linked-session', { event: 'SessionStart', stateRoot });
  assert.equal((await recordSessionCheckout(current, 'codex', 'linked-session', worktree)).kind, 'bound');
  const box = createOutbox(current.stateDir);
  await box.enqueueCheckpoint({ cli: 'codex', sessionId: 'linked-session', start: 0, end: 10,
    sliceHash: 'c'.repeat(64), messages: [{ messageId: 'm', role: 'user', speakerRole: 'user',
      actor: 'owner', origin: 'human', text: 'Rule X.', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 10 }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior; });
  let calls = 0;
  const runCli = async () => { calls++; return { kind: 'success', candidates: [], no_facts: true,
    model: 'claude-sonnet-5-5', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; };
  assert.equal((await consumeCheckpoints({ cli: 'codex', cwd: root, sessionId: 'linked-session',
    stateRoot, runCli })).reason, 'session_checkout_changed');
  assert.equal(calls, 0);
  assert.equal((await consumeCheckpoints({ cli: 'codex', cwd: worktree, sessionId: 'linked-session',
    stateRoot, runCli })).manifested, 1);
  assert.equal(calls, 1);
});
