import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRecall, renderContext, renderRecall, createRecall } from '../base/memoria/context.mjs';
import { recallForPrompt, recordRecallWindow } from '../base/memoria/hook-recall.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMcp } from '../base/memoria/mcp.mjs';
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';

const now = '2026-10-01T00:00:00Z';
const base = { projectId: 'p', status: 'active', score: 0.9, scoreSource: 'mem0_sdk_search',
  text: 'The approved convention is X.',
  metadata: { source: 'message-1', actor: 'owner', evidence_at: '2026-09-01T00:00:00Z',
    origin: 'user_direct', speaker_role: 'user', scope: 'project', valid_from: '2026-09-01T00:00:00Z' } };

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

test('recall requires trusted origin and role and cites report provenance and condition', () => {
  const human = { ...base, sdkId: 'human', metadata: { ...base.metadata, speaker_role: 'user',
    condition: 'only on Fridays' } };
  const report = { ...base, sdkId: 'report', text: 'The assistant reported a passing test.',
    metadata: { ...base.metadata, actor: 'assistant', origin: 'assistant_report', speaker_role: 'assistant' } };
  const missing = { ...base, sdkId: 'missing', metadata: { ...base.metadata, origin: undefined } };
  const forged = { ...base, sdkId: 'forged', metadata: { ...base.metadata, speaker_role: 'assistant' } };
  const picked = selectRecall([human, report, missing, forged], { projectId: 'p', now });
  assert.deepEqual(picked.map(row => row.sdkId), ['human', 'report']);
  const text = renderContext(picked);
  assert.match(text, /origin user_direct; role user; condition only on Fridays/);
  assert.match(text, /origin assistant_report; role assistant/);
  assert.match(text, /Current human instruction takes precedence/);
});

test('conversation summary is recalled as generated evidence with both speaker references', () => {
  const refs = [
    { message_id: 'human-1', role: 'user', origin: 'human', actor: 'user',
      offsets: { start: 0, end: 20 }, source_text_sha256: 'a'.repeat(64), excerpt: 'Use PostgreSQL.' },
    { message_id: 'assistant-1', role: 'assistant', origin: 'assistant', actor: 'assistant',
      offsets: { start: 21, end: 70 }, source_text_sha256: 'b'.repeat(64), excerpt: 'I will use PostgreSQL.' },
  ];
  const summary = { ...base, sdkId: 'summary', text: 'PostgreSQL was chosen in the conversation.',
    metadata: { ...base.metadata, format_version: 4, source: 'human-1',
      actor: 'conversation', origin: 'conversation_summary', speaker_role: 'mixed',
      type: 'decision', source_offsets: refs[0].offsets,
      source_text_sha256: refs[0].source_text_sha256,
      dedup_key: dedupKeyFor({ projectId: 'p', scope: 'project', type: 'decision',
        text: 'PostgreSQL was chosen in the conversation.',
        validFrom: base.metadata.valid_from }), source_refs: refs } };
  const forged = { ...summary, sdkId: 'forged', metadata: { ...summary.metadata,
    speaker_role: 'user' } };
  const legacy = { ...summary, sdkId: 'legacy', metadata: { ...summary.metadata,
    format_version: 3 } };
  const selected = selectRecall([summary, forged, legacy], { projectId: 'p', now });
  assert.deepEqual(selected.map(item => item.sdkId), ['summary']);
  assert.match(renderContext(selected), /resumo gerado; referências 2/);
  assert.match(renderContext(selected), /PostgreSQL was chosen in the conversation/);
});

test('long generated summary fits recall budget with full condition and negation', async () => {
  const refs = [
    { message_id: 'human-20261014-001', role: 'user', origin: 'human', actor: 'owner',
      offsets: { start: 0, end: 106 }, source_text_sha256: 'a'.repeat(64), excerpt: 'Keep reports manual.' },
    { message_id: 'assistant-20261014-002', role: 'assistant', origin: 'assistant', actor: 'assistant',
      offsets: { start: 0, end: 109 }, source_text_sha256: 'b'.repeat(64), excerpt: 'I will keep reports manual.' },
  ];
  const text = 'A equipe decidiu manter a sincronização manual de relatórios financeiros até a revisão de outubro. Não publicar automaticamente quando houver divergência entre filial e matriz; registrar o conflito e pedir confirmação ao responsável. Válido neste projeto.';
  const condition = 'somente após conferência da matriz; nunca publicar divergências';
  const summary = { ...base, sdkId: '123e4567-e89b-12d3-a456-426614174000', score: 0.99, text,
    metadata: { ...base.metadata, format_version: 4, source: refs[0].message_id,
      evidence_at: '2026-10-14T12:34:56Z', actor: 'conversation',
      origin: 'conversation_summary', speaker_role: 'mixed', type: 'decision', condition,
      source_offsets: refs[0].offsets, source_text_sha256: refs[0].source_text_sha256,
      dedup_key: dedupKeyFor({ projectId: 'p', scope: 'project', type: 'decision', text,
        condition, validFrom: base.metadata.valid_from }), source_refs: refs } };
  const selected = selectRecall([summary], { projectId: 'p', now: '2026-10-14T13:00:00Z' });
  assert.deepEqual(selected, [summary]);
  const rendered = renderRecall(selected, 500);
  assert.deepEqual(rendered.used, [summary]);
  assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 500);
  assert.ok(rendered.text.includes('123e4567-e89b-12d3-a456-426614174000; resumo gerado; referências 2; date 2026-10-14; condition ' + condition));
  assert.ok(rendered.text.endsWith(text));
  assert.equal((await createRecall({ search: async () => ({ kind: 'items', items: [summary] }),
    now: () => '2026-10-14T13:00:00Z' })({ projectId: 'p' }, 'relatórios')).kind, 'items');
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

test('native PreCompact opens a new window for a live MCP process', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-recall-shared-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const current = { provider: 'mem0', projectId: 'p', stateDir };
  const mcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', cwd: '/checkout', nativeSessionId: 's',
      projectId: 'p', stateDir }),
    search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'shared' }] }) });
  assert.equal((await mcp.call('search', { query: 'rule' })).kind, 'items');
  assert.equal((await mcp.call('search', { query: 'rule' })).kind, 'abstain');
  await recallForPrompt({ cli: 'claude', event: 'PreCompact', payload: { cwd: '/checkout', session_id: 's' },
    result: { kind: 'queued' }, resolve: async () => current });
  assert.equal((await mcp.call('search', { query: 'rule' })).kind, 'items');
});

test('window write crossing deadline rolls back before the following turn', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-recall-late-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const eligible = [{ ...base, sdkId: 'late' }];
  let deadline = performance.now() + 1000;
  const timed = await recordRecallWindow({ stateDir, cli: 'claude', sessionId: 's', eligible,
    remaining: () => deadline - performance.now(),
    writeSeen: async (file, seen) => {
      deadline = performance.now() + 10;
      await new Promise(resolve => setTimeout(resolve, 30));
      await fs.writeFile(file, JSON.stringify([...seen]));
    } });
  assert.deepEqual(timed, { kind: 'unavailable', reason: 'deadline' });
  const next = await recordRecallWindow({ stateDir, cli: 'claude', sessionId: 's', eligible,
    remaining: () => 1000 });
  assert.equal(next.kind, 'items');
});

test('MCP deadline after selection does not suppress the next search', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-recall-mcp-late-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let first = true;
  const mcp = createMcp({ launchId: 'bound', cli: 'claude',
    resolve: async () => ({ kind: 'bound', cwd: '/checkout', nativeSessionId: 's',
      projectId: 'p', stateDir }),
    search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'late' }] }),
    recordWindow: async options => {
      const selected = await recordRecallWindow(options);
      if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 1020)); }
      return selected;
    } });
  assert.deepEqual(await mcp.call('search', { query: 'rule' }), { kind: 'unavailable', reason: 'deadline' });
  assert.equal((await mcp.call('search', { query: 'rule' })).kind, 'items');
});

test('native hook deadline after selection does not suppress the next prompt', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-recall-hook-late-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let first = true;
  const input = { cli: 'claude', payload: { cwd: '/checkout', session_id: 's', prompt: 'rule' },
    result: { kind: 'queued' }, resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir }),
    search: async () => ({ kind: 'items', items: [{ ...base, sdkId: 'late' }] }), now: () => now,
    recordWindow: async options => {
      const selected = await recordRecallWindow(options);
      if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 1020)); }
      return selected;
    } };
  assert.equal(await recallForPrompt({ ...input, began: performance.now() }), null);
  assert.ok((await recallForPrompt({ ...input, began: performance.now() }))?.hookSpecificOutput);
});

test('prompt recall reports fixed failure categories without changing its null result', async () => {
  const baseInput = { cli: 'claude', payload: { cwd: '/checkout', session_id: 's', prompt: 'rule' },
    result: { kind: 'queued' }, resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: '/tmp' }) };
  const observed = [];
  const onFailure = reason => observed.push(reason);
  assert.equal(await recallForPrompt({ ...baseInput, search: async () =>
    ({ kind: 'blocked', reason: 'missing_key' }), onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, began: performance.now() - 990,
    search: () => new Promise(() => {}), onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, result: { kind: 'blocked', reason: 'unsafe_transcript' },
    onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, result: { kind: 'blocked', reason: 'trust_changed' },
    onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, search: async () =>
    ({ kind: 'unavailable', reason: 'broker_unavailable' }), onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, search: async () =>
    ({ kind: 'items', items: [{ ...base, sdkId: 'one' }] }),
    recordWindow: async () => ({ kind: 'unavailable', reason: 'unsafe_window' }),
    now: () => now, onFailure }), null);
  assert.equal(await recallForPrompt({ ...baseInput, search: async () =>
    ({ kind: 'blocked', reason: 'secret=/malicious/path' }), onFailure }), null);
  assert.deepEqual(observed, ['auth', 'deadline', 'capture', 'trust', 'transport', 'selection', 'error']);
});

test('expired initial hook budget reports deadline before resolve or search', async () => {
  const observed = [];
  let resolved = 0;
  let searched = 0;
  const result = await recallForPrompt({ cli: 'claude',
    payload: { cwd: '/checkout', session_id: 's', prompt: 'rule' },
    result: { kind: 'queued' }, began: performance.now() - 1001,
    resolve: async () => { resolved++; throw new Error('unexpected resolve'); },
    search: async () => { searched++; throw new Error('unexpected search'); },
    onFailure: reason => observed.push(reason) });
  assert.equal(result, null);
  assert.deepEqual(observed, ['deadline']);
  assert.equal(resolved, 0);
  assert.equal(searched, 0);
});

test('empty query and no eligible recall remain diagnostically silent', async () => {
  const observed = [];
  const input = { cli: 'claude', payload: { cwd: '/checkout', session_id: 's', prompt: '' },
    result: { kind: 'queued' }, resolve: async () => ({ provider: 'mem0', projectId: 'p', stateDir: '/tmp' }),
    onFailure: reason => observed.push(reason) };
  assert.equal(await recallForPrompt(input), null);
  assert.equal(await recallForPrompt({ ...input, payload: { ...input.payload, prompt: 'rule' },
    search: async () => ({ kind: 'items', items: [] }) }), null);
  assert.equal(await recallForPrompt({ ...input, resolve: async () => ({ provider: 'claude-mem' }) }), null);
  assert.deepEqual(observed, []);
});

test('capture hook stderr is sanitized on malformed input', () => {
  const hook = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    '../base/memoria/capture-hook.mjs');
  const child = spawnSync(process.execPath, [hook, 'claude', 'UserPromptSubmit'],
    { input: '{"private":"SECRET-LEAK",', encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'CBS Mem0 capture: error\n');
});

test('capture hook without Mem0 configuration leaves stdout, stderr and state empty', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-default-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hook = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    '../base/memoria/capture-hook.mjs');
  const child = spawnSync(process.execPath, [hook, 'claude', 'UserPromptSubmit'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's',
      transcript_path: path.join(root, 's.jsonl'), prompt: 'rule' }), encoding: 'utf8',
    env: { ...process.env, CBS_MEMORIA_STATE_ROOT: path.join(root, 'state') },
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  assert.deepEqual(await fs.readdir(root), []);
});
