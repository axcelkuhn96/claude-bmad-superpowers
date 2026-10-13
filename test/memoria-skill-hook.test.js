import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSkillTrigger, skillHook, authenticateSkillHook } from '../base/memoria/skill-hook.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { captureEvent } from '../base/memoria/checkpoint.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';

const query = Buffer.from('regra de release').toString('base64url');
const payload = (session = 's1', command = 'cbs memoria hook start') => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
  session_id: session, cwd: '/checkout', transcript_path: `/transcripts/${session}.jsonl`,
  tool_use_id: `tool-${session}`,
});

test('fixed trigger grammar rejects shell injection, flags and oversized queries', () => {
  assert.deepEqual(parseSkillTrigger('cbs memoria hook start'), { action: 'start' });
  assert.deepEqual(parseSkillTrigger(`cbs memoria hook search ${query}`),
    { action: 'search', query: 'regra de release' });
  for (const command of ['cbs memoria hook start; touch /tmp/pwn',
    'cbs memoria hook search $(id)', 'cbs memoria hook start --session other',
    ' cbs memoria hook start', `cbs memoria hook search ${'A'.repeat(6000)}`]) {
    assert.equal(parseSkillTrigger(command), null, command);
  }
});

test('direct CLI trigger is inert, without native hook payload', () => {
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'memoria', 'hook', 'search', query],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'typed_trigger_only\n');
});

test('hook ignores ordinary Bash, rejects unbound and never starts broker for bad native payload', async () => {
  let started = 0;
  const deps = { authenticate: async () => ({ kind: 'blocked', reason: 'unbound' }),
    ready: async () => { started++; return { kind: 'ready' }; } };
  assert.equal(await skillHook('claude', payload('s1', 'echo hello'), deps), null);
  const unbound = await skillHook('claude', payload(), deps);
  assert.match(unbound.hookSpecificOutput.additionalContext, /unavailable:unbound/);
  assert.equal(started, 0);
  assert.equal(await skillHook('claude', { ...payload(), tool_use_id: '' }, deps), null);
});

test('native hook never echoes an untrusted failure reason into model context', async () => {
  const result = await skillHook('claude', payload(), { authenticate: async () =>
    ({ kind: 'blocked', reason: 'secret=would-leak' }) });
  assert.equal(result.hookSpecificOutput.additionalContext, 'CBS Mem0: unavailable:error');
});

test('two native sessions on one checkout keep search and recall window isolated', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-hook-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const current = { provider: 'mem0', projectId: 'p', stateDir };
  const deps = { authenticate: async ({ payload: native }) => ({ kind: 'bound', current,
    sessionId: native.session_id, cwd: native.cwd, cli: 'claude' }),
  ready: async () => ({ kind: 'ready' }),
  search: async ({ sessionId }) => ({ kind: 'items', items: [{ sdkId: sessionId, projectId: 'p',
    text: `result-${sessionId}`, score: 0.95, scoreSource: 'mem0_sdk_search', status: 'active',
    metadata: { source: sessionId, actor: 'owner', origin: 'user_direct', speaker_role: 'user',
      scope: 'project', evidence_at: '2026-10-01T00:00:00Z', valid_from: '2026-10-01T00:00:00Z' } }] }),
  now: () => '2026-10-13T00:00:00Z' };
  const run = session => skillHook('claude', payload(session, `cbs memoria hook search ${query}`), deps);
  const [one, two] = await Promise.all([run('s1'), run('s2')]);
  assert.match(one.hookSpecificOutput.additionalContext, /result-s1/);
  assert.doesNotMatch(one.hookSpecificOutput.additionalContext, /result-s2/);
  assert.match(two.hookSpecificOutput.additionalContext, /result-s2/);
  assert.doesNotMatch(two.hookSpecificOutput.additionalContext, /result-s1/);
  assert.match((await run('s1')).hookSpecificOutput.additionalContext, /abstain/);
});

test('native PreToolUse requires prior SessionStart, verified hooks, local trust and checkout', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-native-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const stateRoot = path.join(dir, 'state');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  const git = spawnSync('git', ['init', '-q', root]);
  assert.equal(git.status, 0);
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'p', qdrant: { url: 'https://qdrant.internal',
      collection: 'cbs-p', api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const current = await inspectConfiguration(root, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'applied');
  const first = { ...payload('one'), cwd: root, transcript_path: path.join(dir, 'one.jsonl') };
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).reason,
    'fresh_session');
  const start = await captureEvent({ cli: 'claude', event: 'SessionStart',
    payload: { ...first, hook_event_name: 'SessionStart' }, stateRoot });
  assert.equal(start.kind, 'no_complete_bytes');
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).kind,
    'bound');
  const settingsFile = path.join(root, '.claude', 'settings.local.json');
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  settings.hooks.PreToolUse = [];
  await fs.writeFile(settingsFile, JSON.stringify(settings) + '\n');
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).reason,
    'skill_hooks_changed');
  assert.equal((await applyNativeExclusion(root, { cli: 'claude', stateRoot })).kind, 'applied');
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).kind,
    'bound');
  const wrong = { ...first, session_id: 'two', tool_use_id: 'tool-two',
    transcript_path: path.join(dir, 'two.jsonl') };
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: wrong, stateRoot })).reason,
    'fresh_session');
  await fs.rm(path.join(current.stateDir, 'trust.json'));
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).reason,
    'trust_changed');
  await writeLocalTrust(current.stateDir, trustTuple(current));
  assert.equal((await applyNativeExclusion(root, { cli: 'codex', stateRoot,
    installedPlugin: true })).kind, 'applied');
  const codexHooks = JSON.parse(await fs.readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codexHooks.hooks.PreToolUse[0].matcher, 'Bash');
  const codexPayload = { ...payload('codex-one'), cwd: root,
    transcript_path: path.join(dir, 'codex-one.jsonl') };
  assert.equal((await captureEvent({ cli: 'codex', event: 'SessionStart',
    payload: { ...codexPayload, hook_event_name: 'SessionStart' },
    stateRoot, installedPlugin: true })).kind, 'no_complete_bytes');
  assert.equal((await authenticateSkillHook({ cli: 'codex', payload: codexPayload,
    stateRoot })).kind, 'bound');
  await fs.rm(settingsFile);
  assert.equal((await authenticateSkillHook({ cli: 'claude', payload: first, stateRoot })).reason,
    'native_config_changed');
});
