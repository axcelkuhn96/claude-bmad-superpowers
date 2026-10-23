import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { containsSecret } from './candidates.mjs';
import { dedupKeyFor } from './dedup-key.mjs';
import { targetVersion } from './correction.mjs';
import { externalIdFor, withProjectLock } from './ledger.mjs';
import { createWindowsState } from './windows-state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const blocked = reason => ({ kind: 'blocked', reason });
const directory = resolution => path.join(resolution.stateDir, 'mcp-requests');
const fileFor = (resolution, requestId) => path.join(directory(resolution), `${requestId}.json`);
const policyVersion = 'mcp-request-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameConsent = (a, b) => a?.version === 1 && a.enabled === true &&
  b?.version === 1 && b.enabled === true &&
  ['projectId', 'ownerId', 'consentHash', 'destinationHash', 'deviceId', 'enabledAt']
    .every(key => typeof a[key] === 'string' && a[key] && a[key] === b[key]);

async function readPrivate(file) {
  if (process.platform === 'win32') return createWindowsState(file).read();
  try {
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() ||
        dir.uid !== process.getuid() || stat.uid !== process.getuid() ||
        (dir.mode & 0o077) || (stat.mode & 0o077) || stat.size > 64 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePrivate(file, value) {
  if (process.platform === 'win32') {
    await createWindowsState(file).write(value);
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function createExplicitMcpRequest({ resolution, cli, profile, ownerId, consent,
  text, type = 'fact', scope = 'project', condition, correctionTarget } = {}) {
  const correctionVersion = correctionTarget && targetVersion(correctionTarget);
  if (correctionTarget && (!uuid.test(correctionTarget.sdkId ?? '') ||
      correctionTarget.projectId !== resolution?.projectId ||
      correctionTarget.status !== 'active' || !correctionVersion ||
      correctionTarget.metadata?.scope !== scope ||
      (scope === 'personal' && correctionTarget.metadata?.owner_id !== ownerId))) {
    return blocked('target_unavailable');
  }
  if (resolution?.provider !== 'mem0' || !['claude', 'codex'].includes(cli) ||
      typeof profile !== 'string' || !path.isAbsolute(profile) ||
      typeof ownerId !== 'string' || !ownerId || !sameConsent(consent, consent) ||
      consent.projectId !== resolution.projectId || consent.ownerId !== ownerId ||
      !['rule', 'fact', 'decision', 'preference'].includes(type) ||
      !(correctionTarget ? ['project', 'personal', 'episode'] : ['project', 'personal']).includes(scope) ||
      typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 8192 ||
      condition !== undefined && (typeof condition !== 'string' ||
        Buffer.byteLength(condition, 'utf8') > 512) ||
      containsSecret({ text, condition })) return blocked('invalid_request');
  // Normalize the MCP text and options with the selected target; this is not a native transcript.
  const args = { text, type, scope, ...(condition === undefined ? {} : { condition }),
    ...(correctionTarget ? { memory_id: correctionTarget.sdkId,
      target_version: correctionVersion } : {}) };
  const sourceBytes = JSON.stringify(args);
  const binding = [resolution.projectId, resolution.projectRoot, resolution.destination,
    ownerId, cli, profile, consent.consentHash, sourceBytes];
  const requestId = hash(JSON.stringify(binding));
  const sessionId = `${policyVersion}:${requestId}`;
  const sourceIdentity = { projectId: resolution.projectId, originCli: cli, sessionId,
    start: 0, end: Buffer.byteLength(sourceBytes), sliceHash: hash(sourceBytes), policyVersion };
  const externalId = externalIdFor(sourceIdentity);
  const request = { version: 1, requestId, sourceBytes, projectId: resolution.projectId,
    projectRoot: resolution.projectRoot, destination: resolution.destination,
    cli, profile, ownerId, consent, sourceIdentity };
  try {
    return await withProjectLock(resolution.stateDir, async () => {
      const file = fileFor(resolution, requestId);
      let record = await readPrivate(file);
      if (record && !isDeepStrictEqual({ ...record, createdAt: undefined,
        operation: undefined, ack: undefined }, { ...request, createdAt: undefined,
        operation: undefined, ack: undefined })) return blocked('request_conflict');
      if (!record) {
        const createdAt = new Date().toISOString();
        const operation = { op: 'add', externalId, projectId: resolution.projectId,
          sessionId, sourceIdentity, text,
          metadata: { format_version: 5,
            source: `mcp_request:${requestId}`, source_text_sha256: hash(sourceBytes),
            actor: 'mcp_agent', origin: 'assistant_report', speaker_role: 'assistant',
            review_mode: 'explicit_mcp', auto_consent_hash: consent.consentHash, scope,
            ...(scope === 'personal' ? { owner_id: ownerId } : {}),
            type, ...(condition === undefined ? {} : { condition }),
            ...(correctionTarget ? {
              supersedes_id: correctionTarget.sdkId,
              correction_target_external_id: correctionTarget.externalId,
              correction_target_version: correctionVersion,
              ...(correctionTarget.metadata?.valid_from
                ? { valid_from: correctionTarget.metadata.valid_from } : {}),
              ...(correctionTarget.metadata?.valid_to
                ? { valid_to: correctionTarget.metadata.valid_to } : {}),
            } : {}),
            evidence_at: createdAt, dedup_key: dedupKeyFor({ projectId: resolution.projectId,
              scope, ownerId: scope === 'personal' ? ownerId : undefined,
              type, text, condition,
              validFrom: correctionTarget?.metadata?.valid_from,
              validTo: correctionTarget?.metadata?.valid_to }) },
          approval: { kind: 'approved', mode: 'explicit_mcp' } };
        record = { ...request, createdAt, operation };
        await writePrivate(file, record);
      }
      return { kind: 'request', requestId, operation: record.operation,
        ack: record.ack ?? null };
    }, 'mcp-request.lock');
  } catch { return blocked('request_unavailable'); }
}

export async function createExplicitMcpDeleteRequest({ resolution, cli, profile, ownerId,
  consent, memoryId, expectedVersion } = {}) {
  if (resolution?.provider !== 'mem0' || !['claude', 'codex'].includes(cli) ||
      typeof profile !== 'string' || !path.isAbsolute(profile) ||
      typeof ownerId !== 'string' || !ownerId || !sameConsent(consent, consent) ||
      consent.projectId !== resolution.projectId || consent.ownerId !== ownerId ||
      !uuid.test(memoryId ?? '') || !/^[a-f0-9]{64}$/.test(expectedVersion ?? '')) {
    return blocked('invalid_request');
  }
  const sourceBytes = JSON.stringify({ operation: 'delete', memory_id: memoryId,
    target_version: expectedVersion });
  const requestId = hash(JSON.stringify([resolution.projectId, resolution.projectRoot,
    resolution.destination, ownerId, cli, profile, consent.consentHash, sourceBytes]));
  const operation = { op: 'delete_curated', projectId: resolution.projectId,
    ownerId, memoryId, expectedVersion, requestId,
    approval: { kind: 'approved', mode: 'explicit_mcp' } };
  const request = { version: 1, requestId, sourceBytes, projectId: resolution.projectId,
    projectRoot: resolution.projectRoot, destination: resolution.destination,
    cli, profile, ownerId, consent, operation };
  try {
    return await withProjectLock(resolution.stateDir, async () => {
      const file = fileFor(resolution, requestId);
      const existing = await readPrivate(file);
      if (existing && !isDeepStrictEqual({ ...existing, createdAt: undefined },
        { ...request, createdAt: undefined })) return blocked('request_conflict');
      if (!existing) await writePrivate(file, { ...request, createdAt: new Date().toISOString() });
      return { kind: 'request', requestId, operation };
    }, 'mcp-request.lock');
  } catch { return blocked('request_unavailable'); }
}

async function sourceForExplicitMcpDelete(operation, resolution) {
  if (operation?.op !== 'delete_curated' ||
      operation.approval?.mode !== 'explicit_mcp' ||
      !/^[a-f0-9]{64}$/.test(operation.requestId ?? '')) return blocked('mcp_source_unproved');
  try {
    const record = await readPrivate(fileFor(resolution, operation.requestId));
    if (!record || !isDeepStrictEqual(record.operation, operation) ||
        record.projectId !== resolution.projectId || record.ownerId !== resolution.ownerId ||
        record.projectRoot !== resolution.projectRoot ||
        !isDeepStrictEqual(record.destination, resolution.destination) ||
        !sameConsent(record.consent, resolution.extractor?.autoPublishConsent) ||
        resolution.extractor?.autoPublish !== true ||
        hash(JSON.stringify([record.projectId, record.projectRoot, record.destination,
          record.ownerId, record.cli, record.profile, record.consent?.consentHash,
          record.sourceBytes])) !== operation.requestId ||
        record.sourceBytes !== JSON.stringify({ operation: 'delete',
          memory_id: operation.memoryId, target_version: operation.expectedVersion }) ||
        !uuid.test(operation.memoryId ?? '') ||
        !/^[a-f0-9]{64}$/.test(operation.expectedVersion ?? '')) return blocked('mcp_source_unproved');
    return { kind: 'local_source', requestId: operation.requestId, record };
  } catch { return blocked('mcp_source_unproved'); }
}

export async function sourceForExplicitMcp(operation, resolution) {
  if (operation?.op === 'delete_curated') return sourceForExplicitMcpDelete(operation, resolution);
  if (operation?.metadata?.format_version !== 5 ||
      operation.metadata.review_mode !== 'explicit_mcp' ||
      operation.approval?.mode !== 'explicit_mcp' ||
      operation.metadata.origin !== 'assistant_report' ||
      operation.metadata.speaker_role !== 'assistant' ||
      operation.metadata.actor !== 'mcp_agent' ||
      operation.sourceIdentity?.policyVersion !== policyVersion ||
      operation.projectId !== resolution?.projectId) return blocked('mcp_source_unproved');
  const requestId = operation.sessionId?.slice(`${policyVersion}:`.length);
  if (!/^[a-f0-9]{64}$/.test(requestId ?? '') ||
      operation.sessionId !== `${policyVersion}:${requestId}` ||
      operation.metadata.source !== `mcp_request:${requestId}`) return blocked('mcp_source_unproved');
  try {
    const record = await readPrivate(fileFor(resolution, requestId));
    if (!record || record.requestId !== requestId ||
        record.projectId !== resolution.projectId ||
        record.ownerId !== resolution.ownerId ||
        !sameConsent(record.consent, resolution.extractor?.autoPublishConsent) ||
        resolution.extractor?.autoPublish !== true ||
        record.projectRoot !== resolution.projectRoot ||
        !isDeepStrictEqual(record.destination, resolution.destination) ||
        !isDeepStrictEqual(record.operation, operation) ||
        !isDeepStrictEqual(record.sourceIdentity, operation.sourceIdentity) ||
        hash(record.sourceBytes) !== operation.sourceIdentity.sliceHash ||
        hash(record.sourceBytes) !== operation.metadata.source_text_sha256 ||
        record.sourceIdentity.end !== Buffer.byteLength(record.sourceBytes) ||
        hash(JSON.stringify([record.projectId, record.projectRoot, record.destination,
          record.ownerId, record.cli, record.profile, record.consent?.consentHash,
          record.sourceBytes])) !== requestId ||
        !sameConsent(record.consent, record.consent) ||
        externalIdFor(operation.sourceIdentity) !== operation.externalId ||
        containsSecret(JSON.parse(record.sourceBytes))) return blocked('mcp_source_unproved');
    const args = JSON.parse(record.sourceBytes);
    if (args.text !== operation.text || args.type !== operation.metadata.type ||
        args.scope !== operation.metadata.scope ||
        args.condition !== operation.metadata.condition ||
        args.memory_id !== operation.metadata.supersedes_id ||
        args.target_version !== operation.metadata.correction_target_version) return blocked('mcp_source_unproved');
    return { kind: 'local_source', requestId, record };
  } catch { return blocked('mcp_source_unproved'); }
}

export async function ackExplicitMcpRequest(operation, resolution, externalId, proof) {
  if (externalId !== operation?.externalId || !proof?.sdkId || !proof?.qdrantId ||
      proof.status !== 'active' || proof.externalId !== externalId ||
      proof.projectId !== operation.projectId) return blocked('remote_ack_unproved');
  const requestId = operation.sessionId?.slice(`${policyVersion}:`.length);
  try {
    return await withProjectLock(resolution.stateDir, async () => {
      const source = await sourceForExplicitMcp(operation, resolution);
      if (source.kind !== 'local_source') return source;
      const file = fileFor(resolution, requestId);
      const ack = { externalId, sdkId: proof.sdkId, qdrantId: proof.qdrantId };
      if (source.record.ack && !isDeepStrictEqual(source.record.ack, ack)) return blocked('ack_conflict');
      if (!source.record.ack) await writePrivate(file, { ...source.record, ack });
      return { kind: 'acked', operationId: externalId };
    }, 'mcp-request.lock');
  } catch { return blocked('local_ack_failed'); }
}
