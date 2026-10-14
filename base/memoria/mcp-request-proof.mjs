import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { containsSecret } from './candidates.mjs';
import { dedupKeyFor } from './dedup-key.mjs';
import { externalIdFor, withProjectLock } from './ledger.mjs';
import { createWindowsState } from './windows-state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const blocked = reason => ({ kind: 'blocked', reason });
const directory = resolution => path.join(resolution.stateDir, 'mcp-requests');
const fileFor = (resolution, requestId) => path.join(directory(resolution), `${requestId}.json`);
const policyVersion = 'mcp-request-v1';
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
  text, type = 'fact', scope = 'project', condition } = {}) {
  if (resolution?.provider !== 'mem0' || !['claude', 'codex'].includes(cli) ||
      typeof profile !== 'string' || !path.isAbsolute(profile) ||
      typeof ownerId !== 'string' || !ownerId || !sameConsent(consent, consent) ||
      consent.projectId !== resolution.projectId || consent.ownerId !== ownerId ||
      !['rule', 'fact', 'decision', 'preference'].includes(type) ||
      !['project', 'personal'].includes(scope) ||
      typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 8192 ||
      condition !== undefined && (typeof condition !== 'string' ||
        Buffer.byteLength(condition, 'utf8') > 512) ||
      containsSecret({ text, condition })) return blocked('invalid_request');
  // This is the actual parsed MCP argument object, serialized canonically; it is not a native transcript.
  const args = { text, type, scope, ...(condition === undefined ? {} : { condition }) };
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
            evidence_at: createdAt, dedup_key: dedupKeyFor({ projectId: resolution.projectId,
              scope, ownerId: scope === 'personal' ? ownerId : undefined,
              type, text, condition }) },
          approval: { kind: 'approved', mode: 'explicit_mcp' } };
        record = { ...request, createdAt, operation };
        await writePrivate(file, record);
      }
      return { kind: 'request', requestId, operation: record.operation,
        ack: record.ack ?? null };
    }, 'mcp-request.lock');
  } catch { return blocked('request_unavailable'); }
}

export async function sourceForExplicitMcp(operation, resolution) {
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
        args.condition !== operation.metadata.condition) return blocked('mcp_source_unproved');
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
