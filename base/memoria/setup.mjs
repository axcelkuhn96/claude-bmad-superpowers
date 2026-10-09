import { inspectConfiguration, resolveProject } from './provider.mjs';
import { authorizeDestination, readLocalTrust, trustTuple, writeLocalTrust } from './trust.mjs';
import { pinDestination, validateDestination } from './activation.mjs';
import { applyNativeExclusion, restoreNativeExclusion } from './native.mjs';
import { identifyProject } from './project-id.mjs';

const blocked = (reason) => ({ kind: 'blocked', reason });
const same = (a, b) => a?.provider === 'mem0' && b?.provider === 'mem0' &&
  a.projectRoot === b.projectRoot && a.projectId === b.projectId &&
  a.embeddingFingerprint === b.embeddingFingerprint &&
  JSON.stringify(a.destination) === JSON.stringify(b.destination);

export async function activateProject(cwd, deps = {}) {
  if (process.platform === 'win32') return blocked('windows_release_unproved');
  if (!process.getuid) return blocked('native_windows_unproved');
  const resolution = await inspectConfiguration(cwd, deps);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason);
  const current = async () => same(resolution, await inspectConfiguration(cwd, deps));
  const validated = await validateDestination(resolution, resolution.embeddingFingerprint, {
    ...deps, isCurrent: current,
  });
  if (validated.kind !== 'authorized') return validated;
  if (!await current()) return blocked('config_changed');
  const scope = await identifyProject(cwd);
  if (scope.kind !== 'git' || scope.projectRoot !== resolution.projectRoot) return blocked('unsupported_git');
  const nativeRoot = deps.cli === 'codex' ? scope.activeRoot : resolution.projectRoot;
  const nativeOptions = { ...deps, projectRoot: resolution.projectRoot };
  const applyNative = deps.applyNative ?? ((root) => applyNativeExclusion(root, nativeOptions));
  const native = await applyNative(nativeRoot);
  if (native && native.kind === 'blocked') return native;
  try {
    if (!await current()) {
      if (!deps.applyNative && !native?.existing) await restoreNativeExclusion(nativeRoot, nativeOptions);
      return blocked('config_changed');
    }
    await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  } catch (error) {
    if (!deps.applyNative && !native?.existing) await restoreNativeExclusion(nativeRoot, nativeOptions);
    return blocked('trust_write_failed');
  }
  return { kind: 'activated', projectId: resolution.projectId, stateDir: resolution.stateDir };
}

export async function authorizeCurrentDestination(cwd, sessionId, readSecret, options = {}) {
  const resolution = await resolveProject(cwd, sessionId, options);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason ?? 'not_mem0');
  const localTrust = await readLocalTrust(resolution.stateDir);
  const current = await inspectConfiguration(cwd, options);
  if (!same(resolution, current)) return blocked('session_changed');
  const expected = trustTuple(resolution);
  if (!localTrust || Object.entries(expected).some(([key, value]) => localTrust[key] !== value)) {
    return blocked('trust_changed');
  }
  const pin = await pinDestination(resolution.destination.url, options);
  if (pin.kind !== 'pinned') return pin;
  if (!same(resolution, await inspectConfiguration(cwd, options))) return blocked('session_changed');
  if (options.signal?.aborted || options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    return blocked('deadline');
  }
  const auth = authorizeDestination(resolution, await readLocalTrust(resolution.stateDir), readSecret);
  return auth.kind === 'authorized' ? { ...auth, connection: pin.connection } : auth;
}
