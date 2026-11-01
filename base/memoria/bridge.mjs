import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeCurrentDestination } from './setup.mjs';
import { resolveProject } from './provider.mjs';
import { runtimePython } from './runtime.mjs';
import { requestBroker } from './broker.mjs';
import { ensureBrokerReady } from './broker-start.mjs';
import { createLedger, externalIdFor, reconcileStore, withProjectLock } from './ledger.mjs';
import { assertWriter, writerConnection } from './authority.mjs';
import { targetVersion } from './correction.mjs';
import { createOutbox } from './outbox.mjs';
import { dedupKeyFor } from './dedup-key.mjs';
import { sourceForExplicitMcp } from './mcp-request-proof.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'mem0_adapter.py');
const sameAutoConsent = (frozen, live, resolution) => frozen?.version === 1 &&
  frozen.enabled === true && live?.version === 1 && live.enabled === true &&
  resolution.extractor?.autoPublish === true &&
  resolution.ownerId === frozen.ownerId &&
  frozen.projectId === resolution.projectId && live.projectId === resolution.projectId &&
  ['consentHash', 'destinationHash', 'ownerId', 'deviceId', 'enabledAt']
    .every(key => typeof frozen[key] === 'string' && frozen[key] &&
      frozen[key] === live[key] && frozen[key] === resolution.extractor.autoPublishConsent?.[key]);
async function autoConsentCurrent(resolution, frozen, options) {
  const read = options.readAutoPublish ?? (await import('./policy.mjs')).readAutoPublish;
  return sameAutoConsent(frozen, await read(resolution), resolution);
}

export async function runBridgeOperation(cwd, sessionId, operation, readSecret, options = {}) {
  const deadlineAt = options.deadlineAt ?? (options.deadlineMs != null ? Date.now() + options.deadlineMs : null);
  if (deadlineAt !== null && deadlineAt <= Date.now()) return blocked('deadline');
  const resolution = await (options.resolve ?? resolveProject)(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || operation.projectId !== resolution.projectId) {
    return blocked('project_mismatch');
  }
  const auth = await (options.authorize ?? authorizeCurrentDestination)(cwd, sessionId, readSecret,
    { ...options, deadlineAt });
  if (auth.kind !== 'authorized') return auth;
  if (['add', 'activate'].includes(operation.op)) {
    const writer = await assertWriter(resolution, auth, options);
    if (writer.kind !== 'writer') return blocked(writer.reason ?? 'writer_authority_unavailable');
    if (options.autoPublishConsent &&
        !await autoConsentCurrent(resolution, options.autoPublishConsent, options)) {
      return blocked('auto_publish_revoked');
    }
    if (operation.approval?.mode === 'automatic' && !options.autoPublishConsent) {
      return blocked('auto_publish_unproved');
    }
    const explicit = operation.approval?.mode === 'explicit_mcp' ||
      operation.metadata?.format_version === 5 || options.explicitMcpSource;
    if (explicit) {
      const source = options.explicitMcpSource ?? operation;
      if (!options.run || !options.autoPublishConsent ||
          source.approval?.mode !== 'explicit_mcp' ||
          source.metadata?.format_version !== 5 ||
          !await autoConsentCurrent(resolution, options.autoPublishConsent, options) ||
          (await sourceForExplicitMcp(source, resolution)).kind !== 'local_source') {
        return blocked('explicit_mcp_unproved');
      }
    }
  }
  const remaining = deadlineAt === null ? options.deadlineMs ?? undefined : Math.floor(deadlineAt - Date.now());
  if (deadlineAt !== null && remaining <= 0) return blocked('deadline');
  const request = { ...operation, collection: resolution.destination.collection,
    connection: writerConnection(resolution, auth.connection) };
  const env = { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
  if (options.run) return options.run(runtimePython(resolution.stateDir), script, request, env, Buffer.from(auth.key));
  return requestBroker({ cwd, sessionId, operation,
    ...(['add', 'activate'].includes(operation.op) && options.autoPublishConsent
      ? { autoPublishConsent: options.autoPublishConsent } : {}) }, auth.key,
    { stateRoot: options.stateRoot, deadlineMs: remaining });
}

export async function storeMemory(cwd, sessionId, operation, readSecret, options = {}) {
  if (!operation?.externalId || !operation?.projectId || !operation?.sessionId ||
      !operation?.text || !operation?.metadata?.source || !operation.metadata.actor ||
      !operation.metadata.origin || !operation.metadata.scope || !operation.metadata.evidence_at ||
      operation.approval?.kind !== 'approved' ||
      (operation.metadata.scope === 'personal' && !operation.metadata.owner_id)) return blocked('invalid_store');
  try {
    if (externalIdFor(operation.sourceIdentity) !== operation.externalId ||
        operation.sourceIdentity.projectId !== operation.projectId ||
        operation.sourceIdentity.sessionId !== operation.sessionId) return blocked('source_identity_mismatch');
  } catch { return blocked('invalid_source_identity'); }
  const resolution = await (options.resolve ?? resolveProject)(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || resolution.projectId !== operation.projectId) return blocked('project_mismatch');
  const explicitMcp = operation.metadata.format_version === 5 ||
    operation.metadata.review_mode === 'explicit_mcp' || operation.approval?.mode === 'explicit_mcp';
  if (explicitMcp) {
    if (operation.metadata.format_version !== 5 ||
        operation.metadata.review_mode !== 'explicit_mcp' ||
        operation.approval?.mode !== 'explicit_mcp' ||
        operation.metadata.origin !== 'assistant_report' ||
        operation.metadata.speaker_role !== 'assistant' ||
        operation.metadata.actor !== 'mcp_agent' ||
        operation.metadata.auto_consent_hash !== options.autoPublishConsent?.consentHash ||
        !options.run || !await autoConsentCurrent(resolution, options.autoPublishConsent, options)) {
      return blocked('explicit_mcp_unproved');
    }
    if ((await sourceForExplicitMcp(operation, resolution)).kind !== 'local_source') {
      return blocked('explicit_mcp_source_unproved');
    }
  } else if (operation.metadata.review_mode === 'automatic' || operation.approval?.mode === 'automatic') {
    if (operation.metadata.review_mode !== 'automatic' || operation.approval?.mode !== 'automatic' ||
        ![3, 4].includes(operation.metadata.format_version) ||
        operation.metadata.format_version === 4 &&
          (operation.metadata.origin !== 'conversation_summary' ||
            operation.metadata.speaker_role !== 'mixed' ||
            operation.metadata.actor !== 'conversation') ||
        operation.metadata.auto_actor !== 'project_auto_publisher' ||
        operation.metadata.auto_consent_hash !== options.autoPublishConsent?.consentHash ||
        !await autoConsentCurrent(resolution, options.autoPublishConsent, options)) {
      return blocked('auto_publish_unproved');
    }
  }
  const deduplicated = [4, 5].includes(operation.metadata.format_version);
  if (deduplicated) {
    let expected;
    try { expected = dedupKeyFor({ projectId: operation.projectId,
      scope: operation.metadata.scope, ownerId: operation.metadata.owner_id,
      type: operation.metadata.type, text: operation.text,
      condition: operation.metadata.condition, validFrom: operation.metadata.valid_from,
      validTo: operation.metadata.valid_to }); }
    catch { return blocked('dedup_key_mismatch'); }
    if (operation.metadata.dedup_key !== expected) return blocked('dedup_key_mismatch');
  }
  if ([2, 3, 4].includes(operation.metadata.format_version)) {
    const source = await createOutbox(resolution.stateDir).sourceForRemote(operation);
    if (source.kind !== 'local_source') return blocked('source_review_unproved');
  }
  const bridgeOptions = explicitMcp ? { ...options, explicitMcpSource: operation } : options;
  const bridge = request => runBridgeOperation(cwd, sessionId, request, readSecret, bridgeOptions);
  const response = await withProjectLock(resolution.stateDir, async () => {
    const auth = await (options.authorize ?? authorizeCurrentDestination)(cwd, sessionId, readSecret, options);
    if (auth.kind !== 'authorized') return auth;
    const writer = await assertWriter(resolution, auth, options);
    if (writer.kind !== 'writer') return blocked(writer.reason ?? 'writer_authority_unavailable');
    if ((operation.approval?.mode === 'automatic' || explicitMcp) &&
        !await autoConsentCurrent(resolution, options.autoPublishConsent, options)) {
      return blocked('auto_publish_revoked');
    }
    if (operation.approval?.mode === 'automatic' && !options.run) {
      let ready;
      try {
        ready = await (options.ensureBrokerReady ?? ensureBrokerReady)(cwd,
          { stateRoot: options.stateRoot, bootstrapSessionId: sessionId });
      } catch { return blocked('broker_unavailable'); }
      if (ready?.kind !== 'ready') return ready?.kind === 'blocked'
        ? ready : blocked('broker_unavailable');
    }
    if (deduplicated) {
      const duplicate = await bridge({ op: 'dedup_find', projectId: operation.projectId,
        externalId: operation.externalId, sessionId: operation.sessionId,
        text: operation.text, metadata: operation.metadata });
      if (duplicate.kind === 'duplicate') {
        if (duplicate.dedupKey !== operation.metadata.dedup_key ||
            duplicate.duplicateOf?.externalId === operation.externalId ||
            duplicate.duplicateOf?.status !== 'active' ||
            !/^[a-f0-9]{64}$/.test(duplicate.evidenceDigest ?? '')) {
          return blocked('dedup_proof_mismatch');
        }
        return duplicate;
      }
      if (duplicate.kind === 'pending') return duplicate;
      if (duplicate.kind !== 'clear') return blocked(duplicate.reason ?? 'dedup_lookup_failed');
    }
    const checkTarget = async () => {
      const targetId = operation.metadata.supersedes_id;
      if (!targetId) return { kind: 'eligible' };
      const result = await bridge({ op: 'read', projectId: operation.projectId, sdkId: targetId });
      const target = result.item;
      if (result.kind !== 'item' || !target || target.projectId !== operation.projectId ||
          target.externalId !== operation.metadata.correction_target_external_id ||
          target.metadata?.scope !== operation.metadata.scope ||
          (operation.metadata.scope === 'personal' &&
            target.metadata?.owner_id !== operation.metadata.owner_id)) return { kind: 'conflict', reason: 'target_changed' };
      if (target.status === 'active' &&
          targetVersion(target) === operation.metadata.correction_target_version) return { kind: 'eligible' };
      if (target.status === 'superseded' &&
          target.metadata.superseded_by_external_id === operation.externalId) return { kind: 'eligible' };
      return { kind: 'conflict', reason: 'target_changed' };
    };
    const target = await checkTarget();
    if (target.kind !== 'eligible') return target;
    return reconcileStore(operation, {
    ledger: createLedger(resolution.stateDir, writer.deviceId),
    findRemote: async externalId => {
      const result = await bridge({ op: 'find', projectId: operation.projectId, externalId });
      if (result.kind !== 'items') throw Object.assign(new Error('remote_read_failed'), { code: result.reason ?? 'remote_read_failed' });
      return result.items;
    },
    addViaSdk: async () => {
      const result = await bridge({ op: 'add', ...operation });
      if (result.kind !== 'pending') throw Object.assign(new Error('remote_add_failed'), { code: result.reason ?? 'remote_add_failed' });
      await options.onRemoteAdd?.();
    },
    readRemote: async sdkId => {
      const result = await bridge({ op: 'read', projectId: operation.projectId, sdkId });
      if (result.kind !== 'item') throw Object.assign(new Error('remote_read_failed'), { code: result.reason ?? 'remote_read_failed' });
      return result.item;
    },
    activateViaSdk: async sdkId => {
      const target = await checkTarget();
      if (target.kind !== 'eligible') throw Object.assign(new Error('target_changed'),
        { code: 'target_changed', conflict: true });
      const result = await bridge({ op: 'activate', projectId: operation.projectId,
        externalId: operation.externalId, sdkId });
      if (result.kind !== 'item') throw Object.assign(new Error('remote_activate_failed'), { code: result.reason ?? 'remote_activate_failed' });
    },
    ackLocal: options.ackLocal,
  });
  });
  return response;
}

export async function searchProject({ cwd, sessionId, query, projectId }, readSecret, options = {}) {
  if (typeof query !== 'string' || !query.trim()) return blocked('invalid_query');
  const deadlineAt = options.deadlineMs ? Date.now() + options.deadlineMs : null;
  const resolution = await (options.resolve ?? resolveProject)(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || (projectId && projectId !== resolution.projectId)) return blocked('project_mismatch');
  return runBridgeOperation(cwd, sessionId, { op: 'search', projectId: resolution.projectId, query,
    ownerId: options.ownerId }, readSecret, { ...options, deadlineAt });
}
