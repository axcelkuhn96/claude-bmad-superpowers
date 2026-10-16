import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerQueue } from '../base/memoria/broker-queue.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = (deadlineAt, value) => ({ value: { deadlineAt, value }, secret: Buffer.alloc(32, 7) });

test('a request waits past 100ms and runs once within its original deadline', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const results = [];
  const queue = createBrokerQueue(async value => {
    calls.push(value.value);
    if (value.value === 'a') await gate;
    return { kind: 'done', value: value.value };
  });
  const a = frame(Date.now() + 1000, 'a');
  const b = frame(Date.now() + 1000, 'b');
  queue.enqueue(a, new AbortController().signal, value => results.push(value));
  queue.enqueue(b, new AbortController().signal, value => results.push(value));
  await pause(130);
  release();
  await pause(20);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(results.map(value => value.value), ['a', 'b']);
  assert.equal(a.secret.every(byte => byte === 0), true);
  assert.equal(b.secret.every(byte => byte === 0), true);
});

test('expired and disconnected queued requests never run, and capacity stays bounded', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const results = new Map();
  const queue = createBrokerQueue(async value => {
    calls.push(value.value);
    if (value.value === 'a') await gate;
    return { kind: 'done' };
  });
  const enqueue = (name, ms, controller = new AbortController()) => {
    const request = frame(Date.now() + ms, name);
    queue.enqueue(request, controller.signal, value => results.set(name, value));
    return request;
  };
  const a = enqueue('a', 1000);
  const expired = enqueue('expired', 40);
  const aborter = new AbortController();
  const aborted = enqueue('aborted', 1000, aborter);
  const full = enqueue('full', 1000);
  assert.deepEqual(results.get('full'), { kind: 'unavailable', reason: 'queue_full' });
  aborter.abort();
  await pause(70);
  assert.deepEqual(results.get('expired'), { kind: 'unavailable', reason: 'queue_timeout' });
  release();
  await pause(20);
  assert.deepEqual(calls, ['a']);
  for (const request of [a, expired, aborted, full]) {
    assert.equal(request.secret.every(byte => byte === 0), true);
  }
});
