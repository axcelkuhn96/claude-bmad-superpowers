import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { identifyProject } from './project-id.mjs';
import { RUNTIME_PINS } from './runtime.mjs';

const blocked = (reason) => ({ provider: 'blocked', reason });
const stateRootDefault = () => path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const idValid = (x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);

async function configFor(scope) {
  const file = path.join(scope.projectRoot, '.cbs', 'memoria.json');
  let data;
  try { data = await fs.readFile(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') return blocked('invalid_config');
    if (scope.activeRoot !== scope.projectRoot) {
      try { await fs.access(path.join(scope.activeRoot, '.cbs', 'memoria.json')); return blocked('worktree_config_changed'); }
      catch (e) { if (e.code !== 'ENOENT') return blocked('invalid_config'); }
    }
    return null;
  }
  if (scope.activeRoot !== scope.projectRoot) {
    try {
      const active = await fs.readFile(path.join(scope.activeRoot, '.cbs', 'memoria.json'), 'utf8');
      if (active !== data) return blocked('worktree_config_changed');
    } catch (error) { if (error.code !== 'ENOENT') return blocked('invalid_config'); }
  }
  let c;
  try { c = JSON.parse(data); } catch { return blocked('invalid_config'); }
  if (!isObject(c) || !['mem0', 'claude-mem'].includes(c.provider)) return blocked('invalid_config');
  if (c.provider === 'claude-mem') return { provider: 'claude-mem' };
  if (!idValid(c.project_id) || !isObject(c.qdrant) || !isObject(c.embedding) ||
      typeof c.qdrant.url !== 'string' || !/^https:\/\//.test(c.qdrant.url) ||
      !idValid(c.qdrant.collection) || typeof c.qdrant.api_key_env !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(c.qdrant.api_key_env) ||
      c.embedding.model !== 'multilingual-e5-small' || c.embedding.dimension !== 384 ||
      c.embedding.fingerprint !== `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}`) {
    return blocked('invalid_config');
  }
  return c;
}

function stateDirFor(scope, options) {
  return path.join(options.stateRoot ?? stateRootDefault(), hash(scope.projectRoot));
}
function sessionFile(stateDir, sessionId) {
  return path.join(stateDir, 'sessions', `${hash(sessionId)}.json`);
}
async function readSession(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : blocked('invalid_session'); }
}
function resolution(scope, config, stateDir) {
  return Object.freeze({ provider: 'mem0', projectRoot: scope.projectRoot,
    projectId: config.project_id,
    destination: Object.freeze({ url: config.qdrant.url, collection: config.qdrant.collection,
      apiKeyEnv: config.qdrant.api_key_env }), stateDir,
    embeddingFingerprint: config.embedding.fingerprint });
}
function sameSession(saved, current) {
  return saved?.provider === 'mem0' && saved.projectRoot === current.projectRoot &&
    saved.projectId === current.projectId &&
    JSON.stringify(saved.destination) === JSON.stringify(current.destination) &&
    saved.embeddingFingerprint === current.embeddingFingerprint;
}
async function inspect(cwd, sessionId, options) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return blocked('invalid_session');
  const scope = await identifyProject(cwd);
  if (scope.kind === 'invalid_cwd') return blocked('invalid_cwd');
  if (scope.kind === 'unsupported_git') return blocked('unsupported_git');
  if (scope.kind === 'non_git') {
    for (let dir = scope.cwd; ; dir = path.dirname(dir)) {
      try { await fs.access(path.join(dir, '.cbs', 'memoria.json')); return blocked('unsupported_git'); }
      catch (error) { if (error.code !== 'ENOENT') return blocked('invalid_config'); }
      if (dir === path.dirname(dir)) break;
    }
    return { provider: 'claude-mem' };
  }
  const config = await configFor(scope);
  if (config?.provider === 'blocked') return config;
  const stateDir = stateDirFor(scope, options);
  const saved = await readSession(sessionFile(stateDir, sessionId));
  if (saved?.provider === 'blocked') return saved;
  if (!config || config.provider === 'claude-mem') return saved ? blocked('session_changed') : { provider: 'claude-mem' };
  const current = resolution(scope, config, stateDir);
  return { scope, config, stateDir, saved, current,
    embeddingFingerprint: config.embedding.fingerprint };
}

export async function resolveProject(cwd, sessionId, options = {}) {
  const found = await inspect(cwd, sessionId, options);
  if (!found.current) return found;
  if (!found.saved) return blocked('fresh_session');
  return sameSession(found.saved, { ...found.current, embeddingFingerprint: found.embeddingFingerprint })
    ? found.current : blocked('session_changed');
}

export async function inspectConfiguration(cwd, options = {}) {
  const scope = await identifyProject(cwd);
  if (scope.kind !== 'git') return blocked('unsupported_git');
  const config = await configFor(scope);
  if (config?.provider === 'blocked') return config;
  if (!config || config.provider !== 'mem0') return blocked('not_mem0');
  return resolution(scope, config, stateDirFor(scope, options));
}

export async function initializeSession(cwd, sessionId, options = {}) {
  if (options.event !== 'SessionStart') return resolveProject(cwd, sessionId, options);
  const found = await inspect(cwd, sessionId, options);
  if (!found.current) return found;
  const expected = { ...found.current, embeddingFingerprint: found.embeddingFingerprint };
  if (found.saved) return sameSession(found.saved, expected) ? found.current : blocked('session_changed');
  const file = sessionFile(found.stateDir, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(file, JSON.stringify(expected) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const raced = await readSession(file);
    return sameSession(raced, expected) ? found.current : blocked('session_changed');
  }
  return found.current;
}
