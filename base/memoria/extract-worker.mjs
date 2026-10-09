#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const blocked = reason => ({ kind: 'blocked', reason });
const script = fileURLToPath(import.meta.url);
const boundaryEvents = new Set(['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']);

export function scheduleExtraction({ cli, event, payload, result, stateRoot, spawnChild = spawn } = {}) {
  if (!boundaryEvents.has(event) || !['claude', 'codex'].includes(cli) ||
      result?.kind === 'blocked' || result?.kind === 'pass_through' || !result ||
      typeof payload?.cwd !== 'string' || typeof payload.session_id !== 'string') return false;
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'USERPROFILE',
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CBS_MEMORIA_LAUNCH_ID', 'CBS_MEMORIA_STATE_ROOT']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnChild(process.execPath, [script, cli, payload.cwd, payload.session_id,
    stateRoot ?? ''], { cwd: payload.cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
  return true;
}

export async function consumeCheckpoints({ cli, cwd, sessionId, stateRoot, runCli } = {}) {
  if (!['claude', 'codex'].includes(cli) || !cwd || !sessionId) {
    return blocked('invalid_consumer_identity');
  }
  const [{ identifyProject }, { resolveProject }, { verifyNativeCapture },
    { readSessionCheckout }, { readLocalTrust, trustTuple }, { createOutbox },
    { extractCheckpoint }, { withProjectLock }, { POLICY_VERSION }] = await Promise.all([
    import('./project-id.mjs'), import('./provider.mjs'), import('./native.mjs'),
    import('./session-checkout.mjs'), import('./trust.mjs'), import('./outbox.mjs'),
    import('./candidates.mjs'), import('./ledger.mjs'), import('./transcript.mjs'),
  ]);
  const scope = await identifyProject(cwd);
  const current = await resolveProject(cwd, sessionId, { stateRoot });
  if (scope.kind !== 'git' || current.provider !== 'mem0' || scope.projectRoot !== current.projectRoot) {
    return blocked('unbound');
  }
  const checkout = await readSessionCheckout(current.stateDir, cli, sessionId);
  if (checkout.kind !== 'bound' || checkout.nativeRoot !== scope.activeRoot ||
      checkout.projectRoot !== current.projectRoot || checkout.projectId !== current.projectId) {
    return blocked('session_checkout_changed');
  }
  if (process.platform === 'win32' && checkout.profile !== (cli === 'codex'
    ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR)) return blocked('session_checkout_changed');
  const native = await verifyNativeCapture(cli === 'codex' ? scope.activeRoot : current.projectRoot,
    { cli, stateRoot, projectRoot: current.projectRoot,
      ...(process.platform === 'win32' ? { profile: checkout.profile } : {}) });
  if (native.kind !== 'verified') return native;
  if (process.platform === 'win32') {
    const { resolveBoundLaunch } = await import('./launch.mjs');
    const bound = await resolveBoundLaunch(process.env.CBS_MEMORIA_LAUNCH_ID, cli, { stateRoot });
    if (bound.kind !== 'bound' || bound.nativeSessionId !== sessionId) return blocked('unbound');
  }
  const trust = await readLocalTrust(current.stateDir);
  if (!trust || Object.entries(trustTuple(current)).some(([key, value]) => trust[key] !== value)) {
    return blocked('trust_changed');
  }
  const box = createOutbox(current.stateDir);
  const ownerRoot = path.dirname(current.stateDir);
  try {
    return await withProjectLock(ownerRoot, async () => {
      const rows = (await box.pending()).filter(row => row.projectId === current.projectId &&
        row.policyVersion === POLICY_VERSION);
      let manifested = 0;
      let pending = 0;
      for (const row of rows) {
        const original = await readSessionCheckout(current.stateDir, row.cli, row.sessionId);
        if (original.kind !== 'bound' || original.projectId !== current.projectId ||
            original.projectRoot !== current.projectRoot) { pending++; continue; }
        const sourceScope = await identifyProject(original.nativeRoot);
        const fresh = await resolveProject(original.nativeRoot, row.sessionId, { stateRoot });
        if (sourceScope.kind !== 'git' || sourceScope.activeRoot !== original.nativeRoot ||
            sourceScope.projectRoot !== current.projectRoot || fresh.provider !== 'mem0' ||
            fresh.projectId !== current.projectId || fresh.stateDir !== current.stateDir) { pending++; continue; }
        const sourceNative = await verifyNativeCapture(row.cli === 'codex' ? original.nativeRoot : current.projectRoot,
          { cli: row.cli, stateRoot, projectRoot: current.projectRoot,
            ...(process.platform === 'win32' ? { profile: original.profile } : {}) });
        if (sourceNative.kind !== 'verified') { pending++; continue; }
        const sourceTrust = await readLocalTrust(fresh.stateDir);
        if (!sourceTrust || Object.entries(trustTuple(fresh)).some(([key, value]) => sourceTrust[key] !== value)) {
          pending++; continue;
        }
        const policy = fresh.extractor;
        if (!policy || policy.route !== 'sonnet' || !path.isAbsolute(policy.profile) ||
            !path.isAbsolute(policy.executable)) { pending++; continue; }
        let profile;
        try {
          profile = await fs.realpath(policy.profile);
          if (profile !== policy.profile || (await identifyProject(profile)).kind === 'git') throw new Error('profile');
          if (process.platform === 'win32') {
            const { inspectWindowsPath } = await import('./windows-security.mjs');
            if (!(await inspectWindowsPath(profile, 'directory')).ok) throw new Error('profile');
          } else {
            const stat = await fs.lstat(profile);
            if (!stat.isDirectory() || !process.getuid || stat.uid !== process.getuid() ||
                (stat.mode & 0o022)) throw new Error('profile');
          }
        } catch { pending++; continue; }
        let result;
        const previousCwd = process.cwd();
        try {
          // This dedicated extraction child is serialized by extract.lock; the broker cwd never changes.
          if (!runCli) process.chdir(original.nativeRoot);
          result = await extractCheckpoint(row, { ...policy,
            embeddingFingerprint: fresh.embeddingFingerprint, stateRoot }, { outbox: box, runCli });
        } finally { if (!runCli) process.chdir(previousCwd); }
        if (result.kind === 'manifested' || result.kind === 'processed') manifested++;
        else pending++;
      }
      return { kind: 'consumed', manifested, pending };
    }, 'extract.lock');
  } catch { return blocked('consumer_unavailable'); }
}

if (process.argv[1] === script) {
  const [cli, cwd, sessionId, rawStateRoot] = process.argv.slice(2);
  await consumeCheckpoints({ cli, cwd, sessionId, stateRoot: rawStateRoot || undefined });
}
