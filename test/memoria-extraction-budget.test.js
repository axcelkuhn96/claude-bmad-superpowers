import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOutbox } from '../base/memoria/outbox.mjs';

const day = '2026-10-15T00:00:00.000Z';
const nextDay = Date.parse('2026-10-16T00:00:00.000Z');
const identity = { projectId: 'p', policyVersion: 'native-v2' };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-daily-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-15T12:00:00.000Z');
  const box = () => createOutbox(dir, { now: () => clock });
  const queued = await box().enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: 0,
    end: 10, sliceHash: 'a'.repeat(64), messages: [] }, identity);
  assert.equal(queued.kind, 'queued');
  const extraction = path.join(dir, 'outbox', `extract-${createHash('sha256')
    .update(JSON.stringify(['codex', 's'])).digest('hex')}.json`);
  return { box, id: queued.operationId, extraction,
    setClock: value => { clock = Date.parse(value); } };
}

test('automatic daily claims resume after UTC midnight while lifetime calls remain monotonic', async t => {
  const f = await fixture(t);
  const opts = { automaticDaily: true };
  assert.equal((await f.box().claimExtraction(f.id, 2, opts)).calls, 1);
  assert.equal((await f.box().claimExtraction(f.id, 2, opts)).calls, 2);
  const limited = await f.box().claimExtraction(f.id, 2, opts);
  assert.equal(limited.reason, 'extraction_call_limit');
  assert.equal(limited.retryAt, nextDay);
  assert.equal((await f.box().extractionUsage('codex', 's')).calls, 2);
  f.setClock('2026-10-16T00:00:01.000Z');
  assert.equal((await f.box().claimExtraction(f.id, 2, opts)).calls, 3);
  f.setClock('2026-10-15T23:00:00.000Z');
  assert.equal((await f.box().claimExtraction(f.id, 2, opts)).calls, 4);
  assert.equal((await f.box().claimExtraction(f.id, 2, opts)).retryAt,
    Date.parse('2026-10-17T00:00:00.000Z'));
  assert.equal((await f.box().extractionUsage('codex', 's')).calls, 4);
});

test('daily budget is locked across concurrent claims and exposes capacity after a raised cap', async t => {
  const f = await fixture(t);
  const opts = { automaticDaily: true };
  const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
    f.box().claimExtraction(f.id, 2, opts)));
  assert.deepEqual(outcomes.map(row => row.kind).sort(), ['blocked', 'claimed', 'claimed']);
  assert.equal((await f.box().extractionBudget('codex', 's', 2, opts)).available, false);
  assert.equal((await f.box().extractionBudget('codex', 's', 3, opts)).available, true);
  assert.equal((await f.box().claimExtraction(f.id, 3, opts)).calls, 3);
});

test('legacy counter from yesterday starts a fresh daily window, but same-day usage carries every call', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 105; n++) assert.equal((await f.box().claimExtraction(f.id, 200)).calls, n + 1);
  await fs.utimes(f.extraction, new Date(day), new Date(day));
  const sameDay = await f.box().claimExtraction(f.id, 100, { automaticDaily: true });
  assert.equal(sameDay.reason, 'extraction_call_limit');
  assert.equal((await f.box().claimExtraction(f.id, 200, { automaticDaily: true })).calls, 106);
  assert.equal((await f.box().extractionUsage('codex', 's')).calls, 106);
  assert.equal((await f.box().claimExtraction(f.id, 100)).reason, 'extraction_call_limit');
});

test('legacy counter older than UTC day does not burn the new daily allowance', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 3; n++) await f.box().claimExtraction(f.id, 4);
  const yesterday = new Date('2026-10-14T22:00:00.000Z');
  await fs.utimes(f.extraction, yesterday, yesterday);
  assert.equal((await f.box().claimExtraction(f.id, 1, { automaticDaily: true })).calls, 4);
  assert.equal((await f.box().claimExtraction(f.id, 1, { automaticDaily: true })).retryAt, nextDay);
});

test('a midnight race makes a deferred extraction immediately retryable', async t => {
  const f = await fixture(t);
  f.setClock('2026-10-16T00:00:01.000Z');
  const retry = await f.box().markFailed(f.id, 'extraction_call_limit',
    { automatic: true, retryAt: nextDay });
  assert.equal(retry.kind, 'pending');
  assert.ok(retry.retryAt >= Date.parse('2026-10-16T00:00:01.000Z'));
});

test('replay grants one durable extra claim per authorized operation after 200 calls', async t => {
  const f = await fixture(t);
  const second = await f.box().enqueueCheckpoint({ cli: 'codex', sessionId: 's', start: 10,
    end: 20, sliceHash: 'b'.repeat(64), messages: [] }, identity);
  for (let n = 0; n < 200; n++) {
    assert.equal((await f.box().claimExtraction(f.id, 200,
      { automaticDaily: true })).calls, n + 1);
  }
  assert.equal((await f.box().claimExtraction(f.id, 200,
    { automaticDaily: true })).reason, 'extraction_call_limit');
  assert.equal((await f.box().claimExtraction(f.id, 200,
    { automaticDaily: true, replayRunId: 'run-1' })).calls, 201);
  assert.equal((await f.box().claimExtraction(f.id, 200,
    { automaticDaily: true, replayRunId: 'run-1' })).reason, 'replay_already_claimed');
  assert.equal((await f.box().claimExtraction(second.operationId, 200,
    { automaticDaily: true, replayRunId: 'run-1' })).calls, 202);
  assert.equal((await f.box().extractionUsage('codex', 's')).calls, 202);
  assert.equal((await f.box().claimExtraction(second.operationId, 200,
    { automaticDaily: true })).reason, 'extraction_call_limit');
  const saved = JSON.parse(await fs.readFile(f.extraction, 'utf8'));
  assert.equal(saved.replayClaims[`run-1:${f.id}`], 201);
  assert.equal(saved.replayClaims[`run-1:${second.operationId}`], 202);
});
