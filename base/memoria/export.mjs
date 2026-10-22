import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactSource } from './candidates.mjs';
import { inspectConfiguration } from './provider.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple, authorizeDestination } from './trust.mjs';
import { identifyProject } from './project-id.mjs';
import { pinDestination } from './activation.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { readOwner } from './policy.mjs';
import { runtimePython, runtimeEnvironment } from './runtime.mjs';
import { nativeProfile } from './native-profile.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = code => Object.assign(new Error(code), { code });
const privateMode = stat => stat.isDirectory() && !(stat.mode & 0o077) &&
  (process.getuid === undefined || stat.uid === process.getuid());
const pii = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\+\d{1,3}[ .()-]*\d{2}[ .()-]*\d{4,5}[ .()-]*\d{4}\b|\(\d{2}\)\s*\d{4,5}-\d{4}\b/gi;
const metadataFields = ['type', 'scope', 'owner_id', 'source', 'actor', 'origin',
  'speaker_role', 'evidence_at', 'condition', 'valid_from', 'valid_to',
  'supersedes_id', 'superseded_by', 'source_record_id', 'source_message_id',
  'source_text_sha256', 'claim_sha256', 'dedup_key', 'policy_version',
  'review_mode', 'auto_consent_hash', 'format_version'];
const refFields = ['message_id', 'source_text_sha256', 'role', 'origin'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  return value;
}
function projectMetadata(metadata) {
  const projected = { source_type: 'derived_export' };
  for (const key of metadataFields) {
    if (typeof metadata[key] === 'string' || key === 'format_version' &&
        Number.isSafeInteger(metadata[key])) projected[key] = metadata[key];
  }
  if (Array.isArray(metadata.source_refs)) projected.source_refs = metadata.source_refs.map(ref =>
    Object.fromEntries(refFields.filter(key => typeof ref?.[key] === 'string')
      .map(key => [key, ref[key]])));
  return projected;
}

function scrub(value) {
  if (typeof value === 'string') {
    const result = redactSource(value);
    return result === null ? '[REDACTED]' : result.replace(pii, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => redactSource(key) === key &&
      !new RegExp(pii.source, 'i').test(key)).map(([key, item]) => [key, scrub(item)]));
  return value;
}

async function checkPath(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('unsafe_output');
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create || current !== resolved) throw fail('unsafe_output');
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe_output');
  }
  if (!privateMode(await fs.lstat(resolved))) throw fail('unsafe_output');
  return resolved;
}

async function writeFile(directory, name, data) {
  const handle = await fs.open(path.join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDir(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
const yaml = value => JSON.stringify(value);
export function encodeRelativeLink(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..'))
    throw fail('invalid_link');
  return relative.split('/').map(encodeURIComponent).join('/');
}
const link = encodeRelativeLink;
function concept(row) {
  const metadata = row.metadata ?? {};
  const state = row.historyState;
  const status = state === 'active' ? 'stable' : 'deprecated';
  const type = typeof metadata.type === 'string' && metadata.type.trim() ? metadata.type : 'memory';
  const fields = { ...metadata, id: row.qdrantId, type, status,
    history_state: state, project_id: row.projectId };
  const head = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : yaml(key)}: ${yaml(value)}`).join('\n');
  const refs = ['supersedes_id', 'superseded_by'].filter(key => uuid(metadata[key]))
    .map(key => `- ${key}: [${metadata[key]}](${link(`${metadata[key]}.md`)})`).join('\n');
  return `---\n${head}\n---\n\n# ${type}\n\n${row.text}\n${refs ? `\n${refs}\n` : ''}`;
}
function normalize(row, projectId, ownerId) {
  if (!row || !uuid(row.qdrantId) || row.projectId !== projectId ||
      !['active', 'superseded'].includes(row.status) ||
      !['active', 'expired', 'superseded'].includes(row.historyState) ||
      row.status === 'superseded' && row.historyState !== 'superseded' ||
      typeof row.text !== 'string' || !row.text.trim() ||
      !['project', 'personal', 'episode'].includes(row.metadata?.scope) ||
      (!ownerId && row.metadata?.scope !== 'project') ||
      ['imported_legacy', 'derived_export'].includes(row.metadata?.source_type) ||
      !['source', 'actor', 'origin', 'speaker_role', 'evidence_at']
        .every(key => typeof row.metadata[key] === 'string' && row.metadata[key]) ||
      row.metadata?.scope === 'personal' && (!ownerId || row.metadata.owner_id !== ownerId)) return null;
  return canonical(scrub({ qdrantId: row.qdrantId, projectId: row.projectId,
    status: row.status, historyState: row.historyState, text: row.text,
    metadata: projectMetadata(row.metadata) }));
}
function hashFiles(files) {
  const hash = createHash('sha256');
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name); hash.update('\0'); hash.update(data); hash.update('\0');
  }
  return hash.digest('hex');
}

export async function exportSnapshot({ output, projectId, ownerId = null,
  collectionFingerprint, page, verifyCurrent, now = () => new Date().toISOString() }) {
  if (typeof projectId !== 'string' || !projectId || typeof collectionFingerprint !== 'string' ||
      !collectionFingerprint || typeof page !== 'function') throw fail('invalid_request');
  const root = await checkPath(output, true);
  const rows = new Map();
  const seen = new Set();
  let cursor = null;
  let scanned = 0;
  do {
    if (scanned === 10000) throw fail('limit_exceeded');
    const limit = Math.min(64, 10000 - scanned);
    let result;
    try { result = await page(cursor, limit); }
    catch { throw fail('read_failed'); }
    if (result?.kind !== 'page') throw fail(result?.reason ?? 'read_failed');
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw fail('page_oversized');
    if (!Array.isArray(result.items) || !Number.isInteger(result.scanned) ||
        result.scanned < result.items.length || result.scanned > limit) throw fail('invalid_page');
    const next = result.nextOffset;
    if (next !== null && (typeof next !== 'string' || !next || seen.has(next)))
      throw fail('cursor_repeated');
    if (next !== null && result.scanned === 0) throw fail('invalid_page');
    scanned += result.scanned;
    if (scanned > 10000) throw fail('limit_exceeded');
    for (const raw of result.items) {
      const row = normalize(raw, projectId, ownerId);
      if (row) {
        if (rows.has(row.qdrantId)) throw fail('duplicate_point');
        rows.set(row.qdrantId, row);
      }
    }
    cursor = next;
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  const ordered = [...rows.values()].sort((a, b) => a.qdrantId.localeCompare(b.qdrantId));
  const files = ordered.map(row => [`${row.qdrantId}.md`, concept(row)]);
  files.push(['index.md', `---\nokf_version: "0.2"\n---\n\n# Memórias derivadas\n\nSnapshot local derivado. O Qdrant permanece a fonte da curadoria; estes arquivos não são reimportados automaticamente.\n\n${ordered.map(row =>
    `- [${row.qdrantId}](${link(`${row.qdrantId}.md`)}) — ${row.historyState}`).join('\n')}\n`]);
  files.push(['history.json', JSON.stringify(ordered) + '\n']);
  const sha256 = hashFiles(files);
  const manifest = { version: '0.2', projectId, ownerId, collectionFingerprint,
    createdAt: now(), cursorComplete: true, count: ordered.length, sha256,
    exportScope: ownerId ? 'bound_owner' : 'project_only' };
  const versions = path.join(root, 'versions');
  try { await fs.mkdir(versions, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await checkPath(versions);
  const name = randomUUID();
  const staging = path.join(versions, `.staging-${name}`);
  const bundleDir = path.join(versions, name);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const [filename, data] of files) await writeFile(staging, filename, data);
    await writeFile(staging, 'manifest.json', JSON.stringify(manifest) + '\n');
    await syncDir(staging);
    await fs.rename(staging, bundleDir);
    await syncDir(versions);
    if (verifyCurrent && !await verifyCurrent()) throw fail('config_changed');
    const pointerTemp = `.current-${name}.json`;
    await writeFile(root, pointerTemp, JSON.stringify({ version: name, sha256 }) + '\n');
    const oldPointer = path.join(root, 'current.json');
    try {
      const stat = await fs.lstat(oldPointer);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('unsafe_output');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(path.join(root, pointerTemp), oldPointer);
    await syncDir(root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(path.join(root, `.current-${name}.json`), { force: true });
    throw error;
  }
  return { kind: 'exported', bundleDir, index: path.join(bundleDir, 'index.md'),
    count: ordered.length, sha256 };
}

export async function historySnapshot({ snapshot, id, projectId, ownerId = null, fetchCurrent }) {
  if (!uuid(id)) throw fail('invalid_id');
  let dir = await checkPath(snapshot);
  let pointerSha = null;
  if (!uuid(path.basename(dir))) {
    const pointerStat = await fs.lstat(path.join(dir, 'current.json'));
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || pointerStat.mode & 0o077)
      throw fail('invalid_snapshot');
    const pointer = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8'));
    if (!uuid(pointer.version)) throw fail('invalid_snapshot');
    pointerSha = pointer.sha256;
    dir = await checkPath(path.join(dir, 'versions', pointer.version));
  }
  const manifestStat = await fs.lstat(path.join(dir, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.mode & 0o077)
    throw fail('invalid_snapshot');
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (pointerSha !== null && pointerSha !== manifest.sha256 ||
      manifest.projectId !== projectId || manifest.ownerId !== ownerId ||
      manifest.cursorComplete !== true) throw fail('snapshot_identity');
  const rows = JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'));
  if (!Array.isArray(rows) || rows.length !== manifest.count) throw fail('snapshot_corrupt');
  const files = [];
  for (const name of (await fs.readdir(dir)).filter(name => name !== 'manifest.json')) {
    if (name !== 'index.md' && name !== 'history.json' &&
        !(name.endsWith('.md') && uuid(name.slice(0, -3))))
      throw fail('snapshot_corrupt');
    const stat = await fs.lstat(path.join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('snapshot_corrupt');
    files.push([name, await fs.readFile(path.join(dir, name), 'utf8')]);
  }
  if (hashFiles(files) !== manifest.sha256) throw fail('snapshot_corrupt');
  const byId = new Map(rows.map(row => [row.qdrantId, row]));
  const initial = byId.get(id.toLowerCase());
  if (!initial) throw fail('source_unavailable');
  const chain = [];
  const seen = new Set();
  let integrity = 'complete';
  let start = initial;
  while (uuid(start.metadata?.supersedes_id)) {
    const previous = byId.get(start.metadata.supersedes_id.toLowerCase());
    if (!previous) { integrity = 'missing_link'; break; }
    if (previous.qdrantId === start.qdrantId || seen.has(previous.qdrantId)) { integrity = 'cycle'; break; }
    if (previous.projectId !== projectId || previous.metadata?.scope === 'personal' &&
        previous.metadata.owner_id !== ownerId) { integrity = 'foreign_link'; break; }
    if (previous.metadata?.superseded_by !== start.qdrantId) {
      integrity = 'inconsistent_link'; break;
    }
    seen.add(start.qdrantId); start = previous;
  }
  let current = start;
  while (current) {
    if (chain.some(row => row.qdrantId === current.qdrantId)) { integrity = 'cycle'; break; }
    chain.push(current);
    const nextId = current.metadata?.superseded_by;
    if (!uuid(nextId)) break;
    const next = byId.get(nextId.toLowerCase());
    if (!next) { integrity = 'missing_link'; break; }
    if (chain.some(row => row.qdrantId === next.qdrantId)) { integrity = 'cycle'; break; }
    if (next.projectId !== projectId || next.metadata?.scope === 'personal' &&
        next.metadata.owner_id !== ownerId) { integrity = 'foreign_link'; break; }
    if (next.metadata?.supersedes_id !== current.qdrantId) {
      integrity = 'inconsistent_link'; break;
    }
    current = next;
  }
  let freshness = 'freshness_unverified';
  if (integrity === 'complete' && typeof fetchCurrent === 'function') {
    try {
      freshness = 'fresh';
      for (const row of chain) {
        const remote = await fetchCurrent(row.qdrantId);
        if (!remote || JSON.stringify(normalize(remote, projectId, ownerId)) !==
            JSON.stringify(row)) { freshness = 'stale'; break; }
      }
    } catch { freshness = 'freshness_unverified'; }
  }
  return { kind: 'history', chain: chain.map(row => ({ ...row,
    displayState: row.historyState === 'active' && freshness !== 'fresh'
      ? freshness === 'stale' ? 'active_in_stale_snapshot' : 'active_in_unverified_snapshot'
      : row.historyState })), integrity, freshness, bundleDir: dir };
}

async function runHistoryPython(request, secret, stateDir) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'mem0_adapter.py');
  const child = spawn(runtimePython(stateDir), [script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...runtimeEnvironment(stateDir), CBS_MEMORIA_STATE: stateDir,
      CBS_MEMORIA_API_KEY: secret } });
  return new Promise(resolve => {
    let output = '';
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ kind: 'blocked', reason: 'deadline' }); }, 120000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
        child.kill(); finish({ kind: 'blocked', reason: 'page_oversized' });
      }
    });
    child.once('error', () => finish({ kind: 'blocked', reason: 'worker_unavailable' }));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      if (code !== 0) return finish({ kind: 'blocked', reason: 'worker_failed' });
      try { finish(JSON.parse(output.trim())); }
      catch { finish({ kind: 'blocked', reason: 'worker_protocol' }); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

async function currentOwner(resolution, cli, profile, options) {
  const read = options.readOwner ?? readOwner;
  if (profile && (!cli || path.resolve(profile) !== path.resolve(nativeProfile(cli))))
    throw fail('owner_profile_mismatch');
  const codexActive = !!process.env.CODEX_THREAD_ID;
  const claudeActive = !!process.env.CLAUDECODE;
  const activeCli = codexActive !== claudeActive ? codexActive ? 'codex' : 'claude' : null;
  if (activeCli && cli && cli !== activeCli) throw fail('owner_profile_mismatch');
  const profiles = (activeCli ? [activeCli] : ['codex', 'claude']).map(nativeCli =>
    [nativeCli, nativeProfile(nativeCli)]);
  const owners = new Set();
  let boundProfiles = 0;
  for (const [nativeCli, nativeProfile] of profiles) {
    try { await fs.stat(nativeProfile); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const owner = await read(resolution, nativeCli, nativeProfile);
    if (owner?.kind === 'blocked') throw fail(owner.reason ?? 'owner_binding_changed');
    if (owner?.ownerId) { owners.add(owner.ownerId); boundProfiles += 1; }
  }
  if (owners.size > 1) return null;
  if (!activeCli && boundProfiles !== profiles.length) return null;
  return [...owners][0] ?? null;
}

async function localProject(cwd, options = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('invalid_project');
  cwd = path.resolve(cwd);
  const inspect = options.inspect ?? inspectConfiguration;
  const resolution = await inspect(cwd, options);
  if (resolution.provider !== 'mem0') throw fail(resolution.reason ?? 'not_mem0');
  const scope = await (options.identify ?? identifyProject)(cwd);
  if (scope.kind !== 'git' || scope.activeRoot !== cwd ||
      scope.projectRoot !== resolution.projectRoot) throw fail('unsupported_git');
  const expected = trustTuple(resolution);
  const trust = options.trust ?? readLocalTrust;
  if (!sameTrustTuple(expected, await trust(resolution.stateDir))) throw fail('trust_changed');
  const current = await inspect(cwd, options);
  if (current.provider !== 'mem0' || current.projectId !== resolution.projectId ||
      current.embeddingFingerprint !== resolution.embeddingFingerprint ||
      !sameTrustTuple(expected, trustTuple(current))) throw fail('config_changed');
  const ownerId = await currentOwner(current, options.cli, options.profile, options);
  return { current, ownerId,
    verifyCurrent: async () => {
      const live = await inspect(cwd, options);
      return live.provider === 'mem0' && live.projectId === current.projectId &&
        sameTrustTuple(expected, trustTuple(live)) &&
        sameTrustTuple(expected, await trust(live.stateDir)) &&
        await currentOwner(live, options.cli, options.profile, options) === ownerId;
    } };
}

async function remoteProject(local, options) {
  const destination = local.current.destination;
  const pin = await (options.pin ?? pinDestination)(destination.url, {
    address: destination.address, allowPublic: destination.allowPublic });
  if (pin.kind !== 'pinned') throw fail(pin.reason ?? 'destination_unavailable');
  if (!await local.verifyCurrent()) throw fail('config_changed');
  const auth = authorizeDestination(local.current,
    await (options.trust ?? readLocalTrust)(local.current.stateDir),
    options.readSecret ?? readQdrantSecret);
  if (auth.kind !== 'authorized') throw fail(auth.reason ?? 'unauthorized');
  const request = { projectId: local.current.projectId,
    collection: destination.collection, connection: pin.connection,
    ownerId: local.ownerId };
  const run = options.run ?? ((value, key) => runHistoryPython(value, key, local.current.stateDir));
  return { ...local, request, run: value => run(value, auth.key) };
}

export async function exportProject(cwd, output, options = {}) {
  const auth = await remoteProject(await localProject(cwd, options), options);
  const collectionFingerprint = digest(JSON.stringify([
    auth.current.destination.url, auth.current.destination.collection,
    auth.current.embeddingFingerprint]));
  return exportSnapshot({ output, projectId: auth.current.projectId, ownerId: auth.ownerId,
    collectionFingerprint, verifyCurrent: auth.verifyCurrent,
    page: (offset, limit) => auth.run({ ...auth.request, op: 'history_page', offset, limit }) });
}

export async function historyProject(cwd, snapshot, id, options = {}) {
  const local = await localProject(cwd, options);
  const stored = await historySnapshot({ snapshot, id, projectId: local.current.projectId,
    ownerId: local.ownerId });
  if (stored.integrity !== 'complete') return stored;
  let auth;
  try { auth = await remoteProject(local, options); }
  catch { return stored; }
  return historySnapshot({ snapshot, id, projectId: local.current.projectId,
    ownerId: local.ownerId, fetchCurrent: async memoryId => {
      const result = await auth.run({ ...auth.request, op: 'history_get', memoryId });
      if (result.kind === 'blocked' && result.reason === 'source_unavailable') return null;
      if (result.kind !== 'item') throw fail(result.reason ?? 'read_failed');
      return result.item;
    } });
}
