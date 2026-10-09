#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { identifyProject } from './project-id.mjs';
import { inspectConfiguration } from './provider.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { restoreNativeExclusion } from './native.mjs';
import { withProjectLock } from './ledger.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const hash = value => createHash('sha256').update(value).digest('hex');

async function quiescent(projectRoot, stateDir, stateRoot) {
  const launchDir = path.join(stateRoot, 'launches');
  const closedSessions = new Set();
  let files = [];
  try { files = await fs.readdir(launchDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = JSON.parse(await fs.readFile(path.join(launchDir, name), 'utf8'));
    if (record.projectRoot !== projectRoot) continue;
    const stem = name.slice(0, -5);
    const closed = await fs.readFile(path.join(launchDir, `${stem}.closed`), 'utf8')
      .then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!closed || closed.tokenDigest !== stem || closed.projectId !== record.projectId) {
      return blocked('active_or_ambiguous_session');
    }
    const bind = await fs.readFile(path.join(launchDir, `${stem}.bind`), 'utf8')
      .then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (closed.outcome === 'pre_spawn_aborted' && bind) return blocked('active_or_ambiguous_session');
    if (bind?.nativeSessionId) closedSessions.add(hash(bind.nativeSessionId));
  }
  const sessionsDir = path.join(stateDir, 'sessions');
  let sessions = [];
  try { sessions = await fs.readdir(sessionsDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of sessions) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) return blocked('ambiguous_session_state');
    const saved = JSON.parse(await fs.readFile(path.join(sessionsDir, name), 'utf8'));
    if (saved.projectRoot !== projectRoot || saved.adminSession === true) continue;
    if (!closedSessions.has(name.slice(0, -5))) return blocked('active_or_ambiguous_session');
  }
  return { kind: 'quiescent' };
}

export async function deactivateProject(cwd, options = {}) {
  const scope = await identifyProject(cwd);
  if (scope.kind !== 'git') return blocked('unsupported_git');
  const stateRoot = options.stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
  const stateDir = path.join(stateRoot, hash(scope.projectRoot));
  const marker = path.join(stateDir, 'deactivating.json');
  const configured = await inspectConfiguration(cwd, options);
  if (configured.provider === 'mem0') {
    const trust = await readLocalTrust(stateDir);
    if (!trust || Object.entries(trustTuple(configured)).some(([key, value]) => trust[key] !== value)) {
      return blocked('trust_changed');
    }
  } else if (!['not_mem0'].includes(configured.reason)) return blocked(configured.reason ?? 'config_changed');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  let createdMarker = false;
  try { await fs.writeFile(marker, JSON.stringify({ projectRoot: scope.projectRoot,
    stateDir }) + '\n', { flag: 'wx', mode: 0o600 }); createdMarker = true; }
  catch (error) {
    if (error.code !== 'EEXIST') return blocked('deactivation_state_unsafe');
    const saved = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (saved.projectRoot !== scope.projectRoot || saved.stateDir !== stateDir) return blocked('deactivation_state_unsafe');
  }
  // The marker blocks new writes; this lock drains a write already in flight.
  await withProjectLock(stateDir, async () => {});
  return (async () => {
    const quiet = await quiescent(scope.projectRoot, stateDir, stateRoot);
    if (quiet.kind !== 'quiescent') {
      if (createdMarker) await fs.rm(marker);
      return quiet;
    }
    const configFile = path.join(scope.projectRoot, '.cbs', 'memoria.json');
    let original;
    try { original = await fs.readFile(configFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') return blocked('selection_changed'); }
    if (original) {
      if (configured.provider !== 'mem0') return blocked('selection_changed');
      const current = await inspectConfiguration(cwd, options);
      if (current.provider !== 'mem0' || JSON.stringify(trustTuple(current)) !==
          JSON.stringify(trustTuple(configured))) return blocked('selection_changed');
    }
    const names = (await fs.readdir(stateDir)).filter(name => /^native-(?:claude|codex)(?:-[a-f0-9]{64})?\.json$/.test(name));
    for (const name of names) {
      const saved = JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8'));
      if (saved.projectRoot !== scope.projectRoot || !['claude', 'codex'].includes(saved.cli) ||
          typeof saved.nativeRoot !== 'string') return blocked('native_snapshot_changed');
      const restored = await restoreNativeExclusion(saved.nativeRoot,
        { ...options, cli: saved.cli, projectRoot: scope.projectRoot });
      if (restored.kind !== 'restored') return restored;
    }
    if (original) {
      const backup = path.join(stateDir, `deactivated-selection-${hash(original)}.json`);
      try { await fs.writeFile(backup, original, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(backup, 'utf8') !== original) return blocked('selection_backup_failed'); }
      if (await fs.readFile(configFile, 'utf8') !== original) return blocked('selection_changed');
      await fs.rm(configFile);
    }
    const trustFile = path.join(stateDir, 'trust.json');
    const localTrust = await readLocalTrust(stateDir);
    if (localTrust) {
      if (configured.provider === 'mem0' && JSON.stringify(localTrust) !==
          JSON.stringify(trustTuple(configured))) return blocked('trust_changed');
      await fs.rm(trustFile);
    }
    await fs.rm(marker);
    return { kind: 'deactivated', stateDir };
  })();
}

export async function main(args = process.argv.slice(2)) {
  const at = args.indexOf('--project');
  const cwd = at >= 0 ? args[at + 1] : null;
  if (!cwd || cwd.startsWith('--')) {
    process.stderr.write('Uso: cbs memoria deactivate --project /caminho/git\n');
    return 2;
  }
  const result = await deactivateProject(cwd);
  process.stdout.write(`${result.kind}: ${result.reason ?? result.stateDir}\n`);
  return result.kind === 'deactivated' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
