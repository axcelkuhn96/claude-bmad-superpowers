import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const sha = text => createHash('sha256').update(text).digest('hex');
const blocked = reason => ({ kind: 'abstain', reason });
const rootFor = stateDir => path.join(stateDir, 'handoff-auto');
const scopeFor = identity => sha(JSON.stringify([identity.projectId, identity.ownerId,
  identity.nativeRoot, identity.projectRoot, identity.commonGitDir, identity.worktreeGitDir,
  identity.branch, identity.checkoutFingerprint]));
const nameFor = identity => `${scopeFor(identity)}-${sha(JSON.stringify([identity.cli, identity.sourceSessionId]))}`;
const metadataFile = (dir, identity) => path.join(dir, `${nameFor(identity)}.json`);
const markdownFile = (dir, identity, contentHash) => path.join(dir,
  `${scopeFor(identity)}-${contentHash}.md`);
const receiptDir = dir => path.join(dir, 'receipts');
const receiptFile = (dir, key) => path.join(receiptDir(dir), `${key}.json`);
const TTL = 7 * 24 * 60 * 60 * 1000;
const IDLE = 5 * 60 * 1000;
const terminal = new Set(['SessionEnd', 'Interrupt']);
const active = new Set(['SessionStart', 'UserPromptSubmit']);
const events = new Set([...terminal, ...active, 'Stop', 'PreCompact']);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const validIdentity = value => value &&
  ['projectId', 'ownerId', 'nativeRoot', 'projectRoot', 'cli', 'sourceSessionId',
    'commonGitDir', 'worktreeGitDir', 'checkoutFingerprint']
    .every(key => nonempty(value[key])) && ['claude', 'codex'].includes(value.cli) &&
    [value.nativeRoot, value.projectRoot, value.commonGitDir, value.worktreeGitDir]
      .every(item => path.isAbsolute(item)) &&
    (value.branch === null || nonempty(value.branch)) && oid(value.sourceHEAD);
const sameCheckout = (a, b) => ['projectId', 'ownerId', 'nativeRoot', 'projectRoot',
  'commonGitDir', 'worktreeGitDir', 'branch', 'checkoutFingerprint']
  .every(key => a[key] === b[key]);

async function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await runFile('git', ['-C', cwd, ...args],
    { env, timeout: 100, maxBuffer: 8192 });
  return stdout.trim();
}

// Call only after the existing session checkout/native binding was verified.
// This captures checkout identity at session start, not from a hook request.
export async function captureHandoffIdentity({ projectId, ownerId, nativeRoot, projectRoot,
  cli, sourceSessionId } = {}) {
  if (![projectId, ownerId, nativeRoot, projectRoot, sourceSessionId].every(nonempty) ||
      !['claude', 'codex'].includes(cli)) throw new Error('invalid_handoff_identity');
  const native = await fs.realpath(nativeRoot);
  const project = await fs.realpath(projectRoot);
  const toplevel = await fs.realpath(await git(native, 'rev-parse', '--show-toplevel'));
  if (native !== toplevel || project !== await fs.realpath(
    (await git(native, 'worktree', 'list', '--porcelain')).split('\n')
      .find(line => line.startsWith('worktree '))?.slice(9) ?? '')) {
    throw new Error('invalid_handoff_checkout');
  }
  const commonGitDir = await fs.realpath(await git(native, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const worktreeGitDir = await fs.realpath(await git(native, 'rev-parse', '--absolute-git-dir'));
  const branchName = await git(native, 'symbolic-ref', '--quiet', 'HEAD').catch(() => '');
  const branch = branchName || null;
  const sourceHEAD = await git(native, 'rev-parse', 'HEAD');
  if (!oid(sourceHEAD)) throw new Error('invalid_handoff_head');
  const checkoutFingerprint = sha(JSON.stringify([native, project, commonGitDir, worktreeGitDir, branch]));
  return { projectId, ownerId, nativeRoot: native, projectRoot: project, cli,
    sourceSessionId, commonGitDir, worktreeGitDir, branch, sourceHEAD,
    checkoutFingerprint };
}

async function currentCheckout(identity) {
  if (!validIdentity(identity)) return false;
  try {
    const current = await captureHandoffIdentity(identity);
    if (!sameCheckout(identity, current)) return false;
    if (identity.branch === null) return identity.sourceHEAD === current.sourceHEAD;
    await git(identity.nativeRoot, 'merge-base', '--is-ancestor', identity.sourceHEAD, current.sourceHEAD);
    return true;
  } catch { return false; }
}

async function privateDir(dir, create = false) {
  if (process.platform === 'win32' || !process.getuid || !path.isAbsolute(dir)) throw new Error('unsafe_handoff_dir');
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) {
    throw new Error('unsafe_handoff_dir');
  }
}
async function privateRoot(stateDir, create = false) {
  await privateDir(stateDir, create);
  const dir = rootFor(stateDir);
  await privateDir(dir, create);
  return dir;
}
async function privateRead(file, limit = 1024 * 1024) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) ||
      before.size > limit) throw new Error('unsafe_handoff_file');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) throw new Error('unsafe_handoff_file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function atomicWrite(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(tmp, { force: true }); throw error; }
  await handle.close();
  try { await fs.rename(tmp, file); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readRow(dir, identity) {
  try {
    const row = JSON.parse(await privateRead(metadataFile(dir, identity), 64 * 1024));
    if (row.version !== 2 || !validIdentity(row.identity) ||
        nameFor(row.identity) !== nameFor(identity) ||
        !events.has(row.event) || !Number.isFinite(Date.parse(row.at)) ||
        row.handoff && (!/^[a-f0-9]{64}$/.test(row.handoff.sourceHash ?? '') ||
          !/^[a-f0-9]{64}$/.test(row.handoff.contentHash ?? ''))) return null;
    if (row.handoff) {
      const content = await privateRead(markdownFile(dir, identity, row.handoff.contentHash));
      if (sha(content) !== row.handoff.contentHash) return null;
      row.file = markdownFile(dir, identity, row.handoff.contentHash);
    }
    return row;
  } catch { return null; }
}

async function cleanupExpired(dir, identity, now, hasTime = () => true) {
  const scope = scopeFor(identity);
  const limit = 384;
  const names = (await fs.readdir(dir)).sort();
  if (!hasTime()) return;
  const metadata = names.filter(name => name.startsWith(`${scope}-`) &&
    /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name));
  const cursor = path.join(dir, `.${scope}.gc-metadata-cursor`);
  let after = '';
  try {
    after = (await privateRead(cursor, 128)).trim();
    if (after && !metadata.includes(after)) after = '';
  } catch (error) { if (error.code !== 'ENOENT') return; }
  if (!hasTime()) return;
  const first = metadata.findIndex(name => name > after);
  const ordered = first < 0 ? metadata : [...metadata.slice(first), ...metadata.slice(0, first)];
  const referenced = new Set();
  let examined = 0;
  let last = after;
  for (const name of ordered) {
    if (examined >= limit || !hasTime()) break;
    examined++;
    let row;
    try {
      const raw = JSON.parse(await privateRead(path.join(dir, name), 64 * 1024));
      const source = raw?.identity;
      if (!validIdentity(source) || name !== `${nameFor(source)}.json` ||
          scopeFor(source) !== scope) return;
      row = await readRow(dir, source);
    } catch { return; }
    if (!row || !hasTime()) return;
    if (row.identity.sourceSessionId !== identity.sourceSessionId &&
        now - Date.parse(row.at) > TTL) {
      try { await fs.unlink(path.join(dir, name)); }
      catch { /* A concurrent change is left for a later write. */ }
    } else if (row.handoff) referenced.add(row.handoff.contentHash);
    last = name;
  }
  if (!hasTime()) return;
  if (metadata.length > limit && last !== after) {
    await atomicWrite(cursor, `${last}\n`);
    return;
  }
  // A Markdown link remains valid while any metadata row refers to it.
  const markdowns = names.filter(name => name.startsWith(`${scope}-`) &&
    /^[a-f0-9]{64}-[a-f0-9]{64}\.md$/.test(name));
  const markdownCursor = path.join(dir, `.${scope}.gc-markdown-cursor`);
  let lastMarkdown = '';
  try {
    lastMarkdown = (await privateRead(markdownCursor, 128)).trim();
    if (lastMarkdown && !markdowns.includes(lastMarkdown)) lastMarkdown = '';
  } catch (error) { if (error.code !== 'ENOENT') return; }
  if (!hasTime()) return;
  const markdownFirst = markdowns.findIndex(name => name > lastMarkdown);
  const orderedMarkdowns = markdownFirst < 0 ? markdowns :
    [...markdowns.slice(markdownFirst), ...markdowns.slice(0, markdownFirst)];
  let checked = 0;
  for (const name of orderedMarkdowns) {
    if (checked++ >= limit || !hasTime()) break;
    const file = path.join(dir, name);
    let stat;
    try { stat = await fs.lstat(file); } catch { continue; }
    if (!hasTime()) break;
    lastMarkdown = name;
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
        Date.now() - stat.mtimeMs <= TTL || referenced.has(name.slice(65, -3))) continue;
    try { await fs.unlink(file); }
    catch { /* A concurrent change is left for a later write. */ }
  }
  if (hasTime() && markdowns.length > limit && lastMarkdown) {
    await atomicWrite(markdownCursor, `${lastMarkdown}\n`);
  }
}

// Activity is recorded even without safe text, so concurrent work blocks an
// older handoff. The `handoff` value must come from authenticated capture.
export async function saveHandoff(stateDir, { identity, handoff, event,
  at = new Date().toISOString(), hasTime = () => true } = {}) {
  if (!validIdentity(identity) || !events.has(event) || !Number.isFinite(Date.parse(at))) {
    return blocked('stale_identity');
  }
  if (!hasTime()) return blocked('deadline');
  if (!(await currentCheckout(identity))) return blocked('stale_identity');
  if (!hasTime()) return blocked('deadline');
  let dir;
  try { dir = await privateRoot(stateDir, true); }
  catch { return blocked('unsafe_state'); }
  if (!hasTime()) return blocked('deadline');
  const prior = await readRow(dir, identity);
  if (!hasTime()) return blocked('deadline');
  if (!prior) {
    for (const file of [metadataFile(dir, identity)]) {
      const exists = await fs.lstat(file).then(() => true, error =>
        error.code === 'ENOENT' ? false : Promise.reject(error)).catch(() => true);
      if (exists) return blocked('unsafe_existing_state');
      if (!hasTime()) return blocked('deadline');
    }
  }
  if (prior && !sameCheckout(prior.identity, identity)) return blocked('identity_changed');
  if (prior && Date.parse(at) < Date.parse(prior.at)) return blocked('out_of_order');
  if (prior && terminal.has(prior.event) && !active.has(event)) return { kind: 'saved', file: prior.file ?? null };
  if (handoff && (typeof handoff.markdown !== 'string' || !handoff.markdown.trim() ||
      typeof handoff.summary !== 'string' || !/^[a-f0-9]{64}$/.test(handoff.sourceHash ?? '') ||
      Buffer.byteLength(handoff.markdown) > 64 * 1024 || Buffer.byteLength(handoff.summary) > 300)) {
    return blocked('invalid_handoff');
  }
  const reuse = handoff && prior?.handoff?.sourceHash === handoff.sourceHash;
  const row = { version: 2, identity, event, at,
    handoff: reuse ? prior.handoff : handoff ? { summary: handoff.summary,
      sourceHash: handoff.sourceHash, contentHash: sha(handoff.markdown) } :
      active.has(event) ? null : prior?.handoff ?? null };
  try {
    if (handoff && !reuse) {
      const file = markdownFile(dir, identity, row.handoff.contentHash);
      try {
        if (sha(await privateRead(file)) !== row.handoff.contentHash) return blocked('unsafe_existing_state');
      } catch (error) {
        if (error.code !== 'ENOENT') return blocked('unsafe_existing_state');
        if (!hasTime()) return blocked('deadline');
        await atomicWrite(file, handoff.markdown);
        if (!hasTime()) return blocked('deadline');
      }
    }
    if (!hasTime()) return blocked('deadline');
    await atomicWrite(metadataFile(dir, identity), JSON.stringify(row) + '\n');
    if (hasTime()) await cleanupExpired(dir, identity, Date.parse(at), hasTime).catch(() => {});
    return { kind: 'saved', file: row.handoff ? markdownFile(dir, identity, row.handoff.contentHash) : null };
  } catch { return blocked('write_failed'); }
}

export async function loadHandoff(stateDir, identity) {
  if (!validIdentity(identity) || !Number.isFinite(Date.parse(identity.now ?? '')) ||
      !(await currentCheckout(identity))) return blocked('unknown_identity');
  let dir;
  try { dir = await privateRoot(stateDir); }
  catch { return blocked('unsafe_state'); }
  const names = [];
  try {
    const listing = await fs.opendir(dir);
    for await (const entry of listing) {
      if (!entry.name.startsWith(`${scopeFor(identity)}-`) ||
          !/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > 128) return blocked('state_saturated');
    }
  } catch { return blocked('unsafe_state'); }
  const now = Date.parse(identity.now);
  const eligible = [];
  for (const name of names) {
    const lookup = { cli: identity.cli, sourceSessionId: '' };
    let row;
    try {
      const raw = JSON.parse(await privateRead(path.join(dir, name), 64 * 1024));
      Object.assign(lookup, raw?.identity);
      if (name !== `${nameFor(lookup)}.json`) return blocked('corrupt_state');
      row = await readRow(dir, lookup);
    } catch { return blocked('corrupt_state'); }
    if (!row) return blocked('corrupt_state');
    if (row.identity.sourceSessionId === identity.sourceSessionId ||
        row.identity.cli !== identity.cli || !sameCheckout(row.identity, identity)) continue;
    const age = now - Date.parse(row.at);
    if (age < 0 || age > TTL) continue;
    if (!terminal.has(row.event) && age < IDLE) return blocked('active_competitor');
    eligible.push({ ...row, age });
  }
  if (!eligible.length) return blocked('no_eligible_source');
  eligible.sort((a, b) => a.age - b.age);
  if (eligible.length > 1 && eligible[0].age === eligible[1].age) return blocked('tie');
  const chosen = eligible[0];
  if (!chosen.handoff) return blocked('no_safe_handoff');
  try {
    const head = await git(identity.nativeRoot, 'rev-parse', 'HEAD');
    if (chosen.identity.branch === null) {
      if (chosen.identity.sourceHEAD !== head) return blocked('stale_source');
    } else {
      await git(identity.nativeRoot, 'merge-base', '--is-ancestor', chosen.identity.sourceHEAD, head);
    }
  } catch { return blocked('stale_source'); }
  return { kind: 'selected', sourceSessionId: chosen.identity.sourceSessionId,
    sourceHash: chosen.handoff.sourceHash, summary: chosen.handoff.summary,
    file: chosen.file, idlePartial: !terminal.has(chosen.event), at: chosen.at,
    checkoutFingerprint: chosen.identity.checkoutFingerprint };
}

function receiptData(target, chosen) {
  const key = sha(JSON.stringify([target.projectId, target.ownerId, target.nativeRoot,
    chosen.checkoutFingerprint, chosen.sourceSessionId, chosen.sourceHash,
    target.sourceSessionId]));
  return { key, projectId: target.projectId, ownerId: target.ownerId,
    nativeRoot: target.nativeRoot, checkoutFingerprint: chosen.checkoutFingerprint,
    sourceSessionId: chosen.sourceSessionId, sourceHash: chosen.sourceHash,
    targetSessionId: target.sourceSessionId };
}
export async function prepareHandoff(stateDir, identity) {
  const chosen = await loadHandoff(stateDir, identity);
  if (chosen.kind !== 'selected') return chosen;
  const receipt = receiptData(identity, chosen);
  try {
    const dir = await privateRoot(stateDir);
    await privateDir(receiptDir(dir));
    const saved = JSON.parse(await privateRead(receiptFile(dir, receipt.key), 8192));
    return JSON.stringify(saved) === JSON.stringify(receipt)
      ? { kind: 'deduped' } : blocked('receipt_changed');
  } catch (error) {
    if (error.code !== 'ENOENT') return blocked('unsafe_receipt');
  }
  const summary = `${chosen.idlePartial ? 'Histórico parcial/não verificado' : 'Handoff'}: ${chosen.file}`;
  if (Buffer.byteLength(summary) > 300) return blocked('summary_too_long');
  return { kind: 'prepared', summary, file: chosen.file, receipt,
    sourceSessionId: chosen.sourceSessionId, sourceHash: chosen.sourceHash };
}

// Call only after native stdout has been written/flushed. Preparation never consumes.
export async function acknowledgeHandoff(stateDir, receipt) {
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.key ?? '') ||
      receipt.key !== sha(JSON.stringify([receipt.projectId, receipt.ownerId,
        receipt.nativeRoot, receipt.checkoutFingerprint, receipt.sourceSessionId,
        receipt.sourceHash, receipt.targetSessionId]))) return blocked('invalid_receipt');
  let dir;
  try { dir = await privateRoot(stateDir); }
  catch { return blocked('unsafe_state'); }
  try { await privateDir(receiptDir(dir), true); }
  catch { return blocked('unsafe_receipt_dir'); }
  const file = receiptFile(dir, receipt.key);
  try {
    const saved = JSON.parse(await privateRead(file, 8192));
    return JSON.stringify(saved) === JSON.stringify(receipt)
      ? { kind: 'acked' } : blocked('receipt_changed');
  } catch (error) {
    if (error.code !== 'ENOENT') return blocked('unsafe_receipt');
  }
  try { await atomicWrite(file, JSON.stringify(receipt) + '\n'); }
  catch { return blocked('receipt_write_failed'); }
  return { kind: 'acked' };
}
