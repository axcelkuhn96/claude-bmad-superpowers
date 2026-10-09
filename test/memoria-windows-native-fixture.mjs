#!/usr/bin/env node
// Invoked only by memoria-windows-validation.ps1 on a real Windows host.
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureWindowsPrivateDirectory, inspectWindowsPath, publishWindowsBinary,
  resolveWindowsExecutable, deleteWindowsBinary } from '../base/memoria/windows-security.mjs';
import { enrollWindowsTool } from '../base/memoria/windows-enrollment.mjs';
import { RUNTIME_PINS, verifyRuntimeArtifacts } from '../base/memoria/runtime.mjs';
import { inspectConfiguration, initializeSession } from '../base/memoria/provider.mjs';
import { validateDestination } from '../base/memoria/activation.mjs';
import { trustTuple, writeLocalTrust } from '../base/memoria/trust.mjs';
import { applyNativeExclusion, verifyNativeCapture } from '../base/memoria/native.mjs';
import { createLaunch, buildLaunchCommand, resolveBoundLaunch, launchCli } from '../base/memoria/launch.mjs';
import { removeWindowsOverlay } from '../base/memoria/windows-overlay.mjs';
import { activateProject } from '../base/memoria/setup.mjs';
import { captureEvent } from '../base/memoria/checkpoint.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { consumeCheckpoints } from '../base/memoria/extract-worker.mjs';
import { reviewCandidateOnTerminal } from '../base/memoria/candidates.mjs';
import { provisionRuntime } from '../base/memoria/provision.mjs';
import { brokerEndpointStatus, requestBroker, serveBroker,
  claimBrokerWorker } from '../base/memoria/broker.mjs';
import { authenticateWindowsClient, newWindowsDiscovery } from '../base/memoria/windows-transport.mjs';

const runFile = promisify(execFile);
const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
const settings = JSON.parse(process.env.CBS_WINDOWS_FIXTURE_CONFIG_JSON ?? '{}');
const controls = {};
const report = { schema: 'cbs-mem0-windows-native-fixture-v3', platform: process.platform,
  architecture: process.arch, productRoot, controls };
const record = (name, status, evidence = {}) => {
  if (!['passed', 'failed', 'missing_prerequisite', 'blocked_missing_implementation'].includes(status)) {
    throw new Error('invalid_fixture_status');
  }
  controls[name] = { status, evidence };
};
const failure = error => ({ reason: error?.message ?? 'fixture_error' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requirePrivate = async dir => {
  const result = await ensureWindowsPrivateDirectory(dir);
  if (!result.ok) throw new Error(`fixture_directory_${result.code}`);
  const checked = await inspectWindowsPath(dir, 'directory');
  if (!checked.ok) throw new Error('fixture_directory_changed');
  return checked;
};

async function save() {
  if (!reportPath || !path.isAbsolute(reportPath)) throw new Error('fixture_report_path');
  report.status = Object.values(controls).some(value => value.status === 'failed') ? 'failed' :
    Object.values(controls).some(value => value.status === 'blocked_missing_implementation')
      ? 'blocked_missing_implementation' :
      Object.values(controls).some(value => value.status === 'missing_prerequisite')
        ? 'missing_prerequisite' : 'passed';
  const handle = await fs.open(reportPath, 'wx');
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  process.stdout.write(`${reportPath}\n`);
}

async function gitCheckout(root, leaf = 'project') {
  const git = await resolveWindowsExecutable('git.exe', [root, productRoot]);
  const project = path.join(root, leaf);
  await requirePrivate(project);
  const gitRun = async args => runFile(git, args, { cwd: project, timeout: 15000,
    windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  await gitRun(['init', '-q']);
  await gitRun(['-c', 'user.name=CBS fixture', '-c', 'user.email=cbs-fixture@invalid.example',
    'commit', '--allow-empty', '-q', '-m', 'fixture']);
  return project;
}

async function enroll(root, project) {
  const outcomes = {};
  for (const name of ['claude', 'codex', 'python']) {
    const source = settings.tools?.[name];
    if (!source?.executable || !source?.sha256) {
      outcomes[name] = 'missing_prerequisite';
      continue;
    }
    try {
      await enrollWindowsTool({ stateRoot: root, name, executable: source.executable,
        sha256: source.sha256, projectRoot: project, activeRoot: project, productRoot });
      outcomes[name] = 'passed';
    } catch { outcomes[name] = 'failed'; }
  }
  record('explicit_absolute_sha_tool_enrollment', Object.values(outcomes).includes('failed')
    ? 'failed' : Object.values(outcomes).includes('missing_prerequisite')
      ? 'missing_prerequisite' : 'passed', outcomes);
  return outcomes;
}

async function configuredProject(project, stateRoot, fixture) {
  const destination = settings.destination;
  if (!destination?.url || !destination?.collection || !destination?.apiKeyEnv) {
    record('destination_trust', 'missing_prerequisite', { reason: 'destination_and_key_env_required' });
    return null;
  }
  const config = { provider: 'mem0', project_id: `fixture-${fixture}`,
    qdrant: { url: destination.url, collection: destination.collection,
      api_key_env: destination.apiKeyEnv },
    embedding: { model: 'multilingual-e5-small', dimension: RUNTIME_PINS.dimensions,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } };
  await requirePrivate(path.join(project, '.cbs'));
  await publishWindowsBinary(path.join(project, '.cbs', 'memoria.json'),
    Buffer.from(JSON.stringify(config) + '\n'));
  const resolution = await inspectConfiguration(project, { stateRoot });
  if (resolution.provider !== 'mem0') {
    record('destination_trust', 'failed', { reason: resolution.reason });
    return null;
  }
  const tuple = trustTuple(resolution);
  const checked = await validateDestination(resolution, resolution.embeddingFingerprint, {
    approve: async () => tuple, readSecret: name => process.env[name],
    isCurrent: async () => {
      const current = await inspectConfiguration(project, { stateRoot });
      return current.provider === 'mem0' && JSON.stringify(trustTuple(current)) === JSON.stringify(tuple);
    },
  });
  if (checked.kind !== 'authorized') {
    record('destination_trust', checked.reason === 'invalid_activation' ? 'failed' :
      'missing_prerequisite', { reason: checked.reason });
    return null;
  }
  await writeLocalTrust(resolution.stateDir, tuple);
  record('destination_trust', 'passed', { projectId: resolution.projectId,
    collection: destination.collection });
  return resolution;
}

async function persistenceCore(stateDir, projectId) {
  const box = createOutbox(stateDir);
  const sessionId = `fixture-persistence-${randomUUID()}`;
  const bytes = Buffer.from('fixture checkpoint\r\n');
  const slice = { cli: 'claude', sessionId, start: 0, end: bytes.length,
    sliceHash: sha(bytes), messages: [] };
  const identity = { projectId, policyVersion: 'native-v1' };
  const [first, second] = await Promise.all([
    box.enqueueCheckpoint(slice, identity), box.enqueueCheckpoint(slice, identity),
  ]);
  if (first.operationId !== second.operationId || first.kind !== 'queued' ||
      !['queued', 'acked'].includes(second.kind)) throw new Error('fixture_double_enqueue');
  const restarted = createOutbox(stateDir);
  const pending = await restarted.pending();
  if (pending.filter(row => row.operationId === first.operationId).length !== 1) {
    throw new Error('fixture_replay_lost_item');
  }
  const manifested = await restarted.recordManifest(first.operationId, []);
  if (manifested.kind !== 'manifested') throw new Error('fixture_manifest_failed');
  const processed = await restarted.completeCheckpoint(first.operationId);
  if (processed.kind !== 'processed') throw new Error('fixture_receipt_failed');
  const cursor = await createOutbox(stateDir).cursor('claude', sessionId);
  if (cursor.processedEnd !== bytes.length) throw new Error('fixture_cursor_before_receipt');
  return { operationId: first.operationId, processedEnd: cursor.processedEnd };
}

async function negativeWindowsIpc(stateRoot) {
  const first = await claimBrokerWorker(stateRoot);
  let secondDenied = false;
  try { await claimBrokerWorker(stateRoot); }
  catch { secondDenied = true; }
  await first.release(false);
  let uncertainDenied = false;
  try { await claimBrokerWorker(stateRoot); }
  catch { uncertainDenied = true; }
  await first.release(true);
  const next = await claimBrokerWorker(stateRoot);
  await next.release(true);
  if (!secondDenied || !uncertainDenied) throw new Error('fixture_worker_guard_released_early');

  let accepted;
  let bytes = Buffer.alloc(0);
  const fake = net.createServer(socket => {
    accepted = socket;
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length === 68) socket.write(Buffer.alloc(65));
    });
  });
  await new Promise((resolve, reject) => {
    fake.once('error', reject);
    fake.listen(0, '127.0.0.1', resolve);
  });
  const discovery = newWindowsDiscovery(fake.address().port);
  const client = net.createConnection({ host: '127.0.0.1', port: discovery.port });
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    await authenticateWindowsClient(client, discovery, Date.now() + 1000)
      .then(() => { throw new Error('fixture_fake_server_authenticated'); }, () => {});
    if (bytes.length !== 68) throw new Error('fixture_secret_sent_before_server_proof');
  } finally {
    client.destroy();
    accepted?.destroy();
    await new Promise(resolve => fake.close(resolve));
  }
  return { durableGuardDeniedSecondClaim: true, fakeServerReceivedApplicationBytes: 0 };
}

async function captureCore(project, stateRoot, resolution, profile) {
  process.env.CLAUDE_CONFIG_DIR = profile;
  const native = await applyNativeExclusion(project,
    { cli: 'claude', projectRoot: project, stateRoot, profile });
  if (native.kind !== 'applied') throw new Error(native.reason ?? 'fixture_native_apply');
  const verified = await verifyNativeCapture(project,
    { cli: 'claude', projectRoot: project, stateRoot, profile });
  if (verified.kind !== 'verified') throw new Error(verified.reason ?? 'fixture_native_verify');
  const made = await createLaunch(project, 'claude', { stateRoot });
  if (made.kind !== 'created') throw new Error(made.reason ?? 'fixture_launch');
  process.env.CBS_MEMORIA_LAUNCH_ID = made.token;
  const sessionId = randomUUID();
  const transcript = path.join(stateRoot, 'fixture-transcripts', `${sessionId}.jsonl`);
  await requirePrivate(path.dirname(transcript));
  const payload = { hook_event_name: 'SessionStart', cwd: project, session_id: sessionId,
    transcript_path: transcript };
  const started = await captureEvent({ cli: 'claude', event: 'SessionStart', payload, stateRoot });
  if (started.kind === 'blocked') throw new Error(started.reason);
  const bound = await resolveBoundLaunch(made.token, 'claude', { stateRoot });
  if (bound.kind !== 'bound' || bound.nativeSessionId !== sessionId) throw new Error('fixture_binding_failed');
  const line = JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text: 'Fixture source fact.' }] } }) + '\r\n';
  await publishWindowsBinary(transcript, Buffer.from(line));
  const captured = await captureEvent({ cli: 'claude', event: 'UserPromptSubmit',
    payload: { ...payload, hook_event_name: 'UserPromptSubmit' }, stateRoot });
  if (captured.kind !== 'queued') throw new Error(captured.reason ?? 'fixture_capture_failed');
  const rows = await createOutbox(resolution.stateDir).pending();
  const row = rows.find(item => item.operationId === captured.operationId);
  if (!row || row.messages.length !== 1 || row.messages[0].origin !== 'human' ||
      row.messages[0].sessionId !== sessionId) throw new Error('fixture_capture_identity');
  return { made, captured, sessionId, row, transcript };
}

async function runActualCli(command) {
  return new Promise(resolve => {
    const child = spawn(command.command, command.args, { cwd: command.cwd,
      env: command.env, stdio: 'inherit', windowsHide: false });
    child.once('error', () => resolve({ kind: 'unavailable' }));
    child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
  });
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    record('native_platform', 'missing_prerequisite', { requires: 'Windows x64 NTFS' });
    return;
  }
  const fixture = randomUUID();
  const root = path.join(os.tmpdir(), `cbs-mem0-native-${fixture}`);
  const stateRoot = path.join(root, 'state');
  const claudeProfile = path.join(root, 'profiles', 'claude');
  const codexProfile = path.join(root, 'profiles', 'codex');
  report.fixtureRoot = root; // Retained for audit; no recursive cleanup of unknown objects.
  for (const dir of [root, stateRoot, claudeProfile, codexProfile]) await requirePrivate(dir);
  record('fresh_private_ntfs_fixture', 'passed', { privateState: true });
  const project = await gitCheckout(root);
  record('fresh_git_checkout', 'passed', { project });
  const defaultProject = await gitCheckout(root, 'default-project');
  const defaultSelection = await initializeSession(defaultProject, `fixture-default-${fixture}`,
    { stateRoot, event: 'SessionStart' });
  record('default_claude_mem_selection', defaultSelection.provider === 'claude-mem'
    ? 'passed' : 'failed', { provider: defaultSelection.provider });
  const gates = [await activateProject(project, {}), await launchCli(project, 'claude', [], { stateRoot })];
  record('public_windows_release_gate', gates.every(value => value.kind === 'blocked' &&
    value.reason === 'windows_release_unproved') ? 'passed' : 'failed', { results: gates });
  const enrolled = await enroll(stateRoot, project);
  const resolution = await configuredProject(project, stateRoot, fixture);
  try {
    const persisted = await persistenceCore(path.join(stateRoot, 'fixture-persistence'),
      resolution?.projectId ?? `fixture-${fixture}`);
    record('outbox_concurrent_receipt_replay', 'passed', persisted);
  } catch (error) { record('outbox_concurrent_receipt_replay', 'failed', failure(error)); }
  try { record('worker_guard_and_presecret_ipc', 'passed', await negativeWindowsIpc(stateRoot)); }
  catch (error) { record('worker_guard_and_presecret_ipc', 'failed', failure(error)); }
  if (!resolution) {
    for (const name of ['core_capture_binding', 'capture_source_and_args_negative',
      'native_claude_launch', 'real_extraction', 'manual_review',
      'runtime_broker_recall', 'codex_native_hook_observation',
      'default_claude_mem_simultaneous_control']) {
      record(name, 'missing_prerequisite', { reason: 'destination_trust' });
    }
    return;
  }
  let capture;
  try {
    capture = await captureCore(project, stateRoot, resolution, claudeProfile);
    record('core_capture_binding', 'passed', { operationId: capture.captured.operationId,
      messageCount: capture.row.messages.length });
  } catch (error) { record('core_capture_binding', 'failed', failure(error)); }
  if (capture) await removeWindowsOverlay({ stateRoot, token: capture.made.token,
    expected: capture.made.record.overlay });
  if (capture) {
    const unsafe = await buildLaunchCommand(project, 'claude', ['--settings', 'foreign'],
      { stateRoot }, capture.made);
    const sourceDir = path.join(project, '.claude');
    await requirePrivate(sourceDir);
    const source = path.join(sourceDir, 'settings.local.json');
    const bytes = Buffer.from(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command', command: 'capture-hook.mjs',
    }] }] } }) + '\n');
    const published = await publishWindowsBinary(source, bytes);
    let duplicated;
    try {
      duplicated = await verifyNativeCapture(project, { cli: 'claude', projectRoot: project,
        stateRoot, profile: claudeProfile });
    } finally { await deleteWindowsBinary(source, published.fileId, bytes); }
    record('capture_source_and_args_negative', unsafe.reason === 'unsafe_cli_args' &&
      duplicated.kind === 'blocked' ? 'passed' : 'failed',
    { unsafeArg: unsafe.reason, duplicatedSource: duplicated.reason });
  }
  if (enrolled.claude === 'passed') {
    const made = await createLaunch(project, 'claude', { stateRoot });
    if (made.kind !== 'created') record('native_claude_launch', 'failed', { reason: made.reason });
    else {
      const launch = await buildLaunchCommand(project, 'claude', [], { stateRoot }, made);
      if (launch.kind !== 'ready') {
        record('native_claude_launch', 'failed', { reason: launch.reason });
        await removeWindowsOverlay({ stateRoot, token: made.token, expected: made.record.overlay });
      } else {
        try {
          if (settings.runInteractiveCli) {
            const result = await runActualCli({ ...launch, cwd: project });
            const bound = await resolveBoundLaunch(made.token, 'claude', { stateRoot });
            const cursor = bound.kind === 'bound'
              ? await createOutbox(resolution.stateDir).cursor('claude', bound.nativeSessionId) : null;
            const observed = (cursor?.queuedEnd ?? 0) > 0;
            record('native_claude_launch', result.kind === 'exited' && result.code === 0 && observed
              ? 'passed' : 'failed', { ...result, sessionBound: bound.kind === 'bound',
                checkpointObserved: observed });
          } else record('native_claude_launch', 'missing_prerequisite',
            { reason: 'interactive_cli_prompt_observation_required' });
        } finally { launch.release(); await launch.cleanup(); }
      }
    }
  } else record('native_claude_launch', 'missing_prerequisite', { reason: 'claude_enrollment' });
  if (capture && enrolled.claude === 'passed' && settings.runExtraction) {
    process.env.CBS_MEMORIA_STATE_ROOT = stateRoot;
    const result = await consumeCheckpoints({ cli: 'claude', cwd: project,
      sessionId: capture.sessionId, stateRoot });
    record('real_extraction', result.kind === 'consumed' && result.manifested > 0
      ? 'passed' : 'failed', result);
    const manifest = await createOutbox(resolution.stateDir).readManifest(capture.captured.operationId);
    const candidate = manifest?.candidates?.find(item => item.status === 'pending');
    if (candidate && settings.runReview) {
      const sid = (await inspectWindowsPath(resolution.stateDir, 'directory')).currentSid;
      const review = await reviewCandidateOnTerminal(capture.captured.operationId,
        candidate.candidateKey, { outbox: createOutbox(resolution.stateDir), cwd: project,
          sessionId: capture.sessionId, stateRoot, writerId: `sid:${sid}`,
          actor: `sid:${sid}:${os.userInfo().username}`,
          readSecret: name => process.env[name] });
      record('manual_review', ['acked', 'processed', 'disposed'].includes(review.kind)
        ? 'passed' : 'failed', { kind: review.kind, reason: review.reason });
    } else record('manual_review', 'missing_prerequisite',
      { reason: candidate ? 'operator_review_required' : 'no_pending_candidate' });
  } else {
    record('real_extraction', 'missing_prerequisite', { reason: 'sonnet_account_or_operator_run' });
    record('manual_review', 'missing_prerequisite', { reason: 'extraction_not_run' });
  }
  const inputs = settings.runtime;
  if (capture && enrolled.python === 'passed' && inputs?.model && inputs?.tokenizer &&
      settings.runRuntime) {
    const verified = await verifyRuntimeArtifacts(inputs.model, inputs.tokenizer);
    const prepared = verified.kind === 'verified'
      ? await provisionRuntime(project, inputs.model, inputs.tokenizer, { stateRoot }) : verified;
    if (prepared.kind !== 'provisioned') {
      record('runtime_broker_recall', 'failed', { reason: prepared.reason });
    } else {
      let served;
      const serve = serveBroker({ stateRoot, bootstrapCwd: project,
        bootstrapSessionId: capture?.sessionId, idleMs: 5000 });
      serve.then(value => { served = value; });
      try {
        const endpoint = path.join(stateRoot, 'encoder.discovery.json');
        const start = Date.now();
        while (!served && Date.now() - start < 5000) {
          if (await fs.lstat(endpoint).then(() => true, () => false)) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const status = await brokerEndpointStatus(stateRoot);
        const result = status === 'live' && capture
          ? await requestBroker({ cwd: project, sessionId: capture.sessionId,
            operation: { op: 'search', projectId: resolution.projectId, query: 'fixture source fact' } },
          process.env[settings.destination.apiKeyEnv], { stateRoot, deadlineMs: 1000 })
          : { kind: 'unavailable', reason: status };
        record('runtime_broker_recall', result.kind === 'items' ? 'passed' : 'failed',
          { kind: result.kind, reason: result.reason });
      } finally { await serve; }
    }
  } else record('runtime_broker_recall', 'missing_prerequisite',
    { reason: 'pinned_runtime_artifacts_python_or_operator_run' });
  if (enrolled.codex === 'passed') {
    process.env.CODEX_HOME = codexProfile;
    const native = await applyNativeExclusion(project,
      { cli: 'codex', projectRoot: project, stateRoot, profile: codexProfile });
    const made = native.kind === 'applied' ? await createLaunch(project, 'codex', { stateRoot }) : native;
    const launch = made.kind === 'created'
      ? await buildLaunchCommand(project, 'codex', [], { stateRoot }, made) : made;
    if (launch.kind !== 'ready') record('codex_native_hook_observation', 'failed',
      { reason: launch.reason });
    else {
      try {
        if (settings.runInteractiveCli) {
          const result = await runActualCli({ ...launch, cwd: project });
          const bound = await resolveBoundLaunch(made.token, 'codex', { stateRoot });
          const cursor = bound.kind === 'bound'
            ? await createOutbox(resolution.stateDir).cursor('codex', bound.nativeSessionId) : null;
          const observed = (cursor?.queuedEnd ?? 0) > 0;
          record('codex_native_hook_observation', result.kind === 'exited' &&
            result.code === 0 && observed ? 'passed' : 'failed',
          { ...result, sessionBound: bound.kind === 'bound', checkpointObserved: observed });
        } else record('codex_native_hook_observation', 'missing_prerequisite',
          { reason: 'interactive_cli_prompt_observation_required' });
      } finally { launch.release(); await launch.cleanup(); }
    }
  } else record('codex_native_hook_observation', 'missing_prerequisite',
    { reason: 'codex_enrollment' });
  record('default_claude_mem_simultaneous_control', 'blocked_missing_implementation',
    { reason: 'fixture_cannot_yet_observe_effective_default_plugin_hooks_side_by_side' });
}

try { await main(); }
catch (error) { record('fixture_execution', 'failed', failure(error)); }
finally { await save(); }
