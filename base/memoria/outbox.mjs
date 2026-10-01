import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { externalIdFor } from './ledger.mjs';

const DEFAULT_MAX = 256 * 1024 * 1024;
const blocked = reason => ({ kind: 'blocked', reason });
const validId = id => typeof id === 'string' && /^src-[a-f0-9]{64}$/.test(id);
const proofDigest = proof => createHash('sha256').update(JSON.stringify([proof.sdkId, proof.qdrantId])).digest('hex');

export function createOutbox(stateDir, options = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('invalid_state_dir');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_outbox_limit');
  const reserve = maxBytes >= 64 * 1024 * 1024 ? 16 * 1024 * 1024 : 0;
  const root = path.join(stateDir, 'outbox');
  const items = path.join(root, 'items');
  const acks = path.join(root, 'acks');
  const processed = path.join(root, 'processed');
  const lock = path.join(root, 'lock');
  const itemFile = id => path.join(items, `${id}.json`);
  const ackFile = id => path.join(acks, `${id}.json`);
  const processedFile = id => path.join(processed, `${id}.json`);
  const manifestFile = id => path.join(items, `${id}.manifest.json`);
  const retryFile = id => path.join(items, `${id}.retry.json`);
  const summaryFile = (cli, sessionId) => path.join(root,
    `cursor-${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.json`);

  async function syncDir(dir) {
    const h = await fs.open(dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  }
  async function ensure() {
    if (process.platform === 'win32' || !process.getuid) throw new Error('native_windows_unproved');
    for (const dir of [stateDir, root, items, acks, processed]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('unsafe_outbox_dir');
    }
  }
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function durable(file, value) {
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
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  async function withLock(callback) {
    await ensure();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
        try {
          for (const dir of [items, acks, processed]) {
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
          return await callback();
        }
        finally { await fs.rm(lock, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
        if (owner && owner !== process.pid) {
          try { process.kill(owner, 0); }
          catch (e) { if (e.code === 'ESRCH') { await fs.rm(lock, { recursive: true, force: true }); continue; } }
        }
        if (!owner && Date.now() - (await fs.stat(lock)).mtimeMs > 1000) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
    throw new Error('outbox_lock_timeout');
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
      if (retry && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 5 ||
          !Number.isSafeInteger(retry.retryAt) || typeof retry.lastError !== 'string')) {
        throw new Error('corrupt_retry');
      }
      return { ...row, ...(retry ?? { attempts: 0, retryAt: 0, lastError: null }) };
    }));
  }
  function cursorFrom(rows, cli, sessionId, summary = null) {
    rows = rows.filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    let queuedEnd = summary?.queuedEnd ?? 0;
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
    return cursorFrom(unique(await records()), cli, sessionId, await read(summaryFile(cli, sessionId)));
  }
  async function compactAcksUnlocked(cli, sessionId) {
    const prior = await read(summaryFile(cli, sessionId));
    let rows = unique(await records()).filter(row => row.cli === cli && row.sessionId === sessionId)
      .sort((a, b) => a.start - b.start);
    if (prior) {
      let removed = false;
      for (const row of rows) if (row.acknowledged && row.end <= prior.queuedEnd) {
        if (row.projectId !== prior.projectId || row.policyVersion !== prior.policyVersion) {
          throw new Error('cursor_source_mismatch');
        }
        await fs.rm(ackFile(row.operationId));
        removed = true;
      }
      if (removed) await syncDir(acks);
      rows = rows.filter(row => row.end > prior.queuedEnd);
    }
    let end = prior?.queuedEnd ?? 0;
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
      policyVersion: last.policyVersion, queuedEnd: end, ackedEnd: end, processedEnd: end,
      entries: [...(prior?.entries ?? []), ...removable.map(row =>
        [row.operationId, proofDigest(row)])] };
    if (!await fits(snapshot)) return;
    await durable(summaryFile(cli, sessionId), snapshot);
    for (const row of removable) await fs.rm(ackFile(row.operationId));
    await syncDir(acks);
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
      const position = cursorFrom(rows, cli, sessionId, summary);
      if (start !== position.queuedEnd) return blocked('cursor_gap');
      const row = { operationId, projectId, cli, sessionId, start, end, sliceHash, policyVersion, messages };
      const size = Buffer.byteLength(JSON.stringify(row) + '\n');
      let used = await usageUnlocked();
      if (used + size + reserve > maxBytes) {
        await compactAcksUnlocked(cli, sessionId);
        used = await usageUnlocked();
      }
      if (used + size + reserve > maxBytes) return { kind: 'full', operationId, usedBytes: used, maxBytes };
      await durable(itemFile(operationId), row);
      return { kind: 'queued', operationId, alert: used + size >= maxBytes * 0.8,
        usedBytes: used + size };
    });
  }
  async function usageUnlocked() {
    let bytes = 0;
    for (const dir of [items, acks, processed, root]) {
      for (const name of await fs.readdir(dir)) {
        if (dir === root && !name.endsWith('.json')) continue;
        const stat = await fs.lstat(path.join(dir, name));
        if (stat.isFile()) bytes += stat.size;
      }
    }
    return bytes;
  }
  async function fits(value) {
    return await usageUnlocked() + Buffer.byteLength(JSON.stringify(value) + '\n') <= maxBytes;
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
      await fs.rm(itemFile(operationId));
      await fs.rm(retryFile(operationId), { force: true });
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
              message.start === evidence.start && message.end === evidence.end)) return blocked('invalid_manifest');
        seen.add(candidateKey);
        entries.push({ candidateKey, externalId,
          evidence: { messageId: evidence.messageId, start: evidence.start, end: evidence.end },
          status: 'pending' });
      }
      const prior = await read(manifestFile(operationId));
      if (prior) {
        if (JSON.stringify(prior.candidates.map(({ candidateKey, externalId, evidence }) => ({ candidateKey, externalId, evidence }))) !==
            JSON.stringify(entries.map(({ candidateKey, externalId, evidence }) => ({ candidateKey, externalId, evidence })))) {
          throw new Error('manifest_conflict');
        }
        return { kind: 'manifested', operationId };
      }
      const manifest = { operationId, projectId: row.projectId,
        disposition: entries.length ? 'candidates' : 'no_facts', candidates: entries };
      if (!await fits(manifest)) return { kind: 'full', operationId };
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
      if (candidate.status !== 'pending') {
        if (candidate.status !== status || status === 'remote_acked' &&
            (proof?.externalId !== candidate.externalId || proof.projectId !== row.projectId ||
              proof.status !== 'active' || proof.sdkId !== candidate.sdkId ||
              proof.qdrantId !== candidate.qdrantId) ||
            status !== 'remote_acked' && reason !== candidate.reason) return blocked('candidate_already_terminal');
        return { kind: status === 'remote_acked' ? 'acked' : 'disposed', operationId: candidate.externalId };
      }
      if (status === 'remote_acked' && (proof?.externalId !== candidate.externalId ||
          proof.projectId !== row.projectId || proof.status !== 'active' || !proof.sdkId || !proof.qdrantId)) {
        return blocked('unverified_remote');
      }
      candidate.status = status;
      if (status === 'remote_acked') { candidate.sdkId = proof.sdkId; candidate.qdrantId = proof.qdrantId; }
      else candidate.reason = reason;
      if (!await fits(manifest)) return { kind: 'full', operationId: candidate.externalId };
      await durable(manifestFile(operationId), manifest);
      return { kind: status === 'remote_acked' ? 'acked' : 'disposed', operationId: candidate.externalId };
    });
  }
  async function completeCheckpoint(operationId) {
    if (!validId(operationId)) return blocked('invalid_operation');
    return withLock(async () => {
      if (await read(processedFile(operationId))) return { kind: 'processed', operationId };
      const row = await read(itemFile(operationId));
      const manifest = await read(manifestFile(operationId));
      if (!row || !manifest) return blocked('missing_manifest');
      if (manifest.candidates.some(candidate => candidate.status === 'pending')) return blocked('unresolved_candidates');
      const receipt = { operationId, projectId: row.projectId,
        cli: row.cli, sessionId: row.sessionId, start: row.start, end: row.end,
        sliceHash: row.sliceHash, policyVersion: row.policyVersion,
        disposition: manifest.disposition, candidates: manifest.candidates };
      if (!await fits(receipt)) return { kind: 'full', operationId };
      await durable(processedFile(operationId), receipt);
      await fs.rm(itemFile(operationId));
      await fs.rm(manifestFile(operationId));
      await fs.rm(retryFile(operationId), { force: true });
      await syncDir(items);
      return { kind: 'processed', operationId };
    });
  }
  async function markFailed(operationId, reason) {
    if (!validId(operationId) || typeof reason !== 'string' || !/^[a-z_]{1,64}$/.test(reason)) {
      return blocked('invalid_failure');
    }
    return withLock(async () => {
      if (await read(ackFile(operationId))) return { kind: 'acked', operationId };
      if (!await read(itemFile(operationId))) return blocked('missing_operation');
      const previous = await read(retryFile(operationId));
      if (previous && (!Number.isSafeInteger(previous.attempts) || previous.attempts < 1 ||
          previous.attempts > 5)) throw new Error('corrupt_retry');
      const attempts = Math.min(5, (previous?.attempts ?? 0) + 1);
      const retryAt = Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1));
      const retry = { attempts, retryAt, lastError: reason };
      if (!await fits(retry)) return { kind: 'full', operationId };
      await durable(retryFile(operationId), retry);
      return { kind: 'pending', operationId, attempts, retryAt };
    });
  }
  async function ready(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_retry_clock');
    return (await withLock(pendingUnlocked)).filter(row => row.attempts < 5 && row.retryAt <= now);
  }
  return { enqueueCheckpoint, ackVerified, recordManifest,
    ackCandidate: (id, key, proof) => updateCandidate(id, key, 'remote_acked', null, proof),
    disposeCandidate: (id, key, status, reason) =>
      ['rejected', 'duplicate'].includes(status) && /^[a-z_]{1,64}$/.test(reason ?? '')
        ? updateCandidate(id, key, status, reason) : blocked('invalid_disposition'),
    completeCheckpoint, readDisposition: id => validId(id)
      ? withLock(() => read(processedFile(id))) : blocked('invalid_operation'),
    pending: () => withLock(pendingUnlocked),
    cursor: (cli, sessionId) => withLock(() => cursorUnlocked(cli, sessionId)),
    usage: () => withLock(usageUnlocked), markFailed, ready };
}
