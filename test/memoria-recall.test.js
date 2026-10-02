import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRecall, renderContext, createRecall } from '../base/memoria/context.mjs';
import { recallForPrompt } from '../base/memoria/hook-recall.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const now = '2026-10-01T00:00:00Z';
const base = { projectId: 'p', status: 'active', score: 0.9, scoreSource: 'mem0_sdk_search',
  text: 'The approved convention is X.',
  metadata: { source: 'message-1', actor: 'owner', evidence_at: '2026-09-01T00:00:00Z',
    origin: 'user_direct', scope: 'project', valid_from: '2026-09-01T00:00:00Z' } };

test('identity, state, validity and provenance filter before rank', () => {
  const hits = [
    { ...base, sdkId: 'foreign', projectId: 'other', score: 0.99 },
    ...['candidate', 'conflict', 'rejected', 'superseded'].map((status, index) =>
      ({ ...base, sdkId: status, status, score: 0.98 - index / 100 })),
    { ...base, sdkId: 'expired', metadata: { ...base.metadata, valid_to: now }, score: 0.94 },
    { ...base, sdkId: 'future', metadata: { ...base.metadata, valid_from: '2026-11-01T00:00:00Z' }, score: 0.93 },
    { ...base, sdkId: 'unproven', metadata: { ...base.metadata, actor: null }, score: 0.92 },
    { ...base, sdkId: 'weak', score: 0.84 },
    { ...base, sdkId: 'unscored', score: undefined },
    { ...base, sdkId: 'unsourced-score', scoreSource: undefined, score: 0.99 },
    { ...base, sdkId: 'current', score: 0.85 },
  ];
  assert.deepEqual(selectRecall(hits, { projectId: 'p', now }).map(x => x.sdkId), ['current']);
});

test('episode remains scoped to its project and expires at valid_to', () => {
  const episode = { ...base, sdkId: 'episode', metadata: { ...base.metadata,
    scope: 'episode', valid_to: '2026-10-02T00:00:00Z' } };
  const foreign = { ...episode, sdkId: 'foreign', projectId: 'other', score: 1 };
  assert.deepEqual(selectRecall([foreign, episode], { projectId: 'p', now }).map(x => x.sdkId), ['episode']);
  assert.deepEqual(selectRecall([episode], { projectId: 'p', now: '2026-10-02T00:00:00Z' }), []);
  assert.deepEqual(selectRecall([{ ...episode, metadata: { ...episode.metadata, valid_to: null } }],
    { projectId: 'p', now }), []);
});

test('render budget retains provenance, deduplicates by id and hash, and resets at compaction', async () => {
  const recalled = createRecall({ search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'one' }] }),
    now: () => now });
  assert.ok(renderContext([base], 500).includes('message-1'));
  assert.ok(renderContext([base], 500).includes('owner'));
  assert.ok(renderContext([base], 500).includes('2026-09-01'));
  assert.ok(Buffer.byteLength(renderContext(Array.from({ length: 100 }, (_, i) =>
    ({ ...base, sdkId: `${i}`, text: 'word '.repeat(100) })), 500)) <= 500);
  assert.equal((await recalled({ projectId: 'p' }, 'rule')).kind, 'items');
  assert.equal((await recalled({ projectId: 'p' }, 'rule')).kind, 'abstain');
  recalled.compact();
  assert.equal((await recalled({ projectId: 'p' }, 'rule')).kind, 'items');
});

test('negative result abstains and deadline includes embedder plus remote search', async () => {
  const recall = createRecall({ search: async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { kind: 'items', items: [base] };
  } });
  const start = performance.now();
  const timed = await recall({ projectId: 'p', sessionId: 's' }, 'query', 1000);
  assert.equal(timed.kind, 'unavailable');
  assert.ok(performance.now() - start < 1150);
  const negative = await createRecall({ search: async () => ({ kind: 'items', items: [] }) })
    ({ projectId: 'p' }, 'unknown', 1000);
  assert.deepEqual(negative, { kind: 'abstain' });
  const weak = await createRecall({ search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'low', score: 0.3 }] }), now: () => now })
    ({ projectId: 'p' }, 'unrelated', 1000);
  assert.deepEqual(weak, { kind: 'abstain' });
});

test('dedup is isolated per native session', async () => {
  const recall = createRecall({ search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'one' }] }), now: () => now });
  assert.equal((await recall({ projectId: 'p', nativeSessionId: 'one' }, 'rule')).kind, 'items');
  assert.equal((await recall({ projectId: 'p', nativeSessionId: 'two' }, 'rule')).kind, 'items');
  assert.equal((await recall({ projectId: 'p', nativeSessionId: 'one' }, 'rule')).kind, 'abstain');
  recall.compact('one');
  assert.equal((await recall({ projectId: 'p', nativeSessionId: 'one' }, 'rule')).kind, 'items');
  assert.equal((await recall({ projectId: 'p', nativeSessionId: 'two' }, 'rule')).kind, 'abstain');
});

test('prompt hook injects approved context once per session and resets at compaction', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-recall-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const session = { provider: 'mem0', projectId: 'p', stateDir };
  const input = { cli: 'claude', payload: { session_id: 's', cwd: '/checkout', prompt: 'What rule?' },
    result: { kind: 'queued' }, began: performance.now(),
    resolve: async () => session,
    search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'one' }] }),
    now: () => now };
  const first = await recallForPrompt(input);
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /message-1/);
  assert.equal(await recallForPrompt(input), null);
  assert.equal(await recallForPrompt({ ...input, payload: { ...input.payload, session_id: 's2' } }) !== null, true);
  await recallForPrompt({ ...input, event: 'PreCompact' });
  assert.equal(await recallForPrompt(input) !== null, true);
  assert.equal(await recallForPrompt({ ...input, result: { kind: 'pass_through' } }), null);
  assert.equal(await recallForPrompt({ ...input, began: performance.now() - 1001 }), null);
});
