import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBrokerWorker } from '../base/memoria/broker-worker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';

const fixture = fileURLToPath(new URL('./memoria-broker-worker-fixture.mjs', import.meta.url));

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
