import test from 'node:test';
import assert from 'node:assert/strict';
import { rankHybrid, verifiedLiteralSpans } from '../base/memoria/hybrid-rank.mjs';
import { selectSearchRecall, renderRecall } from '../base/memoria/context.mjs';
import { createMcp } from '../base/memoria/mcp.mjs';
import { recallForPrompt } from '../base/memoria/hook-recall.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const now = '2026-10-22T12:00:00Z';
const common = { projectId: 'p', status: 'active', text: 'Use HML_TRIPEX_COMP here.',
  metadata: { scope: 'project', source: 'm1', actor: 'owner',
    origin: 'user_direct', speaker_role: 'user', evidence_at: '2026-10-20T12:00:00Z' } };
const vector = (id, score, extra = {}) => ({ ...common, sdkId: id, score,
  scoreSource: 'mem0_sdk_search', ...extra });
const lexical = (id, extra = {}) => ({ ...common, sdkId: id,
  scoreSource: 'lexical_verified', retrievalEvidence: { lexicalRank: 1,
    literalSpans: ['HML_TRIPEX_COMP'] }, ...extra });
const options = { projectId: 'p', ownerId: 'owner', now, query: 'Where is HML_TRIPEX_COMP?' };

test('technical literals use whole boundaries and ignore claimed metadata evidence', () => {
  assert.deepEqual(verifiedLiteralSpans('Where HML_TRIPEX_COMP?', 'HML_TRIPEX_COMP is set'),
    ['HML_TRIPEX_COMP']);
  assert.deepEqual(verifiedLiteralSpans('HML_TRIPEX_COMP', 'xHML_TRIPEX_COMPz'), []);
  assert.deepEqual(verifiedLiteralSpans('server', 'server is set'), []);
  assert.deepEqual(verifiedLiteralSpans('ERR42', 'ERR42 is set'), ['ERR42']);
  assert.deepEqual(verifiedLiteralSpans(`HML_${'X'.repeat(80)}`, `HML_${'X'.repeat(80)}`), []);
});

test('RRF joins validated IDs and preserves hybrid order through context rendering', () => {
  const answer = { kind: 'items', items: [vector('a', .99), vector('b', .86)],
    lexical_items: [lexical('b'), lexical('c')] };
  const selected = selectSearchRecall(answer, options);
  assert.deepEqual(selected.map(row => row.sdkId), ['b', 'a', 'c']);
  assert.equal(selected[0].scoreSource, 'hybrid_verified');
  assert.ok(selected[0].retrievalEvidence.vectorScore >= .85);
  assert.deepEqual(renderRecall(selected).used.map(row => row.sdkId), ['b', 'a', 'c']);
  assert.ok(rankHybrid([vector('a', .99)], [lexical('a')])[0].retrievalEvidence.lexicalRank);
});

test('lexical path rejects mismatched scope, stale, superseded, forged source and loose match', () => {
  const rows = [lexical('good'), lexical('foreign', { projectId: 'q' }),
    lexical('personal', { metadata: { ...common.metadata, scope: 'personal', owner_id: 'other' } }),
    lexical('expired', { metadata: { ...common.metadata, valid_to: now } }),
    lexical('superseded', { status: 'superseded' }),
    lexical('unproven', { metadata: { ...common.metadata, actor: null } }),
    lexical('loose', { text: 'xHML_TRIPEX_COMPz' }),
    lexical('wrong-query', { text: 'Use DIFFERENT_ID here.' })];
  const selected = selectSearchRecall({ kind: 'items', items: [], lexical_items: rows }, options);
  assert.deepEqual(selected.map(row => row.sdkId), ['good']);
  assert.deepEqual(selected[0].retrievalEvidence.literalSpans, ['HML_TRIPEX_COMP']);
});

test('weak vector is excluded and missing lexical index keeps vector score order', () => {
  const result = selectSearchRecall({ kind: 'items', items: [vector('b', .86),
    vector('a', .99), vector('weak', .84)], lexical_items: [],
    lexical_degradation: 'index_missing' }, options);
  assert.deepEqual(result.map(row => row.sdkId), ['a', 'b']);
  assert.equal(result[0].scoreSource, 'mem0_sdk_search');
});

test('hybrid selection caps distinct IDs at twenty', () => {
  const rows = Array.from({ length: 25 }, (_, i) => lexical(`m${i}`, {
    text: `HML_TRIPEX_COMP ${i}` }));
  assert.equal(selectSearchRecall({ kind: 'items', items: [], lexical_items: rows }, options).length, 20);
});

test('hook and bound MCP render lexical evidence within 500 bytes and one search dispatch', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-hybrid-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let searches = 0;
  const search = async () => { searches++; return { kind: 'items', items: [],
    lexical_items: [lexical('verified')], vector_degradation: 'vector_unavailable' }; };
  const hook = await recallForPrompt({ cli: 'claude', payload: { cwd: '/project',
    session_id: 'hook', prompt: options.query }, result: { kind: 'queued' },
    resolve: async () => ({ provider: 'mem0', projectId: 'p', ownerId: 'owner', stateDir }),
    search, now: () => now });
  assert.match(hook.hookSpecificOutput.additionalContext, /HML_TRIPEX_COMP/);
  assert.ok(Buffer.byteLength(hook.hookSpecificOutput.additionalContext) <= 500);
  const mcp = createMcp({ cli: 'claude', resolve: async () => ({ kind: 'bound',
    cwd: '/project', nativeSessionId: 'mcp', projectId: 'p', ownerId: 'owner', stateDir }), search });
  const result = await mcp.call('search', { query: options.query });
  assert.equal(result.kind, 'items');
  assert.equal(result.retrievalStatus, 'lexical_only');
  assert.equal(result.count, 1);
  assert.equal(searches, 2);
});
