import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { identifyProject } from './project-id.mjs';
import { RUNTIME_PINS } from './runtime.mjs';
import { ensureWindowsPrivateDirectory, readWindowsPrivateFile,
  writeWindowsPrivateFile, readWindowsBinary } from './windows-security.mjs';
import { readOwner, readExtractor } from './policy.mjs';

const blocked = (reason) => ({ provider: 'blocked', reason });
const stateRootDefault = () => path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const idValid = (x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
function destinationUrlValid(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const tls = value.startsWith('https://') && url.protocol === 'https:';
  const loopback = /^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(value) &&
    url.protocol === 'http:' && url.hostname === '127.0.0.1';
  return (tls || loopback) && !!url.hostname && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
}

async function configFor(scope) {
  async function read(root) {
    try {
      const file = path.join(root, '.cbs', 'memoria.json');
      if (process.platform === 'win32') {
        try { await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        const observed = await readWindowsBinary(file, { length: 1024 * 1024, privateState: false });
        if (observed.size !== observed.bytes.length) throw new Error('oversize_config');
        return observed.bytes.toString('utf8');
      }
      return await fs.readFile(file, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  let data;
  let active;
  try {
    data = await read(scope.projectRoot);
    if (scope.activeRoot !== scope.projectRoot) active = await read(scope.activeRoot);
  } catch { return blocked('invalid_config'); }
  const main = parseConfig(data);
  if (main?.provider === 'blocked') return main;
  if (scope.activeRoot === scope.projectRoot) return main;
  const local = parseConfig(active);
  if (local?.provider === 'blocked') return local;
  if (main?.provider === 'mem0' && !local) return blocked('worktree_config_changed');
  if (main?.provider === 'claude-mem' && !local) return { provider: 'claude-mem' };
  if (JSON.stringify(main) !== JSON.stringify(local)) return blocked('worktree_config_changed');
  return local;
}

function parseConfig(data) {
  if (data === null) return null;
  let c;
  try { c = JSON.parse(data); } catch { return blocked('invalid_config'); }
  if (!isObject(c) || !['mem0', 'claude-mem'].includes(c.provider)) return blocked('invalid_config');
  if (c.provider === 'claude-mem') return { provider: 'claude-mem' };
  if (!idValid(c.project_id) || !isObject(c.qdrant) || !isObject(c.embedding) ||
      !destinationUrlValid(c.qdrant.url) ||
      !idValid(c.qdrant.collection) || typeof c.qdrant.api_key_env !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(c.qdrant.api_key_env) ||
      c.embedding.model !== 'multilingual-e5-small' || c.embedding.dimension !== 384 ||
      c.embedding.fingerprint !== `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}`) {
    return blocked('invalid_config');
  }
  return { provider: 'mem0', project_id: c.project_id,
    qdrant: { url: c.qdrant.url, collection: c.qdrant.collection, api_key_env: c.qdrant.api_key_env },
    embedding: { model: c.embedding.model, dimension: c.embedding.dimension,
      fingerprint: c.embedding.fingerprint } };
}

function stateDirFor(scope, options) {
  return path.join(options.stateRoot ?? stateRootDefault(), hash(scope.projectRoot));
}
function sessionFile(stateDir, sessionId) {
  return path.join(stateDir, 'sessions', `${hash(sessionId)}.json`);
}
async function readSession(file) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file);
    if (result.code === 'missing') return null;
    if (!result.ok) return blocked('invalid_session');
    try { return JSON.parse(result.text); } catch { return blocked('invalid_session'); }
  }
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
    ? Object.freeze({ ...found.current, ownerId: found.saved.ownerId ?? null,
      extractor: found.saved.extractor ?? null }) : blocked('session_changed');
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
  if (found.saved) return sameSession(found.saved, expected)
    ? Object.freeze({ ...found.current, ownerId: found.saved.ownerId ?? null,
      extractor: found.saved.extractor ?? null }) : blocked('session_changed');
  const owner = await readOwner(found.current, options.cli, options.profile);
  const extractor = await readExtractor(found.current);
  if (owner?.kind === 'blocked' || extractor?.kind === 'blocked') return blocked('local_policy_changed');
  expected.ownerId = owner?.ownerId ?? null;
  expected.extractor = extractor ?? null;
  if (options.adminSession === true) expected.adminSession = true;
  const file = sessionFile(found.stateDir, sessionId);
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(path.dirname(file))).ok) return blocked('unsafe_session_state');
    const written = await writeWindowsPrivateFile(file, JSON.stringify(expected) + '\n');
    if (written.ok) return Object.freeze({ ...found.current, ownerId: expected.ownerId, extractor: expected.extractor });
    if (written.code !== 'exists') return blocked('unsafe_session_state');
    const raced = await readSession(file);
    return sameSession(raced, expected) ? Object.freeze({ ...found.current,
      ownerId: raced.ownerId ?? null, extractor: raced.extractor ?? null }) : blocked('session_changed');
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(file, JSON.stringify(expected) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const raced = await readSession(file);
    return sameSession(raced, expected) ? Object.freeze({ ...found.current,
      ownerId: raced.ownerId ?? null, extractor: raced.extractor ?? null }) : blocked('session_changed');
  }
  return Object.freeze({ ...found.current, ownerId: expected.ownerId, extractor: expected.extractor });
}
