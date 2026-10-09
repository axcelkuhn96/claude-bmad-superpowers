#!/usr/bin/env node
// Invoked only by memoria-windows-validation.ps1 on a real Windows host.
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureWindowsPrivateDirectory, inspectWindowsPath, publishWindowsBinary,
  resolveWindowsExecutable, deleteWindowsBinary, readWindowsBinary,
  rewriteWindowsBinary, windowsSystemLocations, windowsPathKey,
  WINDOWS_NATIVE_SHA256 } from '../base/memoria/windows-security.mjs';
import { createWindowsState } from '../base/memoria/windows-state.mjs';
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
import { recallForPrompt } from '../base/memoria/hook-recall.mjs';
import { createOutbox } from '../base/memoria/outbox.mjs';
import { createLedger, externalIdFor } from '../base/memoria/ledger.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
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
let ownedProxy;
let ownedCaptureOverlay;
const controls = {};
const report = { schema: 'cbs-mem0-windows-native-fixture-v4', platform: process.platform,
  architecture: process.arch, productRoot, startedAt: new Date().toISOString(),
  startedMonotonicMs: performance.now(), controls };
const budgets = { captureP95Ms: 250, recallTotalP95Ms: 1000, recallTotalMaxMs: 1000,
  contextTokens: 500, outboxBytes: 256 * 1024 * 1024 };
const controlStarts = new Map();
const beginControl = (...names) => {
  const began = performance.now();
  for (const name of names) controlStarts.set(name, began);
};
const controlBudgetMs = name =>
  ['native_claude_launch', 'native_cli_hook_recall', 'codex_native_hook_observation',
    'default_claude_mem_simultaneous_control', 'manual_review', 'real_extraction',
    'runtime_broker_recall', 'remote_add_crash_replay'].includes(name)
    ? 15 * 60 * 1000 : name.startsWith('outbox_crash_') || name.startsWith('state_crash_')
      ? 120000 : 60000;
const record = (name, status, evidence = {}) => {
  if (!['passed', 'failed', 'missing_prerequisite', 'blocked_missing_implementation'].includes(status)) {
    throw new Error('invalid_fixture_status');
  }
  const endedMonotonicMs = performance.now();
  const executionStarted = controlStarts.has(name);
  const startedMonotonicMs = controlStarts.get(name) ?? endedMonotonicMs;
  const elapsedMs = endedMonotonicMs - startedMonotonicMs;
  const budgetMs = controlBudgetMs(name);
  if (status === 'passed' && (!executionStarted || elapsedMs > budgetMs)) {
    status = 'failed';
    evidence = { ...evidence, reason: !executionStarted
      ? 'required_control_measurement_missing' : 'control_budget_exceeded' };
  }
  controls[name] = { status, startedMonotonicMs, endedMonotonicMs,
    elapsedMs, budgetMs, executionStarted, observedAt: new Date().toISOString(), evidence };
};
const failure = error => ({ reason: error?.message ?? 'fixture_error' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
async function provenance() {
  const source = {};
  for (const name of ['base/memoria/broker.mjs', 'base/memoria/windows-state.mjs',
    'base/memoria/outbox.mjs', 'base/memoria/windows-native.c',
    'base/memoria/windows-native.def', 'base/memoria/hook-recall.mjs',
    'base/memoria/capture-hook.mjs', 'base/memoria/mcp.mjs',
    'base/memoria/native.mjs', 'base/memoria/windows-overlay.mjs',
    'test/memoria-windows-native-fixture.mjs', 'test/memoria-windows-validation.ps1',
    'test/memoria-windows-crash-child.mjs']) {
    source[name] = sha(await fs.readFile(path.join(productRoot, name)));
  }
  const addon = sha(await fs.readFile(path.join(productRoot, 'base', 'memoria', 'bin',
    'windows-native-x64.node')));
  if (addon !== WINDOWS_NATIVE_SHA256) throw new Error('fixture_addon_hash_changed');
  const tools = {};
  for (const [name, tool] of Object.entries(settings.tools ?? {})) {
    if (!tool?.executable || !tool?.sha256) continue;
    const actualSha256 = sha(await fs.readFile(tool.executable));
    if (actualSha256 !== tool.sha256.toLowerCase()) throw new Error(`fixture_${name}_hash_changed`);
    let version;
    try { version = (await runFile(tool.executable, ['--version'],
      { timeout: 5000, maxBuffer: 4096, windowsHide: true })).stdout.trim().slice(0, 200); }
    catch { version = null; }
    tools[name] = { sha256: actualSha256, version };
  }
  return { node: process.version, nodeExecutableSha256: sha(await fs.readFile(process.execPath)),
    addonSha256: addon, sourceSha256: source, tools, budgets,
    resources: { cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(), rssBytes: process.memoryUsage().rss,
      cpuUserMicros: process.resourceUsage().userCPUTime } };
}
const requirePrivate = async dir => {
  const result = await ensureWindowsPrivateDirectory(dir);
  if (!result.ok) throw new Error(`fixture_directory_${result.code}`);
  const checked = await inspectWindowsPath(dir, 'directory');
  if (!checked.ok) throw new Error('fixture_directory_changed');
  return checked;
};

async function save() {
  if (!reportPath || !path.isAbsolute(reportPath)) throw new Error('fixture_report_path');
  if (process.platform === 'win32') {
    const unconditional = ['provenance', 'fresh_private_ntfs_fixture', 'fresh_git_checkout',
      'default_claude_mem_selection', 'public_windows_release_gate',
      'explicit_absolute_sha_tool_enrollment',
      'outbox_same_process_idempotence', 'native_publish_callback_contract',
      'outbox_crash_temp_flushed_before_publish', 'outbox_crash_item_durable',
      'outbox_crash_manifest_durable', 'outbox_crash_receipt_durable',
      'outbox_crash_cursor_durable', 'state_crash_intent_durable',
      'state_crash_rewrite_durable', 'adversarial_reparse', 'adversarial_acl',
      'adversarial_file_id', 'journal_retention', 'worker_guard_and_presecret_ipc'];
    const dependent = ['destination_trust', 'core_capture_binding',
      'capture_source_and_args_negative', 'native_claude_launch', 'capture_p95',
      'real_extraction', 'manual_review', 'remote_add_crash_replay',
      'runtime_broker_recall', 'hook_recall_policy_diagnostic',
      'hook_executable_direct', 'mcp_recall_response', 'native_cli_hook_recall',
      'codex_native_hook_observation',
      'default_claude_mem_simultaneous_control'];
    for (const name of unconditional) if (!controls[name]) {
      record(name, 'failed', { reason: 'control_not_executed' });
    }
    for (const name of dependent) if (!controls[name]) {
      const dependency = controls.destination_trust?.status === 'missing_prerequisite'
        ? 'destination_trust' : controls.core_capture_binding?.status === 'missing_prerequisite'
          ? 'bound_capture' : null;
      record(name, dependency ? 'missing_prerequisite' : 'failed',
        { reason: dependency ?? 'control_not_executed' });
    }
    for (const [name, metricBudget] of [['capture_p95', budgets.captureP95Ms],
      ['runtime_broker_recall', budgets.recallTotalP95Ms]]) {
      const control = controls[name];
      if (control?.status !== 'passed') continue;
      const measure = control.evidence;
      if ((name === 'runtime_broker_recall' && measure?.requiredMetric !== 'full_hook_and_mcp_response') ||
          (name === 'capture_p95' && measure?.actualHookProcess !== true) ||
          !Array.isArray(measure.samplesMs) || measure.samplesMs.length !== 5 ||
          measure.samplesMs.some(value => !Number.isFinite(value) || value < 0) ||
          !Number.isFinite(measure.p95Ms) ||
          Math.abs(p95(measure.samplesMs) - measure.p95Ms) > 1e-9 ||
          measure.p95Ms > metricBudget ||
          (name === 'runtime_broker_recall' &&
            (!Array.isArray(measure.mcpSamplesMs) || measure.mcpSamplesMs.length !== 5 ||
              measure.mcpSamplesMs.some(value => !Number.isFinite(value) || value < 0) ||
              !Number.isFinite(measure.mcpP95Ms) ||
              Math.abs(p95(measure.mcpSamplesMs) - measure.mcpP95Ms) > 1e-9 ||
              measure.mcpP95Ms > metricBudget))) {
        control.status = 'failed';
        control.evidence = { ...measure, reason: 'required_full_hook_measurement_missing' };
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = performance.now() - report.startedMonotonicMs;
  delete report.startedMonotonicMs;
  report.resourcesAfter = { rssBytes: process.memoryUsage().rss,
    cpuUserMicros: process.resourceUsage().userCPUTime,
    freeMemoryBytes: os.freemem() };
  report.status = Object.values(controls).some(value => value.status === 'failed') ? 'failed' :
    Object.values(controls).some(value => value.status === 'blocked_missing_implementation')
      ? 'blocked_missing_implementation' :
      Object.values(controls).some(value => value.status === 'missing_prerequisite')
        ? 'missing_prerequisite' : 'passed';
  if (process.platform === 'win32' && !report.provenance) report.status = 'failed';
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
  beginControl('explicit_absolute_sha_tool_enrollment');
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
  beginControl('destination_trust');
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

async function privateQdrantProxy(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error('fixture_upstream_url');
  }
  let unavailable = false;
  const stats = { forwarded: 0, unavailable: 0 };
  const server = http.createServer(async (request, response) => {
    if (unavailable) {
      stats.unavailable++;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"fixture_destination_unavailable"}');
      return;
    }
    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of request) {
        total += chunk.length;
        if (total > 8 * 1024 * 1024) throw new Error('fixture_proxy_body_oversize');
        chunks.push(chunk);
      }
      const headers = { ...request.headers, 'accept-encoding': 'identity' };
      delete headers['content-length'];
      delete headers.connection;
      delete headers['transfer-encoding'];
      delete headers.host;
      const body = Buffer.concat(chunks);
      const destination = new URL(request.url, upstream);
      if (destination.origin !== upstream.origin) throw new Error('fixture_proxy_origin');
      const forwarded = await fetch(destination, { method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
        signal: AbortSignal.timeout(10000) });
      const output = Buffer.from(await forwarded.arrayBuffer());
      if (output.length > 16 * 1024 * 1024) throw new Error('fixture_proxy_response_oversize');
      stats.forwarded++;
      response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ??
        'application/json', 'content-length': output.length });
      response.end(output);
    } catch {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"fixture_proxy_failed"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, stats,
    setUnavailable: value => { unavailable = value; },
    close: () => new Promise(resolve => server.close(resolve)) };
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

const crashChild = fileURLToPath(new URL('./memoria-windows-crash-child.mjs', import.meta.url));
async function killAtBoundary(input) {
  input.nonce = randomUUID();
  const child = spawn(process.execPath, [crashChild, JSON.stringify(input)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CBS_MEMORIA_STATE_ROOT: input.stateRoot } });
  let stdout = '';
  let stderr = '';
  let reached = false;
  let observation;
  let terminationRequested = false;
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const boundary = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 8192) { reject(new Error('fixture_child_receipt_oversize')); return; }
      const line = stdout.split('\n')[0];
      if (!line || !stdout.includes('\n')) return;
      let value;
      try { value = JSON.parse(line); } catch { reject(new Error('fixture_child_protocol')); return; }
      if (value.boundary !== input.boundary || value.nonce !== input.nonce ||
          !value.metadata || typeof value.metadata !== 'object') {
        reject(new Error('fixture_child_wrong_boundary'));
      } else { observation = value; reached = true; resolve(); }
    });
    exit.then(() => { if (!reached) reject(new Error(`fixture_child_before_boundary:${stderr}`)); }, reject);
  });
  let timer;
  let boundaryError;
  try {
    await Promise.race([boundary, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture_child_boundary_timeout')), 10000);
    })]);
    if (input.boundary === 'temp_flushed_before_publish') {
      const meta = observation.metadata;
      if (meta.boundary !== input.boundary ||
          !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(meta.fileId ?? '') ||
          !Number.isSafeInteger(meta.size) || meta.size < 0 ||
          !meta.temporary?.endsWith('.tmp') ||
          !/^src-[a-f0-9]{64}\.json$/.test(path.basename(meta.target ?? '')) ||
          windowsPathKey(path.dirname(meta.target)) !==
            windowsPathKey(path.join(input.stateDir, 'outbox', 'items')) ||
          windowsPathKey(path.dirname(meta.temporary)) !== windowsPathKey(path.dirname(meta.target))) {
        throw new Error('fixture_temp_receipt_invalid');
      }
    }
    const receipt = path.join(input.stateDir, `boundary-${input.nonce}.json`);
    const handle = await fs.open(receipt, 'wx');
    try {
      await handle.writeFile(JSON.stringify(observation) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) { boundaryError = error; }
  finally {
    clearTimeout(timer);
    if (child.exitCode === null) terminationRequested = child.kill('SIGKILL');
  }
  let closeTimer;
  const closed = await Promise.race([exit, new Promise((_, reject) => {
    closeTimer = setTimeout(() => reject(new Error('fixture_child_not_closed')), 5000);
  })]).finally(() => clearTimeout(closeTimer));
  if (boundaryError) throw boundaryError;
  if (!reached || !terminationRequested || closed.code === 0) {
    throw new Error('fixture_child_not_crashed');
  }
  return { boundary: input.boundary, childClosed: true, terminationRequested,
    receipt: path.join(input.stateDir, `boundary-${input.nonce}.json`),
    metadata: observation.metadata };
}

async function crashOutbox(stateRoot, projectId) {
  const outcome = {};
  const bytes = Buffer.from('fixture-crash-source\n');
  const identity = { projectId, policyVersion: 'native-v1' };
  for (const boundary of ['temp_flushed_before_publish', 'item_durable',
    'manifest_durable', 'receipt_durable', 'cursor_durable']) {
    const stateDir = path.join(stateRoot, `crash-${boundary}`);
    await requirePrivate(stateDir);
    const sessionId = `fixture-${boundary}-${randomUUID()}`;
    const slice = { cli: 'claude', sessionId, start: 0, end: bytes.length,
      sliceHash: sha(bytes), messages: [] };
    const box = createOutbox(stateDir);
    let operationId;
    if (!['temp_flushed_before_publish', 'item_durable'].includes(boundary)) {
      const queued = await box.enqueueCheckpoint(slice, identity);
      if (queued.kind !== 'queued') throw new Error('fixture_crash_setup_item');
      operationId = queued.operationId;
    }
    if (boundary === 'receipt_durable' &&
        (await box.recordManifest(operationId, [])).kind !== 'manifested') {
      throw new Error('fixture_crash_setup_manifest');
    }
    let nextSlice = slice;
    let maxBytes;
    if (boundary === 'cursor_durable') {
      if ((await box.recordManifest(operationId, [])).kind !== 'manifested' ||
          (await box.completeCheckpoint(operationId)).kind !== 'processed') {
        throw new Error('fixture_crash_setup_cursor');
      }
      maxBytes = await box.usage() + 8192;
      const nextBytes = Buffer.from('x'.repeat(10000));
      nextSlice = { ...slice, start: bytes.length, end: bytes.length + nextBytes.length,
        sliceHash: sha(nextBytes), messages: [{ text: nextBytes.toString() }] };
    }
    outcome[boundary] = await killAtBoundary({ mode:
      boundary === 'temp_flushed_before_publish' ? 'temp' :
        boundary === 'cursor_durable' ? 'cursor' : boundary.split('_')[0], boundary,
      stateDir, stateRoot, slice: nextSlice, identity, operationId, maxBytes });
    const reopened = createOutbox(stateDir);
    if (boundary === 'temp_flushed_before_publish') {
      const meta = outcome[boundary].metadata;
      const temporary = await readWindowsBinary(meta.temporary, { length: meta.size });
      let tempRow;
      try { tempRow = JSON.parse(temporary.bytes.toString('utf8')); }
      catch { throw new Error('fixture_temp_bytes_invalid'); }
      if (temporary.fileId !== meta.fileId || temporary.size !== meta.size ||
          tempRow.sliceHash !== slice.sliceHash || tempRow.projectId !== identity.projectId ||
          tempRow.sessionId !== sessionId ||
          await fs.lstat(meta.target).then(() => true, error => error.code !== 'ENOENT')) {
        throw new Error('fixture_temp_published_or_lost');
      }
      const redelivery = await reopened.enqueueCheckpoint(nextSlice, identity);
      if (redelivery.kind !== 'queued' || redelivery.operationId !== tempRow.operationId ||
          (await reopened.pending()).filter(row => row.operationId === redelivery.operationId).length !== 1) {
        throw new Error('fixture_temp_input_not_redeliverable');
      }
      operationId = redelivery.operationId;
      outcome[boundary].tempRetained = true;
      outcome[boundary].redeliverable = true;
    } else if (boundary === 'item_durable') {
      const pending = await reopened.pending();
      if (pending.length !== 1 || pending[0].sliceHash !== slice.sliceHash) {
        throw new Error('fixture_crash_item_lost');
      }
      operationId = pending[0].operationId;
    } else if (boundary === 'manifest_durable') {
      const manifest = await reopened.readManifest(operationId);
      if (manifest.kind === 'blocked' || manifest.disposition !== 'no_facts') {
        throw new Error('fixture_crash_manifest_lost');
      }
    } else if (boundary === 'receipt_durable') {
      const cursor = await reopened.cursor('claude', sessionId);
      if (cursor.processedEnd !== bytes.length || (await reopened.pending()).length !== 0) {
        throw new Error('fixture_crash_receipt_cursor');
      }
    } else {
      const cursor = await reopened.cursor('claude', sessionId);
      if (cursor.processedEnd !== bytes.length || (await reopened.pending()).length !== 0) {
        throw new Error('fixture_crash_cursor_lost');
      }
      const redelivery = await reopened.enqueueCheckpoint(nextSlice, identity);
      if (redelivery.kind !== 'queued' || (await reopened.pending()).length !== 1) {
        throw new Error('fixture_crash_cursor_replay');
      }
      operationId = redelivery.operationId;
      outcome[boundary].processedEnd = cursor.processedEnd;
    }
    const ackFile = path.join(stateDir, 'outbox', 'acks', `${operationId}.json`);
    if (await fs.lstat(ackFile).then(() => true, error => error.code !== 'ENOENT')) {
      throw new Error('fixture_false_ack');
    }
    outcome[boundary].noUnverifiedAck = true;
  }
  return outcome;
}

async function crashWindowsState(stateRoot) {
  const outcome = {};
  for (const boundary of ['intent_durable', 'rewrite_durable']) {
    const dir = path.join(stateRoot, `state-${boundary}`);
    await requirePrivate(dir);
    const file = path.join(dir, 'cursor-fixture.json');
    const state = createWindowsState(file);
    await state.write({ revision: 1 });
    outcome[boundary] = await killAtBoundary({ mode: 'state', boundary,
      stateDir: dir, stateRoot, file, next: { revision: 2 } });
    const recovered = await createWindowsState(file).read();
    if (recovered?.revision !== (boundary === 'intent_durable' ? 1 : 2)) {
      throw new Error('fixture_state_replay_lost');
    }
    outcome[boundary].recoveredRevision = recovered.revision;
  }
  return outcome;
}

async function nativePublishCallbackContract(stateRoot) {
  const dir = path.join(stateRoot, `publish-callback-${randomUUID()}`);
  await requirePrivate(dir);
  const bytes = Buffer.from('native callback contract\n');
  const omitted = path.join(dir, 'omitted.json');
  await publishWindowsBinary(omitted, bytes);
  let observed;
  const normal = path.join(dir, 'normal.json');
  await publishWindowsBinary(normal, bytes, value => { observed = value; });
  if (observed?.boundary !== 'temp_flushed_before_publish' ||
      observed.target !== normal || observed.size !== bytes.length ||
      !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(observed.fileId ?? '')) {
    throw new Error('fixture_native_callback_observation');
  }
  let thrown = false;
  try {
    await publishWindowsBinary(path.join(dir, 'throw.json'), bytes,
      () => { throw new Error('fixture_callback_original_exception'); });
  } catch (error) { thrown = error.message === 'fixture_callback_original_exception'; }
  let promiseRejected = false;
  try {
    await publishWindowsBinary(path.join(dir, 'promise.json'), bytes,
      () => Promise.resolve());
  } catch (error) { promiseRejected = error.message === 'windows_publish_callback'; }
  let valueRejected = false;
  try {
    await publishWindowsBinary(path.join(dir, 'value.json'), bytes, () => true);
  } catch (error) { valueRejected = error.message === 'windows_publish_callback'; }
  const addon = createRequire(import.meta.url)(path.join(productRoot, 'base', 'memoria',
    'bin', 'windows-native-x64.node'));
  const invalidTemporary = path.join(dir, `.${randomUUID()}.tmp`);
  let invalidRejected = false;
  try { addon.publishNew(invalidTemporary, path.join(dir, 'invalid.json'), bytes, true); }
  catch (error) { invalidRejected = error.message === 'windows_publish_args'; }
  let reentrantDenied = false;
  const outer = path.join(dir, 'outer.json');
  const inner = path.join(dir, 'inner.json');
  const directTemporary = path.join(dir, `.${randomUUID()}.tmp`);
  addon.publishNew(directTemporary, outer, bytes, () => {
    try { addon.publishNew(path.join(dir, `.${randomUUID()}.tmp`), inner, bytes); }
    catch (error) { reentrantDenied = error.message === 'windows_publish_args'; }
  });
  const names = await fs.readdir(dir);
  if (!thrown || !promiseRejected || !valueRejected || !invalidRejected ||
      !reentrantDenied ||
      names.some(name => name.endsWith('.tmp')) ||
      names.some(name => ['throw.json', 'promise.json', 'value.json', 'inner.json'].includes(name)) ||
      !(await readWindowsBinary(outer, { length: bytes.length })).bytes.equals(bytes)) {
    throw new Error('fixture_native_callback_fail_closed');
  }
  return { omitted: true, observedFlushed: true, originalException: thrown,
    promiseRejected, valueRejected, invalidRejectedBeforeTemp: invalidRejected,
    reentrantDenied, tempCleanup: true };
}

async function adversarialWindowsFiles(stateRoot) {
  beginControl('adversarial_reparse', 'adversarial_acl', 'adversarial_file_id');
  const dir = path.join(stateRoot, `adversarial-${randomUUID()}`);
  await requirePrivate(dir);
  const bytes = Buffer.from('{"revision":1}\n');
  const target = path.join(dir, 'target.json');
  await publishWindowsBinary(target, bytes);
  const alias = path.join(dir, 'alias.json');
  try {
    await fs.symlink(target, alias, 'file');
    let refused = false;
    try { await readWindowsBinary(alias); } catch { refused = true; }
    record('adversarial_reparse', refused ? 'passed' : 'failed', { contained: true });
  } catch (error) {
    record('adversarial_reparse', ['EPERM', 'EACCES'].includes(error.code)
      ? 'missing_prerequisite' : 'failed', { reason: error.code ?? error.message });
  }
  const aclFile = path.join(dir, 'acl.json');
  await publishWindowsBinary(aclFile, bytes);
  const { windows } = await windowsSystemLocations();
  try {
    await runFile(path.join(windows, 'System32', 'icacls.exe'),
      [aclFile, '/grant', '*S-1-1-0:(R)'], { timeout: 5000, windowsHide: true });
    let refused = false;
    try { await readWindowsBinary(aclFile); } catch { refused = true; }
    record('adversarial_acl', refused ? 'passed' : 'failed', { contained: true });
  } catch (error) { record('adversarial_acl', 'failed', failure(error)); }

  const stateFile = path.join(dir, 'file-id.json');
  await createWindowsState(stateFile).write({ revision: 1 });
  const interrupted = await killAtBoundary({ mode: 'state', boundary: 'intent_durable',
    stateDir: dir, stateRoot, file: stateFile, next: { revision: 2 } });
  const original = await readWindowsBinary(stateFile);
  await deleteWindowsBinary(stateFile, original.fileId, original.bytes);
  const replacement = await publishWindowsBinary(stateFile, original.bytes);
  let refused = false;
  try { await createWindowsState(stateFile).read(); }
  catch (error) { refused = error.message === 'windows_recovery_required'; }
  const journal = path.join(dir, '.journal');
  const intentRetained = (await fs.readdir(journal)).some(name => name.endsWith('.intent.json'));
  record('adversarial_file_id', refused && intentRetained && replacement.fileId !== original.fileId
    ? 'passed' : 'failed', { ...interrupted, intentRetained,
      identityChanged: replacement.fileId !== original.fileId });
}

async function journalRetention(stateRoot) {
  const dir = path.join(stateRoot, `journal-retention-${randomUUID()}`);
  await requirePrivate(dir);
  const box = createOutbox(dir);
  await box.pending();
  const file = path.join(dir, 'outbox', `cursor-${'a'.repeat(64)}.json`);
  const state = createWindowsState(file);
  await state.write({ revision: 0 });
  const baseline = await box.usage();
  for (let revision = 1; revision <= 8; revision++) await state.write({ revision });
  const prefix = sha(windowsPathKey(file));
  const journal = path.join(path.dirname(file), '.journal');
  const receipts = (await fs.readdir(journal)).filter(name =>
    name.startsWith(`${prefix}-`) && name.endsWith('.commit.json'));
  const after = await box.usage();
  if (receipts.length !== 1 || after - baseline > 3 * 4096) {
    throw new Error('fixture_journal_unbounded');
  }
  const ambiguousName = `${prefix}-${randomUUID()}.commit.json`;
  const ambiguous = Buffer.from('{"ambiguous":true}\n');
  await publishWindowsBinary(path.join(journal, ambiguousName), ambiguous);
  await state.write({ revision: 9 });
  const retained = await readWindowsBinary(path.join(journal, ambiguousName));
  if (!retained.bytes.equals(ambiguous)) throw new Error('fixture_ambiguous_receipt_lost');
  return { updates: 9, completedReceipts: receipts.length, baselineBytes: baseline,
    compactedBytes: after, ambiguousRetained: true };
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
  return { made, captured, sessionId, row, transcript, stateDir: resolution.stateDir };
}

async function captureP95(capture, project, stateRoot, profile) {
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.CBS_MEMORIA_LAUNCH_ID = capture.made.token;
  const times = [];
  const box = createOutbox(capture.stateDir);
  const payload = { cwd: project, session_id: capture.sessionId,
    transcript_path: capture.transcript, hook_event_name: 'UserPromptSubmit' };
  for (let i = 0; i < 5; i++) {
    const current = await readWindowsBinary(capture.transcript);
    const line = JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: capture.sessionId,
      timestamp: new Date().toISOString(), isSidechain: false, userType: 'external',
      message: { role: 'user', content: [{ type: 'text', text: `Fixture timing source ${i}.` }] } }) + '\r\n';
    await rewriteWindowsBinary(capture.transcript, current.fileId, current.bytes,
      Buffer.concat([current.bytes, Buffer.from(line)]));
    const before = await box.cursor('claude', capture.sessionId);
    const result = await executeHookExecutable({ capture, project, stateRoot,
      profile, event: 'UserPromptSubmit', payload });
    times.push(result.elapsedMs);
    const after = await box.cursor('claude', capture.sessionId);
    if (!(after.queuedEnd > before.queuedEnd)) throw new Error('fixture_capture_hook_no_checkpoint');
  }
  return { samplesMs: times, p95Ms: p95(times), thresholdMs: budgets.captureP95Ms,
    observed: times.length, actualHookProcess: true, dispatchToExit: true };
}

async function crashRemoteAdd({ capture, project, stateRoot, resolution }) {
  process.env.CLAUDE_CONFIG_DIR = capture.made.record.profile;
  process.env.CBS_MEMORIA_LAUNCH_ID = capture.made.token;
  const current = await readWindowsBinary(capture.transcript);
  const text = 'Fixture remote crash source fact.';
  const line = JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: capture.sessionId,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text }] } }) + '\r\n';
  await rewriteWindowsBinary(capture.transcript, current.fileId, current.bytes,
    Buffer.concat([current.bytes, Buffer.from(line)]));
  const queued = await captureEvent({ cli: 'claude', event: 'UserPromptSubmit',
    payload: { cwd: project, session_id: capture.sessionId,
      transcript_path: capture.transcript, hook_event_name: 'UserPromptSubmit' }, stateRoot });
  if (queued.kind !== 'queued') throw new Error(queued.reason ?? 'fixture_remote_source_capture');
  const box = createOutbox(resolution.stateDir);
  const row = (await box.pending()).find(item => item.operationId === queued.operationId);
  const source = row?.messages.find(item => item.text.includes(text));
  if (!row || !source || source.origin !== 'human') throw new Error('fixture_remote_source_missing');
  const sourceIdentity = { projectId: row.projectId, originCli: row.cli,
    sessionId: row.sessionId, start: row.start, end: row.end,
    sliceHash: row.sliceHash, policyVersion: row.policyVersion };
  if (externalIdFor(sourceIdentity) !== queued.operationId) throw new Error('fixture_remote_source_identity');
  const operation = { externalId: queued.operationId, projectId: row.projectId,
    sessionId: row.sessionId, sourceIdentity, text,
    metadata: { source: source.messageId, actor: source.actor, origin: 'user_direct',
      speaker_role: 'user', scope: 'project', evidence_at: source.timestamp },
    approval: { kind: 'approved' } };
  const sid = (await inspectWindowsPath(resolution.stateDir, 'directory')).currentSid;
  const writerId = `sid:${sid}`;
  const secret = process.env[settings.destination.apiKeyEnv];
  const find = () => requestBroker({ cwd: project, sessionId: capture.sessionId,
    operation: { op: 'find', projectId: resolution.projectId,
      externalId: operation.externalId } }, secret, { stateRoot, deadlineMs: 10000 });
  const before = await find();
  if (before.kind !== 'items' || before.items.length !== 0) throw new Error('fixture_remote_source_not_fresh');
  const crashed = await killAtBoundary({ mode: 'remote_add', boundary: 'remote_add_durable',
    cwd: project, stateDir: resolution.stateDir, stateRoot, sessionId: capture.sessionId,
    writerId, operation });
  const afterCrash = await find();
  const local = await createLedger(resolution.stateDir, writerId).read(operation.externalId);
  const pending = await box.pending();
  const ackFile = path.join(resolution.stateDir, 'outbox', 'acks', `${operation.externalId}.json`);
  const hasAck = await fs.lstat(ackFile).then(() => true, error => error.code !== 'ENOENT');
  if (afterCrash.kind !== 'items' || afterCrash.items.length !== 1 ||
      afterCrash.items[0].status !== 'pending' || local?.status === 'acked' ||
      !pending.some(item => item.operationId === operation.externalId) || hasAck) {
    throw new Error('fixture_remote_crash_false_ack_or_missing_pending');
  }
  let secondAdd = 0;
  const recovered = await storeMemory(project, capture.sessionId, operation,
    name => process.env[name], { stateRoot, writerId,
      ackLocal: (id, proof) => box.ackVerified(id, proof),
      onRemoteAdd: () => { secondAdd++; } });
  const final = await find();
  if (recovered.kind !== 'stored' || secondAdd !== 0 || final.kind !== 'items' ||
      final.items.length !== 1 || final.items[0].status !== 'active' ||
      final.items[0].sdkId !== afterCrash.items[0].sdkId ||
      (await createLedger(resolution.stateDir, writerId).read(operation.externalId))?.status !== 'acked') {
    throw new Error('fixture_remote_replay_duplicate_or_unacked');
  }
  return { ...crashed, pendingAfterCrash: true, noFalseAck: true,
    secondSdkAdd: secondAdd, finalRemoteRows: final.items.length,
    approved: { text, externalId: operation.externalId,
      source: operation.metadata.source, projectId: operation.projectId } };
}

async function runActualCli(command) {
  return new Promise(resolve => {
    const child = spawn(command.command, command.args, { cwd: command.cwd,
      env: command.env, stdio: 'inherit', windowsHide: false });
    child.once('error', () => resolve({ kind: 'unavailable' }));
    child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
  });
}

async function executeHookExecutable({ capture, project, stateRoot, profile, event, payload }) {
  const file = path.join(productRoot, 'base', 'memoria', 'capture-hook.mjs');
  const began = performance.now();
  const child = spawn(process.execPath, [file, 'claude', event], {
    cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: profile, CBS_MEMORIA_STATE_ROOT: stateRoot,
      CBS_MEMORIA_LAUNCH_ID: capture.made.token } });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 16000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 1000); });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture_hook_timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  const elapsedMs = performance.now() - began;
  if (exit !== 0 || stderr) throw new Error('fixture_direct_hook_failed');
  const output = stdout.trim() ? JSON.parse(stdout.trim()) : null;
  return { output, elapsedMs };
}

async function directHookExecutable({ capture, project, stateRoot, profile, prompt }) {
  return executeHookExecutable({ capture, project, stateRoot, profile,
    event: 'UserPromptSubmit', payload: { cwd: project, session_id: capture.sessionId,
      hook_event_name: 'UserPromptSubmit', transcript_path: capture.transcript, prompt } });
}

async function mcpSearchExecutable({ capture, project, stateRoot, profile, query }) {
  const file = path.join(productRoot, 'base', 'memoria', 'mcp.mjs');
  const began = performance.now();
  const child = spawn(process.execPath, [file], { cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: profile, CBS_MEMORIA_STATE_ROOT: stateRoot,
      CBS_MEMORIA_LAUNCH_ID: capture.made.token, CBS_MEMORIA_CLI: 'claude' } });
  child.stdin.on('error', () => {});
  const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  child.stdin.end(request(1, 'initialize', { protocolVersion: '2025-03-26',
    capabilities: {}, clientInfo: { name: 'cbs-fixture', version: '1' } }) +
    request(2, 'tools/call', { name: 'search', arguments: { query } }));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 16000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 1000); });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture_mcp_timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  const elapsedMs = performance.now() - began;
  if (exit !== 0 || stderr) throw new Error('fixture_mcp_process_failed');
  const response = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    .find(value => value.id === 2);
  const value = JSON.parse(response?.result?.content?.[0]?.text ?? 'null');
  return { value, elapsedMs };
}

async function nativeHookObservation(profile, afterMs, text, source) {
  let visited = 0;
  let matched = 0;
  const hashes = [];
  const contextValues = value => {
    if (!value || typeof value !== 'object') return [];
    const own = typeof value.additionalContext === 'string' ? [value.additionalContext] : [];
    return own.concat(Object.values(value).flatMap(contextValues));
  };
  const visit = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++visited > 5000 || entry.isSymbolicLink()) throw new Error('fixture_native_trace_unsafe');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = await fs.lstat(file);
        if (stat.mtimeMs < afterMs || stat.size > 8 * 1024 * 1024) continue;
        const bytes = await fs.readFile(file);
        for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          for (const context of contextValues(value)) if (context.includes(text) && context.includes(source)) {
            matched++;
            hashes.push(sha(context));
          }
        }
      }
    }
  };
  await visit(path.join(profile, 'projects'));
  return { matched, contextSha256: hashes, filesVisited: visited };
}

async function hashPluginTree(root) {
  const digest = createHash('sha256');
  let count = 0;
  const visit = async (dir, relative = '') => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 20000 || entry.isSymbolicLink()) throw new Error('unsafe_plugin_tree');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { digest.update(`d:${name}\n`); await visit(file, name); }
      else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        if (stat.size > 64 * 1024 * 1024) throw new Error('unsafe_plugin_tree');
        digest.update(`f:${name}:${stat.size}\n`);
        digest.update(await fs.readFile(file));
      } else throw new Error('unsafe_plugin_tree');
    }
  };
  await visit(root);
  return digest.digest('hex');
}

async function pluginCounts(python, dbFile, defaultProject, optInProject) {
  await fs.lstat(dbFile);
  const script = `import json,sqlite3,sys,pathlib\n` +
    `db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)\n` +
    `out={}\n` +
    `for label,root in [('default',sys.argv[2]),('opt_in',sys.argv[3])]:\n` +
    ` p=db.execute('select id from projects where lower(root_path)=lower(?)',(root,)).fetchone()\n` +
    ` if p:\n` +
    `  e=db.execute('select event_type,count(*) from agent_events where project_id=? group by event_type',(p[0],)).fetchall()\n` +
    `  m=db.execute('select count(*) from memory_items where project_id=?',(p[0],)).fetchone()[0]\n` +
    `  out[label]={'events':dict(e),'memory_items':m}\n` +
    ` else: out[label]={'events':{},'memory_items':0}\n` +
    `print(json.dumps(out))\n`;
  const { stdout } = await runFile(python, ['-c', script, dbFile, defaultProject, optInProject],
    { timeout: 5000, maxBuffer: 4096, windowsHide: true });
  return JSON.parse(stdout);
}

async function pluginHealth(port, copied, version) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`,
    { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('fixture_plugin_health');
  const value = await response.json();
  if (value.version !== version || typeof value.workerPath !== 'string' ||
      !windowsPathKey(value.workerPath).startsWith(windowsPathKey(copied) + '\\')) {
    throw new Error('fixture_foreign_plugin_worker');
  }
  return { version: value.version, workerPathSha256: sha(value.workerPath),
    pid: value.pid };
}

function privateCliEnv(profile, pluginEnv) {
  const env = { ...process.env, ...pluginEnv, CLAUDE_CONFIG_DIR: profile,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(profile, 'plugins'),
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_AUTOUPDATER: '1' };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  delete env.CLAUDE_CODE_PLUGIN_SEED_DIR;
  return env;
}

async function installedPrivatePlugin(claude, profile, marketplace, pluginSource,
  version, sourceHash, pluginEnv) {
  const env = privateCliEnv(profile, pluginEnv);
  await runFile(claude, ['plugin', 'marketplace', 'add', marketplace],
    { env, timeout: 30000, maxBuffer: 8192, windowsHide: true });
  const marketList = await runFile(claude, ['plugin', 'marketplace', 'list', '--json'],
    { env, timeout: 15000, maxBuffer: 65536, windowsHide: true });
  const markets = JSON.parse(marketList.stdout);
  const registered = Array.isArray(markets) ? markets.filter(row =>
    row?.name === 'thedotmack' && row.source === 'directory' &&
    windowsPathKey(row.path ?? '') === windowsPathKey(marketplace) &&
    windowsPathKey(row.installLocation ?? '') === windowsPathKey(marketplace)) : [];
  if (registered.length !== 1) throw new Error('fixture_private_marketplace_registration_changed');
  await runFile(claude, ['plugin', 'install', 'claude-mem@thedotmack', '--scope', 'user'],
    { env, timeout: 60000, maxBuffer: 8192, windowsHide: true });
  const { stdout } = await runFile(claude, ['plugin', 'list', '--json'],
    { env, timeout: 15000, maxBuffer: 65536, windowsHide: true });
  const entries = JSON.parse(stdout);
  const installed = Array.isArray(entries) ? entries.filter(row =>
    row?.id === 'claude-mem@thedotmack' && row.enabled === true &&
    row.scope === 'user' && row.version === version) : [];
  if (installed.length !== 1 || entries.some(row => row?.id === 'claude-mem@inline')) {
    throw new Error('fixture_private_plugin_install_unverified');
  }
  const settingsText = await fs.readFile(path.join(profile, 'settings.json'), 'utf8');
  const saved = JSON.parse(settingsText);
  if (saved.enabledPlugins?.['claude-mem@thedotmack'] !== true) {
    throw new Error('fixture_private_plugin_not_enabled');
  }
  if (installed[0].errors?.length) throw new Error('fixture_private_plugin_load_error');
  const loadedPathEvidence = installed[0].readFromFolder ? 'readFromFolder' :
    installed[0].installPath ? 'installPath' : 'registered_marketplace_in_place';
  const loadedFrom = installed[0].readFromFolder || installed[0].installPath || pluginSource;
  const loadedKey = windowsPathKey(loadedFrom ?? '');
  if (!loadedFrom || !path.isAbsolute(loadedFrom) ||
      !(loadedKey.startsWith(windowsPathKey(marketplace) + '\\') ||
        loadedKey.startsWith(windowsPathKey(path.join(profile, 'plugins')) + '\\'))) {
    throw new Error('fixture_private_plugin_source_changed');
  }
  const loadedTreeSha256 = await hashPluginTree(loadedFrom);
  if (loadedTreeSha256 !== sourceHash) throw new Error('fixture_loaded_plugin_hash_changed');
  const authResult = await runFile(claude, ['auth', 'status'],
    { env, timeout: 10000, maxBuffer: 8192, windowsHide: true });
  const auth = JSON.parse(authResult.stdout);
  if (!auth || auth.authMethod === 'none' || typeof auth.authMethod !== 'string') {
    throw new Error('fixture_private_claude_account_missing');
  }
  const { configDirectory, ...account } = auth;
  return { env, settings: saved, installed: { id: installed[0].id,
    version: installed[0].version, scope: installed[0].scope,
    enabled: installed[0].enabled }, loadedFrom, loadedTreeSha256,
    loadedPathEvidence,
    authMethod: auth.authMethod, accountSha256: sha(JSON.stringify(account)) };
}

async function nativeToolEffect(profile, afterMs, marker) {
  let visited = 0;
  const used = new Set();
  const succeeded = new Set();
  let pluginToolCalls = 0;
  const visit = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++visited > 5000 || entry.isSymbolicLink()) throw new Error('fixture_native_trace_unsafe');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = await fs.lstat(file);
        if (stat.mtimeMs < afterMs || stat.size > 8 * 1024 * 1024) continue;
        for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)) {
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          for (const item of value.message?.content ?? []) {
            if (item?.type === 'tool_use' && typeof item.name === 'string' &&
                /claude[-_]?mem|thedotmack/i.test(item.name)) pluginToolCalls++;
            if (item?.type === 'tool_use' && item.name === 'Bash' &&
                item.input?.command?.includes(marker) && typeof item.id === 'string') used.add(item.id);
            if (item?.type === 'tool_result' && item.is_error !== true &&
                typeof item.tool_use_id === 'string' &&
                JSON.stringify(item.content).includes(marker)) succeeded.add(item.tool_use_id);
          }
        }
      }
    }
  };
  await visit(path.join(profile, 'projects'));
  return { completed: [...used].some(id => succeeded.has(id)),
    pluginToolCalls, filesVisited: visited };
}

async function defaultPluginControl({ root, defaultProject, project, stateRoot,
  defaultProfile, optInProfile, enrolled }) {
  const supplied = settings.plugin;
  if (!supplied?.source || !supplied?.marketplaceSource ||
      !/^[a-f0-9]{64}$/.test(supplied.treeSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(supplied.marketplaceTreeSha256 ?? '') ||
      enrolled.claude !== 'passed' || enrolled.python !== 'passed' || !settings.runInteractiveCli) {
    return { status: 'missing_prerequisite', evidence: {
      reason: 'verified_real_marketplace_plugin_cli_python_and_interactive_sessions_required' } };
  }
  const sourceAudit = await inspectWindowsPath(supplied.source, 'directory', { privateState: false });
  if (!sourceAudit.ok) throw new Error('fixture_plugin_source_unsafe');
  const manifest = JSON.parse(await fs.readFile(path.join(supplied.source, '.claude-plugin', 'plugin.json')));
  const hooks = JSON.parse(await fs.readFile(path.join(supplied.source, 'hooks', 'hooks.json')));
  if (manifest.name !== 'claude-mem' || !manifest.version ||
      !hooks.hooks?.SessionStart || !hooks.hooks?.UserPromptSubmit) {
    throw new Error('fixture_plugin_not_real');
  }
  const sourceHash = await hashPluginTree(supplied.source);
  if (sourceHash !== supplied.treeSha256) throw new Error('fixture_plugin_hash_changed');
  const marketplaceAudit = await inspectWindowsPath(supplied.marketplaceSource, 'directory',
    { privateState: false });
  if (!marketplaceAudit.ok ||
      await hashPluginTree(supplied.marketplaceSource) !== supplied.marketplaceTreeSha256) {
    throw new Error('fixture_marketplace_source_unsafe');
  }
  const catalog = JSON.parse(await fs.readFile(path.join(supplied.marketplaceSource,
    '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = catalog.plugins?.filter(row => row.name === 'claude-mem');
  if (catalog.name !== 'thedotmack' || entry?.length !== 1 ||
      typeof entry[0].source !== 'string' ||
      !/^\.\/[A-Za-z0-9._/-]+$/.test(entry[0].source) ||
      entry[0].source.includes('..') ||
      await hashPluginTree(path.join(supplied.marketplaceSource, entry[0].source)) !== sourceHash) {
    throw new Error('fixture_marketplace_plugin_identity');
  }
  const pluginsDir = path.join(root, 'plugins');
  await requirePrivate(pluginsDir);
  const privateMarketplace = path.join(pluginsDir, 'thedotmack');
  await fs.cp(supplied.marketplaceSource, privateMarketplace,
    { recursive: true, force: false, errorOnExist: true });
  await requirePrivate(privateMarketplace);
  if (await hashPluginTree(privateMarketplace) !== supplied.marketplaceTreeSha256) {
    throw new Error('fixture_marketplace_copy_changed');
  }
  const pluginData = path.join(root, 'plugin-state');
  await requirePrivate(pluginData);
  await requirePrivate(defaultProfile);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const pluginSettings = Buffer.from(JSON.stringify({ CLAUDE_MEM_DATA_DIR: pluginData,
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_IDLE_EXIT_SEC: '30' }) + '\n');
  await publishWindowsBinary(path.join(pluginData, 'settings.json'), pluginSettings);
  const pluginEnv = { CLAUDE_MEM_DATA_DIR: pluginData, CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_IDLE_EXIT_SEC: '30' };
  for (const [profile, cwd] of [[defaultProfile, defaultProject], [optInProfile, project]]) {
    process.stdout.write(`Fixture private Claude account/trust: log in to the same account, review ${cwd}, accept only its private workspace trust, then exit without a prompt.\n`);
    const trusted = await runActualCli({ command: settings.tools.claude.executable,
      args: [], cwd, env: privateCliEnv(profile, pluginEnv) });
    if (trusted.kind !== 'exited' || trusted.code !== 0) {
      return { status: 'missing_prerequisite', evidence: { reason: 'private_claude_trust' } };
    }
  }
  let profiles;
  try {
    profiles = [];
    for (const profile of [defaultProfile, optInProfile]) {
      profiles.push(await installedPrivatePlugin(settings.tools.claude.executable, profile,
        privateMarketplace, path.join(privateMarketplace, entry[0].source),
        manifest.version, sourceHash, pluginEnv));
    }
  } catch (error) {
    if (/^fixture_(private_marketplace_registration_changed|private_plugin_install_unverified|private_plugin_not_enabled|private_plugin_load_error|private_plugin_source_changed|loaded_plugin_hash_changed)$/.test(error.message)) {
      throw error;
    }
    return { status: 'missing_prerequisite', evidence: {
      reason: 'private_marketplace_install_or_policy_unavailable', detail: error.message } };
  }
  if (JSON.stringify(profiles[0].settings) !== JSON.stringify(profiles[1].settings) ||
      JSON.stringify(profiles[0].installed) !== JSON.stringify(profiles[1].installed) ||
      profiles[0].loadedTreeSha256 !== profiles[1].loadedTreeSha256 ||
      profiles[0].loadedPathEvidence !== profiles[1].loadedPathEvidence ||
      profiles[0].accountSha256 !== profiles[1].accountSha256) {
    throw new Error('fixture_private_profiles_not_equivalent');
  }
  const marker = `CBSMEM0${randomUUID().replaceAll('-', '')}`;
  const startedAt = Date.now();
  const defaultChild = spawn(settings.tools.claude.executable,
    ['--allowedTools', 'Bash', '-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose'],
    { cwd: defaultProject, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: profiles[0].env });
  let defaultClosed = false;
  let defaultError = '';
  const defaultExit = new Promise(resolve => {
    defaultChild.once('error', error => {
      defaultClosed = true;
      defaultError = error.message;
      resolve({ error: error.message });
    });
    defaultChild.once('close', (code, signal) => { defaultClosed = true; resolve({ code, signal }); });
  });
  defaultChild.stdout.on('data', () => {});
  defaultChild.stdin.on('error', () => {});
  defaultChild.stderr.on('data', chunk => { defaultError = (defaultError + chunk).slice(-1000); });
  defaultChild.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user',
    content: `Use the Bash tool to run powershell.exe -NoProfile -Command Write-Output ${marker}, then reply DONE.` } }) + '\n');
  try {
    const deadline = Date.now() + 30000;
    let before;
    let defaultTool;
    let toolEvents = 0;
    while (!defaultClosed && Date.now() < deadline) {
      try {
        before = await pluginCounts(settings.tools.python.executable,
          path.join(pluginData, 'claude-mem.db'), defaultProject, project);
        toolEvents = Object.entries(before.default.events).filter(([name]) =>
          /tool|command/i.test(name)).reduce((sum, [, count]) => sum + count, 0);
        if (toolEvents > 0) {
          defaultTool = await nativeToolEffect(defaultProfile, startedAt, marker);
          if (defaultTool.completed) break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (defaultClosed || toolEvents < 1 || !defaultTool?.completed) {
      if (/login|authentication|not logged|api key/i.test(defaultError)) {
        return { status: 'missing_prerequisite',
          evidence: { reason: 'claude_account_in_private_profile' } };
      }
      if (/trust|approve|permission/i.test(defaultError)) {
        return { status: 'missing_prerequisite',
          evidence: { reason: 'private_default_project_trust' } };
      }
      throw new Error('fixture_default_plugin_ineffective');
    }
    const beforeEvents = Object.values(before.default.events).reduce((a, b) => a + b, 0);
    const liveBefore = await pluginHealth(port, profiles[0].loadedFrom, manifest.version);
    process.env.CLAUDE_CONFIG_DIR = optInProfile;
    const made = await createLaunch(project, 'claude', { stateRoot });
    if (made.kind !== 'created') throw new Error(made.reason ?? 'fixture_opt_in_launch');
    const launch = await buildLaunchCommand(project, 'claude', [], { stateRoot }, made);
    if (launch.kind !== 'ready') throw new Error(launch.reason ?? 'fixture_opt_in_launch');
    let opted;
    const optMarker = `CBSMEM0${randomUUID().replaceAll('-', '')}`;
    const optStartedAt = Date.now();
    try {
      if (defaultClosed) throw new Error('fixture_default_exited_before_overlap');
      if (launch.args[0] !== '--settings' ||
          windowsPathKey(launch.args[1] ?? '') !== windowsPathKey(made.record.overlay.file)) {
        throw new Error('fixture_opt_in_productive_overlay_missing');
      }
      const optEnv = { ...profiles[1].env, ...launch.env, ...pluginEnv,
        CLAUDE_CONFIG_DIR: optInProfile,
        CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(optInProfile, 'plugins') };
      const activeList = await runFile(launch.command,
        ['--settings', launch.args[1], 'plugin', 'list', '--json'],
        { env: optEnv, timeout: 15000, maxBuffer: 65536, windowsHide: true });
      const activePlugins = JSON.parse(activeList.stdout);
      if (!Array.isArray(activePlugins) ||
          activePlugins.filter(row => row?.id === 'claude-mem@thedotmack' &&
            row.enabled === false).length !== 1 ||
          activePlugins.some(row => row?.id === 'claude-mem@inline')) {
        throw new Error('fixture_opt_in_plugin_still_enabled');
      }
      process.stdout.write(`Fixture opt-in session: submit a prompt, run Bash command powershell.exe -NoProfile -Command Write-Output ${optMarker}, then exit.\n`);
      opted = await runActualCli({ ...launch, cwd: project,
        env: optEnv });
    } finally { launch.release(); await launch.cleanup(); }
    if (opted.kind !== 'exited' || opted.code !== 0) throw new Error('fixture_opt_in_cli_failed');
    if (defaultClosed) throw new Error('fixture_default_exited_during_overlap');
    const after = await pluginCounts(settings.tools.python.executable,
      path.join(pluginData, 'claude-mem.db'), defaultProject, project);
    const liveAfter = await pluginHealth(port, profiles[0].loadedFrom, manifest.version);
    const optInSettingsAfter = JSON.parse(await fs.readFile(
      path.join(optInProfile, 'settings.json'), 'utf8'));
    if (JSON.stringify(optInSettingsAfter) !== JSON.stringify(profiles[1].settings)) {
      throw new Error('fixture_opt_in_profile_settings_changed');
    }
    const optTool = await nativeToolEffect(optInProfile, optStartedAt, optMarker);
    const bound = await resolveBoundLaunch(made.token, 'claude', { stateRoot });
    const cursor = bound.kind === 'bound'
      ? await createOutbox(bound.stateDir).cursor('claude', bound.nativeSessionId) : null;
    if (!optTool.completed || optTool.pluginToolCalls !== 0 || !(cursor?.queuedEnd > 0)) {
      throw new Error('fixture_opt_in_tool_or_cbs_hook_missing');
    }
    if (JSON.stringify(after.opt_in) !== JSON.stringify(before.opt_in) ||
        Object.values(after.default.events).reduce((a, b) => a + b, 0) < beforeEvents) {
      throw new Error('fixture_plugin_exclusivity_failed');
    }
    return { status: 'passed', evidence: { version: manifest.version, treeSha256: sourceHash,
      marketplaceTreeSha256: supplied.marketplaceTreeSha256,
      installed: profiles[0].installed, equivalentEnabledSettings: true,
      loadedTreeSha256: profiles[0].loadedTreeSha256,
      loadedPathEvidence: profiles[0].loadedPathEvidence,
      accountSha256: profiles[0].accountSha256, authMethod: profiles[0].authMethod,
      privatePort: port, defaultEvents: before.default.events, optInEvents: after.opt_in.events,
      defaultToolCommandEvents: toolEvents, defaultTool, optTool,
      optInCbsCheckpointObserved: true, optInMergedPluginEnabled: false,
      overlapStartedWhileDefaultLive: true,
      ownedDefaultChildClosed: true, workerBefore: liveBefore, workerAfter: liveAfter } };
  } finally {
    defaultChild.stdin.end();
    if (!defaultClosed) defaultChild.kill();
    let timer;
    await Promise.race([defaultExit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture_default_child_not_closed')), 5000);
    })]).finally(() => clearTimeout(timer));
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    record('native_platform', 'missing_prerequisite', { requires: 'Windows x64 NTFS' });
    return;
  }
  beginControl('provenance');
  report.provenance = await provenance();
  record('provenance', ['claude', 'codex', 'python'].every(name =>
    report.provenance.tools[name]?.version)
    ? 'passed' : 'missing_prerequisite',
  { sourceCount: Object.keys(report.provenance.sourceSha256).length,
    addonVerified: true, versionedTools: Object.keys(report.provenance.tools).length });
  const fixture = randomUUID();
  const root = path.join(os.tmpdir(), `cbs-mem0-native-${fixture}`);
  const stateRoot = path.join(root, 'state');
  const claudeProfile = path.join(root, 'profiles', 'claude');
  const codexProfile = path.join(root, 'profiles', 'codex');
  const defaultProfile = path.join(root, 'profiles', 'default');
  const pluginOptInProfile = path.join(root, 'profiles', 'plugin-opt-in');
  report.fixtureRoot = root; // Retained for audit; no recursive cleanup of unknown objects.
  beginControl('fresh_private_ntfs_fixture');
  for (const dir of [root, stateRoot, claudeProfile, codexProfile, defaultProfile,
    pluginOptInProfile]) await requirePrivate(dir);
  record('fresh_private_ntfs_fixture', 'passed', { privateState: true });
  beginControl('fresh_git_checkout');
  const project = await gitCheckout(root);
  record('fresh_git_checkout', 'passed', { project });
  const defaultProject = await gitCheckout(root, 'default-project');
  beginControl('default_claude_mem_selection');
  const defaultSelection = await initializeSession(defaultProject, `fixture-default-${fixture}`,
    { stateRoot, event: 'SessionStart' });
  record('default_claude_mem_selection', defaultSelection.provider === 'claude-mem'
    ? 'passed' : 'failed', { provider: defaultSelection.provider });
  beginControl('public_windows_release_gate');
  const gates = [await activateProject(project, {}), await launchCli(project, 'claude', [], { stateRoot })];
  record('public_windows_release_gate', gates.every(value => value.kind === 'blocked' &&
    value.reason === 'windows_release_unproved') ? 'passed' : 'failed', { results: gates });
  const enrolled = await enroll(stateRoot, project);
  if (settings.destination?.url) {
    beginControl('private_destination_proxy');
    report.provenance.destinationUpstreamSha256 = sha(settings.destination.url);
    ownedProxy = await privateQdrantProxy(settings.destination.url);
    settings.destination.url = ownedProxy.url;
    record('private_destination_proxy', 'passed', { ownedPort: new URL(ownedProxy.url).port,
      upstreamSha256: report.provenance.destinationUpstreamSha256 });
  } else record('private_destination_proxy', 'missing_prerequisite', { reason: 'destination_url' });
  const resolution = await configuredProject(project, stateRoot, fixture);
  beginControl('outbox_same_process_idempotence');
  try {
    const persisted = await persistenceCore(path.join(stateRoot, 'fixture-persistence'),
      resolution?.projectId ?? `fixture-${fixture}`);
    record('outbox_same_process_idempotence', 'passed', persisted);
  } catch (error) { record('outbox_same_process_idempotence', 'failed', failure(error)); }
  beginControl('outbox_crash_temp_flushed_before_publish', 'outbox_crash_item_durable',
    'outbox_crash_manifest_durable', 'outbox_crash_receipt_durable',
    'outbox_crash_cursor_durable');
  try {
    const crashed = await crashOutbox(stateRoot, resolution?.projectId ?? `fixture-${fixture}`);
    for (const [name, evidence] of Object.entries(crashed)) record(`outbox_crash_${name}`, 'passed', evidence);
  } catch (error) { record('outbox_crash_replay', 'failed', failure(error)); }
  beginControl('native_publish_callback_contract');
  try { record('native_publish_callback_contract', 'passed',
    await nativePublishCallbackContract(stateRoot)); }
  catch (error) { record('native_publish_callback_contract', 'failed', failure(error)); }
  beginControl('state_crash_intent_durable', 'state_crash_rewrite_durable');
  try {
    const crashed = await crashWindowsState(stateRoot);
    for (const [name, evidence] of Object.entries(crashed)) record(`state_crash_${name}`, 'passed', evidence);
  } catch (error) { record('state_crash_replay', 'failed', failure(error)); }
  try { await adversarialWindowsFiles(stateRoot); }
  catch (error) { record('adversarial_files', 'failed', failure(error)); }
  beginControl('journal_retention');
  try { record('journal_retention', 'passed', await journalRetention(stateRoot)); }
  catch (error) { record('journal_retention', 'failed', failure(error)); }
  beginControl('worker_guard_and_presecret_ipc');
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
  beginControl('core_capture_binding');
  try {
    capture = await captureCore(project, stateRoot, resolution, claudeProfile);
    ownedCaptureOverlay = { stateRoot, token: capture.made.token,
      expected: capture.made.record.overlay };
    record('core_capture_binding', 'passed', { operationId: capture.captured.operationId,
      messageCount: capture.row.messages.length });
  } catch (error) { record('core_capture_binding', 'failed', failure(error)); }
  if (capture) {
    beginControl('capture_source_and_args_negative');
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
    beginControl('native_claude_launch');
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
  let approvedCandidate;
  if (capture && enrolled.claude === 'passed' && settings.runExtraction) {
    beginControl('real_extraction');
    process.env.CBS_MEMORIA_STATE_ROOT = stateRoot;
    const result = await consumeCheckpoints({ cli: 'claude', cwd: project,
      sessionId: capture.sessionId, stateRoot });
    record('real_extraction', result.kind === 'consumed' && result.manifested > 0
      ? 'passed' : 'failed', result);
    const manifest = await createOutbox(resolution.stateDir).readManifest(capture.captured.operationId);
    const candidate = manifest?.candidates?.find(item => item.status === 'pending');
    if (candidate && settings.runReview) {
      beginControl('manual_review');
      const payload = await createOutbox(resolution.stateDir).readCandidatePayload(
        capture.captured.operationId, candidate.candidateKey);
      const sid = (await inspectWindowsPath(resolution.stateDir, 'directory')).currentSid;
      const review = await reviewCandidateOnTerminal(capture.captured.operationId,
        candidate.candidateKey, { outbox: createOutbox(resolution.stateDir), cwd: project,
          sessionId: capture.sessionId, stateRoot, writerId: `sid:${sid}`,
          actor: `sid:${sid}:${os.userInfo().username}`,
          readSecret: name => process.env[name] });
      record('manual_review', ['acked', 'processed', 'disposed'].includes(review.kind)
        ? 'passed' : 'failed', { kind: review.kind, reason: review.reason });
      if (review.kind === 'acked' && payload?.text) approvedCandidate = {
        text: payload.text, externalId: candidate.externalId,
        source: payload.source_message_id, projectId: resolution.projectId };
    } else record('manual_review', 'missing_prerequisite',
      { reason: candidate ? 'operator_review_required' : 'no_pending_candidate' });
  } else {
    record('real_extraction', 'missing_prerequisite', { reason: 'sonnet_account_or_operator_run' });
    record('manual_review', 'missing_prerequisite', { reason: 'extraction_not_run' });
  }
  const inputs = settings.runtime;
  if (capture && enrolled.python === 'passed' && inputs?.model && inputs?.tokenizer &&
      settings.runRuntime) {
    beginControl('runtime_broker_recall');
    const verified = await verifyRuntimeArtifacts(inputs.model, inputs.tokenizer);
    const prepared = verified.kind === 'verified'
      ? await provisionRuntime(project, inputs.model, inputs.tokenizer, { stateRoot }) : verified;
    if (prepared.kind !== 'provisioned') {
      record('runtime_broker_recall', 'failed', { reason: prepared.reason });
    } else {
      let served;
      const serve = serveBroker({ stateRoot, bootstrapCwd: project,
        bootstrapSessionId: capture?.sessionId, idleMs: settings.runInteractiveCli ? 60000 : 5000 });
      serve.then(value => { served = value; });
      try {
        const endpoint = path.join(stateRoot, 'encoder.discovery.json');
        const start = Date.now();
        while (!served && Date.now() - start < 5000) {
          if (await fs.lstat(endpoint).then(() => true, () => false)) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const status = await brokerEndpointStatus(stateRoot);
        if (status === 'live' && settings.runCrashRemote) {
          beginControl('remote_add_crash_replay');
          try {
            const replay = await crashRemoteAdd({ capture, project, stateRoot, resolution });
            if (!approvedCandidate) approvedCandidate = replay.approved;
            record('remote_add_crash_replay', 'passed', {
              boundary: replay.boundary, childClosed: replay.childClosed,
              pendingAfterCrash: replay.pendingAfterCrash, noFalseAck: replay.noFalseAck,
              secondSdkAdd: replay.secondSdkAdd, finalRemoteRows: replay.finalRemoteRows });
          } catch (error) { record('remote_add_crash_replay', 'failed', failure(error)); }
        } else record('remote_add_crash_replay', 'missing_prerequisite',
          { reason: status === 'live' ? 'operator_source_approval' : 'broker_not_live' });
        beginControl('runtime_broker_search_diagnostic');
        const diagnostic = status === 'live' && capture
          ? await requestBroker({ cwd: project, sessionId: capture.sessionId,
            operation: { op: 'search', projectId: resolution.projectId,
              query: approvedCandidate?.text ?? 'fixture source fact' } },
          process.env[settings.destination.apiKeyEnv], { stateRoot, deadlineMs: 1000 })
          : { kind: 'unavailable', reason: status };
        record('runtime_broker_search_diagnostic', diagnostic.kind === 'items'
          ? 'passed' : 'failed', { kind: diagnostic.kind, itemCount: diagnostic.items?.length,
            reason: diagnostic.reason });
        if (!approvedCandidate) {
          record('runtime_broker_recall', 'missing_prerequisite',
            { reason: 'reviewed_active_source_memory_required' });
          for (const name of ['hook_recall_policy_diagnostic', 'hook_executable_direct',
            'mcp_recall_response', 'native_cli_hook_recall']) record(name, 'missing_prerequisite',
            { reason: 'reviewed_active_source_memory_required' });
        } else {
          beginControl('hook_recall_policy_diagnostic', 'hook_executable_direct',
            'mcp_recall_response');
          const payload = { cwd: project, session_id: capture.sessionId,
            prompt: approvedCandidate.text };
          let context;
          const directBegan = performance.now();
          const output = await recallForPrompt({ cli: 'claude', payload,
            result: capture.captured, stateRoot, began: directBegan });
          const directElapsedMs = performance.now() - directBegan;
          context = output?.hookSpecificOutput?.additionalContext;
          const correct = !!context?.includes(approvedCandidate.text) &&
            context.includes(approvedCandidate.source) && Buffer.byteLength(context, 'utf8') <= 500;
          const dedup = await recallForPrompt({ cli: 'claude', payload,
            result: capture.captured, stateRoot });
          await recallForPrompt({ cli: 'claude', event: 'PreCompact', payload,
            result: capture.captured, stateRoot });
          const negative = await recallForPrompt({ cli: 'claude',
            payload: { ...payload, prompt: 'zzzxq unrelated synthetic query' },
            result: capture.captured, stateRoot });
          await recallForPrompt({ cli: 'claude', event: 'PreCompact', payload,
            result: capture.captured, stateRoot });
          const beforeUnavailable = ownedProxy.stats.unavailable;
          ownedProxy.setUnavailable(true);
          let unavailable;
          try {
            unavailable = await recallForPrompt({ cli: 'claude', payload,
              result: capture.captured, stateRoot });
          } finally { ownedProxy.setUnavailable(false); }
          const realOutageObserved = ownedProxy.stats.unavailable > beforeUnavailable;
          const sourced = diagnostic.items?.find(item =>
            (item.text ?? item.memory) === approvedCandidate.text);
          let policyFiltered = false;
          if (sourced) {
            const foreign = { ...sourced, projectId: 'foreign-project', project_id: 'foreign-project' };
            const unsourced = { ...sourced, metadata: { ...sourced.metadata, source: '' } };
            const search = async () => ({ kind: 'items', items: [foreign, unsourced] });
            const filtered = await recallForPrompt({ cli: 'claude', payload,
              result: capture.captured, stateRoot, search });
            policyFiltered = filtered === null;
          }
          const late = await recallForPrompt({ cli: 'claude', payload,
            result: capture.captured, stateRoot, began: performance.now() - 1001 });
          record('hook_recall_policy_diagnostic', policyFiltered && late === null
            ? 'passed' : 'failed', { injectedRowsFromRealSearch: !!sourced,
              foreignProjectAndMissingSourceFiltered: policyFiltered,
              absoluteDeadlineRejected: late === null });
          let fullHook;
          try {
            const samplesMs = [];
            let hookCorrect = true;
            const contextSha256 = [];
            for (let i = 0; i < 5; i++) {
              await recallForPrompt({ cli: 'claude', event: 'PreCompact', payload,
                result: capture.captured, stateRoot });
              const direct = await directHookExecutable({ capture, project, stateRoot,
                profile: claudeProfile, prompt: approvedCandidate.text });
              samplesMs.push(direct.elapsedMs);
              const additionalContext = direct.output?.hookSpecificOutput?.additionalContext;
              if (!additionalContext?.includes(approvedCandidate.text) ||
                  !additionalContext.includes(approvedCandidate.source) ||
                  Buffer.byteLength(additionalContext, 'utf8') > 500) hookCorrect = false;
              contextSha256.push(additionalContext ? sha(additionalContext) : null);
            }
            fullHook = { samplesMs, p95Ms: p95(samplesMs),
              maxMs: Math.max(...samplesMs), thresholdMs: budgets.recallTotalP95Ms,
              hookCorrect, contextSha256, actualHookProcess: true,
              brokerIpcAndResponse: true, dispatchToExit: true };
            record('hook_executable_direct', hookCorrect &&
              fullHook.p95Ms <= budgets.recallTotalP95Ms &&
              fullHook.maxMs <= budgets.recallTotalMaxMs ? 'passed' : 'failed', fullHook);
          } catch (error) { record('hook_executable_direct', 'failed', failure(error)); }
          let mcpMeasurement;
          try {
            const samplesMs = [];
            let responseCorrect = true;
            for (let i = 0; i < 5; i++) {
              await recallForPrompt({ cli: 'claude', event: 'PreCompact', payload,
                result: capture.captured, stateRoot });
              const response = await mcpSearchExecutable({ capture, project, stateRoot,
                profile: claudeProfile, query: approvedCandidate.text });
              samplesMs.push(response.elapsedMs);
              if (response.value?.kind !== 'items' ||
                  !response.value.context?.includes(approvedCandidate.text) ||
                  !response.value.context.includes(approvedCandidate.source) ||
                  Buffer.byteLength(response.value.context, 'utf8') > 500) responseCorrect = false;
            }
            mcpMeasurement = { samplesMs, p95Ms: p95(samplesMs),
              maxMs: Math.max(...samplesMs), responseCorrect,
              actualMcpProcess: true, dispatchToResponseAndExit: true };
            record('mcp_recall_response', responseCorrect &&
              mcpMeasurement.p95Ms <= budgets.recallTotalP95Ms &&
              mcpMeasurement.maxMs <= budgets.recallTotalMaxMs ? 'passed' : 'failed',
            mcpMeasurement);
          } catch (error) { record('mcp_recall_response', 'failed', failure(error)); }
          record('runtime_broker_recall', correct && dedup === null && negative === null &&
            unavailable === null && realOutageObserved && fullHook?.hookCorrect &&
            mcpMeasurement?.responseCorrect &&
            fullHook.p95Ms <= budgets.recallTotalP95Ms &&
            fullHook.maxMs <= budgets.recallTotalMaxMs &&
            mcpMeasurement.p95Ms <= budgets.recallTotalP95Ms &&
            mcpMeasurement.maxMs <= budgets.recallTotalMaxMs ? 'passed' : 'failed',
          { directCoreDiagnostic: { elapsedMs: directElapsedMs,
            contextSha256: context ? sha(context) : null }, nativeCliHookObserved: false,
            samplesMs: fullHook?.samplesMs, p95Ms: fullHook?.p95Ms,
            mcpSamplesMs: mcpMeasurement?.samplesMs, mcpP95Ms: mcpMeasurement?.p95Ms,
            requiredMetric: 'full_hook_and_mcp_response', dedupAbstained: dedup === null,
            negativeAbstained: negative === null, qdrantUnavailableObserved: realOutageObserved,
            qdrantUnavailableAbstained: unavailable === null,
            source: approvedCandidate.source, projectId: approvedCandidate.projectId });
          if (settings.runInteractiveCli && enrolled.claude === 'passed') {
            beginControl('native_cli_hook_recall');
            process.env.CLAUDE_CONFIG_DIR = claudeProfile;
            const made = await createLaunch(project, 'claude', { stateRoot });
            const launch = made.kind === 'created'
              ? await buildLaunchCommand(project, 'claude', [], { stateRoot }, made) : made;
            if (launch.kind !== 'ready') record('native_cli_hook_recall', 'failed',
              { reason: launch.reason });
            else {
              const beganAt = Date.now();
              try {
                process.stdout.write('Fixture native hook: submit the reviewed fact as a prompt, then exit.\n');
                const native = await runActualCli({ ...launch, cwd: project });
                const observation = await nativeHookObservation(claudeProfile, beganAt,
                  approvedCandidate.text, approvedCandidate.source);
                record('native_cli_hook_recall', native.kind === 'exited' && native.code === 0 &&
                  observation.matched > 0 ? 'passed' : 'failed',
                { cliExit: native, ...observation, directModuleInvocation: false });
              } finally { launch.release(); await launch.cleanup(); }
            }
          } else record('native_cli_hook_recall', 'missing_prerequisite',
            { reason: 'interactive_cli_and_reviewed_memory_required' });
        }
      } finally { await serve; }
    }
  } else for (const name of ['runtime_broker_recall', 'remote_add_crash_replay',
    'hook_recall_policy_diagnostic', 'hook_executable_direct', 'mcp_recall_response',
    'native_cli_hook_recall']) {
    record(name, 'missing_prerequisite',
      { reason: 'pinned_runtime_artifacts_python_or_operator_run' });
  }
  if (enrolled.codex === 'passed') {
    beginControl('codex_native_hook_observation');
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
  if (capture) {
    beginControl('capture_p95');
    try {
      const measurement = await captureP95(capture, project, stateRoot, claudeProfile);
      record('capture_p95', measurement.p95Ms <= budgets.captureP95Ms ? 'passed' : 'failed',
        measurement);
    } catch (error) { record('capture_p95', 'failed', failure(error)); }
  } else record('capture_p95', 'missing_prerequisite', { reason: 'bound_capture' });
  beginControl('default_claude_mem_simultaneous_control');
  try {
    const control = await defaultPluginControl({ root, defaultProject, project, stateRoot,
      defaultProfile, optInProfile: pluginOptInProfile, enrolled });
    record('default_claude_mem_simultaneous_control', control.status, control.evidence);
  } catch (error) { record('default_claude_mem_simultaneous_control', 'failed', failure(error)); }
}

try { await main(); }
catch (error) { record('fixture_execution', 'failed', failure(error)); }
finally {
  try { if (ownedCaptureOverlay) await removeWindowsOverlay(ownedCaptureOverlay); }
  catch (error) { record('capture_overlay_cleanup', 'failed', failure(error)); }
  try { await ownedProxy?.close(); }
  catch (error) { record('private_destination_proxy_cleanup', 'failed', failure(error)); }
  await save();
}
