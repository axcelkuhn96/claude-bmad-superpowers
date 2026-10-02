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
import { brokerPath } from './broker.mjs';

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

export async function createLaunch(cwd, cli, { stateRoot } = {}) {
  if (!['claude', 'codex'].includes(cli) || process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  const scope = await identifyProject(cwd);
  const nativeRoot = scope.activeRoot;
  const trust = await readLocalTrust(current.stateDir);
  const expected = trustTuple(current);
  if (!trust || Object.entries(expected).some(([key, value]) => trust[key] !== value)) return blocked('trust_changed');
  const token = randomBytes(32).toString('hex');
  const dir = launchDir(stateRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return blocked('unsafe_launch_state');
  const record = { cli, nativeRoot, projectRoot: current.projectRoot, projectId: current.projectId,
    destination: current.destination, embeddingFingerprint: current.embeddingFingerprint,
    createdAt: Date.now() };
  await fs.writeFile(launchFile(stateRoot, token), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  return { kind: 'created', token, record };
}

export async function bindLaunch(token, cli, cwd, nativeSessionId, { stateRoot } = {}) {
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
  const made = await createLaunch(cwd, cli, options);
  if (made.kind !== 'created') return made;
  const root = options.stateRoot ?? rootDefault();
  const mcpScript = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
  const brokerScript = fileURLToPath(new URL('./broker.mjs', import.meta.url));
  if (process.platform !== 'win32') {
    try { await fs.access(brokerPath(root)); }
    catch {
      const broker = spawn(process.execPath, [brokerScript, root, cwd], { detached: true,
        stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME,
          ...(process.env.CBS_MEMORIA_CA_FILE ? { CBS_MEMORIA_CA_FILE: process.env.CBS_MEMORIA_CA_FILE } : {}) } });
      broker.unref();
    }
  }
  const mcp = { mcpServers: { cbs_memoria: { command: process.execPath, args: [mcpScript] } } };
  const mcpArgs = cli === 'claude' ? ['--mcp-config', JSON.stringify(mcp)] :
    ['-c', `mcp_servers.cbs_memoria.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.cbs_memoria.args=${JSON.stringify([mcpScript])}`];
  const child = spawn(cli, [...mcpArgs, ...args], { cwd, stdio: 'inherit',
    env: { ...process.env, CBS_MEMORIA_LAUNCH_ID: made.token, CBS_MEMORIA_CLI: cli,
      ...(options.stateRoot ? { CBS_MEMORIA_STATE_ROOT: options.stateRoot } : {}) } });
  return await new Promise(resolve => {
    child.once('error', () => resolve(blocked('cli_unavailable')));
    child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
  });
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
