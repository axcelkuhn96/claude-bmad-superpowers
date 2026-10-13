import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FrameReader, encodeFrame } from '../base/memoria/frame.mjs';
import { EventEmitter } from 'node:events';
import { createMcp } from '../base/memoria/mcp.mjs';
import { scheduleExtraction, consumeCheckpoints } from '../base/memoria/extract-worker.mjs';
import { recordSessionCheckout } from '../base/memoria/session-checkout.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { configureExtractor } from '../base/memoria/policy.mjs';
import { withProjectLock } from '../base/memoria/ledger.mjs';
import { createLaunch, bindLaunch, resolveBoundLaunch, launchCli } from '../base/memoria/launch.mjs';
import { recallForPrompt } from '../base/memoria/hook-recall.mjs';
import { inspectConfiguration, initializeSession } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { applyNativeExclusion, restoreNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';
import { RUNTIME_PINS, runtimePython, openArtifactIdentity } from '../base/memoria/runtime.mjs';
import { pinDestination } from '../base/memoria/activation.mjs';
import net from 'node:net';
import { readBrokerRequest, manageBrokerConnection, brokerEndpointStatus, prepareBrokerEndpoint, brokerPath, authorizeBrokerLease } from '../base/memoria/broker.mjs';

test('broker connection survives disconnect before and after late response, then serves next client', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-disconnect-'));
  const file = path.join(dir, 'sock');
  let accepted = 0;
  const links = [];
  const server = net.createServer(socket => {
    const link = manageBrokerConnection(socket, () => {});
    links.push(link);
    accepted++;
    if (accepted === 1) {
      setTimeout(() => link.respond({ kind: 'items', items: [] }), 40);
    } else if (accepted === 2) {
      link.respond({ kind: 'items', items: [] });
      socket.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      socket.emit('error', Object.assign(new Error('late ECONNRESET'), { code: 'ECONNRESET' }));
    } else link.respond({ kind: 'items', items: [{ id: 'next' }] });
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(file, resolve));
  const first = net.createConnection(file);
  await new Promise(resolve => first.once('connect', resolve));
  first.destroy();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(links[0].respond({ kind: 'items', items: [] }), false);
  const second = net.createConnection(file);
  second.on('error', () => {});
  second.resume();
  await Promise.race([new Promise(resolve => second.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('second_not_closed')), 300))]);
  const third = net.createConnection(file);
  const parser = new FrameReader({ response: true });
  const result = await Promise.race([new Promise((resolve, reject) => {
    third.on('data', bytes => { for (const frame of parser.push(bytes)) resolve(frame.value); });
    third.once('error', reject);
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('third_no_response')), 300))]);
  assert.deepEqual(result, { kind: 'items', items: [{ id: 'next' }] });
  assert.equal(links[1].signal.aborted, true);
  third.destroy();
});

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

test('review CLI passes its private state root through to storeMemory', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  await fs.mkdir(path.join(root, '.cbs'));
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const current = await initializeSession(root, 's', { event: 'SessionStart', stateRoot });
  assert.equal(current.provider, 'mem0');
  assert.equal((await recordSessionCheckout(current, 'claude', 's', root)).kind, 'bound');

  const candidateUrl = new URL('../base/memoria/candidates.mjs', import.meta.url).href;
  const bridgeUrl = new URL('../base/memoria/bridge.mjs', import.meta.url).href;
  const ledgerUrl = new URL('../base/memoria/ledger.mjs', import.meta.url).href;
  const replacement = `import { storeMemory } from ${JSON.stringify(bridgeUrl)};\n` +
    `import { externalIdFor } from ${JSON.stringify(ledgerUrl)};\n` +
    `export async function reviewCandidateOnTerminal(_checkpoint, _key, options) {\n` +
    `  const sourceIdentity = { projectId: 'p', originCli: 'claude', sessionId: 's', ` +
    `start: 0, end: 1, sliceHash: 'a'.repeat(64), policyVersion: 'native-v1', candidateKey: 'rule' };\n` +
    `  return storeMemory(options.cwd, options.sessionId, { externalId: externalIdFor(sourceIdentity), ` +
    `projectId: 'p', sessionId: 's', sourceIdentity, text: 'A release checklist is required.', ` +
    `metadata: { source: 'm1', actor: 'owner', origin: 'user_direct', scope: 'project', ` +
    `evidence_at: '2026-10-01T00:00:00Z' }, approval: { kind: 'approved' } }, options.readSecret, options);\n` +
    `}\n`;
  const preload = path.join(dir, 'review-import-hook.mjs');
  await fs.writeFile(preload, `const source = ${JSON.stringify(replacement)};\n` +
    `export async function load(url, context, nextLoad) {\n` +
    `  if (url === ${JSON.stringify(candidateUrl)}) return { format: 'module', shortCircuit: true, source };\n` +
    `  return nextLoad(url, context);\n` +
    `}\n`);
  const review = new URL('../base/memoria/review.mjs', import.meta.url).pathname;
  const child = spawnSync('/usr/bin/script', ['-q', '-e', '-c',
    `${process.execPath} --experimental-loader ${preload} ${review} claude ${root} s checkpoint rule`, '/dev/null'], {
    encoding: 'utf8', env: { ...process.env, CBS_MEMORIA_STATE_ROOT: stateRoot },
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /blocked: trust_changed/, child.stderr);
});

test('outbox observation fires after a real durable item is readable', async t => {
  const { stateRoot } = await fixture(t);
  const stateDir = path.join(stateRoot, 'observed');
  let observed;
  const box = createOutbox(stateDir, { onDurable: async file => {
    if (!file.includes(`${path.sep}items${path.sep}`)) return;
    observed = JSON.parse(await fs.readFile(file, 'utf8'));
  } });
  const slice = { cli: 'claude', sessionId: 'observed', start: 0, end: 1,
    sliceHash: 'a'.repeat(64), messages: [] };
  const queued = await box.enqueueCheckpoint(slice, { projectId: 'fixture', policyVersion: 'v1' });
  assert.equal(queued.kind, 'queued');
  assert.equal(observed.operationId, queued.operationId);
});

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

test('broker accepts one request split across real Unix socket writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-frame-'));
  const file = path.join(dir, 'sock');
  const server = net.createServer(socket => readBrokerRequest(socket, frame =>
    socket.end(encodeFrame({ kind: 'items', query: frame.value.query }, undefined, true))));
  t.after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(file, resolve));
  const client = net.createConnection(file);
  const response = new FrameReader({ response: true });
  const result = new Promise((resolve, reject) => {
    client.on('data', chunk => {
      const frames = response.push(chunk);
      if (frames.length) resolve(frames[0].value);
    });
    client.on('error', reject);
    client.on('close', () => reject(new Error('fragmented_request_rejected')));
  });
  await new Promise(resolve => client.once('connect', resolve));
  const frame = encodeFrame({ query: 'split' }, Buffer.from('key'));
  client.write(frame.subarray(0, 6));
  await new Promise(resolve => setTimeout(resolve, 10));
  client.write(frame.subarray(6));
  assert.deepEqual(await result, { kind: 'items', query: 'split' });
  client.destroy();
});

test('broker closes an incomplete frame at an absolute reception deadline and becomes idle', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-incomplete-'));
  const file = path.join(dir, 'sock');
  let accepted = 0;
  let active = 0;
  let idle;
  const server = net.createServer(socket => {
    active++;
    clearTimeout(idle);
    readBrokerRequest(socket, () => { accepted++; }, { receptionMs: 80 });
    socket.once('close', () => {
      active--;
      if (!active) idle = setTimeout(() => server.close(), 20);
    });
  });
  t.after(async () => {
    clearTimeout(idle);
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(file, resolve));
  const closed = new Promise(resolve => server.once('close', resolve));
  const client = net.createConnection(file);
  let clientError;
  client.on('error', error => { if (error.code !== 'EPIPE') clientError = error; });
  await new Promise(resolve => client.once('connect', resolve));
  const began = performance.now();
  const frame = encodeFrame({ query: 'incomplete' }, Buffer.from('key'));
  client.write(frame.subarray(0, 13));
  const drip = setInterval(() => client.write(frame.subarray(13, 14)), 20);
  client.once('close', () => clearInterval(drip));
  t.after(() => { clearInterval(drip); client.destroy(); });
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('broker_not_idle')), 350))]);
  clearInterval(drip);
  assert.ok(performance.now() - began < 300);
  assert.equal(active, 0);
  assert.equal(accepted, 0);
  assert.ifError(clientError);
});

test('broker closes a client holding only a partial header', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-header-'));
  const file = path.join(dir, 'sock');
  let accepted = 0;
  const server = net.createServer(socket => readBrokerRequest(socket, () => { accepted++; }, { receptionMs: 50 }));
  t.after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(file, resolve));
  const client = net.createConnection(file);
  await new Promise(resolve => client.once('connect', resolve));
  client.write(Buffer.from('M0BW'));
  await Promise.race([
    new Promise(resolve => client.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('partial_header_left_open')), 250)),
  ]);
  assert.equal(accepted, 0);
});

test('broker rejects trailing partial bytes without processing the request', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-trailing-'));
  const file = path.join(dir, 'sock');
  let processed = 0;
  const server = net.createServer(socket => readBrokerRequest(socket, () => { processed++; }));
  t.after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(file, resolve));
  const client = net.createConnection(file);
  await new Promise(resolve => client.once('connect', resolve));
  client.write(Buffer.concat([encodeFrame({ query: 'fact' }, Buffer.from('key')), Buffer.from('M0')]));
  await new Promise(resolve => client.once('close', resolve));
  assert.equal(processed, 0);
});

test('broker recovers a verified orphan socket after its own listener crashes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-orphan-'));
  const file = path.join(dir, 'encoder.sock');
  const child = spawn(process.execPath, ['-e',
    'require("node:net").createServer().listen(process.argv[1],()=>{require("node:fs").chmodSync(process.argv[1],0o600);process.stdout.write("ready\\n")})', file],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  assert.equal(await brokerEndpointStatus(dir), 'live');
  assert.equal(await prepareBrokerEndpoint(dir), 'live');
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(await brokerEndpointStatus(dir), 'orphan');
  assert.equal(await prepareBrokerEndpoint(dir), 'ready');
  assert.equal(await brokerEndpointStatus(dir), 'missing');
});

test('DNS lookup is killed at recall deadline and next destination is serviced', async t => {
  let lookupChild;
  const started = performance.now();
  const pending = await pinDestination('https://qdrant.internal/', {
    deadlineAt: Date.now() + 130,
    spawnLookup: () => {
      lookupChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      return lookupChild;
    },
  });
  assert.deepEqual(pending, { kind: 'blocked', reason: 'deadline' });
  assert.ok(performance.now() - started < 450);
  await new Promise(resolve => lookupChild.once('exit', resolve));
  assert.equal(lookupChild.signalCode, 'SIGKILL');
  const next = await pinDestination('http://localhost/', { deadlineAt: Date.now() + 300,
    lookup: async () => ['127.0.0.1'] });
  assert.equal(next.kind, 'pinned');
  t.after(() => { if (lookupChild.exitCode === null && lookupChild.signalCode === null) lookupChild.kill('SIGKILL'); });
});

test('hook child exits despite a host DNS implementation that never answers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-dns-hook-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'hang-dns.cjs');
  await fs.writeFile(preload,
    'require("node:dns/promises").lookup=()=>new Promise(()=>setInterval(()=>{},1000));\n');
  const script = `import { recallForPrompt } from './base/memoria/hook-recall.mjs';
import { pinDestination } from './base/memoria/activation.mjs';
await recallForPrompt({ cli:'claude', result:{kind:'queued'},
  payload:{cwd:'/fixture',session_id:'s',prompt:'rule'}, began:performance.now(),
  resolve:async()=>({provider:'mem0',projectId:'p',stateDir:process.argv[1]}),
  search:(_query,_secret,options)=>pinDestination('https://qdrant.invalid/',
    {deadlineAt:Date.now()+options.deadlineMs}) });`;
  const started = performance.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir],
    { cwd: path.resolve('.'), stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }); }, 1300);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  assert.ok(performance.now() - started < 1300);
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
    { kind: 'unavailable', reason: 'invalid_arguments' });
  assert.equal(calls, 0);
  assert.deepEqual(await bound.call('search', { query: 'negative', project_id: 'other' }),
    { kind: 'unavailable', reason: 'invalid_arguments' });
  assert.equal(calls, 0);
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

test('MCP search failure is typed and does not escape the tool call', async () => {
  const mcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', projectId: 'p', cwd: '/fixture', nativeSessionId: 's' }),
    search: async () => { throw new Error('synthetic_search_failure'); } });
  assert.deepEqual(await mcp.call('search', { query: 'rule' }),
    { kind: 'unavailable', reason: 'search_failed' });
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
  assert.equal((await sourceMcp.call('source', { memory_id: 'historical' })).kind, 'remote_metadata');
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

test('native SessionStart binds before Claude creates its transcript, then Stop captures verified bytes', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  await fs.mkdir(path.join(root, '.cbs'));
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'applied');
  const current = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  const launch = await createLaunch(root, 'claude', { stateRoot });
  assert.equal(launch.kind, 'created');
  const transcriptPath = path.join(dir, 'native-session.jsonl');
  const payload = { cwd: root, session_id: 'native-session', transcript_path: transcriptPath,
    hook_event_name: 'SessionStart' };
  const moduleUrl = new URL('../base/memoria/checkpoint.mjs', import.meta.url).href;
  const script = `import { captureEvent } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(await captureEvent(JSON.parse(process.argv[1]))));`;
  const invoke = (event, token, sessionId = 'native-session', file = transcriptPath) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify({ cli: 'claude', event, payload: { ...payload, session_id: sessionId,
        transcript_path: file, hook_event_name: event }, stateRoot })],
    { encoding: 'utf8', env: { ...process.env, CBS_MEMORIA_LAUNCH_ID: token } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = invoke('SessionStart', launch.token);
  assert.equal(first.kind, 'no_complete_bytes', JSON.stringify(first));
  assert.equal((await resolveBoundLaunch(launch.token, 'claude', { stateRoot })).nativeSessionId, 'native-session');
  const pretranscript = invoke('UserPromptSubmit', launch.token);
  assert.equal(pretranscript.kind, 'no_complete_bytes');
  assert.equal((await createOutbox(current.stateDir).pending()).length, 0);
  const injection = await recallForPrompt({ cli: 'claude', payload: {
    ...payload, hook_event_name: 'UserPromptSubmit', prompt: 'What is the approved rule?',
  }, result: pretranscript, stateRoot,
  search: async () => ({ kind: 'items', items: [{ projectId: 'p', sdkId: 'fixture', status: 'active',
    score: 0.9, scoreSource: 'mem0_sdk_search', text: 'Use the approved fixture rule.',
    metadata: { source: 'fixture-message', actor: 'owner', evidence_at: '2026-09-01T00:00:00Z',
      origin: 'user_direct', speaker_role: 'user', scope: 'project', valid_from: '2026-09-01T00:00:00Z' } }] }),
  now: () => '2026-10-01T00:00:00Z' });
  assert.match(injection?.hookSpecificOutput.additionalContext ?? '', /approved fixture rule/);
  assert.equal((await createOutbox(current.stateDir).pending()).length, 0);
  assert.equal(invoke('Stop', launch.token).reason, 'missing_transcript');
  assert.equal(invoke('SessionEnd', launch.token).reason, 'missing_transcript');
  assert.equal(invoke('UserPromptSubmit', launch.token, 'unbound-session',
    path.join(dir, 'unbound-session.jsonl')).reason, 'fresh_session');
  assert.equal(invoke('UserPromptSubmit', launch.token, 'native-session',
    path.join(dir, 'wrong.jsonl')).reason, 'transcript_session_mismatch');
  const hostile = path.join(dir, 'hostile');
  await fs.mkdir(hostile);
  await fs.symlink(transcriptPath, path.join(hostile, 'native-session.jsonl'));
  assert.equal(invoke('UserPromptSubmit', launch.token, 'native-session',
    path.join(hostile, 'native-session.jsonl')).reason, 'unsafe_transcript');
  const directorySource = path.join(dir, 'directory', 'native-session.jsonl');
  await fs.mkdir(directorySource, { recursive: true });
  assert.equal(invoke('UserPromptSubmit', launch.token, 'native-session', directorySource).reason,
    'unsafe_transcript');
  await fs.copyFile(new URL('./fixtures/memoria-native-claude.jsonl', import.meta.url), transcriptPath);
  assert.equal(invoke('Stop', launch.token).kind, 'queued');
  assert.equal((await createOutbox(current.stateDir).pending()).length, 1);

  const unsafe = await createLaunch(root, 'claude', { stateRoot });
  const link = path.join(dir, 'unsafe-session.jsonl');
  await fs.symlink(transcriptPath, link);
  assert.equal(invoke('SessionStart', unsafe.token, 'unsafe-session', link).reason, 'unsafe_transcript');
  assert.equal((await resolveBoundLaunch(unsafe.token, 'claude', { stateRoot })).reason, 'unbound');

  const deferred = await createLaunch(root, 'claude', { stateRoot });
  const lateLink = path.join(dir, 'deferred-session.jsonl');
  assert.equal(invoke('SessionStart', deferred.token, 'deferred-session', lateLink).kind, 'no_complete_bytes');
  await fs.symlink(transcriptPath, lateLink);
  assert.equal(invoke('Stop', deferred.token, 'deferred-session', lateLink).reason, 'unsafe_transcript');
  assert.equal((await createOutbox(current.stateDir).pending()).length, 1);
});

test('native restore preserves user handlers sharing CBS PreToolUse matcher', async t => {
  const { root, stateRoot } = await fixture(t);
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(hooksPath));
  const userHandler = { type: 'command', command: 'user-hook', timeout: 7 };
  const original = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [userHandler] }] }, other: true };
  await fs.writeFile(hooksPath, JSON.stringify(original, null, 2) + '\n');
  const options = { cli: 'codex', stateRoot, installedPlugin: true };

  assert.equal((await applyNativeExclusion(root, options)).kind, 'applied');
  const active = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
  const cbsGroup = active.hooks.PreToolUse.find(group =>
    group.hooks.some(handler => handler.command?.includes('skill-hook-cli.mjs')));
  cbsGroup.hooks.push({ ...userHandler, command: 'user-hook-added-after-activation' });
  await fs.writeFile(hooksPath, JSON.stringify(active, null, 2) + '\n');
  assert.equal((await verifyNativeCapture(root, options)).kind, 'verified');
  assert.equal((await restoreNativeExclusion(root, options)).kind, 'restored');
  const restored = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
  assert.deepEqual(restored.hooks.PreToolUse, [
    original.hooks.PreToolUse[0],
    { matcher: 'Bash', hooks: [{ ...userHandler, command: 'user-hook-added-after-activation' }] },
  ]);
  assert.equal(restored.other, true);
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

test('trusted linked Codex launch carries only its verified hooks as session config', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  const linked = path.join(dir, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'linked-hooks', linked);
  const config = JSON.stringify({ provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } });
  for (const checkout of [root, linked]) {
    await fs.mkdir(path.join(checkout, '.cbs'));
    await fs.writeFile(path.join(checkout, '.cbs', 'memoria.json'), config);
  }
  const current = await inspectConfiguration(linked, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  assert.equal((await applyNativeExclusion(linked,
    { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root })).kind, 'applied');
  const expected = JSON.parse(await fs.readFile(path.join(linked, '.codex', 'hooks.json'), 'utf8')).hooks;
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  let onProbe;
  let held = 0;
  let active = 0;
  let idle;
  let expireWhenIdle = false;
  let rejectLease = false;
  const subdir = path.join(linked, 'nested');
  await fs.mkdir(subdir);
  const server = net.createServer(socket => {
    active++;
    clearTimeout(idle);
    onProbe?.();
    let lease = false;
    readBrokerRequest(socket, async frame => {
      if (frame.value.kind === 'launch_lease') {
        const authorized = !rejectLease && await authorizeBrokerLease(stateRoot,
          frame.value.cwd, current, frame.value.launchDigest, frame.secret);
        frame.secret.fill(0);
        if (!authorized) {
          socket.end(encodeFrame({ kind: 'unavailable', reason: 'lease_invalid' }, undefined, true));
          return;
        }
        lease = true;
        held++;
        socket.write(encodeFrame({ kind: 'leased' }, undefined, true));
      } else { frame.secret.fill(0); socket.end(); }
    });
    socket.once('close', () => {
      active--;
      if (lease) held--;
      if (!active && expireWhenIdle) idle = setTimeout(() => server.close(), 50);
    });
  });
  t.after(() => { clearTimeout(idle); server.close(); });
  await new Promise(resolve => server.listen(brokerPath(stateRoot), resolve));
  await fs.chmod(brokerPath(stateRoot), 0o600);
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const capture = path.join(dir, 'cli-args.json');
  const script = path.join(bin, 'codex');
  await fs.writeFile(script, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CBS_TEST_LAUNCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), launchId: process.env.CBS_MEMORIA_LAUNCH_ID, leaseSecret: process.env.CBS_MEMORIA_LEASE_SECRET }));\nif (process.env.CBS_TEST_LAUNCH_DELAY) setTimeout(() => {}, Number(process.env.CBS_TEST_LAUNCH_DELAY));\n`);
  await fs.chmod(script, 0o700);
  const oldPath = process.env.PATH;
  const oldCapture = process.env.CBS_TEST_LAUNCH_CAPTURE;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.CBS_TEST_LAUNCH_CAPTURE = capture;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldCapture === undefined) delete process.env.CBS_TEST_LAUNCH_CAPTURE;
    else process.env.CBS_TEST_LAUNCH_CAPTURE = oldCapture;
  });
  assert.deepEqual(await launchCli(subdir, 'codex', ['--model', 'safe-model'], { stateRoot }),
    { kind: 'exited', code: 0, signal: null });
  const seen = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(seen.cwd, subdir);
  assert.match(seen.launchId, /^[a-f0-9]{64}$/);
  for (const [event, groups] of Object.entries(expected)) {
    const command = groups[0].hooks[0].command;
    const matcher = event === 'PreToolUse' ? 'matcher="Bash",' : '';
    assert.ok(seen.args.includes(`hooks.${event}=[{${matcher}hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`), event);
  }
  assert.equal(seen.args.filter(arg => arg.startsWith('hooks.')).length, Object.keys(expected).length);
  assert.ok(seen.args.some(arg => arg.startsWith('mcp_servers.cbs_memoria.command=')));
  assert.equal(seen.args.includes('CBS_TEST_KEY'), false);
  assert.equal(seen.leaseSecret, undefined);
  await assert.rejects(fs.readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'), { code: 'ENOENT' });

  const oldDelay = process.env.CBS_TEST_LAUNCH_DELAY;
  process.env.CBS_TEST_LAUNCH_DELAY = '250';
  await fs.rm(capture);
  expireWhenIdle = true;
  let running;
  try {
    running = launchCli(linked, 'codex', [], { stateRoot });
    for (let i = 0; i < 100 && !await fs.access(capture).then(() => true, () => false); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(await fs.access(capture).then(() => true, () => false), true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(server.listening, true);
    assert.equal(held, 1);
    expireWhenIdle = false;
    assert.deepEqual(await running, { kind: 'exited', code: 0, signal: null });
  } finally {
    expireWhenIdle = false;
    clearTimeout(idle);
    if (oldDelay === undefined) delete process.env.CBS_TEST_LAUNCH_DELAY;
    else process.env.CBS_TEST_LAUNCH_DELAY = oldDelay;
    await running?.catch(() => {});
  }

  await fs.rm(capture);
  rejectLease = true;
  try {
    assert.equal((await launchCli(linked, 'codex', [], { stateRoot })).reason, 'lease_invalid');
    await assert.rejects(fs.readFile(capture, 'utf8'), { code: 'ENOENT' });
    assert.equal((await fs.readdir(path.join(stateRoot, 'launches'))).some(name => name.endsWith('.lease')), false);
  } finally { rejectLease = false; }

  assert.deepEqual(await launchCli(linked, 'codex', ['--model', 'safe-model', 'Qual regra?'], { stateRoot }),
    { kind: 'exited', code: 0, signal: null });
  assert.deepEqual(JSON.parse(await fs.readFile(capture, 'utf8')).args.slice(-2), ['--', 'Qual regra?']);
  for (const args of [['resume'], ['--', 'resume'], ['--profile', 'other'],
    ['--cd', root], ['--dangerously-bypass-hook-trust'], ['-c', 'hooks.SessionStart=[]']]) {
    assert.equal((await launchCli(linked, 'codex', args, { stateRoot })).reason, 'unsafe_cli_args');
  }

  const mainHooksFile = path.join(root, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(mainHooksFile), { recursive: true });
  const custom = [{ hooks: [{ type: 'command', command: 'echo custom' }] }];
  await fs.writeFile(mainHooksFile, JSON.stringify({ hooks: { PreToolUse: custom } }));
  assert.deepEqual(await launchCli(linked, 'codex', [], { stateRoot }),
    { kind: 'exited', code: 0, signal: null });
  assert.equal(JSON.parse(await fs.readFile(capture, 'utf8')).args.filter(arg =>
    arg.startsWith('hooks.')).length, Object.keys(expected).length);
  await fs.rm(mainHooksFile);

  assert.equal((await applyNativeExclusion(root,
    { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root })).kind, 'applied');
  const mainHooks = JSON.parse(await fs.readFile(mainHooksFile, 'utf8'));
  mainHooks.hooks.PreToolUse.push(...custom);
  await fs.writeFile(mainHooksFile, JSON.stringify(mainHooks));
  for (const checkout of [root, linked]) {
    assert.deepEqual(await launchCli(checkout, 'codex', [], { stateRoot }),
      { kind: 'exited', code: 0, signal: null });
    const launched = JSON.parse(await fs.readFile(capture, 'utf8'));
    assert.equal(launched.cwd, checkout);
    assert.equal(launched.args.filter(arg => arg.startsWith('hooks.')).length, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(mainHooksFile, 'utf8')).hooks.PreToolUse,
      mainHooks.hooks.PreToolUse);
  }
  const duplicate = structuredClone(mainHooks);
  duplicate.hooks.SessionStart.push(structuredClone(duplicate.hooks.SessionStart[0]));
  await fs.rm(capture);
  onProbe = () => writeFileSync(mainHooksFile, JSON.stringify(duplicate));
  assert.equal((await launchCli(linked, 'codex', [], { stateRoot })).reason, 'ambiguous_main_hooks');
  onProbe = undefined;
  await assert.rejects(fs.readFile(capture, 'utf8'), { code: 'ENOENT' });
  await fs.writeFile(mainHooksFile, JSON.stringify(mainHooks));
  await fs.writeFile(mainHooksFile, JSON.stringify(duplicate));
  assert.equal((await launchCli(linked, 'codex', [], { stateRoot })).reason, 'ambiguous_main_hooks');
  await fs.writeFile(mainHooksFile, JSON.stringify(mainHooks));
  await fs.rm(path.join(current.stateDir, 'native-codex.json'));
  assert.equal((await launchCli(linked, 'codex', [], { stateRoot })).reason, 'stale_main_hooks');

  await fs.rm(capture, { force: true });
  const hooksFile = path.join(linked, '.codex', 'hooks.json');
  const changed = JSON.parse(await fs.readFile(hooksFile, 'utf8'));
  changed.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'echo custom' }] }];
  await fs.writeFile(hooksFile, JSON.stringify(changed));
  assert.equal((await launchCli(linked, 'codex', [], { stateRoot })).reason, 'skill_hooks_changed');
  await assert.rejects(fs.readFile(capture, 'utf8'), { code: 'ENOENT' });
  assert.equal((await launchCli(linked, 'codex', ['-c', 'hooks.SessionStart=[]'], { stateRoot })).reason,
    'unsafe_cli_args');
  for (const args of [['--cd', root], ['--profile', 'other'], ['--dangerously-bypass-hook-trust']]) {
    assert.equal((await launchCli(linked, 'codex', args, { stateRoot })).reason, 'unsafe_cli_args');
  }
  await assert.rejects(fs.readFile(capture, 'utf8'), { code: 'ENOENT' });
  const launchFiles = await fs.readdir(path.join(stateRoot, 'launches'));
  for (const name of launchFiles.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    assert.ok(launchFiles.includes(name.replace(/\.json$/, '.closed')), name);
  }
  assert.equal(launchFiles.some(name => name.endsWith('.lease')), false);
});

test('native rollback retries after Git exclude write failure on final shared lease', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  const worktree = path.join(dir, 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'rollback-worktree', worktree);
  const options = { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root };
  assert.equal((await applyNativeExclusion(root, options)).kind, 'applied');
  assert.equal((await applyNativeExclusion(worktree, options)).kind, 'applied');
  assert.equal((await restoreNativeExclusion(root, options)).kind, 'restored');
  const exclude = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
  const info = path.dirname(exclude);
  await fs.chmod(info, 0o500);
  let failed;
  try { failed = await restoreNativeExclusion(worktree, options); }
  finally { await fs.chmod(info, 0o700); }
  assert.deepEqual(failed, { kind: 'blocked', reason: 'git_exclude_changed' });
  await assert.rejects(fs.readFile(path.join(worktree, '.codex', 'config.toml'), 'utf8'), { code: 'ENOENT' });
  assert.ok((await fs.readFile(exclude, 'utf8')).includes('/.codex/config.toml'));
  assert.equal((await restoreNativeExclusion(worktree, options)).kind, 'restored');
  assert.equal((await fs.readFile(exclude, 'utf8')).includes('/.codex/config.toml'), false);
});

test('native rollback retry preserves a checkout acquired after final lease release failed', async t => {
  const { dir, root, stateRoot } = await fixture(t);
  const worktree = path.join(dir, 'new-owner');
  git(root, 'worktree', 'add', '-q', '-b', 'new-owner', worktree);
  const options = { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root };
  assert.equal((await applyNativeExclusion(root, options)).kind, 'applied');
  const exclude = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
  const info = path.dirname(exclude);
  await fs.chmod(info, 0o500);
  let failed;
  try { failed = await restoreNativeExclusion(root, options); }
  finally { await fs.chmod(info, 0o700); }
  assert.deepEqual(failed, { kind: 'blocked', reason: 'git_exclude_changed' });
  await assert.rejects(fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8'), { code: 'ENOENT' });

  assert.equal((await applyNativeExclusion(worktree, options)).kind, 'applied');
  assert.equal((await restoreNativeExclusion(root, options)).kind, 'restored');
  assert.equal((await verifyNativeCapture(worktree, options)).kind, 'verified');
  const text = await fs.readFile(exclude, 'utf8');
  assert.ok(text.includes('/.codex/config.toml'));
  assert.ok(text.includes('/.codex/hooks.json'));
  const state = path.join(stateRoot, (await fs.readdir(stateRoot))[0]);
  const leases = (await fs.readdir(state)).filter(name => name.startsWith('exclude-'));
  assert.equal(leases.length, 2);
  for (const lease of leases) {
    const saved = JSON.parse(await fs.readFile(path.join(state, lease), 'utf8'));
    assert.deepEqual(saved.owners, [worktree]);
    assert.equal(Object.hasOwn(saved, 'releasing'), false);
  }
  assert.equal((await restoreNativeExclusion(worktree, options)).kind, 'restored');
  assert.equal((await fs.readFile(exclude, 'utf8')).includes('# cbs-memoria codex'), false);
  assert.equal((await fs.readdir(state)).some(name => name.startsWith('exclude-')), false);
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
  assert.equal((await configureExtractor(current, { route: 'sonnet', profile,
    executable: process.execPath })).kind, 'selected');
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
  assert.deepEqual(await consumeCheckpoints({ cli: 'claude', cwd: root, sessionId: 's',
    stateRoot, runCli }), { kind: 'consumed', manifested: 0, pending: 0 });
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
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  assert.equal((await configureExtractor(current, { route: 'sonnet', profile,
    executable: process.execPath })).kind, 'selected');
  assert.equal((await applyNativeExclusion(worktree,
    { cli: 'codex', stateRoot, installedPlugin: true, projectRoot: root })).kind, 'applied');
  await initializeSession(worktree, 'linked-session', { event: 'SessionStart', stateRoot });
  assert.equal((await recordSessionCheckout(current, 'codex', 'linked-session', worktree)).kind, 'bound');
  const box = createOutbox(current.stateDir);
  await box.enqueueCheckpoint({ cli: 'codex', sessionId: 'linked-session', start: 0, end: 10,
    sliceHash: 'c'.repeat(64), messages: [{ messageId: 'm', role: 'user', speakerRole: 'user',
      actor: 'owner', origin: 'human', text: 'Rule X.', timestamp: '2026-10-01T00:00:00Z', start: 0, end: 10 }] },
  { projectId: 'p', policyVersion: 'native-v1' });
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

test('Linux public activation reaches config validation and status reports experimental release', async t => {
  if (process.platform !== 'linux') return t.skip('Linux release gate');
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.cbs'));
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({ provider: 'mem0',
    project_id: 'fixture', qdrant: { url: 'https://qdrant.invalid', collection: 'fixture',
      api_key_env: 'CBS_TEST_KEY' }, embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } }));
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;
  const status = spawnSync(process.execPath, [cli, 'memoria', 'status', '--project', root], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).release, 'linux_experimental');
  assert.equal(JSON.parse(status.stdout).trusted, false);
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), '{invalid');
  const activated = spawnSync(process.execPath, [cli, 'memoria', 'activate', '--cli', 'claude',
    '--project', root], { encoding: 'utf8' });
  assert.equal(activated.status, 1, activated.stdout + activated.stderr);
  assert.match(activated.stdout, /blocked: invalid_config/);
  assert.doesNotMatch(activated.stdout, /local_native_gate_failed/);
});
