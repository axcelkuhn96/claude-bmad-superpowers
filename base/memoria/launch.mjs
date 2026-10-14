#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { identifyProject } from './project-id.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple } from './trust.mjs';
import { createBrokerLeaseCredential, openBrokerLease } from './broker.mjs';
import { ensureBrokerReady } from './broker-start.mjs';
import { inspectCodexMainHooks, verifyNativeCapture } from './native.mjs';
import { codexHookOverride, codexTomlString } from './codex-config-toml.mjs';
import { ensureWindowsPrivateDirectory, readWindowsPrivateFile,
  writeWindowsPrivateFile, readWindowsBinary, publishWindowsBinary,
  withWindowsFileLock } from './windows-security.mjs';
import { prepareWindowsOverlay, holdWindowsOverlay, removeWindowsOverlay,
  verifyWindowsLaunchOverlay } from './windows-overlay.mjs';
import { resolveEnrolledWindowsTool } from './windows-enrollment.mjs';
import { readOwner, readExtractor } from './policy.mjs';
import { nativeProfile } from './native-profile.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const rootDefault = () => path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const digest = value => createHash('sha256').update(value).digest('hex');
const launchDir = root => path.join(root ?? rootDefault(), 'launches');
const launchFile = (root, token) => path.join(launchDir(root), `${digest(token)}.json`);
const bindingFile = (root, token) => path.join(launchDir(root), `${digest(token)}.bind`);
const sessionBindingFile = (root, cli, sessionId) => path.join(launchDir(root),
  `${digest(JSON.stringify([cli, sessionId]))}.session-bind`);

async function sameBinding(root, token, cli, sessionId) {
  if (process.platform === 'win32') {
    const [bound, session] = await Promise.all([
      readWindowsBinary(bindingFile(root, token), { length: 8192 }),
      readWindowsBinary(sessionBindingFile(root, cli, sessionId), { length: 8192 }),
    ]);
    if (bound.size !== bound.bytes.length || session.size !== session.bytes.length) return false;
    const one = JSON.parse(bound.bytes.toString('utf8'));
    const other = JSON.parse(session.bytes.toString('utf8'));
    return one.nativeSessionId === sessionId && other.nativeSessionId === sessionId &&
      other.tokenDigest === digest(token) && one.cli === cli && other.cli === cli;
  }
  const [tokenStat, sessionStat] = await Promise.all([
    fs.lstat(bindingFile(root, token)), fs.lstat(sessionBindingFile(root, cli, sessionId)),
  ]);
  return tokenStat.isFile() && sessionStat.isFile() && tokenStat.dev === sessionStat.dev &&
    tokenStat.ino === sessionStat.ino && tokenStat.uid === process.getuid() &&
    sessionStat.uid === process.getuid() && !(tokenStat.mode & 0o077);
}

async function windowsClaim(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const observed = await readWindowsBinary(file, { length: 8192 });
  if (observed.size !== observed.bytes.length) throw new Error('unsafe_launch_binding');
  let claim;
  try { claim = JSON.parse(observed.bytes.toString('utf8')); }
  catch { throw new Error('unsafe_launch_binding'); }
  if (!['claude', 'codex'].includes(claim.cli) ||
      typeof claim.nativeSessionId !== 'string' || !claim.nativeSessionId ||
      claim.nativeSessionId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(claim.tokenDigest ?? '')) {
    throw new Error('unsafe_launch_binding');
  }
  return claim;
}

async function safeRead(file) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file);
    if (!result.ok) return null;
    try { return JSON.parse(result.text); } catch { return null; }
  }
  try {
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!process.getuid || !dir.isDirectory() || !stat.isFile() ||
        dir.uid !== process.getuid() || stat.uid !== process.getuid() ||
        (dir.mode & 0o077) || (stat.mode & 0o077)) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

function same(current, saved) {
  return current.provider === 'mem0' && current.projectRoot === saved.projectRoot &&
    current.projectId === saved.projectId && current.embeddingFingerprint === saved.embeddingFingerprint &&
    JSON.stringify(current.destination) === JSON.stringify(saved.destination);
}

async function codexCaptureSource(nativeRoot, projectRoot, stateRoot) {
  const active = await verifyNativeCapture(nativeRoot, { cli: 'codex', projectRoot, stateRoot,
    includeLaunchHooks: nativeRoot !== projectRoot });
  if (active.kind !== 'verified') return active;
  const main = await inspectCodexMainHooks(projectRoot, { stateRoot });
  if (main.kind === 'blocked') return main;
  if (process.platform === 'win32') return { kind: 'verified', source: 'session', hooks: active.hooks };
  if (nativeRoot === projectRoot && main.kind !== 'verified') return blocked('stale_main_hooks');
  return main.kind === 'verified'
    ? { kind: 'verified', source: 'main', fingerprint: main.fingerprint }
    : { kind: 'verified', source: 'session', hooks: active.hooks };
}

export async function createLaunch(cwd, cli, { stateRoot } = {}) {
  if (!['claude', 'codex'].includes(cli) || (process.platform !== 'win32' && !process.getuid)) return blocked('native_windows_unproved');
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  if (await fs.lstat(path.join(current.stateDir, 'deactivating.json')).then(() => true,
    error => error.code === 'ENOENT' ? false : Promise.reject(error))) return blocked('deactivation_pending');
  const scope = await identifyProject(cwd);
  if (scope.kind !== 'git') return blocked('unsupported_git');
  const nativeRoot = scope.activeRoot;
  const trust = await readLocalTrust(current.stateDir);
  const expected = trustTuple(current);
  if (!sameTrustTuple(expected, trust)) return blocked('trust_changed');
  const profile = nativeProfile(cli);
  const owner = await readOwner(current, cli, profile);
  const extractor = await readExtractor(current);
  if (owner?.kind === 'blocked' || extractor?.kind === 'blocked') return blocked('local_policy_changed');
  let captureSource;
  if (process.platform === 'win32') {
    const verified = await verifyNativeCapture(nativeRoot, { cli, projectRoot: current.projectRoot,
      stateRoot, profile });
    if (verified.kind !== 'verified') return blocked(verified.reason);
    captureSource = cli === 'codex'
      ? await codexCaptureSource(nativeRoot, current.projectRoot, stateRoot) : verified;
    if (captureSource.kind !== 'verified') return blocked(captureSource.reason);
  } else if (cli === 'codex') {
    captureSource = await codexCaptureSource(nativeRoot, current.projectRoot, stateRoot);
    if (captureSource.kind !== 'verified') return blocked(captureSource.reason);
  }
  const token = randomBytes(32).toString('hex');
  let overlay;
  if (process.platform === 'win32' && cli === 'claude') {
    try { overlay = await prepareWindowsOverlay({ stateRoot, token, hooks: captureSource.hooks }); }
    catch (error) { return blocked(error.message); }
  }
  const dir = launchDir(stateRoot);
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(dir)).ok) {
      if (overlay) await removeWindowsOverlay({ stateRoot, token, expected: overlay }).catch(() => {});
      return blocked('unsafe_launch_state');
    }
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return blocked('unsafe_launch_state');
  }
  const record = { cli, nativeRoot, projectRoot: current.projectRoot, projectId: current.projectId,
    destination: current.destination, embeddingFingerprint: current.embeddingFingerprint,
    ownerId: owner?.ownerId ?? null, extractor: extractor ?? null,
    createdAt: Date.now(), ...(process.platform === 'win32'
      ? { profile, ...(overlay ? { overlay } : {}) } : {}) };
  if (process.platform === 'win32') {
    if (!(await writeWindowsPrivateFile(launchFile(stateRoot, token), JSON.stringify(record) + '\n')).ok) {
      if (overlay) await removeWindowsOverlay({ stateRoot, token, expected: overlay }).catch(() => {});
      return blocked('unsafe_launch_state');
    }
  } else await fs.writeFile(launchFile(stateRoot, token), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  return { kind: 'created', token, record, ...(captureSource ? { captureSource } : {}) };
}

export async function bindLaunch(token, cli, cwd, nativeSessionId, { stateRoot } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !nativeSessionId || nativeSessionId.length > 256) return blocked('unbound');
  const saved = await safeRead(launchFile(stateRoot, token));
  if (!saved || saved.cli !== cli || Date.now() - saved.createdAt > 12 * 60 * 60 * 1000) return blocked('unbound');
  const scope = await identifyProject(cwd);
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (scope.kind !== 'git' || scope.activeRoot !== saved.nativeRoot || !same(current, saved)) return blocked('launch_changed');
  const frozen = await resolveProject(cwd, nativeSessionId, { stateRoot });
  if (frozen.provider !== 'mem0' || frozen.ownerId !== (saved.ownerId ?? null) ||
      JSON.stringify(frozen.extractor) !== JSON.stringify(saved.extractor ?? null)) return blocked('launch_changed');
  const file = bindingFile(stateRoot, token);
  if (process.platform === 'win32') {
    try {
      return await withWindowsFileLock(path.join(launchDir(stateRoot),
        `${digest(JSON.stringify([cli, nativeSessionId]))}.session-lock`), async () =>
        withWindowsFileLock(path.join(launchDir(stateRoot), `${digest(token)}.lock`), async () => {
        const reciprocal = sessionBindingFile(stateRoot, cli, nativeSessionId);
        const [byToken, bySession] = await Promise.all([windowsClaim(file), windowsClaim(reciprocal)]);
        const matches = claim => !claim || claim.cli === cli && claim.nativeSessionId === nativeSessionId &&
          claim.tokenDigest === digest(token);
        if (!matches(byToken) || !matches(bySession)) return blocked('already_bound');
        if (byToken && bySession) return { kind: 'bound', nativeSessionId };
        const claim = Buffer.from(JSON.stringify({ cli, nativeSessionId,
          tokenDigest: digest(token), boundAt: byToken?.boundAt ?? bySession?.boundAt ?? Date.now() }) + '\n');
        // A crash may leave either claim. Only the same token/session can complete it.
        if (!bySession) await publishWindowsBinary(reciprocal, claim);
        if (!byToken) await publishWindowsBinary(file, claim);
        return await sameBinding(stateRoot, token, cli, nativeSessionId)
          ? { kind: 'bound', nativeSessionId } : blocked('already_bound');
      }));
    } catch { return blocked('bind_failed'); }
  }
  try { await fs.writeFile(file, JSON.stringify({ nativeSessionId, boundAt: Date.now() }) + '\n',
    { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') return blocked('bind_failed');
    const bound = await safeRead(file);
    return bound?.nativeSessionId === nativeSessionId &&
      await sameBinding(stateRoot, token, cli, nativeSessionId).catch(() => false)
      ? { kind: 'bound', nativeSessionId } : blocked('already_bound');
  }
  try { await fs.link(file, sessionBindingFile(stateRoot, cli, nativeSessionId)); }
  catch { await fs.rm(file, { force: true }); return blocked('already_bound'); }
  return { kind: 'bound', nativeSessionId };
}

export async function resolveBoundLaunch(token, cli, { stateRoot } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return blocked('unbound');
  const saved = await safeRead(launchFile(stateRoot, token));
  const bound = await safeRead(bindingFile(stateRoot, token));
  if (!saved || !bound || saved.cli !== cli || Date.now() - saved.createdAt > 12 * 60 * 60 * 1000) return blocked('unbound');
  if (!await sameBinding(stateRoot, token, cli, bound.nativeSessionId).catch(() => false)) return blocked('unbound');
  const current = await resolveProject(saved.nativeRoot, bound.nativeSessionId, { stateRoot });
  const scope = await identifyProject(saved.nativeRoot);
  if (scope.kind !== 'git' || scope.activeRoot !== saved.nativeRoot || !same(current, saved)) return blocked('launch_changed');
  return { kind: 'bound', cwd: saved.nativeRoot, nativeSessionId: bound.nativeSessionId,
    projectId: saved.projectId, stateDir: current.stateDir, ownerId: current.ownerId ?? null, cli };
}

export async function buildLaunchCommand(cwd, cli, args = [], options = {}, made) {
  const codexArgs = cli === 'codex' ? safeCodexArgs(args) : null;
  if (cli === 'codex' && !codexArgs) return blocked('unsafe_cli_args');
  if (process.platform === 'win32' && !safeClaudeArgs(args) && cli === 'claude') return blocked('unsafe_cli_args');
  if (made?.kind !== 'created' || made.record.cli !== cli) return blocked('unbound');
  const root = options.stateRoot ?? rootDefault();
  const mcpScript = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
  const mcp = { mcpServers: { cbs_memoria: { command: process.execPath, args: [mcpScript] } } };
  let mcpArgs;
  if (cli === 'claude') mcpArgs = ['--mcp-config', JSON.stringify(mcp)];
  else {
    try {
      mcpArgs = ['-c', `mcp_servers.cbs_memoria.command=${codexTomlString(process.execPath)}`,
        '-c', `mcp_servers.cbs_memoria.args=[${codexTomlString(mcpScript)}]`];
    } catch { return blocked('unsafe_mcp_command'); }
  }
  let hookArgs = [];
  if (cli === 'codex' && made.captureSource.source === 'session') {
    try {
      hookArgs = Object.entries(made.captureSource.hooks).flatMap(([event, groups]) =>
        ['-c', codexHookOverride(event, groups)]);
    } catch { return blocked('unsafe_capture_hooks'); }
  }
  if (cli === 'codex') {
    const currentSource = await codexCaptureSource(made.record.nativeRoot,
      made.record.projectRoot, options.stateRoot);
    if (currentSource.kind !== 'verified') return blocked(currentSource.reason);
    if (JSON.stringify(currentSource) !== JSON.stringify(made.captureSource)) return blocked('capture_source_changed');
  }
  let command = cli;
  let release = () => {};
  let overlayRelease = () => {};
  let overlay;
  if (process.platform === 'win32') {
    try {
      const saved = await verifyWindowsLaunchOverlay({ stateRoot: options.stateRoot, token: made.token,
        cli, nativeRoot: made.record.nativeRoot, projectRoot: made.record.projectRoot });
      if (saved.projectId !== made.record.projectId ||
          saved.profile !== nativeProfile(cli)) {
        return blocked('launch_changed');
      }
      const capture = await verifyNativeCapture(made.record.nativeRoot, {
        cli, projectRoot: made.record.projectRoot, stateRoot: options.stateRoot,
        profile: saved.profile, launchToken: made.token,
      });
      if (capture.kind !== 'verified' ||
          JSON.stringify(capture.hooks) !== JSON.stringify(made.captureSource.hooks)) {
        return blocked(capture.reason ?? 'capture_source_changed');
      }
      const tool = await resolveEnrolledWindowsTool({ stateRoot: root, name: cli,
        projectRoot: made.record.projectRoot, activeRoot: made.record.nativeRoot,
        productRoot: path.resolve(path.dirname(mcpScript), '..', '..') });
      command = tool.executable;
      release = tool.release;
      if (cli === 'claude') {
        overlay = saved.overlay;
        overlayRelease = await holdWindowsOverlay({ stateRoot: options.stateRoot,
          token: made.token, expected: overlay });
      }
    } catch (error) {
      try { overlayRelease(); } finally { release(); }
      return blocked(error.message);
    }
  }
  const overlayArgs = process.platform === 'win32' && cli === 'claude'
    ? ['--settings', overlay.file] : [];
  return { kind: 'ready', command,
    args: [...overlayArgs, ...mcpArgs, ...hookArgs, ...(codexArgs ?? args)],
    env: { ...process.env, CBS_MEMORIA_LAUNCH_ID: made.token, CBS_MEMORIA_CLI: cli,
      ...(options.stateRoot ? { CBS_MEMORIA_STATE_ROOT: options.stateRoot } : {}) },
    release: () => { try { overlayRelease(); } finally { release(); } },
    cleanup: async () => {
      if (overlay) await removeWindowsOverlay({ stateRoot: options.stateRoot,
        token: made.token, expected: overlay });
    } };
}

export async function launchCli(cwd, cli, args = [], options = {}) {
  if (process.platform === 'win32') return blocked('windows_release_unproved');
  if (cli === 'codex' && !safeCodexArgs(args)) return blocked('unsafe_cli_args');
  const made = await createLaunch(cwd, cli, options);
  if (made.kind !== 'created') return made;
  const root = options.stateRoot ?? rootDefault();
  let launch;
  let credential;
  let lease;
  let cliMayBeLive = false;
  let cliSettled = false;
  try {
    const leaseDeadline = Date.now() + 30000;
    const ready = await ensureBrokerReady(cwd, { stateRoot: root,
      deadlineMs: Math.max(1, leaseDeadline - Date.now()) });
    if (ready.kind !== 'ready') return ready;
    launch = await buildLaunchCommand(cwd, cli, args, options, made);
    if (launch.kind !== 'ready') return launch;
    try { credential = await createBrokerLeaseCredential(root, made.token); }
    catch { return blocked('broker_lease_unavailable'); }
    while (Date.now() < leaseDeadline) {
      const opened = await openBrokerLease(cwd, credential.digest, credential.secret,
        { stateRoot: root, deadlineMs: Math.min(1000, Math.max(1, leaseDeadline - Date.now())) });
      if (opened.kind === 'leased') { lease = opened; credential.secret.fill(0); break; }
      if (opened.reason !== 'broker_unavailable') return blocked(opened.reason);
      await new Promise(resolve => setTimeout(resolve, Math.min(250,
        Math.max(1, leaseDeadline - Date.now()))));
    }
    if (!lease) return blocked('broker_lease_unavailable');
    const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', env: launch.env });
    cliMayBeLive = !!child.pid;
    return await new Promise(resolve => {
      child.once('error', () => { if (!child.pid) cliSettled = true; resolve(blocked('cli_unavailable')); });
      child.once('exit', (code, signal) => { cliSettled = true; resolve({ kind: 'exited', code, signal }); });
    });
  } finally {
    try {
      lease?.release();
    } finally {
      try { await credential?.release(); }
      finally {
        try {
          if (launch?.kind === 'ready') { launch.release(); await launch.cleanup(); }
        } finally {
          if (!cliMayBeLive || cliSettled) {
            const dir = launchDir(options.stateRoot);
            const file = path.join(dir, `${digest(made.token)}.closed`);
            const handle = await fs.open(file, 'wx', 0o600);
            try {
              await handle.writeFile(JSON.stringify({ tokenDigest: digest(made.token),
                projectId: made.record.projectId, outcome: cliMayBeLive ? 'exited' : 'pre_spawn_aborted',
                closedAt: new Date().toISOString() }) + '\n');
              await handle.sync();
            } finally { await handle.close(); }
            const directory = await fs.open(dir, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          }
        }
      }
    }
  }
}

function safeClaudeArgs(args) {
  if (!Array.isArray(args)) return false;
  let expectModel = false;
  let after = false;
  let prompt = false;
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg) return false;
    if (expectModel) {
      if (arg.startsWith('-')) return false;
      expectModel = false;
    } else if (!after && arg === '--model') expectModel = true;
    else if (!after && arg === '--') after = true;
    else if (!after && arg.startsWith('-')) return false;
    else if (prompt) return false;
    else prompt = true;
  }
  return !expectModel;
}

function safeCodexArgs(args) {
  if (!Array.isArray(args)) return null;
  const values = new Set(['-m', '--model']);
  const flags = new Set(['--no-alt-screen', '--no-daemon', '--strict-config']);
  const commands = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin',
    'app-server', 'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug',
    'apply', 'a', 'resume', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive',
    'fork', 'cloud', 'exec-server', 'features', 'help']);
  const safe = [];
  let terminated = false;
  let prompt;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!terminated && arg === '--') { terminated = true; continue; }
    if (!terminated && flags.has(arg)) { safe.push(arg); continue; }
    if (!terminated && values.has(arg)) {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('-')) return null;
      safe.push(arg, value);
      continue;
    }
    if (prompt !== undefined || typeof arg !== 'string' || !arg ||
        (!terminated && arg.startsWith('-')) || commands.has(arg)) return null;
    prompt = arg;
    terminated = true;
  }
  return prompt === undefined ? safe : [...safe, '--', prompt];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    process.stdout.write('blocked: local_native_gate_failed\n');
    process.exitCode = 1;
  } else {
  const [cli, cwd, ...args] = process.argv.slice(2);
  if (!cli || !cwd) { process.stderr.write('Usage: node launch.mjs <claude|codex> <checkout> [cli args...]\n'); process.exitCode = 2; }
  else {
    const result = await launchCli(cwd, cli, args);
    if (result.kind !== 'exited') { process.stderr.write(`CBS Mem0: ${result.reason}\n`); process.exitCode = 1; }
    else process.exitCode = result.code ?? 1;
  }
  }
}
