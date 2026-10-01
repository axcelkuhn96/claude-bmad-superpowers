import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readCompleteJsonl, parsePersistedSlice } from '../base/memoria/transcript.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { captureEvent } from '../base/memoria/checkpoint.mjs';
import { applyNativeExclusion, restoreNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';
import { reconcileStore } from '../base/memoria/ledger.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';

const fixture = name => path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'fixtures', name);
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mem0-recovery-'));
const run = promisify(execFile);

test('reader stops before incomplete UTF-8 record and counts CRLF bytes', () => {
  const first = Buffer.from('{"role":"user","text":"ação"}\r\n');
  const partial = Buffer.concat([Buffer.from('{"role":"assistant","text":"'), Buffer.from('ç').subarray(0, 1)]);
  const parsed = readCompleteJsonl(Buffer.concat([first, partial]), 19);
  assert.equal(parsed.lastCompleteByte, 19 + first.length);
  assert.deepEqual(parsed.records.map(r => [r.start, r.end, r.value.text]), [[19, 19 + first.length, 'ação']]);
});

test('sidechain user role and unproved Codex source never become direct human', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claude = JSON.parse((await fs.readFile(fixture('memoria-native-claude.jsonl'), 'utf8')).split('\n')[0]);
  claude.isSidechain = true;
  const cp = path.join(dir, 'claude.jsonl'); await fs.writeFile(cp, JSON.stringify(claude) + '\n');
  const sidechain = await parsePersistedSlice({ cli: 'claude', transcriptPath: cp, sessionId: 'native-session' });
  assert.notEqual(sidechain.messages[0].origin, 'human');
  const codex = (await fs.readFile(fixture('memoria-native-codex.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  codex[0].payload.thread_source = 'unknown';
  const xp = path.join(dir, 'codex.jsonl'); await fs.writeFile(xp, codex.map(x => JSON.stringify(x)).join('\n') + '\n');
  const unknown = await parsePersistedSlice({ cli: 'codex', transcriptPath: xp, sessionId: 'native-session' });
  assert.notEqual(unknown.messages[0].origin, 'human');
});

for (const [cli, filename] of [['claude', 'memoria-native-claude.jsonl'], ['codex', 'memoria-native-codex.jsonl']]) {
  test(`${cli} native messages retain role, actor, timestamp, ID and byte offsets`, async () => {
    const parsed = await parsePersistedSlice({ cli, transcriptPath: fixture(filename), start: 0,
      sessionId: 'native-session' });
    assert.deepEqual(parsed.messages.map(m => m.origin), ['human', 'tool', 'tool', 'assistant']);
    assert.equal(parsed.messages[2].actor === 'user', false);
    assert.match(parsed.messages[2].text, /User decided:/);
    assert.equal(parsed.messages[0].sessionId, 'native-session');
    for (const m of parsed.messages) {
      assert.ok(m.messageId);
      assert.match(m.timestamp, /^2026-/);
      assert.ok(m.end > m.start);
      assert.equal(m.policyVersion, 'native-v1');
    }
    assert.equal(parsed.messages.at(-1).end, parsed.lastCompleteByte);
  });
}

test('outbox persists one operation per project, CLI, session and interval, ACK only with proof', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const bytes = await fs.readFile(fixture('memoria-native-claude.jsonl'));
  const parsed = await parsePersistedSlice({ cli: 'claude', transcriptPath: fixture('memoria-native-claude.jsonl'), start: 0, sessionId: 'native-session' });
  const slice = { cli: 'claude', sessionId: 'native-session', start: 0, end: parsed.lastCompleteByte,
    sliceHash: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), messages: parsed.messages };
  const first = await outbox.enqueueCheckpoint(slice, { projectId: 'project-a', policyVersion: 'native-v1' });
  assert.equal(first.kind, 'queued');
  assert.equal((await outbox.enqueueCheckpoint(slice, { projectId: 'project-a', policyVersion: 'native-v1' })).operationId, first.operationId);
  assert.equal((await createOutbox(dir).pending()).length, 1);
  assert.equal((await outbox.cursor('claude', 'native-session')).ackedEnd, 0);
  assert.equal((await outbox.ackVerified(first.operationId, {})).kind, 'blocked');
  assert.equal((await outbox.cursor('claude', 'native-session')).ackedEnd, 0);
  assert.equal((await outbox.ackVerified(first.operationId, { externalId: first.operationId, sdkId: 'sdk-1', qdrantId: 'q-1', projectId: 'project-a', status: 'active' })).kind, 'acked');
  assert.equal((await createOutbox(dir).cursor('claude', 'native-session')).ackedEnd, slice.end);
  const second = await outbox.enqueueCheckpoint({ ...slice, sessionId: 's2',
    messages: slice.messages.map(message => ({ ...message, sessionId: 's2' })) },
  { projectId: 'project-a', policyVersion: 'native-v1' });
  assert.notEqual(first.operationId, second.operationId);
});

test('Task3 verified reconciliation callback advances ACK after remote read', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const queued = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 9,
    sliceHash: 'a'.repeat(64), messages: [{ origin: 'human', text: 'ação' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const operation = { externalId: queued.operationId, projectId: 'p' };
  let reads = 0;
  const remote = { externalId: queued.operationId, projectId: 'p', sdkId: 'sdk-1', qdrantId: 'q-1', status: 'active' };
  const result = await reconcileStore(operation, { findRemote: async () => null,
    addViaSdk: async () => {}, readRemote: async () => { reads++; return remote; },
    ackLocal: (id, proof) => outbox.ackVerified(id, proof),
  });
  assert.notEqual(result.kind, 'stored');
  assert.equal(reads, 0);
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 0);
  const verified = await reconcileStore(operation, { findRemote: async () => remote,
    addViaSdk: async () => { throw new Error('duplicate'); },
    ackLocal: (id, proof) => outbox.ackVerified(id, proof),
  });
  assert.equal(verified.kind, 'stored');
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 9);
});

test('remote outage records bounded retry state while bytes and ACK remain pending', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir);
  const queued = await outbox.enqueueCheckpoint({ cli: 'claude', sessionId: 's', start: 0, end: 9,
    sliceHash: 'f'.repeat(64), messages: [{ text: 'safe' }] },
  { projectId: 'p', policyVersion: 'native-v1' });
  const before = Date.now();
  const failed = await outbox.markFailed(queued.operationId, 'remote_unavailable');
  assert.equal(failed.kind, 'pending');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.retryAt > before);
  assert.equal((await createOutbox(dir).pending())[0].lastError, 'remote_unavailable');
  assert.equal((await outbox.cursor('claude', 's')).ackedEnd, 0);
  assert.equal((await outbox.ready(before)).length, 0);
  assert.equal((await outbox.ready(failed.retryAt)).length, 1);
  for (let n = 1; n < 5; n++) await outbox.markFailed(queued.operationId, 'remote_unavailable');
  assert.equal((await outbox.ready(Date.now() + 1000000)).length, 0);
  assert.equal((await outbox.pending()).length, 1);
});

test('capacity rejects without advancing queued cursor; replay follows freed capacity', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outbox = createOutbox(dir, { maxBytes: 350 });
  const one = { cli: 'codex', sessionId: 's', start: 0, end: 4, sliceHash: 'a'.repeat(64), messages: [{ text: 'x' }] };
  const queued = await outbox.enqueueCheckpoint(one, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(queued.kind, 'queued');
  assert.equal(queued.alert, true);
  const full = await outbox.enqueueCheckpoint({ ...one, start: 4, end: 8, sliceHash: 'b'.repeat(64) }, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(full.kind, 'full');
  assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 4);
  await outbox.ackVerified(queued.operationId, { externalId: queued.operationId, sdkId: 's', qdrantId: 'q', projectId: 'p', status: 'active' });
  const replay = await createOutbox(dir, { maxBytes: 350 }).enqueueCheckpoint({ ...one, start: 4, end: 8, sliceHash: 'b'.repeat(64) }, { projectId: 'p', policyVersion: 'native-v1' });
  assert.equal(replay.kind, 'queued');
  assert.equal((await outbox.cursor('codex', 's')).queuedEnd, 8);
});

test('unconfigured capture is a default pass-through and never starts optional state', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateRoot = path.join(dir, 'state');
  const result = await captureEvent({ cli: 'claude', event: 'SessionStart', payload: {
    cwd: dir, session_id: 's', transcript_path: fixture('memoria-native-claude.jsonl'),
    hook_event_name: 'SessionStart',
  }, stateRoot });
  assert.equal(result.kind, 'pass_through');
  await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' });
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} capture requires a locally applied native exclusion and exact hooks`, async t => {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await run('git', ['init', '-q', dir]);
    const stateRoot = path.join(dir, 'state');
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot })).kind, 'blocked');
    assert.equal((await applyNativeExclusion(dir, { cli, stateRoot, installedPlugin: true })).kind, 'applied');
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot, installedPlugin: true })).kind, 'verified');
    const nativePath = path.join(dir, cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml');
    if (cli === 'claude') {
      const data = JSON.parse(await fs.readFile(nativePath, 'utf8'));
      data.enabledPlugins['claude-mem@thedotmack'] = true;
      await fs.writeFile(nativePath, JSON.stringify(data));
    } else {
      await fs.writeFile(nativePath, (await fs.readFile(nativePath, 'utf8')).replace('enabled = false', 'enabled = true'));
    }
    assert.equal((await verifyNativeCapture(dir, { cli, stateRoot, installedPlugin: true })).kind, 'blocked');
  });
}

test('legacy Codex exclusion snapshot still restores without a Task4 hook file', async t => {
  const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); await fs.mkdir(root); await run('git', ['init', '-q', root]);
  const stateRoot = path.join(dir, 'state');
  await applyNativeExclusion(root, { cli: 'codex', stateRoot, installedPlugin: true });
  const snap = path.join(stateRoot, (await import('node:crypto')).createHash('sha256').update(root).digest('hex'), 'native-codex.json');
  const saved = JSON.parse(await fs.readFile(snap, 'utf8'));
  for (const key of ['capturePath', 'captureExisted', 'captureExclude', 'pluginChecked']) delete saved[key];
  await fs.writeFile(snap, JSON.stringify(saved));
  await fs.rm(path.join(root, '.codex/hooks.json'));
  assert.equal((await restoreNativeExclusion(root, { cli: 'codex', stateRoot })).kind, 'restored');
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} SessionStart guard captures persisted bytes once and rejects live config mutation`, async t => {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'project'); await fs.mkdir(root); await run('git', ['init', '-q', root]);
    const stateRoot = path.join(dir, 'state');
    const config = { provider: 'mem0', project_id: 'project-one',
      qdrant: { url: 'https://qdrant.internal', collection: 'cbs-project-one', api_key_env: 'CBS_MEMORIA_TEST_KEY' },
      embedding: { model: 'multilingual-e5-small', dimension: 384,
        fingerprint: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' } };
    await fs.mkdir(path.join(root, '.cbs'));
    await fs.writeFile(path.join(root, '.cbs/memoria.json'), JSON.stringify(config));
    const transcriptPath = path.join(dir, cli === 'claude' ? 'native-session.jsonl' : 'rollout-native-session.jsonl');
    await fs.copyFile(fixture(`memoria-native-${cli}.jsonl`), transcriptPath);
    const payload = { cwd: root, session_id: 'native-session', transcript_path: transcriptPath,
      hook_event_name: 'SessionStart' };
    const args = { cli, event: 'SessionStart', payload, stateRoot, installedPlugin: true };
    assert.equal((await captureEvent(args)).kind, 'blocked');
    await assert.rejects(fs.stat(stateRoot), { code: 'ENOENT' });
    await applyNativeExclusion(root, { cli, stateRoot, installedPlugin: true });
    assert.equal((await captureEvent(args)).reason, 'trust_changed');
    const resolution = await inspectConfiguration(root, { stateRoot });
    await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
    const first = await captureEvent(args);
    assert.equal(first.kind, 'queued');
    const repeated = await captureEvent(args);
    assert.equal(repeated.kind, 'no_complete_bytes');
    const outbox = createOutbox(path.join(stateRoot, (await import('node:crypto')).createHash('sha256').update(root).digest('hex')));
    assert.equal((await outbox.pending()).length, 1);
    for (let n = 0; n < 20; n++) {
      assert.equal((await captureEvent({ ...args, event: 'PostToolUse', payload: { ...payload, hook_event_name: 'PostToolUse' } })).kind, 'blocked');
    }
    assert.equal((await outbox.pending()).length, 1);
    config.project_id = 'changed';
    await fs.writeFile(path.join(root, '.cbs/memoria.json'), JSON.stringify(config));
    assert.equal((await captureEvent({ ...args, event: 'Stop', payload: { ...payload, hook_event_name: 'Stop' } })).kind, 'blocked');
  });
}

test('fault at each item file boundary never acknowledges and replays at most one ID', async t => {
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const row = { cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'c'.repeat(64), messages: [{ text: 'durable' }] };
    const identity = { projectId: 'p', policyVersion: 'native-v1' };
    const broken = createOutbox(dir, { fault: stage => { if (stage === boundary) throw new Error('injected'); } });
    await assert.rejects(broken.enqueueCheckpoint(row, identity), /injected/);
    const recovered = createOutbox(dir);
    const pending = await recovered.pending();
    assert.ok(pending.length <= 1);
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, 0);
    const replay = await recovered.enqueueCheckpoint(row, identity);
    assert.equal(replay.kind, 'queued');
    assert.equal((await recovered.pending()).length, 1);
  }
});

test('real SIGKILL at item boundaries replays the durable operation once', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
const box = createOutbox(process.argv[1], { fault: stage => { if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });
await box.enqueueCheckpoint({cli:'codex',sessionId:'crash',start:0,end:4,sliceHash:'d'.repeat(64),messages:[{text:'durable'}]}, {projectId:'p',policyVersion:'native-v1'});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, boundary], { stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, 'SIGKILL', `${boundary}: ${JSON.stringify(result)}`);
    const outbox = createOutbox(dir);
    const before = await outbox.pending();
    assert.equal(before.length, boundary === 'after_write' || boundary === 'after_file_sync' ? 0 : 1);
    assert.equal((await outbox.cursor('codex', 'crash')).ackedEnd, 0);
    const replay = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'd'.repeat(64), messages: [{ text: 'durable' }] },
    { projectId: 'p', policyVersion: 'native-v1' });
    assert.equal(replay.kind, 'queued');
    assert.equal((await outbox.pending()).length, 1);
  }
});

test('real SIGKILL at ACK boundaries never advances before durable receipt', async t => {
  const moduleUrl = new URL('../base/memoria/outbox.mjs', import.meta.url).href;
  for (const boundary of ['after_write', 'after_file_sync', 'after_rename', 'after_dir_sync']) {
    const dir = await temp(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const outbox = createOutbox(dir);
    const queued = await outbox.enqueueCheckpoint({ cli: 'codex', sessionId: 'crash', start: 0, end: 4,
      sliceHash: 'e'.repeat(64), messages: [{ text: 'durable' }] },
    { projectId: 'p', policyVersion: 'native-v1' });
    const proof = { externalId: queued.operationId, projectId: 'p', sdkId: 'sdk-1', qdrantId: 'q-1', status: 'active' };
    const source = `import { createOutbox } from ${JSON.stringify(moduleUrl)};
const box = createOutbox(process.argv[1], { fault: stage => { if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });
await box.ackVerified(process.argv[3], JSON.parse(process.argv[4]));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, boundary,
      queued.operationId, JSON.stringify(proof)], { stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, 'SIGKILL', `${boundary}: ${JSON.stringify(result)}`);
    const recovered = createOutbox(dir);
    const expected = boundary === 'after_write' || boundary === 'after_file_sync' ? 0 : 4;
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, expected);
    assert.equal((await recovered.ackVerified(queued.operationId, proof)).kind, 'acked');
    assert.equal((await recovered.cursor('codex', 'crash')).ackedEnd, 4);
    assert.equal((await recovered.pending()).length, 0);
  }
});
