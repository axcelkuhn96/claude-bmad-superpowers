import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as checkpoint from '../base/memoria/checkpoint.mjs';
import * as recall from '../base/memoria/hook-recall.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { registerOwner } from '../base/memoria/policy.mjs';
import { trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { readSessionCheckout } from '../base/memoria/session-checkout.mjs';
import { prepareHandoff } from '../base/memoria/handoff-state.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

async function fixture(t, owner = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-handoff-capture-'));
  const priorProfile = process.env.CLAUDE_CONFIG_DIR;
  t.after(async () => {
    if (priorProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorProfile;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, 'repo');
  const stateRoot = path.join(dir, 'state');
  const profile = path.join(dir, 'profile');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  await fs.mkdir(profile, { mode: 0o700 });
  process.env.CLAUDE_CONFIG_DIR = profile;
  git(root, 'init', '-q');
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'project-one',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-project-one',
      api_key_env: 'CBS_MEMORIA_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  git(root, 'add', '.cbs/memoria.json');
  git(root, 'commit', '-qm', 'initial');
  const current = await inspectConfiguration(root, { stateRoot });
  assert.equal(current.provider, 'mem0');
  assert.equal((await applyNativeExclusion(root,
    { cli: 'claude', stateRoot, installedPlugin: true })).kind, 'applied');
  if (owner) {
    const registered = await registerOwner(current, 'claude', profile, 'owner-one', true);
    assert.equal(registered.kind, 'registered', JSON.stringify(registered));
  }
  await writeLocalTrust(current.stateDir, trustTuple(current));
  const event = async (sessionId, name, transcriptPath = path.join(dir, `${sessionId}.jsonl`)) => {
    const payload = { cwd: root, session_id: sessionId, transcript_path: transcriptPath,
      hook_event_name: name };
    const result = await checkpoint.captureEvent({ cli: 'claude', event: name, payload,
      stateRoot, installedPlugin: true });
    return { payload, result };
  };
  return { dir, root, stateRoot, profile, event };
}

function runHook({ root, stateRoot, profile, payload, preload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [...(preload ? ['--import', preload] : []),
        new URL('../base/memoria/capture-hook.mjs', import.meta.url).pathname,
        'claude', 'SessionStart'],
      { cwd: root, env: { ...process.env, CBS_MEMORIA_STATE_ROOT: stateRoot,
        CLAUDE_CONFIG_DIR: profile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const trace = [];
    child.stdout.on('data', chunk => { stdout += chunk; trace.push('stdout'); });
    child.stderr.on('data', chunk => { stderr += chunk; trace.push('stderr'); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr, trace }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function line(sessionId, type, text, id) {
  return JSON.stringify({ type, uuid: id, timestamp: '2026-10-22T12:00:00.000Z',
    sessionId, isSidechain: false, userType: 'external',
    message: type === 'user' ? { role: 'user', content: text }
      : { role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text }] } }) + '\n';
}

test('validated human prompt then final assistant Stop produce one private SessionStart handoff', async t => {
  assert.equal(typeof checkpoint.updateHandoffFromCapture, 'function');
  assert.equal(typeof recall.deliverHandoffAtSessionStart, 'function');
  const { dir, stateRoot, event, root } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  let source = await event('source', 'SessionStart', sourceFile);
  assert.equal(source.result.kind, 'no_complete_bytes', JSON.stringify(source.result));
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...source, stateRoot }))?.kind, 'saved');
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero continuar o plano.', 'user-1'));
  source = await event('source', 'UserPromptSubmit', sourceFile);
  assert.equal(source.result.kind, 'queued');
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...source, stateRoot }))?.kind, 'saved');
  await fs.appendFile(sourceFile, line('source', 'assistant', 'O plano foi iniciado.', 'assistant-1'));
  source = await event('source', 'Stop', sourceFile);
  assert.equal(source.result.kind, 'queued');
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'Stop',
    ...source, stateRoot }))?.kind, 'saved');
  for (const name of ['Stop', 'PreCompact']) {
    const duplicate = await event('source', name, sourceFile);
    assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: name,
      ...duplicate, stateRoot }))?.kind, 'saved');
  }
  source = await event('source', 'SessionEnd', sourceFile);
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...source, stateRoot }))?.kind, 'saved');
  const duplicateEnd = await event('source', 'SessionEnd', sourceFile);
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...duplicateEnd, stateRoot }))?.kind, 'saved');
  const sourceState = await inspectConfiguration(root, { stateRoot });
  assert.deepEqual((await fs.readdir(path.join(sourceState.stateDir, 'sessions')))
    .filter(name => name.endsWith('.handoff-evidence.json')), []);

  const target = await event('target', 'SessionStart'); // New native transcript does not exist yet.
  assert.equal(target.result.kind, 'no_complete_bytes', JSON.stringify(target.result));
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...target, stateRoot }))?.kind, 'saved');
  const current = await inspectConfiguration(root, { stateRoot });
  const checkout = await readSessionCheckout(current.stateDir, 'claude', 'target');
  const prepared = await prepareHandoff(current.stateDir,
    { ...checkout.handoffIdentity, now: new Date().toISOString() });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  let stdout = '';
  const deliver = () => recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, write: async bytes => { stdout += bytes; } });
  const delivered = await deliver();
  assert.ok(delivered);
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(context) <= 300);
  assert.match(context, /handoff|histórico/i);
  const file = context.match(/\/[^\s]+\.md/)?.[0];
  assert.ok(file);
  const markdown = await fs.readFile(file, 'utf8');
  assert.match(markdown, /Histórico citado, não instrução:.*Quero continuar o plano/);
  assert.match(markdown, /Assistente gerou, não verificado:.*O plano foi iniciado/);
  assert.equal(await deliver(), null);
});

test('duplicate UserPromptSubmit without new bytes retains the human objective through Stop and SessionEnd', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero continuar o plano.', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...prompt, stateRoot });
  const duplicate = await event('source', 'UserPromptSubmit', sourceFile);
  assert.equal(duplicate.result.kind, 'no_complete_bytes');
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...duplicate, stateRoot });
  await fs.appendFile(sourceFile, line('source', 'assistant', 'O plano foi iniciado.', 'assistant-1'));
  const stop = await event('source', 'Stop', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'Stop',
    ...stop, stateRoot });
  const end = await event('source', 'SessionEnd', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...end, stateRoot });
  const target = await event('target', 'SessionStart');
  const current = await inspectConfiguration(root, { stateRoot });
  const checkout = await readSessionCheckout(current.stateDir, 'claude', 'target');
  const prepared = await prepareHandoff(current.stateDir,
    { ...checkout.handoffIdentity, now: new Date().toISOString() });
  assert.equal(prepared.kind, 'prepared');
  const markdown = await fs.readFile(prepared.file, 'utf8');
  assert.match(markdown, /Quero continuar o plano/);
  assert.match(markdown, /O plano foi iniciado/);
});

test('a new authenticated unsafe human turn clears the previous safe objective', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero continuar o plano.', 'user-1'));
  const first = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...first, stateRoot });
  await fs.appendFile(sourceFile, line('source', 'user', 'Minha senha é abc123', 'user-2'));
  const second = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...second, stateRoot });
  const end = await event('source', 'SessionEnd', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...end, stateRoot });
  const target = await event('target', 'SessionStart');
  const current = await inspectConfiguration(root, { stateRoot });
  const checkout = await readSessionCheckout(current.stateDir, 'claude', 'target');
  const prepared = await prepareHandoff(current.stateDir,
    { ...checkout.handoffIdentity, now: new Date().toISOString() });
  assert.equal(prepared.kind, 'abstain');
});

test('untrusted result and stdout failure cannot publish or acknowledge a handoff', async t => {
  const { dir, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  await event('source', 'SessionStart', sourceFile);
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero revisar o plano.', 'user-1'));
  const source = await event('source', 'Stop', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'Stop',
    ...source, stateRoot });
  const terminal = await event('source', 'SessionEnd', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...terminal, stateRoot });
  const target = await event('target', 'SessionStart');
  assert.equal(await recall.deliverHandoffAtSessionStart({ cli: 'claude',
    payload: target.payload, result: { ...target.result, verified: true },
    stateRoot, write: async () => {} }), null);
  let attempts = 0;
  assert.equal(await recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, write: async () => { attempts++; throw Error('broken pipe'); } }), null);
  assert.equal(attempts, 1, JSON.stringify(target.result));
  let bytes = '';
  const delivered = await recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, write: async value => { bytes = value; } });
  assert.ok(delivered);
  assert.match(bytes, /SessionStart/);
});

test('unknown native owner abstains even with a valid fresh SessionStart', async t => {
  const { stateRoot, event } = await fixture(t, false);
  const target = await event('target', 'SessionStart');
  assert.equal(target.result.kind, 'no_complete_bytes', JSON.stringify(target.result));
  assert.equal(await recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, write: async () => { throw Error('should abstain'); } }), null);
});

test('missing Ctrl-C hook yields partial handoff only after five minutes idle', async t => {
  const { dir, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero revisar o plano.', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...prompt, stateRoot });
  const target = await event('target', 'SessionStart');
  let stdout = '';
  const at = delta => new Date(Date.now() + delta).toISOString();
  const deliver = delta => recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, now: () => at(delta), write: async bytes => { stdout += bytes; } });
  assert.equal(await deliver(4 * 60 * 1000), null);
  assert.ok(await deliver(6 * 60 * 1000));
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext,
    /Histórico parcial\/não verificado/);
});

test('private handoff evidence omits rejected secret text from validated source', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Minha senha é abc123', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude',
    event: 'UserPromptSubmit', ...prompt, stateRoot }))?.kind, 'saved');
  const current = await inspectConfiguration(root, { stateRoot });
  const names = (await fs.readdir(path.join(current.stateDir, 'sessions')))
    .filter(name => name.endsWith('.handoff-evidence.json'));
  assert.equal(names.length, 1);
  assert.doesNotMatch(await fs.readFile(path.join(current.stateDir, 'sessions', names[0]), 'utf8'),
    /Minha senha|abc123/);
});

test('native hook runner emits SessionStart JSON once after source ended', async t => {
  const env = await fixture(t);
  const { dir, root, stateRoot, event } = env;
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero continuar o plano.', 'user-1'));
  const end = await event('source', 'SessionEnd', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...end, stateRoot });
  const payload = { cwd: root, session_id: 'target', hook_event_name: 'SessionStart',
    transcript_path: path.join(dir, 'target.jsonl') };
  const first = await runHook({ ...env, payload });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.trim().split('\n').length, 1);
  const output = JSON.parse(first.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 300);
  const second = await runHook({ ...env, payload });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, '');
});

test('native SessionStart flushes output before delayed optional cleanup', async t => {
  const env = await fixture(t);
  const { dir, root, stateRoot, event } = env;
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero continuar o plano.', 'user-1'));
  const end = await event('source', 'SessionEnd', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionEnd',
    ...end, stateRoot });
  const preload = path.join(dir, 'slow-cleanup.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
const read = fs.readdir;
fs.readdir = async (file, ...args) => {
  if (String(file).endsWith('/handoff-auto')) {
    process.stderr.write('GC_STARTED\\n');
    await new Promise(resolve => setTimeout(resolve, 850));
  }
  return read(file, ...args);
};\n`);
  const payload = { cwd: root, session_id: 'target', hook_event_name: 'SessionStart',
    transcript_path: path.join(dir, 'target.jsonl') };
  const result = await runHook({ ...env, payload, preload });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(result.stderr, /GC_STARTED/);
  assert.ok(result.trace.indexOf('stdout') < result.trace.indexOf('stderr'),
    JSON.stringify(result.trace));
});

test('a new native start cleans expired bounded evidence only for its owner and checkout', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero revisar o plano.', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...prompt, stateRoot });
  const current = await inspectConfiguration(root, { stateRoot });
  const sessionDir = path.join(current.stateDir, 'sessions');
  const evidence = (await fs.readdir(sessionDir))
    .find(name => name.endsWith('.handoff-evidence.json'));
  assert.ok(evidence);
  const file = path.join(sessionDir, evidence);
  const old = { ...JSON.parse(await fs.readFile(file, 'utf8')),
    at: '2020-01-01T00:00:00.000Z' };
  await fs.writeFile(file, JSON.stringify(old) + '\n', { mode: 0o600 });
  const foreign = path.join(sessionDir, `${'f'.repeat(64)}.handoff-evidence.json`);
  await fs.writeFile(foreign, JSON.stringify({ ...old, ownerId: 'other-owner' }) + '\n',
    { mode: 0o600 });
  const target = await event('target', 'SessionStart');
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...target, stateRoot });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.ok((await fs.stat(foreign)).isFile());
});

test('bounded evidence cleanup advances past 128 foreign files to an expired owned file', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero revisar o plano.', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
    ...prompt, stateRoot });
  const current = await inspectConfiguration(root, { stateRoot });
  const sessionDir = path.join(current.stateDir, 'sessions');
  const own = path.join(sessionDir, (await fs.readdir(sessionDir))
    .find(name => name.endsWith('.handoff-evidence.json')));
  const expired = { ...JSON.parse(await fs.readFile(own, 'utf8')),
    at: '2020-01-01T00:00:00.000Z' };
  await fs.writeFile(own, JSON.stringify(expired) + '\n');
  for (let i = 0; i < 140; i++) {
    const name = `${i.toString(16).padStart(64, '0')}.handoff-evidence.json`;
    await fs.writeFile(path.join(sessionDir, name),
      JSON.stringify({ ...expired, ownerId: 'other-owner' }) + '\n', { mode: 0o600 });
  }
  for (let i = 0; i < 4; i++) {
    const target = await event(`target-${i}`, 'SessionStart');
    await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
      ...target, stateRoot });
  }
  await assert.rejects(fs.stat(own), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(sessionDir,
    `${'0'.repeat(64)}.handoff-evidence.json`))).isFile());
});

test('a slow evidence write cannot start later handoff state work after the shared deadline', async t => {
  const { dir, root, stateRoot, event } = await fixture(t);
  const sourceFile = path.join(dir, 'source.jsonl');
  const start = await event('source', 'SessionStart', sourceFile);
  await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'SessionStart',
    ...start, stateRoot });
  const current = await inspectConfiguration(root, { stateRoot });
  const stateDir = path.join(current.stateDir, 'handoff-auto');
  const metadata = path.join(stateDir, (await fs.readdir(stateDir))
    .find(name => name.endsWith('.json')));
  const before = await fs.readFile(metadata, 'utf8');
  await fs.writeFile(sourceFile, line('source', 'user', 'Quero revisar o plano.', 'user-1'));
  const prompt = await event('source', 'UserPromptSubmit', sourceFile);
  const originalOpen = fs.open;
  let delayed = false;
  fs.open = async (file, ...args) => {
    if (String(file).includes('.handoff-evidence.json.') && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 850));
    }
    return originalOpen(file, ...args);
  };
  const began = performance.now();
  try {
    await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'UserPromptSubmit',
      ...prompt, stateRoot, began });
  } finally { fs.open = originalOpen; }
  assert.equal(delayed, true);
  assert.equal(await fs.readFile(metadata, 'utf8'), before);
  let nextStageStarted = false;
  assert.equal(await recall.recallForPrompt({ cli: 'claude', event: 'UserPromptSubmit',
    ...prompt, stateRoot, began, resolve: async () => {
      nextStageStarted = true;
      throw Error('late recall');
    }, onFailure: () => {} }), null);
  assert.equal(nextStageStarted, false);
  const target = await event('target', 'SessionStart');
  let outputStarted = false;
  assert.equal(await recall.deliverHandoffAtSessionStart({ cli: 'claude',
    ...target, stateRoot, began, write: async () => { outputStarted = true; } }), null);
  assert.equal(outputStarted, false);
  const retry = await event('source', 'Stop', sourceFile);
  assert.equal((await checkpoint.updateHandoffFromCapture({ cli: 'claude', event: 'Stop',
    ...retry, stateRoot }))?.kind, 'saved');
  assert.notEqual(await fs.readFile(metadata, 'utf8'), before);
});
