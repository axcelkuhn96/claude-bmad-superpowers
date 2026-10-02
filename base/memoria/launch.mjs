#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { identifyProject } from './project-id.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { brokerEndpointStatus } from './broker.mjs';
import { inspectCodexMainHooks, verifyNativeCapture } from './native.mjs';
import { codexHookOverride, codexTomlString } from './codex-config-toml.mjs';
import { ensureWindowsPrivateDirectory, readWindowsPrivateFile,
  writeWindowsPrivateFile } from './windows-security.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const rootDefault = () => path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const digest = value => createHash('sha256').update(value).digest('hex');
const launchDir = root => path.join(root ?? rootDefault(), 'launches');
const launchFile = (root, token) => path.join(launchDir(root), `${digest(token)}.json`);
const bindingFile = (root, token) => path.join(launchDir(root), `${digest(token)}.bind`);
const sessionBindingFile = (root, cli, sessionId) => path.join(launchDir(root),
  `${digest(JSON.stringify([cli, sessionId]))}.session-bind`);

async function sameBinding(root, token, cli, sessionId) {
  const [tokenStat, sessionStat] = await Promise.all([
    fs.lstat(bindingFile(root, token)), fs.lstat(sessionBindingFile(root, cli, sessionId)),
  ]);
  return tokenStat.isFile() && sessionStat.isFile() && tokenStat.dev === sessionStat.dev &&
    tokenStat.ino === sessionStat.ino && tokenStat.uid === process.getuid() &&
    sessionStat.uid === process.getuid() && !(tokenStat.mode & 0o077);
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
  if (nativeRoot === projectRoot && main.kind !== 'verified') return blocked('stale_main_hooks');
  return main.kind === 'verified'
    ? { kind: 'verified', source: 'main', fingerprint: main.fingerprint }
    : { kind: 'verified', source: 'session', hooks: active.hooks };
}

export async function createLaunch(cwd, cli, { stateRoot } = {}) {
  if (!['claude', 'codex'].includes(cli) || (process.platform !== 'win32' && !process.getuid)) return blocked('native_windows_unproved');
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  const scope = await identifyProject(cwd);
  if (scope.kind !== 'git') return blocked('unsupported_git');
  const nativeRoot = scope.activeRoot;
  const trust = await readLocalTrust(current.stateDir);
  const expected = trustTuple(current);
  if (!trust || Object.entries(expected).some(([key, value]) => trust[key] !== value)) return blocked('trust_changed');
  let captureSource;
  if (process.platform === 'win32') {
    const verified = await verifyNativeCapture(nativeRoot, { cli, projectRoot: current.projectRoot, stateRoot });
    if (verified.kind !== 'verified') return blocked(verified.reason);
  } else if (cli === 'codex') {
    captureSource = await codexCaptureSource(nativeRoot, current.projectRoot, stateRoot);
    if (captureSource.kind !== 'verified') return blocked(captureSource.reason);
  }
  const token = randomBytes(32).toString('hex');
  const dir = launchDir(stateRoot);
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(dir)).ok) return blocked('unsafe_launch_state');
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return blocked('unsafe_launch_state');
  }
  const record = { cli, nativeRoot, projectRoot: current.projectRoot, projectId: current.projectId,
    destination: current.destination, embeddingFingerprint: current.embeddingFingerprint,
    createdAt: Date.now() };
  if (process.platform === 'win32') {
    if (!(await writeWindowsPrivateFile(launchFile(stateRoot, token), JSON.stringify(record) + '\n')).ok) {
      return blocked('unsafe_launch_state');
    }
  } else await fs.writeFile(launchFile(stateRoot, token), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  return { kind: 'created', token, record, ...(captureSource ? { captureSource } : {}) };
}

export async function bindLaunch(token, cli, cwd, nativeSessionId, { stateRoot } = {}) {
  if (process.platform === 'win32') return blocked('native_windows_unproved');
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !nativeSessionId || nativeSessionId.length > 256) return blocked('unbound');
  const saved = await safeRead(launchFile(stateRoot, token));
  if (!saved || saved.cli !== cli || Date.now() - saved.createdAt > 12 * 60 * 60 * 1000) return blocked('unbound');
  const scope = await identifyProject(cwd);
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (scope.kind !== 'git' || scope.activeRoot !== saved.nativeRoot || !same(current, saved)) return blocked('launch_changed');
  const file = bindingFile(stateRoot, token);
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
  if (process.platform === 'win32') return blocked('native_windows_unproved');
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return blocked('unbound');
  const saved = await safeRead(launchFile(stateRoot, token));
  const bound = await safeRead(bindingFile(stateRoot, token));
  if (!saved || !bound || saved.cli !== cli || Date.now() - saved.createdAt > 12 * 60 * 60 * 1000) return blocked('unbound');
  if (!await sameBinding(stateRoot, token, cli, bound.nativeSessionId).catch(() => false)) return blocked('unbound');
  const current = await resolveProject(saved.nativeRoot, bound.nativeSessionId, { stateRoot });
  const scope = await identifyProject(saved.nativeRoot);
  if (scope.kind !== 'git' || scope.activeRoot !== saved.nativeRoot || !same(current, saved)) return blocked('launch_changed');
  return { kind: 'bound', cwd: saved.nativeRoot, nativeSessionId: bound.nativeSessionId,
    projectId: saved.projectId, stateDir: current.stateDir, cli };
}

export async function launchCli(cwd, cli, args = [], options = {}) {
  if (process.platform === 'win32') return blocked('native_windows_unproved');
  const codexArgs = cli === 'codex' ? safeCodexArgs(args) : null;
  if (cli === 'codex' && !codexArgs) return blocked('unsafe_cli_args');
  const made = await createLaunch(cwd, cli, options);
  if (made.kind !== 'created') return made;
  const root = options.stateRoot ?? rootDefault();
  const mcpScript = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
  const brokerScript = fileURLToPath(new URL('./broker.mjs', import.meta.url));
  if (process.platform !== 'win32') {
    const endpoint = await brokerEndpointStatus(root);
    if (endpoint === 'unsafe') return blocked('unsafe_broker');
    if (endpoint === 'missing' || endpoint === 'orphan') {
      const broker = spawn(process.execPath, [brokerScript, root, cwd], { detached: true,
        stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME,
          ...(process.env.CBS_MEMORIA_CA_FILE ? { CBS_MEMORIA_CA_FILE: process.env.CBS_MEMORIA_CA_FILE } : {}) } });
      broker.unref();
    }
  }
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
  const child = spawn(cli, [...mcpArgs, ...hookArgs, ...(codexArgs ?? args)], { cwd, stdio: 'inherit',
    env: { ...process.env, CBS_MEMORIA_LAUNCH_ID: made.token, CBS_MEMORIA_CLI: cli,
      ...(options.stateRoot ? { CBS_MEMORIA_STATE_ROOT: options.stateRoot } : {}) } });
  return await new Promise(resolve => {
    child.once('error', () => resolve(blocked('cli_unavailable')));
    child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
  });
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
  const [cli, cwd, ...args] = process.argv.slice(2);
  if (!cli || !cwd) { process.stderr.write('Usage: node launch.mjs <claude|codex> <checkout> [cli args...]\n'); process.exitCode = 2; }
  else {
    const result = await launchCli(cwd, cli, args);
    if (result.kind !== 'exited') { process.stderr.write(`CBS Mem0: ${result.reason}\n`); process.exitCode = 1; }
    else process.exitCode = result.code ?? 1;
  }
}
