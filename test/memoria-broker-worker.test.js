import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { claimBrokerWorker } from '../base/memoria/broker.mjs';
import { createBrokerWorker } from '../base/memoria/broker-worker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';

const fixture = fileURLToPath(new URL('./memoria-broker-worker-fixture.mjs', import.meta.url));

test('uncertain child close keeps the shared guard and rejects a new broker process before spawn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-broker-guard-'));
  await fs.mkdir(path.join(root, 'ledger'), { mode: 0o700 });
  let starts = 0;
  const start = () => {
    starts++;
    const child = new EventEmitter();
    child.pid = 1; // In-memory fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.kill = () => true;
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  };
  try {
    const first = await claimBrokerWorker(root);
    const bridge = createBrokerWorker(start);
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.equal(await bridge.close(), false);
    await first.release(false);
    const moduleUrl = new URL('../base/memoria/broker.mjs', import.meta.url).href;
    const probe = spawn(process.execPath, ['--input-type=module', '-e',
      `import { claimBrokerWorker } from ${JSON.stringify(moduleUrl)};
       try { await claimBrokerWorker(process.argv[1]); process.stdout.write('NUMERIC_STARTED'); }
       catch (error) { if (error.code !== 'EEXIST') throw error; process.stdout.write('BROKER_BLOCKED'); }`, root],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    probe.stdout.on('data', chunk => { output += chunk; });
    probe.stderr.on('data', chunk => { errors += chunk; });
    const exit = await new Promise(resolve => probe.once('close', resolve));
    assert.equal(exit, 0, errors);
    assert.equal(output, 'BROKER_BLOCKED');
    assert.equal(starts, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('confirmed child close releases the shared guard for the next broker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-broker-guard-'));
  await fs.mkdir(path.join(root, 'ledger'), { mode: 0o700 });
  let starts = 0;
  const start = () => {
    starts++;
    return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
  };
  try {
    const first = await claimBrokerWorker(root);
    const bridge = createBrokerWorker(start);
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.equal(await bridge.close(), true);
    await first.release(true);
    const second = await claimBrokerWorker(root);
    const next = createBrokerWorker(start);
    try {
      assert.deepEqual(await next.start(), { kind: 'ready' });
      assert.equal(starts, 2);
    } finally { await second.release(await next.close()); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a worker deadline kills only its worker and the next request gets a ready replacement', async () => {
  let started = 0;
  let active = 0;
  let peak = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    active++;
    peak = Math.max(peak, active);
    const child = spawn(process.execPath, [fixture, started === 2 ? '250' : '0'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    child.once('close', () => active--);
    return child;
  }, { coldMs: 2000, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    const first = await bridge.request({ id: 1, hang: true }, Buffer.from('key'), Date.now() + 80);
    assert.deepEqual(first, { kind: 'unavailable', reason: 'deadline' });
    const cold = await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 100);
    assert.deepEqual(cold, { kind: 'unavailable', reason: 'deadline' });
    const second = await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 3000);
    assert.deepEqual(second, { kind: 'result', id: 2, secretLength: 3 });
    assert.equal(started, 2);
    assert.equal(peak, 1);
    assert.equal(fatal, 0);
  } finally { await bridge.close(); }
  assert.equal(active, 0);
});

test('late output from an expired worker never answers the replacement request', async () => {
  let started = 0;
  let active = 0;
  let peak = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    active++;
    peak = Math.max(peak, active);
    const child = spawn(process.execPath, [fixture, '0', started === 1 ? 'late' : 'normal'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    child.once('close', () => active--);
    return child;
  }, { coldMs: 2000 });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ id: 1, lateMs: 150 }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.deepEqual(await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 2000),
      { kind: 'result', id: 2, secretLength: 3 });
    assert.equal(started, 2);
    assert.equal(peak, 1);
  } finally { await bridge.close(); }
  assert.equal(active, 0);
});

test('a replacement that never becomes ready closes the owning endpoint', async () => {
  let started = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    return started === 1
      ? spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
  }, { coldMs: 120, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.deepEqual(await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000),
      { kind: 'unavailable', reason: 'worker_cold' });
    assert.equal(started, 2);
    assert.equal(fatal, 1);
    assert.equal((await bridge.request({ id: 4 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal(started, 2);
    assert.equal(fatal, 1);
  } finally { await bridge.close(); }
});
test('synchronous replacement spawn failure closes recovery without a third worker', async () => {
  let started = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    if (started > 1) throw new Error('spawn failed');
    return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
  }, { coldMs: 1000, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.equal((await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal((await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal(started, 2);
    assert.equal(fatal, 1);
  } finally { await bridge.close(); }
});

test('an owned child that never closes makes recovery fatal without replacement and permits bounded shutdown', async () => {
  let started = 0;
  let fatal = 0;
  const signals = [];
  const bridge = createBrokerWorker(() => {
    started++;
    const child = new EventEmitter();
    child.pid = 1; // In-memory child fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.kill = signal => { signals.push(signal ?? 'SIGTERM'); return true; };
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  }, { onFatal: () => fatal++ });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 30),
    { kind: 'unavailable', reason: 'deadline' });
  assert.deepEqual(await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 5500),
    { kind: 'unavailable', reason: 'worker_unstoppable' });
  assert.equal(started, 1);
  assert.equal(fatal, 1);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000),
    { kind: 'unavailable', reason: 'worker_unstoppable' });
  assert.equal(started, 1);
  let timer;
  try {
    assert.equal(await Promise.race([bridge.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true);
  } finally { clearTimeout(timer); }
  assert.equal(fatal, 1);
});

test('close finishes within the termination bound when its owned child never closes', async () => {
  const child = new EventEmitter();
  child.pid = 1; // In-memory child fixture; kill never signals an OS process.
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => true;
  const bridge = createBrokerWorker(() => {
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  let timer;
  try {
    assert.equal(await Promise.race([bridge.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5500); })]), true);
  } finally { clearTimeout(timer); }
});

test('a request that discovers an unclosed exited worker keeps its absolute deadline', async () => {
  const child = new EventEmitter();
  child.pid = 1; // In-memory child fixture; no OS process is signaled.
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => { throw new Error('exited fixture must not be signaled'); };
  const bridge = createBrokerWorker(() => {
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  child.exitCode = 1;
  child.emit('exit');
  const startedAt = Date.now();
  const result = await bridge.request({ id: 1 }, Buffer.from('key'), startedAt + 100);
  assert.deepEqual(result, { kind: 'unavailable', reason: 'deadline' });
  assert.ok(Date.now() - startedAt < 1000);
  await bridge.close();
});

test('a response observed after the absolute deadline cannot return late output', async () => {
  const bridge = createBrokerWorker(() => {
    const child = new EventEmitter();
    child.pid = 1; // In-memory child fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      const actualNow = Date.now;
      Date.now = () => actualNow() + 100;
      try { child.stdout.emit('data', encodeFrame({ kind: 'result', id: 1 }, undefined, true)); }
      finally { Date.now = actualNow; }
      return true;
    };
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      queueMicrotask(() => { child.emit('exit'); child.emit('close'); });
      return true;
    };
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ id: 1 }, Buffer.from('key'), Date.now() + 50),
      { kind: 'unavailable', reason: 'deadline' });
  } finally { await bridge.close(); }
});
