import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import { externalIdFor } from './ledger.mjs';
import { ensureWindowsPrivateDirectory, inspectWindowsPath, readWindowsBinary,
  publishWindowsBinary, deleteWindowsBinary, withWindowsFileLock } from './windows-security.mjs';
import { createWindowsState } from './windows-state.mjs';
import { POLICY_VERSION } from './transcript.mjs';
import { conversationCutoff } from './conversation-batches.mjs';

const DEFAULT_MAX = 256 * 1024 * 1024;
const blocked = reason => ({ kind: 'blocked', reason });
const validId = id => typeof id === 'string' && /^src-[a-f0-9]{64}$/.test(id);
const proofDigest = proof => createHash('sha256').update(JSON.stringify([proof.sdkId, proof.qdrantId])).digest('hex');
const quotedV2Source = (text, metadata, sourceSha256) => {
  const prefix = metadata?.origin === 'user_direct' ? 'Citação do usuário: ' :
    metadata?.origin === 'assistant_report' ? 'O assistente relatou: ' :
      metadata?.origin === 'tool_observation' ? 'A ferramenta observou: ' : null;
  if (!prefix || metadata?.format_version !== 2 ||
      metadata.type !== (metadata.origin === 'user_direct' ? 'source_note' : 'report') ||
      metadata.condition != null || metadata.valid_from != null || metadata.valid_to != null ||
      typeof text !== 'string' || !text.startsWith(prefix)) return false;
  let source;
  try { source = JSON.parse(text.slice(prefix.length)); }
  catch { return false; }
  return typeof source === 'string' && !!source.trim() &&
    Buffer.byteLength(source, 'utf8') <= 512 &&
    text === prefix + JSON.stringify(source) &&
    createHash('sha256').update(source).digest('hex') === sourceSha256;
};

export function createOutbox(stateDir, options = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('invalid_state_dir');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_outbox_limit');
  const reserve = maxBytes >= 64 * 1024 * 1024 ? 16 * 1024 * 1024 : 0;
  let blockSize = 4096;
  const root = path.join(stateDir, 'outbox');
  const items = path.join(root, 'items');
  const acks = path.join(root, 'acks');
  const processed = path.join(root, 'processed');
  const payloads = path.join(stateDir, 'candidates', 'payloads');
  const reviews = path.join(stateDir, 'candidates', 'reviews');
  const lock = path.join(root, 'lock');
  const kernelLock = path.join(root, '.kernel-lock');
  const itemFile = id => path.join(items, `${id}.json`);
  const ackFile = id => path.join(acks, `${id}.json`);
  const processedFile = id => path.join(processed, `${id}.json`);
  const manifestFile = id => path.join(items, `${id}.manifest.json`);
  const retryFile = id => path.join(items, `${id}.retry.json`);
  const summaryFile = (cli, sessionId) => path.join(root,
    `cursor-${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.json`);
  const baselineFile = (cli, sessionId) => path.join(root,
    `baseline-${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.json`);
  const extractionFile = (cli, sessionId) => path.join(root,
    `extract-${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.json`);
  const conversationFile = (cli, sessionId) => path.join(root,
    `conversation-${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.json`);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const v2PayloadValid = (data, original) => data.format_version === undefined ||
    [2, 3].includes(data.format_version) && typeof original?.text === 'string' &&
    data.source_text_sha256 === hash(original.text) &&
    data.claim_sha256 === hash(JSON.stringify([data.text, data.type, data.scope,
      data.condition ?? null, data.valid_from ?? null, data.valid_to ?? null])) &&
    (data.format_version !== 3 || original.origin === 'human' &&
      original.text.includes(data.text) && ['rule', 'fact', 'preference', 'decision'].includes(data.type) &&
      data.scope !== 'episode' && data.condition == null && data.valid_from == null &&
      data.valid_to == null) &&
    data.actor === original.actor && data.speaker_role === original.speakerRole &&
    data.evidence_at === original.timestamp &&
    data.origin === (original.origin === 'human' ? 'user_direct' :
      original.origin === 'assistant' ? 'assistant_report' :
        original.origin === 'tool' ? 'tool_observation' : null) &&
    (data.scope !== 'personal' || data.owner_id === original.ownerId);
  const payloadProofValid = async (data, original, row) => data.format_version === 4
    ? (await import('./conversation-proof.mjs')).validateConversationProof(data, row).eligible
    : v2PayloadValid(data, original);
  const windows = process.platform === 'win32';
  const mutable = file => /(?:^|[\\/])(?:cursor-|extract-|conversation-)[a-f0-9]{64}\.json$/.test(file) ||
    /\.(?:manifest|retry)\.json$/.test(file);

  async function removeOwned(file, optional = false) {
    if (!windows) return fs.rm(file, { force: optional });
    if (mutable(file)) await createWindowsState(file).read();
    let observed;
    try { observed = await readWindowsBinary(file, { length: 16 * 1024 * 1024 }); }
    catch (error) {
      if (optional && error.message === 'windows_read_open' &&
          await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) return;
      throw error;
    }
    if (observed.size !== observed.bytes.length) throw new Error('windows_outbox_oversize');
    await deleteWindowsBinary(file, observed.fileId, observed.bytes);
  }

  async function syncDir(dir) {
    if (windows) return;
    const h = await fs.open(dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  }
  async function ensure() {
    if (windows) {
      for (const dir of [stateDir, root, items, acks, processed]) {
        if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_outbox_dir');
      }
      return;
    }
    if (!process.getuid) throw new Error('native_windows_unproved');
    for (const dir of [stateDir, root, items, acks, processed]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('unsafe_outbox_dir');
      blockSize = Math.max(blockSize, st.blksize ?? 4096);
    }
  }
  async function read(file) {
    if (windows) {
      if (mutable(file)) return createWindowsState(file).read();
      try {
        const observed = await readWindowsBinary(file, { length: 16 * 1024 * 1024 });
        if (observed.size !== observed.bytes.length) throw new Error('windows_outbox_oversize');
        return JSON.parse(observed.bytes.toString('utf8'));
      } catch (error) {
        if (error.message === 'windows_read_open' &&
            await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) return null;
        throw error;
      }
    }
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function durable(file, value) {
    if (windows) {
      if (mutable(file)) await createWindowsState(file).write(value);
      else await publishWindowsBinary(file, Buffer.from(JSON.stringify(value) + '\n'),
        options.onTempFlushed);
      await options.onDurable?.(file);
      return;
    }
    const dir = path.dirname(file);
    const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await options.fault?.('after_write');
      await handle.sync();
      await options.fault?.('after_file_sync');
    } finally { await handle.close(); }
    try {
      await fs.rename(temporary, file);
      await options.fault?.('after_rename');
      await syncDir(dir);
      await options.fault?.('after_dir_sync');
      await options.onDurable?.(file);
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  async function withLock(callback) {
    await ensure();
    if (windows) return withWindowsFileLock(kernelLock, async () => {
      for (const name of await fs.readdir(acks)) if (/^src-[a-f0-9]{64}\.json$/.test(name)) {
        const id = name.slice(0, -5);
        if (await read(itemFile(id))) await removeOwned(itemFile(id));
        if (await read(retryFile(id))) await removeOwned(retryFile(id));
      }
      for (const name of await fs.readdir(processed)) if (/^src-[a-f0-9]{64}\.json$/.test(name)) {
        const id = name.slice(0, -5);
        for (const file of [itemFile(id), manifestFile(id), retryFile(id)]) {
          if (await read(file)) await removeOwned(file);
        }
      }
      return callback();
    });
    if (process.platform !== 'linux') throw new Error('outbox_lock_unsupported');
    const supported = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);
    if (!supported.has((await fs.statfs(root)).type)) throw new Error('outbox_lock_unsupported');
    const utility = '/usr/bin/flock';
    let utilityStat, utilityDir, utilityParent, utilityRoot;
    try {
      [utilityStat, utilityDir, utilityParent, utilityRoot] = await Promise.all([
        fs.lstat(utility), fs.lstat('/usr/bin'), fs.lstat('/usr'), fs.lstat('/')]);
    } catch (error) { throw new Error('outbox_lock_utility_unavailable', { cause: error }); }
    if (!utilityStat.isFile() || utilityStat.isSymbolicLink() || utilityStat.uid !== 0 ||
        (utilityStat.mode & 0o022) || !(utilityStat.mode & 0o111) ||
        !utilityDir.isDirectory() || utilityDir.uid !== 0 || (utilityDir.mode & 0o022) ||
        !utilityParent.isDirectory() || utilityParent.uid !== 0 || (utilityParent.mode & 0o022) ||
        !utilityRoot.isDirectory() || utilityRoot.uid !== 0 || (utilityRoot.mode & 0o022)) {
      throw new Error('outbox_lock_utility_unavailable');
    }
    let handle;
    try {
      const priorLegacy = await fs.lstat(lock).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      let created = false;
      try {
        handle = await fs.open(kernelLock, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW |
          (priorLegacy ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
        created = !priorLegacy;
      } catch (error) {
        if (priorLegacy && error.code === 'ENOENT') {
          let content = '';
          if (priorLegacy.isFile() && !priorLegacy.isSymbolicLink() && priorLegacy.size < 128) {
            const marker = await fs.open(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { content = await marker.readFile('utf8'); } finally { await marker.close(); }
          }
          throw new Error(content.startsWith('cbs-kernel-lock-v1 ')
            ? 'outbox_lock_identity_changed' : 'outbox_legacy_lock', { cause: error });
        }
        if (error.code === 'ELOOP' || error.code === 'EISDIR') {
          throw new Error('outbox_lock_identity_changed', { cause: error });
        }
        if (error.code !== 'EEXIST') throw error;
        handle = await fs.open(kernelLock, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)
          .catch(cause => { throw new Error('outbox_lock_identity_changed', { cause }); });
      }
      if (created) await syncDir(root);
      const held = await handle.stat();
      const legacyMarker = `cbs-kernel-lock-v1 ${held.dev}:${held.ino}\n`;
      const sameKernelInode = async () => {
        const current = await fs.lstat(kernelLock).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        return current?.isFile() && !current.isSymbolicLink() && current.dev === held.dev &&
          current.ino === held.ino && current.nlink === 1 && current.uid === process.getuid() &&
          (current.mode & 0o777) === 0o600;
      };
      if (!held.isFile() || held.nlink !== 1 || held.uid !== process.getuid() ||
          (held.mode & 0o777) !== 0o600 || !await sameKernelInode()) {
        throw new Error('outbox_lock_identity_changed');
      }
      await new Promise((resolve, reject) => {
        const child = spawn(utility, ['-x', '-E', '75', '-w', '0.2', '3'], {
          stdio: ['ignore', 'pipe', 'pipe', handle.fd], env: { LC_ALL: 'C' }, windowsHide: true });
        let output = '';
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        const capture = chunk => {
          output += chunk;
          if (output.length > 4096) child.kill('SIGKILL');
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        child.once('error', error => finish(Object.assign(new Error('outbox_lock_utility_unavailable', { cause: error }),
          { code: 'OUTBOX_LOCK_UTILITY' })));
        child.once('close', code => finish(code === 0 ? null :
          new Error(code === 75 ? 'outbox_lock_timeout' : 'outbox_lock_utility_unavailable')));
      });
      await syncDir(root);
      if (!await sameKernelInode()) throw new Error('outbox_lock_identity_changed');
      let legacy;
      try { legacy = await fs.lstat(lock); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (legacy) {
        if (!legacy.isFile() || legacy.isSymbolicLink() || legacy.uid !== process.getuid() ||
            legacy.nlink !== 1 || (legacy.mode & 0o777) !== 0o600 || legacy.size >= 128) {
          throw new Error('outbox_legacy_lock');
        }
        const marker = await fs.open(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = await marker.stat();
          const current = await fs.lstat(lock);
          if (opened.dev !== legacy.dev || opened.ino !== legacy.ino ||
              current.dev !== legacy.dev || current.ino !== legacy.ino) throw new Error('outbox_legacy_lock');
          const content = await marker.readFile('utf8');
          if (content !== legacyMarker) throw new Error(content.startsWith('cbs-kernel-lock-v1 ')
            ? 'outbox_lock_identity_changed' : 'outbox_legacy_lock');
        } finally { await marker.close(); }
      } else {
        const temporary = path.join(root, `.${randomUUID()}.tmp`);
        let markerHandle;
        try {
          markerHandle = await fs.open(temporary, 'wx', 0o600);
          await markerHandle.writeFile(legacyMarker);
          await markerHandle.sync();
          await markerHandle.close(); markerHandle = null;
          await fs.link(temporary, lock);
          await syncDir(root);
        } catch (error) {
          if (error.code === 'EEXIST') throw new Error('outbox_legacy_lock', { cause: error });
          throw error;
        } finally {
          await markerHandle?.close();
          await fs.rm(temporary, { force: true });
        }
      }
      if (!await sameKernelInode()) throw new Error('outbox_lock_identity_changed');
      try {
        for (const dir of [items, acks, processed, root]) {
          let removed = false;
          for (const name of await fs.readdir(dir)) if (/^\.[a-f0-9-]+\.tmp$/.test(name)) {
            await fs.rm(path.join(dir, name));
            removed = true;
          }
          if (removed) await syncDir(dir);
        }
        let reclaimed = false;
        for (const name of await fs.readdir(acks)) if (/^src-[a-f0-9]{64}\.json$/.test(name)) {
          const retry = retryFile(name.slice(0, -5));
          const present = await Promise.all([fs.stat(path.join(items, name)).then(() => true, error => {
            if (error.code === 'ENOENT') return false; throw error;
          }), fs.stat(retry).then(() => true, error => {
            if (error.code === 'ENOENT') return false; throw error;
          })]);
          if (present.some(Boolean)) {
            await syncDir(acks);
            if (present[0]) await fs.rm(path.join(items, name));
            if (present[1]) await fs.rm(retry);
            reclaimed = true;
          }
        }
        if (reclaimed) await syncDir(items);
        for (const name of await fs.readdir(processed)) if (/^src-[a-f0-9]{64}\.json$/.test(name)) {
          const id = name.slice(0, -5);
          await fs.rm(itemFile(id), { force: true });
          await fs.rm(manifestFile(id), { force: true });
          await fs.rm(retryFile(id), { force: true });
        }
        let cleanedProcessed = false;
        for (const name of await fs.readdir(root)) if (/^cursor-[a-f0-9]{64}\.json$/.test(name)) {
          const summary = await read(path.join(root, name));
          if (!summary?.processedAudit) continue;
          for (const receiptName of await fs.readdir(processed)) {
            if (!/^src-[a-f0-9]{64}\.json$/.test(receiptName)) continue;
            const receipt = await read(path.join(processed, receiptName));
            if (receipt?.disposition === 'no_facts' && receipt.cli === summary.cli &&
                receipt.sessionId === summary.sessionId && receipt.projectId === summary.projectId &&
                receipt.policyVersion === summary.policyVersion && receipt.end <= summary.processedEnd) {
              await fs.rm(path.join(processed, receiptName));
              cleanedProcessed = true;
            }
          }
        }
        if (cleanedProcessed) await syncDir(processed);
        return await callback();
      } finally { await handle.close(); handle = null; }
    } finally { await handle?.close(); }
  }
  async function records() {
    await ensure();
    const rows = [];
    for (const dir of [acks, processed, items]) {
      for (const name of await fs.readdir(dir)) {
        if (!/^src-[a-f0-9]{64}\.json$/.test(name)) continue;
        const row = await read(path.join(dir, name));
        if (!row || row.operationId !== name.slice(0, -5)) throw new Error('corrupt_outbox');
        rows.push({ ...row, acknowledged: dir === acks, terminal: dir !== items });
      }
    }
    return rows;
  }
  function unique(rows) {
    const byId = new Map();
    for (const row of rows) if (!byId.has(row.operationId) || row.terminal) byId.set(row.operationId, row);
    return [...byId.values()];
  }
  async function pendingUnlocked() {
    const rows = unique(await records()).filter(row => !row.terminal).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId) || a.start - b.start);
    return Promise.all(rows.map(async row => {
      const retry = await read(retryFile(row.operationId));
      if (retry && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 ||
          retry.attempts > (retry.automatic === true ? Number.MAX_SAFE_INTEGER : 5) ||
          !Number.isSafeInteger(retry.retryAt) || typeof retry.lastError !== 'string')) {
        throw new Error('corrupt_retry');
      }
      return { ...row, ...(retry ?? { attempts: 0, retryAt: 0, lastError: null }) };
    }));
  }
  function cursorFrom(rows, cli, sessionId, summary = null, baseline = null) {
    rows = rows.filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    let queuedEnd = Math.max(summary?.queuedEnd ?? 0, baseline?.cutoffEnd ?? 0);
    let ackedEnd = summary?.ackedEnd ?? 0;
    let processedEnd = summary?.processedEnd ?? 0;
    for (const row of rows) {
      if (row.start === queuedEnd) queuedEnd = row.end;
      if (row.acknowledged && row.start === ackedEnd) ackedEnd = row.end;
      if (row.terminal && row.start === processedEnd) processedEnd = row.end;
    }
    return { queuedEnd, ackedEnd, processedEnd };
  }
  async function cursorUnlocked(cli, sessionId) {
    const cursor = cursorFrom(unique(await records()), cli, sessionId,
      await read(summaryFile(cli, sessionId)), await read(baselineFile(cli, sessionId)));
    const staged = await read(conversationFile(cli, sessionId));
    return staged ? { ...cursor, queuedEnd: Math.max(cursor.queuedEnd, staged.end) } : cursor;
  }
  async function ensureFutureBaseline(binding) {
    const { cli, sessionId, projectId, ownerId, consentHash, policyVersion, cutoffEnd } = binding ?? {};
    const initialSize = binding?.initialSize ?? cutoffEnd;
    if (!['claude', 'codex'].includes(cli) || typeof sessionId !== 'string' || !sessionId ||
        typeof projectId !== 'string' || !projectId || typeof ownerId !== 'string' || !ownerId ||
        !/^[a-f0-9]{64}$/.test(consentHash ?? '') || policyVersion !== POLICY_VERSION ||
        !Number.isSafeInteger(cutoffEnd) || cutoffEnd < 0 ||
        !Number.isSafeInteger(initialSize) || initialSize < cutoffEnd) {
      return blocked('invalid_future_baseline');
    }
    return withLock(async () => {
      const file = baselineFile(cli, sessionId);
      const prior = await read(file);
      if (prior) return prior.cli === cli && prior.sessionId === sessionId &&
        prior.projectId === projectId && prior.ownerId === ownerId &&
        prior.consentHash === consentHash && prior.policyVersion === policyVersion &&
        Number.isSafeInteger(prior.cutoffEnd) && prior.cutoffEnd >= 0 &&
        Number.isSafeInteger(prior.initialSize ?? prior.cutoffEnd) &&
        (prior.initialSize ?? prior.cutoffEnd) >= prior.cutoffEnd
        ? { kind: 'baselined', cutoffEnd: prior.cutoffEnd,
          initialSize: prior.initialSize ?? prior.cutoffEnd } : blocked('future_baseline_changed');
      const cursor = cursorFrom(unique(await records()), cli, sessionId,
        await read(summaryFile(cli, sessionId)));
      if (cutoffEnd < cursor.queuedEnd) return blocked('future_baseline_before_cursor');
      await durable(file, { cli, sessionId, projectId, ownerId, consentHash,
        policyVersion, cutoffEnd, initialSize });
      return { kind: 'baselined', cutoffEnd, initialSize };
    });
  }
  async function readFutureBaseline(binding) {
    const { cli, sessionId, projectId, ownerId, consentHash, policyVersion } = binding ?? {};
    if (!['claude', 'codex'].includes(cli) || typeof sessionId !== 'string' || !sessionId ||
        typeof projectId !== 'string' || !projectId || typeof ownerId !== 'string' || !ownerId ||
        !/^[a-f0-9]{64}$/.test(consentHash ?? '') || policyVersion !== POLICY_VERSION) {
      return blocked('invalid_future_baseline');
    }
    return withLock(async () => {
      const baseline = await read(baselineFile(cli, sessionId));
      if (!baseline) return blocked('future_baseline_unavailable');
      return baseline.cli === cli && baseline.sessionId === sessionId &&
        baseline.projectId === projectId && baseline.ownerId === ownerId &&
        baseline.consentHash === consentHash && baseline.policyVersion === policyVersion
        ? { kind: 'baselined', cutoffEnd: baseline.cutoffEnd,
          initialSize: baseline.initialSize ?? baseline.cutoffEnd }
        : blocked('future_baseline_changed');
    });
  }
  function futureSourceValid(source, baseline, binding) {
    return source && baseline && typeof binding?.ownerId === 'string' && !!binding.ownerId &&
      /^[a-f0-9]{64}$/.test(binding.consentHash ?? '') &&
      source.projectId === binding.projectId && source.cli === binding.cli &&
      source.sessionId === binding.sessionId && source.policyVersion === POLICY_VERSION &&
      baseline.projectId === binding.projectId && baseline.cli === binding.cli &&
      baseline.sessionId === binding.sessionId && baseline.ownerId === binding.ownerId &&
      baseline.consentHash === binding.consentHash && baseline.policyVersion === POLICY_VERSION &&
      Number.isSafeInteger(baseline.cutoffEnd) && source.start >= baseline.cutoffEnd &&
      source.messages?.some(message => message.origin === 'human' &&
        message.ownerId === binding.ownerId) &&
      !source.messages.some(message => message.origin === 'human' &&
        message.ownerId !== binding.ownerId);
  }
  async function futureSourceAllowed(row, binding) {
    if (!validId(row?.operationId)) return blocked('source_policy_unproved');
    return withLock(async () => {
      const source = await read(itemFile(row.operationId)) ?? await read(ackFile(row.operationId)) ??
        await read(processedFile(row.operationId));
      const baseline = await read(baselineFile(row.cli, row.sessionId));
      if (!futureSourceValid(source, baseline, binding) ||
          source.operationId !== row.operationId || source.start !== row.start ||
          source.end !== row.end || source.sliceHash !== row.sliceHash ||
          JSON.stringify(source.messages) !== JSON.stringify(row.messages)) {
        return blocked('source_policy_unproved');
      }
      return { kind: 'allowed' };
    });
  }
  async function compactAcksUnlocked(cli, sessionId) {
    const prior = await read(summaryFile(cli, sessionId));
    let rows = unique(await records()).filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    if (prior) {
      let removed = false;
      for (const row of rows) if (row.acknowledged && prior.entries?.some(([id]) => id === row.operationId)) {
        if (row.projectId !== prior.projectId || row.policyVersion !== prior.policyVersion) {
          throw new Error('cursor_source_mismatch');
        }
        await removeOwned(ackFile(row.operationId));
        removed = true;
      }
      if (removed) await syncDir(acks);
      rows = rows.filter(row => !prior.entries?.some(([id]) => id === row.operationId));
    }
    let end = prior?.ackedEnd ?? 0;
    const removable = [];
    for (const row of rows) {
      if (row.start !== end || !row.acknowledged) break;
      if (prior && (row.projectId !== prior.projectId || row.policyVersion !== prior.policyVersion)) {
        throw new Error('cursor_source_mismatch');
      }
      end = row.end;
      removable.push(row);
    }
    if (!removable.length) return;
    const last = removable.at(-1);
    const snapshot = { cli, sessionId, projectId: last.projectId,
      policyVersion: last.policyVersion, queuedEnd: Math.max(prior?.queuedEnd ?? 0, end),
      ackedEnd: end, processedEnd: Math.max(prior?.processedEnd ?? 0, end),
      processedAudit: prior?.processedAudit, processedCount: prior?.processedCount,
      entries: [...(prior?.entries ?? []), ...removable.map(row =>
        [row.operationId, proofDigest(row)])] };
    if (!await fits(snapshot)) return;
    await durable(summaryFile(cli, sessionId), snapshot);
    for (const row of removable) await removeOwned(ackFile(row.operationId));
    await syncDir(acks);
  }
  async function compactProcessedUnlocked(cli, sessionId) {
    const prior = await read(summaryFile(cli, sessionId));
    const rows = unique(await records()).filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    let end = prior?.processedEnd ?? 0;
    let digest = prior?.processedAudit ?? '0'.repeat(64);
    const removable = [];
    let source = prior;
    for (const row of rows) {
      if (row.end <= end) continue;
      if (row.start !== end || !row.terminal || !row.disposition) break;
      if (source && (row.projectId !== source.projectId || row.policyVersion !== source.policyVersion)) {
        throw new Error('cursor_source_mismatch');
      }
      source ??= row;
      const noFacts = row.disposition === 'no_facts' && !row.candidates?.length;
      const terminalCandidates = row.disposition === 'candidates' && row.candidates?.length > 0 &&
        row.candidates.every(candidate => ['rejected', 'duplicate', 'remote_acked', 'conflict'].includes(candidate.status));
      if (!noFacts && !terminalCandidates) break;
      let validConflict = true;
      for (const candidate of row.candidates ?? []) {
        if (candidate.status === 'conflict' && !await conflictProofValid(row.operationId, candidate, row)) {
          validConflict = false;
          break;
        }
      }
      if (!validConflict) break;
      digest = hash(JSON.stringify([digest, row.operationId, row.sliceHash, row.start, row.end]));
      end = row.end;
      if (noFacts) removable.push(row);
    }
    if (!removable.length) return;
    const last = removable.at(-1);
    const snapshot = { cli, sessionId, projectId: last.projectId, policyVersion: last.policyVersion,
      queuedEnd: Math.max(prior?.queuedEnd ?? 0, end), ackedEnd: prior?.ackedEnd ?? 0,
      processedEnd: end, processedAudit: digest, processedCount: (prior?.processedCount ?? 0) + removable.length,
      entries: prior?.entries ?? [] };
    if (!await fits(snapshot)) return;
    await durable(summaryFile(cli, sessionId), snapshot);
    for (const row of removable) await removeOwned(processedFile(row.operationId));
    await syncDir(processed);
  }
  async function commitConversationUnlocked(staged, force = false, turns = 5) {
    const cutoff = conversationCutoff(staged.messages, turns, force);
    if (!cutoff) return { kind: 'staged', queuedEnd: staged.end };
    const end = cutoff.end;
    // sliceHash proves the original captured slice; fullStart/fullEnd retain its
    // bounds when a large capture is divided between conversation batches.
    const sourceSlices = staged.parts.filter(part => part.start < end).map(part =>
      ({ ...part, end: Math.min(part.end, end) }));
    const sliceHash = hash(JSON.stringify(sourceSlices));
    const operationId = externalIdFor({ originCli: staged.cli, projectId: staged.projectId,
      sessionId: staged.sessionId, start: staged.start, end, sliceHash,
      policyVersion: staged.policyVersion });
    const row = { operationId, projectId: staged.projectId, cli: staged.cli,
      sessionId: staged.sessionId, start: staged.start, end, sliceHash,
      policyVersion: staged.policyVersion, conversationBatch: true,
      conversationPairs: cutoff.pairs, sourceSlices,
      messages: staged.messages.filter(message => message.end <= end) };
    const existing = await read(itemFile(operationId)) ?? await read(ackFile(operationId)) ??
      await read(processedFile(operationId));
    const summary = await read(summaryFile(staged.cli, staged.sessionId));
    const compacted = !existing && summary?.projectId === staged.projectId &&
      summary.policyVersion === staged.policyVersion && summary.cli === staged.cli &&
      summary.sessionId === staged.sessionId && Number.isSafeInteger(summary.processedEnd) &&
      summary.processedEnd >= end && summary.queuedEnd >= end &&
      Number.isSafeInteger(summary.processedCount) && summary.processedCount > 0 &&
      /^[a-f0-9]{64}$/.test(summary.processedAudit ?? '');
    if (existing && (existing.projectId !== row.projectId || existing.start !== row.start ||
        existing.end !== row.end || existing.sliceHash !== row.sliceHash ||
        JSON.stringify(existing.messages) !== JSON.stringify(row.messages))) {
      return blocked('conversation_batch_conflict');
    }
    if (!existing && !compacted) {
      if (!await fits(row)) return { kind: 'full', operationId };
      await durable(itemFile(operationId), row);
    }
    const remaining = { ...staged, start: end,
      parts: staged.parts.filter(part => part.end > end).map(part =>
        ({ ...part, start: Math.max(part.start, end) })),
      messages: staged.messages.filter(message => message.end > end) };
    if (remaining.start === remaining.end) await removeOwned(conversationFile(staged.cli, staged.sessionId));
    else await durable(conversationFile(staged.cli, staged.sessionId), remaining);
    return { kind: compacted || existing?.disposition ? 'processed' : existing?.sdkId ? 'acked' : 'queued',
      operationId, queuedEnd: staged.end, conversationPairs: cutoff.pairs };
  }
  async function drainConversationUnlocked(staged, force, turns) {
    let last = { kind: 'staged', queuedEnd: staged.end };
    while (staged && conversationCutoff(staged.messages, turns, force)) {
      const committed = await commitConversationUnlocked(staged, force, turns);
      if (!['queued', 'acked', 'processed'].includes(committed.kind)) return committed;
      last = committed;
      staged = await read(conversationFile(staged.cli, staged.sessionId));
    }
    return last;
  }
  async function enqueueConversationSlice(slice, identity, { event, conversationTurns = 5 } = {}) {
    const { cli, sessionId, start, end, sliceHash, messages } = slice ?? {};
    const { projectId, policyVersion } = identity ?? {};
    if (!['claude', 'codex'].includes(cli) || typeof sessionId !== 'string' || !sessionId ||
        typeof projectId !== 'string' || !projectId || policyVersion !== POLICY_VERSION ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end ||
        !/^[a-f0-9]{64}$/.test(sliceHash ?? '') || !Number.isSafeInteger(conversationTurns) ||
        conversationTurns < 1 || conversationTurns > 100 || !Array.isArray(messages) ||
        !messages.every(message => message && message.sessionId === sessionId &&
          Number.isSafeInteger(message.start) && message.start >= start &&
          Number.isSafeInteger(message.end) && message.end <= end && message.start < message.end)) {
      return blocked('invalid_conversation_slice');
    }
    return withLock(async () => {
      const file = conversationFile(cli, sessionId);
      let staged = await read(file);
      if (staged && (staged.projectId !== projectId || staged.policyVersion !== policyVersion ||
          staged.cli !== cli || staged.sessionId !== sessionId)) return blocked('conversation_source_changed');
      // A prior crash may have persisted the batch before removing its staging file.
      if (staged && conversationCutoff(staged.messages, conversationTurns)) {
        const recovered = await drainConversationUnlocked(staged, false, conversationTurns);
        if (!['queued', 'processed', 'acked'].includes(recovered.kind)) return recovered;
        staged = await read(file);
      }
      const position = cursorFrom(unique(await records()), cli, sessionId,
        await read(summaryFile(cli, sessionId)), await read(baselineFile(cli, sessionId)));
      const expected = staged?.end ?? position.queuedEnd;
      if (start !== expected) return blocked('cursor_gap');
      staged = staged ?? { cli, sessionId, projectId, policyVersion, start, end: start,
        parts: [], messages: [] };
      staged = { ...staged, end, parts: [...staged.parts,
        { start, end, fullStart: start, fullEnd: end, sliceHash }],
        messages: [...staged.messages, ...messages] };
      if (!await fits(staged)) return { kind: 'full', usedBytes: await usageUnlocked(), maxBytes };
      await durable(file, staged);
      const force = ['PreCompact', 'SessionEnd', 'Interrupt', 'Recovery'].includes(event);
      const result = await drainConversationUnlocked(staged, force, conversationTurns);
      return result.kind === 'staged' ? { kind: 'staged', queuedEnd: end } : result;
    });
  }
  async function flushConversationStage({ cli, sessionId, projectId, policyVersion, event,
    conversationTurns = 5 } = {}) {
    if (!['PreCompact', 'SessionEnd', 'Interrupt', 'Recovery'].includes(event) ||
        !['claude', 'codex'].includes(cli) || typeof sessionId !== 'string' || !sessionId ||
        typeof projectId !== 'string' || !projectId || policyVersion !== POLICY_VERSION ||
        !Number.isSafeInteger(conversationTurns) || conversationTurns < 1 || conversationTurns > 100) {
      return blocked('invalid_conversation_flush');
    }
    return withLock(async () => {
      const staged = await read(conversationFile(cli, sessionId));
      if (!staged) return { kind: 'no_complete_pairs' };
      if (staged.projectId !== projectId || staged.policyVersion !== policyVersion) {
        return blocked('conversation_source_changed');
      }
      const result = await drainConversationUnlocked(staged, true, conversationTurns);
      return result.kind === 'staged' ? { kind: 'no_complete_pairs' } : result;
    });
  }
  async function listConversationStages({ cli, projectId } = {}) {
    if (!['claude', 'codex'].includes(cli) || typeof projectId !== 'string' || !projectId) {
      return blocked('invalid_conversation_scope');
    }
    return withLock(async () => {
      const stages = [];
      for (const name of await fs.readdir(root)) {
        if (!/^conversation-[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = path.join(root, name);
        const staged = await read(file);
        if (staged?.cli !== cli || staged.projectId !== projectId) continue;
        if (staged.policyVersion !== POLICY_VERSION ||
            conversationFile(staged.cli, staged.sessionId) !== file) {
          return blocked('conversation_source_changed');
        }
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return blocked('conversation_source_changed');
        stages.push({ sessionId: staged.sessionId, completedPairs:
          (await import('./conversation-batches.mjs')).completedConversationPairs(staged.messages).length,
        queuedEnd: staged.end, updatedAtMs: stat.mtimeMs });
      }
      return { kind: 'stages', stages };
    });
  }
  async function enqueueCheckpoint(slice, identity) {
    const { cli, sessionId, start, end, sliceHash, messages } = slice ?? {};
    const { projectId, policyVersion } = identity ?? {};
    const operationId = externalIdFor({ originCli: cli, projectId, sessionId, start, end, sliceHash, policyVersion });
    if (!Array.isArray(messages) || !messages.every(message => message && typeof message === 'object' &&
        (!message.sessionId || message.sessionId === sessionId) &&
        (message.start === undefined || Number.isSafeInteger(message.start) && message.start >= start) &&
        (message.end === undefined || Number.isSafeInteger(message.end) && message.end <= end))) {
      throw new Error('invalid_checkpoint_messages');
    }
    return withLock(async () => {
      if (await read(conversationFile(cli, sessionId))) return blocked('conversation_stage_active');
      const existing = await read(itemFile(operationId)) ?? await read(ackFile(operationId)) ??
        await read(processedFile(operationId));
      if (existing) return { kind: existing.disposition ? 'processed' : existing.sdkId ? 'acked' : 'queued', operationId,
        alert: (await usageUnlocked()) >= maxBytes * 0.8 };
      const summary = await read(summaryFile(cli, sessionId));
      if (summary && (summary.projectId !== projectId || summary.policyVersion !== policyVersion)) {
        return blocked('cursor_source_mismatch');
      }
      if (summary && start < summary.queuedEnd) return summary.entries?.some(([id]) => id === operationId)
        ? { kind: 'acked', operationId } : blocked('compacted_checkpoint');
      const rows = unique(await records());
      const baseline = await read(baselineFile(cli, sessionId));
      const position = cursorFrom(rows, cli, sessionId, summary, baseline);
      if (start !== position.queuedEnd) return blocked('cursor_gap');
      const row = { operationId, projectId, cli, sessionId, start, end, sliceHash, policyVersion, messages };
      const size = allocated(JSON.stringify(row) + '\n');
      let used = await usageUnlocked();
      if (used + size + reserve > maxBytes) {
        await compactAcksUnlocked(cli, sessionId);
        await compactProcessedUnlocked(cli, sessionId);
        used = await usageUnlocked();
      }
      if (used + size + reserve > maxBytes) return { kind: 'full', operationId, usedBytes: used, maxBytes };
      await durable(itemFile(operationId), row);
      return { kind: 'queued', operationId, alert: used + size >= maxBytes * 0.8,
        usedBytes: used + size };
    });
  }
  async function usageUnlocked() {
    if (windows) {
      let total = 0;
      let count = 0;
      const visit = async dir => {
        const audit = await inspectWindowsPath(dir, 'directory');
        if (!audit.ok) throw new Error('unsafe_outbox_dir');
        total += blockSize;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (++count > 65536 || entry.isSymbolicLink()) throw new Error('unsafe_outbox_entry');
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile()) {
            const observed = await readWindowsBinary(file, { length: 0 });
            total += Math.max(observed.allocatedBytes, allocated(observed.size));
          } else throw new Error('unsafe_outbox_entry');
        }
      };
      for (const dir of [root, path.dirname(payloads)]) {
        try { await fs.lstat(dir); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await visit(dir);
      }
      return total;
    }
    let bytes = 0;
    for (const dir of [items, acks, processed, root, lock, path.dirname(payloads), payloads, reviews]) {
      try { await fs.lstat(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const directory = await fs.lstat(dir);
      if (dir === lock && !directory.isDirectory()) continue;
      bytes += Math.max(directory.size, (directory.blocks ?? 0) * 512);
      for (const name of await fs.readdir(dir)) {
        const stat = await fs.lstat(path.join(dir, name));
        if (stat.isFile()) bytes += Math.max(stat.size, (stat.blocks ?? 0) * 512);
      }
    }
    return bytes;
  }
  function allocated(value) {
    const size = typeof value === 'number' ? value : Buffer.byteLength(value);
    return Math.ceil(size / blockSize) * blockSize + blockSize;
  }
  async function payloadValid(ref, row, candidate) {
    if (!ref || Object.keys(ref).length !== 1 || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) return false;
    const file = path.join(payloads, `${candidate.externalId}.${ref.sha256}.json`);
    if (windows) {
      try {
        const observed = await readWindowsBinary(file, { length: 16 * 1024 * 1024 });
        if (observed.size !== observed.bytes.length || hash(observed.bytes) !== ref.sha256) return false;
        const data = JSON.parse(observed.bytes.toString('utf8'));
        const original = row.messages.find(message => message.messageId === data?.source_message_id &&
          message.start === data?.source_offsets?.start && message.end === data?.source_offsets?.end);
        return data?.external_id === candidate.externalId && data.project_id === row.projectId &&
          data.checkpoint_id === row.operationId && data.source_message_id === candidate.evidence.messageId &&
          data.candidate_key === candidate.candidateKey && data.origin_cli === row.cli &&
          data.session_id === row.sessionId && data.policy_version === row.policyVersion &&
          data.slice_start === row.start && data.slice_end === row.end && data.slice_hash === row.sliceHash &&
          data.source_offsets?.start === candidate.evidence.start &&
          data.source_offsets?.end === candidate.evidence.end &&
          await payloadProofValid(data, original, row) &&
          (data.source_text_sha256 === undefined || typeof original?.text === 'string' &&
            data.source_text_sha256 === hash(original.text)) ? data : false;
      } catch (error) {
        if (error.message === 'windows_read_open' &&
            await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) return false;
        throw error;
      }
    }
    let handle;
    try {
      for (const dir of [path.dirname(payloads), payloads]) {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return false;
      }
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || before.uid !== process.getuid() ||
          (before.mode & 0o077)) return false;
      handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (actual.dev !== before.dev || actual.ino !== before.ino) return false;
      const bytes = await handle.readFile();
      if (hash(bytes) !== ref.sha256) return false;
      let data;
      try { data = JSON.parse(bytes); } catch { return false; }
      if (data?.external_id !== candidate.externalId || data.project_id !== row.projectId ||
          data.checkpoint_id !== row.operationId || data.source_message_id !== candidate.evidence.messageId ||
          data.candidate_key !== candidate.candidateKey || data.origin_cli !== row.cli ||
          data.session_id !== row.sessionId || data.policy_version !== row.policyVersion ||
          data.slice_start !== row.start || data.slice_end !== row.end ||
          data.slice_hash !== row.sliceHash ||
          data.source_offsets?.start !== candidate.evidence.start ||
          data.source_offsets?.end !== candidate.evidence.end) return false;
      const original = row.messages.find(message => message.messageId === data.source_message_id &&
        message.start === data.source_offsets.start && message.end === data.source_offsets.end);
      if (!await payloadProofValid(data, original, row) || data.source_text_sha256 !== undefined &&
          (typeof original?.text !== 'string' || data.source_text_sha256 !== hash(original.text))) return false;
      await handle.sync();
      const after = await fs.lstat(file);
      if (after.dev !== actual.dev || after.ino !== actual.ino || after.size !== actual.size ||
          after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) return false;
      await syncDir(payloads);
      return data;
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) return false;
      throw error;
    } finally { await handle?.close(); }
  }
  async function fits(value) {
    return await usageUnlocked() + allocated(JSON.stringify(value) + '\n') <= maxBytes;
  }
  async function persistCandidatePayload(operationId, candidate) {
    if (!validId(operationId) || !candidate || typeof candidate !== 'object') return blocked('invalid_candidate');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row || await read(manifestFile(operationId))) return blocked('candidate_source_unavailable');
      const identity = { projectId: row.projectId, originCli: row.cli, sessionId: row.sessionId,
        start: row.start, end: row.end, sliceHash: row.sliceHash, policyVersion: row.policyVersion,
        candidateKey: candidate.candidate_key };
      let externalId;
      try { externalId = externalIdFor(identity); } catch { return blocked('invalid_candidate'); }
      const original = row.messages.find(message => message.messageId === candidate.source_message_id &&
        message.start === candidate.source_offsets?.start &&
        message.end === candidate.source_offsets?.end);
      if (candidate.external_id !== externalId || candidate.project_id !== row.projectId ||
          candidate.checkpoint_id !== operationId || candidate.session_id !== row.sessionId ||
          candidate.origin_cli !== row.cli || candidate.policy_version !== row.policyVersion ||
          candidate.slice_hash !== row.sliceHash || typeof original?.text !== 'string') {
        return blocked('candidate_source_mismatch');
      }
      const content = JSON.stringify({ ...candidate, source_text_sha256: hash(original.text) }) + '\n';
      const digest = hash(content);
      const file = path.join(payloads, `${externalId}.${digest}.json`);
      if (windows) {
        if (!(await ensureWindowsPrivateDirectory(payloads)).ok) return blocked('unsafe_candidate_dir');
        const existing = await read(file);
        if (existing) return await payloadValid({ sha256: digest }, row,
          { candidateKey: candidate.candidate_key, externalId,
            evidence: { messageId: candidate.source_message_id,
              start: candidate.source_offsets.start, end: candidate.source_offsets.end } })
          ? { kind: 'persisted', externalId, payloadRef: { sha256: digest } }
          : blocked('candidate_payload_mismatch');
        if (await usageUnlocked() + 2 * allocated(content) + reserve > maxBytes) {
          return { kind: 'full', operationId };
        }
        await publishWindowsBinary(file, Buffer.from(content));
        return { kind: 'persisted', externalId, payloadRef: { sha256: digest } };
      }
      for (const dir of [path.dirname(payloads), payloads]) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return blocked('unsafe_candidate_dir');
      }
      const existing = await fs.lstat(file).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) return await payloadValid({ sha256: digest }, row,
        { externalId, evidence: { messageId: candidate.source_message_id,
          start: candidate.source_offsets.start, end: candidate.source_offsets.end } })
        ? { kind: 'persisted', externalId, payloadRef: { sha256: digest } }
        : blocked('candidate_payload_mismatch');
      if (await usageUnlocked() + 2 * allocated(content) + reserve > maxBytes) {
        return { kind: 'full', operationId };
      }
      const temp = path.join(payloads, `.${randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await fs.link(temp, file);
        await syncDir(payloads);
      } finally {
        await handle.close();
        await fs.rm(temp, { force: true });
      }
      await syncDir(payloads);
      return { kind: 'persisted', externalId, payloadRef: { sha256: digest } };
    });
  }
  const budgetDayMs = 24 * 60 * 60 * 1000;
  const budgetClock = () => options.now?.() ?? Date.now();
  async function dailyWindow(counter, file, now) {
    const today = Math.floor(now / budgetDayMs);
    if (counter?.budgetDay !== undefined) {
      if (!Number.isSafeInteger(counter.budgetDay) || counter.budgetDay < 0 ||
          !Number.isSafeInteger(counter.windowCalls) || counter.windowCalls < 0 ||
          counter.windowCalls > counter.calls) throw new Error('corrupt_extraction_budget');
      const day = Math.max(today, counter.budgetDay);
      return { day, calls: day === counter.budgetDay ? counter.windowCalls : 0 };
    }
    // A legacy counter has no per-call dates. Only a file proven older than this
    // UTC day can start at zero; otherwise carry every lifetime call conservatively.
    const stat = counter ? await fs.stat(file).catch(() => null) : null;
    return { day: today, calls: stat && stat.mtimeMs < today * budgetDayMs
      ? 0 : (counter?.calls ?? 0) };
  }
  async function extractionBudget(cli, sessionId, maxCallsPerSession = 4,
    budgetOptions = {}) {
    if (!Number.isSafeInteger(maxCallsPerSession) || maxCallsPerSession < 1 ||
        maxCallsPerSession > 1000) return blocked('invalid_extraction_limit');
    return withLock(async () => {
      const file = extractionFile(cli, sessionId);
      const counter = await read(file);
      if (budgetOptions.automaticDaily !== true) {
        return { kind: 'budget', available: (counter?.calls ?? 0) < maxCallsPerSession,
          calls: counter?.calls ?? 0 };
      }
      const now = budgetClock();
      if (!Number.isSafeInteger(now) || now < 0) return blocked('invalid_retry_clock');
      const window = await dailyWindow(counter, file, now);
      return { kind: 'budget', available: window.calls < maxCallsPerSession,
        calls: counter?.calls ?? 0, windowCalls: window.calls,
        budgetDay: window.day, retryAt: (window.day + 1) * budgetDayMs };
    });
  }
  async function claimExtraction(operationId, maxCallsPerSession = 4, budgetOptions = {}) {
    if (!validId(operationId)) return blocked('invalid_operation');
    if (!Number.isSafeInteger(maxCallsPerSession) || maxCallsPerSession < 1 ||
        maxCallsPerSession > 1000) return blocked('invalid_extraction_limit');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row || await read(manifestFile(operationId))) return blocked('extraction_source_unavailable');
      const file = extractionFile(row.cli, row.sessionId);
      const prior = await read(file);
      if (prior && (prior.projectId !== row.projectId || prior.policyVersion !== row.policyVersion)) {
        return blocked('extraction_session_mismatch');
      }
      const daily = budgetOptions.automaticDaily === true || prior?.budgetDay !== undefined;
      const now = budgetClock();
      if (daily && (!Number.isSafeInteger(now) || now < 0)) return blocked('invalid_retry_clock');
      const window = daily ? await dailyWindow(prior, file, now) : null;
      const replayRunId = budgetOptions.replayRunId;
      const replay = typeof replayRunId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(replayRunId);
      const replayKey = replay ? `${replayRunId}:${operationId}` : null;
      if (replay && prior?.replayClaims?.[replayKey]) return blocked('replay_already_claimed');
      if (!replay && budgetOptions.automaticDaily === true && window.calls >= maxCallsPerSession) {
        return { ...blocked('extraction_call_limit'), retryAt: (window.day + 1) * budgetDayMs };
      }
      if (!replay && budgetOptions.automaticDaily !== true && (prior?.calls ?? 0) >= maxCallsPerSession) {
        return blocked('extraction_call_limit');
      }
      const count = { cli: row.cli, sessionId: row.sessionId, projectId: row.projectId,
        policyVersion: row.policyVersion, calls: (prior?.calls ?? 0) + 1,
        results: prior?.results ?? [],
        ...(replay || prior?.replayClaims ? { replayClaims: {
          ...(prior?.replayClaims ?? {}), ...(replay ? { [replayKey]: (prior?.calls ?? 0) + 1 } : {}) } } : {}),
        ...(daily ? { budgetDay: window.day, windowCalls: window.calls + 1 } : {}) };
      if (!await fits(count)) return { kind: 'full', operationId };
      await durable(file, count);
      return { kind: 'claimed', calls: count.calls };
    });
  }
  async function recordExtractionUsage(operationId, callIndex, usage, latencyMs, context) {
    if (!validId(operationId) || !Number.isSafeInteger(callIndex) || callIndex < 1 ||
        !Number.isSafeInteger(latencyMs) || latencyMs < 0) return blocked('invalid_extraction_usage');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row) return blocked('missing_operation');
      const file = extractionFile(row.cli, row.sessionId);
      const counter = await read(file);
      if (!counter || callIndex > counter.calls) return blocked('missing_extraction_claim');
      if (counter.results.some(result => result.callIndex === callIndex)) return { kind: 'recorded' };
      const number = value => Number.isFinite(value) && value >= 0 ? value : null;
      const bounded = (value, limit) => Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, limit) : 0;
      const kinds = ['ready', 'saturated', 'unavailable'];
      const reasons = ['context_not_configured', 'context_identity_changed',
        'context_untrusted', 'context_unavailable', 'remote_status', 'remote_schema',
        'remote_unavailable'];
      const contextStatus = context && kinds.includes(context.kind)
        ? { kind: context.kind,
          ...(reasons.includes(context.reason) ? { reason: context.reason } : {}),
          scanned: bounded(context.scanned, 64), selected: bounded(context.selected, 8) }
        : null;
      counter.results.push({ callIndex, operationId, inputTokens: number(usage.inputTokens),
        outputTokens: number(usage.outputTokens), costUsd: number(usage.costUsd), latencyMs,
        ...(context?.replayRunId && context?.executionProfile && context?.frozenProfile ? {
          replayRunId: context.replayRunId, executionProfile: context.executionProfile,
          frozenProfile: context.frozenProfile } : {}),
        ...(contextStatus ? { context: contextStatus } : {}) });
      if (!await fits(counter)) return { kind: 'full', operationId };
      await durable(file, counter);
      return { kind: 'recorded' };
    });
  }
  async function extractionUsage(cli, sessionId) {
    return withLock(async () => {
      const counter = await read(extractionFile(cli, sessionId));
      if (!counter) return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return { calls: counter.calls,
        inputTokens: counter.results.reduce((n, row) => n + (row.inputTokens ?? 0), 0),
        outputTokens: counter.results.reduce((n, row) => n + (row.outputTokens ?? 0), 0),
        costUsd: counter.results.reduce((n, row) => n + (row.costUsd ?? 0), 0) };
    });
  }
  async function readCandidatePayload(operationId, candidateKey) {
    if (!validId(operationId) || typeof candidateKey !== 'string') return blocked('invalid_candidate');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      const candidate = manifest?.candidates?.find(item => item.candidateKey === candidateKey);
      if (!row || !candidate) return blocked('missing_candidate');
      return await payloadValid(candidate.payloadRef, row, candidate) || blocked('candidate_payload_mismatch');
    });
  }
  function rowSourceValid(row, payload, text) {
    const source = row?.messages?.find(message => message.messageId === payload.source_message_id &&
      message.start === payload.source_offsets.start && message.end === payload.source_offsets.end);
    return source?.origin === 'human' && typeof source.text === 'string' &&
      hash(source.text) === payload.source_text_sha256 && source.text.includes(text);
  }
  async function sourceForRemote(item, { allowLegacyReadOnly = false } = {}) {
    const externalId = item?.externalId;
    if (!validId(externalId) || typeof item.projectId !== 'string' ||
        typeof item.sessionId !== 'string' || !item.metadata?.source ||
        !item.metadata?.checkpoint_id || !item.metadata?.source_offsets) return blocked('source_unavailable');
    return withLock(async () => {
      let names;
      try { names = (await fs.readdir(payloads)).filter(name =>
        name.startsWith(`${externalId}.`) && /^src-[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(name)); }
      catch (error) { if (error.code === 'ENOENT') return blocked('source_unavailable'); throw error; }
      if (names.length !== 1) return blocked(names.length ? 'source_ambiguous' : 'source_unavailable');
      const file = path.join(payloads, names[0]);
      let bytes;
      if (windows) {
        const observed = await readWindowsBinary(file, { length: 1024 * 1024 });
        if (observed.size !== observed.bytes.length) return blocked('source_corrupt');
        bytes = observed.bytes;
      } else {
        const dir = await fs.lstat(payloads);
        const stat = await fs.lstat(file);
        if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
            !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
            (stat.mode & 0o077) || stat.size > 1024 * 1024) return blocked('source_corrupt');
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) return blocked('source_corrupt');
          bytes = await handle.readFile();
        } finally { await handle.close(); }
      }
      if (hash(bytes) !== names[0].slice(externalId.length + 1, -5)) return blocked('source_corrupt');
      let payload;
      try { payload = JSON.parse(bytes); } catch { return blocked('source_corrupt'); }
      const metadata = item.metadata;
      if (payload.external_id !== externalId || payload.project_id !== item.projectId ||
          payload.session_id !== item.sessionId || payload.checkpoint_id !== metadata.checkpoint_id ||
          payload.source_message_id !== metadata.source ||
          JSON.stringify(payload.source_offsets) !== JSON.stringify(metadata.source_offsets) ||
          payload.policy_version !== metadata.policy_version ||
          payload.scope !== metadata.scope || payload.owner_id !== (metadata.owner_id ?? null) ||
          payload.actor !== metadata.actor || payload.origin !== metadata.origin ||
          payload.evidence_at !== metadata.evidence_at ||
          [2, 3, 4].includes(payload.format_version) && (payload.type !== metadata.type ||
            payload.speaker_role !== metadata.speaker_role || metadata.format_version !== payload.format_version ||
            payload.source_text_sha256 !== metadata.source_text_sha256 ||
            metadata.claim_sha256 !== hash(JSON.stringify([item.text, metadata.type,
              metadata.scope, metadata.condition ?? null, metadata.valid_from ?? null,
              metadata.valid_to ?? null]))) ||
          typeof payload.text !== 'string' || typeof item.text !== 'string' ||
          item.text.length > 8192) return blocked('source_mismatch');
      if (payload.format_version === 2 &&
          (!quotedV2Source(payload.text, payload, payload.source_text_sha256) ||
            !quotedV2Source(item.text, metadata, payload.source_text_sha256) ||
            payload.claim_sha256 !== hash(JSON.stringify([payload.text, payload.type,
              payload.scope, payload.condition ?? null, payload.valid_from ?? null,
              payload.valid_to ?? null])))) {
        return blocked('source_mismatch');
      }
      const sourceRow = await read(itemFile(metadata.checkpoint_id));
      const manifest = sourceRow && await read(manifestFile(metadata.checkpoint_id));
      const processed = await read(processedFile(metadata.checkpoint_id));
      const acknowledgedChild = (manifest ?? processed)?.candidates?.find(candidate =>
        candidate.externalId === externalId && candidate.payloadRef?.sha256 ===
          names[0].slice(externalId.length + 1, -5) && candidate.status === 'remote_acked');
      const processedChild = processed?.candidates?.find(candidate =>
        candidate.externalId === externalId && candidate.payloadRef?.sha256 ===
          names[0].slice(externalId.length + 1, -5) && candidate.status === 'remote_acked');
      const record = await verifiedReviewFile(path.join(reviews, `${externalId}.json`));
      if (payload.format_version === 4) {
        const { validateConversationProof } = await import('./conversation-proof.mjs');
        const { dedupKeyFor } = await import('./dedup-key.mjs');
        let dedupKey;
        try { dedupKey = dedupKeyFor({ projectId: payload.project_id,
          scope: payload.scope, ownerId: payload.owner_id, type: payload.type,
          text: payload.text, condition: payload.condition,
          validFrom: payload.valid_from, validTo: payload.valid_to }); }
        catch { return blocked('source_mismatch'); }
        if (payload.policy_version !== POLICY_VERSION || payload.origin !== 'conversation_summary' ||
            payload.speaker_role !== 'mixed' || payload.actor !== 'conversation' ||
            metadata.format_version !== 4 || metadata.origin !== payload.origin ||
            metadata.speaker_role !== payload.speaker_role || metadata.actor !== payload.actor ||
            !isDeepStrictEqual(metadata.source_refs, payload.source_refs) ||
            Object.hasOwn(metadata, 'context_generated') !==
              Object.hasOwn(payload, 'context_generated') ||
            !isDeepStrictEqual(metadata.context_generated, payload.context_generated) ||
            metadata.dedup_key !== payload.dedup_key || dedupKey !== payload.dedup_key ||
            metadata.review_mode !== 'automatic' ||
            !/^[a-f0-9]{64}$/.test(metadata.auto_consent_hash ?? '') ||
            metadata.auto_actor !== 'project_auto_publisher' || item.text !== payload.text ||
            !(sourceRow ? validateConversationProof(payload, sourceRow).eligible : processedChild &&
              record?.review?.sourceProof?.refsSha256 === hash(JSON.stringify(payload.source_refs)))) {
          return blocked('source_mismatch');
        }
      }
      if ([3, 4].includes(payload.format_version)) {
        const proven = sourceRow ?? processed;
        const baseline = proven && await read(baselineFile(proven.cli, proven.sessionId));
        const binding = { cli: proven?.cli,
          sessionId: proven?.sessionId, projectId: item.projectId,
          ownerId: baseline?.ownerId, consentHash: metadata.auto_consent_hash };
        const legacyRemoteRead = payload.format_version === 3 && allowLegacyReadOnly && acknowledgedChild &&
          (sourceRow ?? processed)?.policyVersion === POLICY_VERSION &&
          record?.review?.sourceProof?.ownerId == null;
        if (!legacyRemoteRead && !(sourceRow ? futureSourceValid(sourceRow, baseline, binding) :
          processed && baseline && processed.projectId === binding.projectId &&
          processed.cli === binding.cli && processed.sessionId === binding.sessionId &&
          processed.policyVersion === POLICY_VERSION && processed.start >= baseline.cutoffEnd &&
          baseline.projectId === binding.projectId && baseline.cli === binding.cli &&
          baseline.sessionId === binding.sessionId && baseline.policyVersion === POLICY_VERSION &&
          baseline.consentHash === binding.consentHash &&
          record?.review?.sourceProof?.ownerId === baseline.ownerId)) {
          return blocked('source_mismatch');
        }
      }
      if (payload.format_version === 3 && (payload.policy_version !== POLICY_VERSION ||
          payload.origin !== 'user_direct' ||
          !(sourceRow ? sourceRow.policyVersion === POLICY_VERSION &&
            rowSourceValid(sourceRow, payload, item.text) :
            processed?.policyVersion === POLICY_VERSION && processedChild) ||
          item.text !== payload.text || metadata.review_mode !== 'automatic' ||
          !/^[a-f0-9]{64}$/.test(metadata.auto_consent_hash ?? '') ||
          metadata.auto_actor !== 'project_auto_publisher')) return blocked('source_mismatch');
      if ([2, 3, 4].includes(payload.format_version)) {
        const { redactSource, containsSecret } = await import('./candidates.mjs');
        if (containsSecret(item.text) || redactSource(item.text) !== item.text) {
          return blocked('source_mismatch');
        }
      }
      if (processed || item.status === 'active' || record || [3, 4].includes(payload.format_version)) {
        const proof = record?.review?.sourceProof;
        const operation = record?.review?.operation;
        if (record?.externalId !== externalId || record.operationId !== metadata.checkpoint_id ||
            record.payloadSha256 !== names[0].slice(externalId.length + 1, -5) ||
            record.digest !== hash(JSON.stringify(record.review)) ||
            !['approve', 'correct'].includes(record.review.decision) ||
            [3, 4].includes(payload.format_version) && (record.review.mode !== 'automatic' ||
              record.review.actor !== 'project_auto_publisher' ||
              record.review.consentHash !== metadata.auto_consent_hash) ||
            operation?.externalId !== externalId || operation.projectId !== item.projectId ||
            operation.sessionId !== item.sessionId || operation.text !== item.text ||
            operation.metadata?.source !== metadata.source ||
            JSON.stringify(operation.metadata?.source_offsets) !== JSON.stringify(metadata.source_offsets) ||
            operation.metadata?.checkpoint_id !== metadata.checkpoint_id ||
            operation.metadata?.scope !== metadata.scope ||
            (operation.metadata?.owner_id ?? null) !== (metadata.owner_id ?? null) ||
            [2, 3, 4].includes(payload.format_version) && (Object.entries(operation.metadata ?? {}).some(
              ([key, value]) => !isDeepStrictEqual(metadata[key], value)) ||
              item.sourceIdentity && !isDeepStrictEqual(item.sourceIdentity, operation.sourceIdentity)) ||
            proof?.messageId !== metadata.source ||
            proof?.messageSha256 !== payload.source_text_sha256 ||
            proof.approvedTextSha256 !== hash(item.text) ||
            (payload.format_version === 4 && proof.refsSha256 !== hash(JSON.stringify(payload.source_refs))) ||
            ([2, 3, 4].includes(payload.format_version) ? proof.claimSha256 !== metadata.claim_sha256 :
              !Number.isSafeInteger(proof.start) || proof.start < 0 ||
              proof.end !== proof.start + item.text.length)) return blocked('source_mismatch');
      } else if (payload.format_version === 2 || !payload.text.includes(item.text)) return blocked('source_mismatch');
      return { kind: 'local_source', text: item.text,
        metadata: { source: metadata.source, source_offsets: metadata.source_offsets,
          checkpoint_id: metadata.checkpoint_id, evidence_at: metadata.evidence_at,
          origin: metadata.origin, actor: metadata.actor, scope: metadata.scope,
          owner_id: metadata.owner_id ?? null,
          ...(payload.format_version === 4 ? { format_version: 4,
            source_refs: payload.source_refs, generated: true } : {}) } };
    });
  }
  async function verifiedReviewFile(file) {
    if (windows) {
      try {
        const observed = await readWindowsBinary(file, { length: 1024 * 1024 });
        if (observed.size !== observed.bytes.length) return blocked('unsafe_review');
        try { return JSON.parse(observed.bytes.toString('utf8')); }
        catch { return blocked('unsafe_review'); }
      } catch (error) {
        if (error.message === 'windows_read_open' &&
            await fs.lstat(file).then(() => false, cause => cause.code === 'ENOENT')) return null;
        throw error;
      }
    }
    let handle;
    try {
      const parent = await fs.lstat(reviews);
      const before = await fs.lstat(file);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
          (parent.mode & 0o077)) return blocked('unsafe_review_dir');
      if (!before.isFile() || before.isSymbolicLink() ||
          before.uid !== process.getuid() || before.nlink !== 1 ||
          (before.mode & 0o777) !== 0o600 || before.size > 1024 * 1024) return blocked('unsafe_review');
      handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) return blocked('unsafe_review');
      const content = await handle.readFile('utf8');
      const after = await fs.lstat(file);
      if (after.dev !== opened.dev || after.ino !== opened.ino ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs) return blocked('unsafe_review');
      try { return JSON.parse(content); }
      catch { return blocked('unsafe_review'); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async function readReview(operationId, candidateKey) {
    if (!validId(operationId) || typeof candidateKey !== 'string') return blocked('invalid_candidate');
    return withLock(async () => {
      const manifest = await read(manifestFile(operationId));
      const candidate = manifest?.candidates?.find(item => item.candidateKey === candidateKey);
      if (!candidate) return blocked('missing_candidate');
      const file = path.join(reviews, `${candidate.externalId}.json`);
      const record = await verifiedReviewFile(file);
      if (!record) return blocked('missing_review');
      if (record.kind === 'blocked') return record;
      return record.externalId === candidate.externalId && record.operationId === operationId &&
        record.payloadSha256 === candidate.payloadRef.sha256 &&
        record.digest === hash(JSON.stringify(record.review)) ? record : blocked('review_mismatch');
    });
  }
  async function sealReview(operationId, candidateKey, review) {
    if (!validId(operationId) || typeof candidateKey !== 'string' ||
        !['approve', 'correct', 'reject', 'duplicate'].includes(review?.decision)) return blocked('invalid_review');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      const candidate = manifest?.candidates?.find(item => item.candidateKey === candidateKey);
      const payload = row && candidate && await payloadValid(candidate.payloadRef, row, candidate);
      if (!row || !candidate || !payload) {
        return blocked('candidate_payload_mismatch');
      }
      if (review.payloadSha256 !== candidate.payloadRef.sha256) return blocked('review_source_mismatch');
      let sealedReview = review;
      if (['approve', 'correct'].includes(review.decision)) {
        const source = row.messages.find(message => message.messageId === payload.source_message_id &&
          message.start === payload.source_offsets.start && message.end === payload.source_offsets.end);
        const approved = review.operation?.text;
        const start = typeof approved === 'string' ? source?.text?.indexOf(approved) : -1;
        if (!source || !approved || approved.length > 8192 ||
            (payload.format_version === 3 && start < 0) ||
            review.operation.externalId !== candidate.externalId ||
            review.operation.projectId !== row.projectId ||
            review.operation.sessionId !== row.sessionId ||
            review.operation.metadata?.source !== source.messageId ||
            JSON.stringify(review.operation.metadata?.source_offsets) !==
              JSON.stringify(payload.source_offsets) ||
            review.operation.metadata?.checkpoint_id !== operationId ||
            review.operation.metadata?.scope !== payload.scope ||
            [2, 3, 4].includes(payload.format_version) && (
              review.operation.metadata?.type !== payload.type ||
              review.operation.metadata?.actor !== payload.actor ||
              review.operation.metadata?.speaker_role !== payload.speaker_role ||
              review.operation.metadata?.origin !== payload.origin ||
              review.operation.metadata?.evidence_at !== payload.evidence_at) ||
            (review.operation.metadata?.owner_id ?? null) !== (payload.owner_id ?? null)) {
          return blocked('review_source_mismatch');
        }
        if (payload.format_version === 2) {
          const meta = review.operation.metadata;
          if (!quotedV2Source(payload.text, payload, hash(source.text)) ||
              !quotedV2Source(approved, meta, hash(source.text)) ||
              meta.source_text_sha256 !== hash(source.text) ||
              meta.claim_sha256 !== hash(JSON.stringify([approved, meta.type, meta.scope,
                meta.condition ?? null, meta.valid_from ?? null, meta.valid_to ?? null])) ||
              !process.stdin.isTTY || !process.stdout.isTTY) return blocked('trusted_review_required');
          const { redactSource, containsSecret } = await import('./candidates.mjs');
          const safe = redactSource(source.text);
          if (safe === null || containsSecret(review.operation)) return blocked('sensitive_content');
          process.stdout.write(`Review ${candidateKey}\nClaim ${JSON.stringify(approved)}\n` +
            `Metadata ${JSON.stringify(meta)}\nSource ${JSON.stringify(safe)}\n` +
            `Payload SHA-256 ${candidate.payloadRef.sha256}\n`);
          const io = readline.createInterface({ input: process.stdin, output: process.stdout });
          let confirmed;
          try { confirmed = (await io.question('Confirm complete claim, metadata and source (yes): ')).trim(); }
          finally { io.close(); }
          if (confirmed !== 'yes') return blocked('owner_approval_required');
        }
        if (payload.format_version === 3) {
          const meta = review.operation.metadata;
          const { redactSource, containsSecret } = await import('./candidates.mjs');
          const baseline = await read(baselineFile(row.cli, row.sessionId));
          if (row.policyVersion !== POLICY_VERSION || payload.policy_version !== POLICY_VERSION ||
              review.decision !== 'approve' || review.mode !== 'automatic' ||
              review.actor !== 'project_auto_publisher' ||
              review.consentHash !== meta.auto_consent_hash ||
              !/^[a-f0-9]{64}$/.test(review.consentHash ?? '') ||
              meta.review_mode !== 'automatic' || meta.auto_actor !== review.actor ||
              meta.format_version !== 3 || approved !== payload.text ||
              source.origin !== 'human' || !source.text.includes(approved) ||
              !futureSourceValid(row, baseline, { cli: row.cli, sessionId: row.sessionId,
                projectId: row.projectId, ownerId: baseline?.ownerId,
                consentHash: review.consentHash }) ||
              meta.source_text_sha256 !== hash(source.text) ||
              meta.claim_sha256 !== hash(JSON.stringify([approved, meta.type, meta.scope,
                meta.condition ?? null, meta.valid_from ?? null, meta.valid_to ?? null])) ||
              containsSecret(review.operation) || redactSource(source.text) !== source.text) {
            return blocked('automatic_review_unproved');
          }
        }
        if (payload.format_version === 4) {
          const meta = review.operation.metadata;
          const { validateConversationProof } = await import('./conversation-proof.mjs');
          const { dedupKeyFor } = await import('./dedup-key.mjs');
          const { containsSecret } = await import('./candidates.mjs');
          const baseline = await read(baselineFile(row.cli, row.sessionId));
          let dedupKey;
          try { dedupKey = dedupKeyFor({ projectId: payload.project_id,
            scope: payload.scope, ownerId: payload.owner_id, type: payload.type,
            text: payload.text, condition: payload.condition,
            validFrom: payload.valid_from, validTo: payload.valid_to }); }
          catch { return blocked('automatic_review_unproved'); }
          if (row.policyVersion !== POLICY_VERSION || payload.policy_version !== POLICY_VERSION ||
              review.decision !== 'approve' || review.mode !== 'automatic' ||
              review.actor !== 'project_auto_publisher' ||
              review.consentHash !== meta.auto_consent_hash ||
              !/^[a-f0-9]{64}$/.test(review.consentHash ?? '') ||
              meta.review_mode !== 'automatic' || meta.auto_actor !== review.actor ||
              meta.format_version !== 4 || approved !== payload.text ||
              !futureSourceValid(row, baseline, { cli: row.cli, sessionId: row.sessionId,
                projectId: row.projectId, ownerId: baseline?.ownerId,
                consentHash: review.consentHash }) ||
              !validateConversationProof(payload, row).eligible ||
              !isDeepStrictEqual(meta.source_refs, payload.source_refs) ||
              meta.dedup_key !== payload.dedup_key || payload.dedup_key !== dedupKey ||
              meta.source_text_sha256 !== payload.source_text_sha256 ||
              meta.claim_sha256 !== payload.claim_sha256 ||
              containsSecret(review.operation)) return blocked('automatic_review_unproved');
        }
        sealedReview = { ...review, sourceProof: { messageId: source.messageId,
          messageSha256: hash(source.text), approvedTextSha256: hash(approved),
          ...([3, 4].includes(payload.format_version) ? { ownerId: payload.format_version === 4
            ? (await read(baselineFile(row.cli, row.sessionId)))?.ownerId : source.ownerId } : {}),
          ...(payload.format_version === 4 ? { refsSha256: hash(JSON.stringify(payload.source_refs)) } : {}),
          ...([2, 3, 4].includes(payload.format_version) ? { claimSha256: review.operation.metadata.claim_sha256 } :
            { start, end: start + approved.length }) } };
      }
      if (windows) {
        if (!(await ensureWindowsPrivateDirectory(reviews)).ok) return blocked('unsafe_review_dir');
        const file = path.join(reviews, `${candidate.externalId}.json`);
        if (await read(file)) return blocked('review_conflict');
        const record = { operationId, externalId: candidate.externalId,
          payloadSha256: candidate.payloadRef.sha256, review: sealedReview,
          digest: hash(JSON.stringify(sealedReview)) };
        const content = JSON.stringify(record) + '\n';
        if (await usageUnlocked() + 2 * allocated(content) + reserve > maxBytes) return { kind: 'full', operationId };
        await publishWindowsBinary(file, Buffer.from(content));
        return { kind: 'sealed', review: sealedReview, digest: record.digest };
      }
      await fs.mkdir(reviews, { recursive: true, mode: 0o700 });
      const directory = await fs.lstat(reviews);
      if (!directory.isDirectory() || directory.uid !== process.getuid() ||
          (directory.mode & 0o077)) return blocked('unsafe_review_dir');
      const file = path.join(reviews, `${candidate.externalId}.json`);
      const prior = await fs.lstat(file).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (prior) return blocked('review_conflict');
      const record = { operationId, externalId: candidate.externalId,
        payloadSha256: candidate.payloadRef.sha256, review: sealedReview,
        digest: hash(JSON.stringify(sealedReview)) };
      const content = JSON.stringify(record) + '\n';
      if (await usageUnlocked() + 2 * allocated(content) + reserve > maxBytes) return { kind: 'full', operationId };
      const temp = path.join(reviews, `.${randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await fs.link(temp, file);
        await syncDir(reviews);
      } finally { await handle.close(); await fs.rm(temp, { force: true }); }
      await syncDir(reviews);
      return { kind: 'sealed', review: sealedReview, digest: record.digest };
    });
  }
  async function ackVerified(operationId, proof) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row) {
        const receipt = await read(ackFile(operationId));
        if (receipt) return proof?.externalId === operationId && proof.projectId === receipt.projectId &&
            proof.status === 'active' && proof.sdkId === receipt.sdkId && proof.qdrantId === receipt.qdrantId
          ? { kind: 'acked', operationId } : blocked('unverified_remote');
        for (const name of await fs.readdir(root)) if (/^cursor-[a-f0-9]{64}\.json$/.test(name)) {
          const summary = await read(path.join(root, name));
          const entry = summary?.entries?.find(([id]) => id === operationId);
          if (entry) return proof?.externalId === operationId && proof.projectId === summary.projectId &&
              proof.status === 'active' && proof.sdkId && proof.qdrantId && proofDigest(proof) === entry[1]
            ? { kind: 'acked', operationId } : blocked('unverified_remote');
        }
        return blocked('missing_operation');
      }
      if (await read(manifestFile(operationId))) return blocked('manifest_requires_child_ack');
      if (proof?.externalId !== operationId || proof.projectId !== row.projectId ||
          proof.status !== 'active' || !proof.sdkId || !proof.qdrantId) return blocked('unverified_remote');
      const receipt = { operationId, projectId: row.projectId, cli: row.cli,
        sessionId: row.sessionId, start: row.start, end: row.end, sliceHash: row.sliceHash,
        policyVersion: row.policyVersion, sdkId: proof.sdkId, qdrantId: proof.qdrantId };
      if (!await fits(receipt)) return { kind: 'full', operationId };
      await durable(ackFile(operationId), receipt);
      await removeOwned(itemFile(operationId));
      await removeOwned(retryFile(operationId), true);
      await syncDir(items);
      if (reserve && await usageUnlocked() >= maxBytes * 0.8) await compactAcksUnlocked(row.cli, row.sessionId);
      return { kind: 'acked', operationId };
    });
  }
  async function recordManifest(operationId, candidates) {
    if (!validId(operationId) || !Array.isArray(candidates) || candidates.length > 5) return blocked('invalid_manifest');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      if (!row) return blocked('missing_operation');
      const seen = new Set();
      const entries = [];
      for (const candidate of candidates) {
        const candidateKey = candidate?.candidateKey;
        let externalId;
        try { externalId = externalIdFor({ projectId: row.projectId, originCli: row.cli,
          sessionId: row.sessionId, start: row.start, end: row.end, sliceHash: row.sliceHash,
          policyVersion: row.policyVersion, candidateKey }); } catch { return blocked('invalid_manifest'); }
        const evidence = candidate.evidence;
        if (!candidateKey || candidate.externalId !== externalId || seen.has(candidateKey) ||
            !evidence || !row.messages.some(message => message.messageId === evidence.messageId &&
              message.start === evidence.start && message.end === evidence.end) ||
            !await payloadValid(candidate.payloadRef, row, candidate)) return blocked('invalid_manifest');
        seen.add(candidateKey);
        entries.push({ candidateKey, externalId,
          evidence: { messageId: evidence.messageId, start: evidence.start, end: evidence.end },
          payloadRef: { sha256: candidate.payloadRef.sha256 },
          status: 'pending' });
      }
      const prior = await read(manifestFile(operationId));
      if (prior) {
        if (JSON.stringify(prior.candidates.map(({ candidateKey, externalId, evidence, payloadRef }) => ({ candidateKey, externalId, evidence, payloadRef }))) !==
            JSON.stringify(entries.map(({ candidateKey, externalId, evidence, payloadRef }) => ({ candidateKey, externalId, evidence, payloadRef })))) {
          throw new Error('manifest_conflict');
        }
        return { kind: 'manifested', operationId };
      }
      const manifest = { operationId, projectId: row.projectId,
        disposition: entries.length ? 'candidates' : 'no_facts', candidates: entries };
      if (!await fits(manifest)) {
        await compactProcessedUnlocked(row.cli, row.sessionId);
        if (!await fits(manifest)) return { kind: 'full', operationId };
      }
      await durable(manifestFile(operationId), manifest);
      return { kind: 'manifested', operationId };
    });
  }
  async function updateCandidate(operationId, candidateKey, status, reason, proof) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      if (!row || !manifest) return blocked('missing_manifest');
      const candidate = manifest.candidates.find(item => item.candidateKey === candidateKey);
      if (!candidate) return blocked('missing_candidate');
      if (!await payloadValid(candidate.payloadRef, row, candidate)) return blocked('candidate_payload_mismatch');
      if (candidate.status !== 'pending') {
        if (candidate.status !== status || status === 'remote_acked' &&
            (proof?.externalId !== candidate.externalId || proof.projectId !== row.projectId ||
              proof.status !== 'active' || proof.sdkId !== candidate.sdkId ||
              proof.qdrantId !== candidate.qdrantId) ||
            status === 'conflict' && proof?.reviewDigest !== candidate.reviewDigest ||
            status !== 'remote_acked' && reason !== candidate.reason) return blocked('candidate_already_terminal');
        return { kind: status === 'remote_acked' ? 'acked' : status === 'conflict' ? 'conflict' : 'disposed',
          ...(status === 'conflict' ? { reason } : {}), operationId: candidate.externalId };
      }
      if (status === 'remote_acked' && (proof?.externalId !== candidate.externalId ||
          proof.projectId !== row.projectId || proof.status !== 'active' || !proof.sdkId || !proof.qdrantId)) {
        return blocked('unverified_remote');
      }
      if (status === 'conflict') {
        const review = await verifiedReviewFile(path.join(reviews, `${candidate.externalId}.json`));
        if (!review || review.kind === 'blocked' || review.externalId !== candidate.externalId ||
            review.operationId !== operationId || review.payloadSha256 !== candidate.payloadRef.sha256 ||
            review.digest !== proof?.reviewDigest ||
            review.digest !== hash(JSON.stringify(review.review)) ||
            review.review?.decision !== 'correct' ||
            review.review.operation?.externalId !== candidate.externalId ||
            typeof review.review.target?.sdkId !== 'string' || !review.review.target.sdkId ||
            !validId(review.review.target.externalId) ||
            !/^[a-f0-9]{64}$/.test(review.review.target.version ?? '') ||
            review.review.operation?.metadata?.supersedes_id !== review.review.target.sdkId ||
            review.review.operation?.metadata?.correction_target_external_id !==
              review.review.target.externalId ||
            review.review.operation?.metadata?.correction_target_version !==
              review.review.target.version) {
          return blocked('review_mismatch');
        }
        candidate.target = structuredClone(review.review.target);
      }
      candidate.status = status;
      if (status === 'remote_acked') { candidate.sdkId = proof.sdkId; candidate.qdrantId = proof.qdrantId; }
      else candidate.reason = reason;
      if (status === 'conflict') candidate.reviewDigest = proof.reviewDigest;
      if (status === 'conflict' && !await conflictProofValid(operationId, candidate, row)) {
        return blocked('review_mismatch');
      }
      if (!await fits(manifest)) return { kind: 'full', operationId: candidate.externalId };
      await durable(manifestFile(operationId), manifest);
      return { kind: status === 'remote_acked' ? 'acked' : status === 'conflict' ? 'conflict' : 'disposed',
        ...(status === 'conflict' ? { reason } : {}), operationId: candidate.externalId };
    });
  }
  async function duplicateCandidate(operationId, candidateKey, proof) {
    if (!validId(operationId) || typeof candidateKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(proof?.dedupKey ?? '') ||
        !/^[a-f0-9]{64}$/.test(proof?.evidenceDigest ?? '') ||
        !validId(proof?.duplicateOf?.externalId) ||
        typeof proof?.duplicateOf?.sdkId !== 'string' || !proof.duplicateOf.sdkId ||
        typeof proof?.duplicateOf?.qdrantId !== 'string' || !proof.duplicateOf.qdrantId ||
        proof.duplicateOf.status !== 'active') return blocked('invalid_duplicate_proof');
    return withLock(async () => {
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      const candidate = manifest?.candidates?.find(item => item.candidateKey === candidateKey);
      const payload = row && candidate && await payloadValid(candidate.payloadRef, row, candidate);
      if (!row || !candidate || !payload || payload.format_version !== 4) {
        return blocked('candidate_payload_mismatch');
      }
      const { dedupKeyFor } = await import('./dedup-key.mjs');
      let exact;
      try { exact = dedupKeyFor({ projectId: payload.project_id, scope: payload.scope,
        ownerId: payload.owner_id, type: payload.type, text: payload.text,
        condition: payload.condition, validFrom: payload.valid_from, validTo: payload.valid_to }); }
      catch { return blocked('invalid_duplicate_proof'); }
      if (proof.projectId !== row.projectId || proof.dedupKey !== exact ||
          payload.dedup_key !== exact || proof.duplicateOf.externalId === candidate.externalId) {
        return blocked('duplicate_source_mismatch');
      }
      const review = await verifiedReviewFile(path.join(reviews, `${candidate.externalId}.json`));
      if (!review || review.kind === 'blocked' || review.operationId !== operationId ||
          review.externalId !== candidate.externalId ||
          review.payloadSha256 !== candidate.payloadRef.sha256 ||
          review.review?.mode !== 'automatic' || review.review?.decision !== 'approve' ||
          review.review?.operation?.metadata?.dedup_key !== exact ||
          review.digest !== hash(JSON.stringify(review.review))) return blocked('review_mismatch');
      const duplicateProof = { dedupKey: exact, duplicateOf: proof.duplicateOf,
        evidenceDigest: proof.evidenceDigest };
      if (candidate.status !== 'pending') return candidate.status === 'duplicate' &&
        isDeepStrictEqual(candidate.duplicateProof, duplicateProof)
        ? { kind: 'duplicate', operationId: candidate.externalId }
        : blocked('candidate_already_terminal');
      candidate.status = 'duplicate';
      candidate.reason = payload.context_generated && proof.duplicateOf.hasContext === false
        ? 'duplicate_without_context' : 'exact_remote_duplicate';
      candidate.duplicateProof = duplicateProof;
      if (!await fits(manifest)) return { kind: 'full', operationId: candidate.externalId };
      await durable(manifestFile(operationId), manifest);
      return { kind: 'duplicate', operationId: candidate.externalId };
    });
  }
  async function completeCheckpoint(operationId) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      if (await read(processedFile(operationId))) return { kind: 'processed', operationId };
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      if (!row || !manifest) return blocked('missing_manifest');
      if (!(await Promise.all(manifest.candidates.map(candidate => payloadValid(candidate.payloadRef, row, candidate)))).every(Boolean)) {
        return blocked('candidate_payload_mismatch');
      }
      if (manifest.candidates.some(candidate => candidate.status === 'pending')) return blocked('unresolved_candidates');
      const receipt = { operationId, projectId: row.projectId,
        cli: row.cli, sessionId: row.sessionId, start: row.start, end: row.end,
        sliceHash: row.sliceHash, policyVersion: row.policyVersion,
        disposition: manifest.disposition, candidates: manifest.candidates };
      if (!await fits(receipt)) {
        await compactProcessedUnlocked(row.cli, row.sessionId);
        if (!await fits(receipt)) return { kind: 'full', operationId };
      }
      await durable(processedFile(operationId), receipt);
      await removeOwned(itemFile(operationId));
      await removeOwned(manifestFile(operationId));
      await removeOwned(retryFile(operationId), true);
      await syncDir(items);
      if (manifest.disposition === 'no_facts' && await usageUnlocked() >= maxBytes * 0.6) {
        await compactProcessedUnlocked(row.cli, row.sessionId);
      }
      return { kind: 'processed', operationId };
    });
  }
  async function markFailed(operationId, reason, options = {}) {
    if (!validId(operationId) || typeof reason !== 'string' || !/^[a-z_]{1,64}$/.test(reason)) {
      return blocked('invalid_failure');
    }
    if (options.retryAt !== undefined &&
        (!Number.isSafeInteger(options.retryAt) || options.retryAt < 0)) {
      return blocked('invalid_retry_clock');
    }
    return withLock(async () => {
      if (await read(ackFile(operationId))) return { kind: 'acked', operationId };
      if (!await read(itemFile(operationId))) return blocked('missing_operation');
      const previous = await read(retryFile(operationId));
      if (previous && (!Number.isSafeInteger(previous.attempts) || previous.attempts < 1 ||
          previous.attempts > (previous.automatic ? Number.MAX_SAFE_INTEGER - 1 : 5))) {
        throw new Error('corrupt_retry');
      }
      const automatic = options.automatic === true;
      if (previous && (previous.automatic === true) !== automatic) return blocked('retry_mode_mismatch');
      const attempts = automatic ? (previous?.attempts ?? 0) + 1 : Math.min(5, (previous?.attempts ?? 0) + 1);
      const now = budgetClock();
      if (!Number.isSafeInteger(now) || now < 0) return blocked('invalid_retry_clock');
      const retryAt = options.retryAt === undefined
        ? now + Math.min(automatic ? 300000 : 60000,
          1000 * 2 ** Math.min(attempts - 1, 20))
        : Math.max(now, options.retryAt);
      const retry = { attempts, retryAt, lastError: reason, ...(automatic ? { automatic: true } : {}) };
      if (!await fits(retry)) return { kind: 'full', operationId };
      await durable(retryFile(operationId), retry);
      return { kind: 'pending', operationId, attempts, retryAt };
    });
  }
  async function ready(now = Date.now(), options = {}) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_retry_clock');
    return (await withLock(pendingUnlocked)).filter(row =>
      (row.attempts < 5 || options.automatic === true && row.automatic === true) && row.retryAt <= now);
  }
  async function readManifest(operationId) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      const manifest = await read(manifestFile(operationId));
      const row = await read(itemFile(operationId));
      if (!manifest || !row || manifest.operationId !== row.operationId ||
          manifest.projectId !== row.projectId) return blocked('missing_manifest');
      if (!Array.isArray(manifest.candidates) || manifest.candidates.length > 5 ||
          manifest.disposition !== (manifest.candidates.length ? 'candidates' : 'no_facts') ||
          new Set(manifest.candidates.map(candidate => candidate.candidateKey)).size !== manifest.candidates.length) {
        return blocked('corrupt_manifest');
      }
      for (const candidate of manifest.candidates) {
        let expected;
        try { expected = externalIdFor({ projectId: row.projectId, originCli: row.cli,
          sessionId: row.sessionId, start: row.start, end: row.end, sliceHash: row.sliceHash,
          policyVersion: row.policyVersion, candidateKey: candidate.candidateKey }); }
        catch { return blocked('corrupt_manifest'); }
        if (candidate.externalId !== expected || !row.messages.some(message =>
            message.messageId === candidate.evidence?.messageId && message.start === candidate.evidence.start &&
            message.end === candidate.evidence.end) ||
            !['pending', 'remote_acked', 'rejected', 'duplicate', 'conflict'].includes(candidate.status)) return blocked('corrupt_manifest');
        if (!await payloadValid(candidate.payloadRef, row, candidate)) return blocked('candidate_payload_mismatch');
        if (candidate.status === 'conflict' && !await conflictProofValid(operationId, candidate, row)) {
          return blocked('review_mismatch');
        }
      }
      return structuredClone(manifest);
    });
  }
  async function conflictProofValid(operationId, candidate, source) {
    if (!validId(candidate?.externalId) || source?.operationId !== operationId ||
        !/^[a-z_]{1,64}$/.test(candidate.reason ?? '') ||
        !/^[a-f0-9]{64}$/.test(candidate.reviewDigest ?? '') ||
        !/^[a-f0-9]{64}$/.test(candidate.payloadRef?.sha256 ?? '')) return false;
    const identity = { projectId: source?.projectId, originCli: source?.cli,
      sessionId: source?.sessionId, start: source?.start, end: source?.end,
      sliceHash: source?.sliceHash, policyVersion: source?.policyVersion,
      candidateKey: candidate.candidateKey };
    let checkpointId, candidateId;
    try {
      const { candidateKey, ...checkpoint } = identity;
      checkpointId = externalIdFor(checkpoint);
      candidateId = externalIdFor(identity);
    } catch { return false; }
    if (checkpointId !== operationId || candidateId !== candidate.externalId) return false;
    const record = await verifiedReviewFile(path.join(reviews, `${candidate.externalId}.json`));
    let reviewedId;
    try { reviewedId = externalIdFor(record?.review?.operation?.sourceIdentity); }
    catch { return false; }
    return record && record.kind !== 'blocked' && record.operationId === operationId &&
      reviewedId === candidate.externalId &&
      Object.keys(record.review.operation.sourceIdentity).length === Object.keys(identity).length &&
      Object.keys(identity).every(key => record.review.operation.sourceIdentity[key] === identity[key]) &&
      record.review.operation.projectId === source.projectId &&
      record.review.operation.sessionId === source.sessionId &&
      record.review.operation.metadata?.checkpoint_id === operationId &&
      record.externalId === candidate.externalId && record.payloadSha256 === candidate.payloadRef.sha256 &&
      record.digest === candidate.reviewDigest && record.digest === hash(JSON.stringify(record.review)) &&
      record.review?.decision === 'correct' &&
      JSON.stringify(record.review.target) === JSON.stringify(candidate.target) &&
      typeof candidate.target?.sdkId === 'string' && !!candidate.target.sdkId &&
      validId(candidate.target.externalId) && /^[a-f0-9]{64}$/.test(candidate.target.version ?? '') &&
      record.review.operation?.externalId === candidate.externalId &&
      record.review.operation?.metadata?.supersedes_id === candidate.target.sdkId &&
      record.review.operation?.metadata?.correction_target_external_id === candidate.target.externalId &&
      record.review.operation?.metadata?.correction_target_version === candidate.target.version;
  }
  async function readDisposition(operationId) {
    return withLock(async () => {
      const receipt = await read(processedFile(operationId));
      if (receipt?.candidates?.some(candidate => candidate.status === 'conflict' &&
          !candidate.reviewDigest)) return blocked('review_mismatch');
      for (const candidate of receipt?.candidates ?? []) {
        if (candidate.status === 'conflict' && !await conflictProofValid(operationId, candidate, receipt)) {
          return blocked('review_mismatch');
        }
      }
      return receipt;
    });
  }
  // Read only the exact durable source just accepted by captureEvent. This is
  // deliberately narrower than a transcript or outbox history API.
  async function handoffSource({ cli, sessionId, projectId, ownerId, operationId } = {}) {
    if (process.platform === 'win32' || !['claude', 'codex'].includes(cli) ||
        !sessionId || !projectId || !ownerId ||
        operationId != null && !validId(operationId)) return blocked('invalid_handoff_source');
    const files = operationId ? [itemFile(operationId), ackFile(operationId),
      processedFile(operationId)] : [conversationFile(cli, sessionId)];
    let row;
    for (const file of files) {
      try {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() ||
            (before.mode & 0o077) || before.size > 16 * 1024 * 1024) return blocked('unsafe_handoff_source');
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino ||
              opened.size !== before.size) return blocked('unsafe_handoff_source');
          row = JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') return blocked('unsafe_handoff_source');
      }
    }
    if (!row || row.cli !== cli || row.sessionId !== sessionId ||
        row.projectId !== projectId || row.policyVersion !== POLICY_VERSION ||
        !Array.isArray(row.messages) || !Number.isSafeInteger(row.start) ||
        !Number.isSafeInteger(row.end) || row.end <= row.start) return blocked('missing_handoff_source');
    const slices = operationId ? row.sourceSlices : row.parts;
    if (operationId ? row.operationId !== operationId ||
        !/^[a-f0-9]{64}$/.test(row.sliceHash ?? '') ||
        Array.isArray(slices) && hash(JSON.stringify(slices)) !== row.sliceHash
      : !Array.isArray(slices) || !slices.length ||
        !slices.every(part => /^[a-f0-9]{64}$/.test(part.sliceHash ?? ''))) {
      return blocked('invalid_handoff_proof');
    }
    const latest = [];
    for (const message of row.messages) {
      if (message?.sessionId !== sessionId || !Number.isSafeInteger(message.start) ||
          !Number.isSafeInteger(message.end) || message.start < row.start ||
          message.end > row.end || message.end <= message.start) return blocked('invalid_handoff_message');
      if (message.origin === 'human' && message.ownerId === ownerId ||
          message.origin === 'assistant' && message.finalVisible === true) {
        latest.push({ origin: message.origin, text: message.text,
          messageId: message.messageId, finalVisible: message.finalVisible === true,
          start: message.start, end: message.end,
          proofHash: hash(JSON.stringify([row.sliceHash ?? slices, message.messageId,
            message.start, message.end, message.text])) });
      }
    }
    return { kind: 'source', operationId: operationId ?? `stage-${hash(JSON.stringify(slices))}`,
      messages: latest.slice(-8) };
  }
  return { enqueueCheckpoint, enqueueConversationSlice, flushConversationStage,
    listConversationStages, handoffSource,
    ensureFutureBaseline, readFutureBaseline, futureSourceAllowed,
    ackVerified, recordManifest, persistCandidatePayload, sourceForRemote,
    claimExtraction, extractionBudget, recordExtractionUsage, extractionUsage, readCandidatePayload, readReview, sealReview,
    readManifest,
    ackCandidate: (id, key, proof) => updateCandidate(id, key, 'remote_acked', null, proof),
    duplicateCandidate,
    conflictCandidate: (id, key, reason, reviewDigest) =>
      /^[a-z_]{1,64}$/.test(reason ?? '') && /^[a-f0-9]{64}$/.test(reviewDigest ?? '')
        ? updateCandidate(id, key, 'conflict', reason, { reviewDigest }) : blocked('invalid_conflict'),
    disposeCandidate: (id, key, status, reason) =>
      ['rejected', 'duplicate'].includes(status) && /^[a-z_]{1,64}$/.test(reason ?? '')
        ? updateCandidate(id, key, status, reason) : blocked('invalid_disposition'),
    completeCheckpoint, readDisposition: id => validId(id)
      ? readDisposition(id) : blocked('invalid_operation'),
    pending: () => withLock(pendingUnlocked),
    cursor: (cli, sessionId) => withLock(() => cursorUnlocked(cli, sessionId)),
    usage: () => withLock(usageUnlocked), markFailed, ready };
}
