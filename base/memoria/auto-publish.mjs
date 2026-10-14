import { createOutbox } from './outbox.mjs';
import { storeMemory } from './bridge.mjs';
import { storeOperation, validateCandidate, containsSecret, redactSource } from './candidates.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { POLICY_VERSION } from './transcript.mjs';
import { validateConversationProof } from './conversation-proof.mjs';
import { dedupKeyFor } from './dedup-key.mjs';

const blocked = reason => ({ kind: 'blocked', published: 0, pending: 0, reason });
const sameConsent = (frozen, live, projectId) => frozen?.version === 1 &&
  frozen.enabled === true && live?.version === 1 && live.enabled === true &&
  frozen.projectId === projectId && live.projectId === projectId &&
  ['consentHash', 'destinationHash', 'ownerId', 'deviceId', 'enabledAt']
    .every(key => typeof frozen[key] === 'string' && frozen[key] && frozen[key] === live[key]);

export async function publishCheckpointAutomatically(row, resolution, options = {}) {
  if (!row?.operationId || !resolution?.stateDir || row.projectId !== resolution.projectId ||
      resolution.provider !== 'mem0' || resolution.extractor?.autoPublish !== true) {
    return blocked('auto_publish_unavailable');
  }
  const frozen = resolution.extractor.autoPublishConsent;
  if (resolution.ownerId !== frozen?.ownerId) return blocked('auto_publish_owner_mismatch');
  const readConsent = options.readAutoPublish ??
    (await import('./policy.mjs')).readAutoPublish;
  const checkConsent = async () => {
    try { return sameConsent(frozen, await readConsent(resolution), row.projectId); }
    catch { return false; }
  };
  const checkOriginOwner = async () => {
    try {
      if (options.readOriginOwner) {
        return await options.readOriginOwner(resolution, row) === frozen.ownerId;
      }
      const [{ readSessionCheckout }, { readOwner }] = await Promise.all([
        import('./session-checkout.mjs'), import('./policy.mjs')]);
      const checkout = await readSessionCheckout(resolution.stateDir, row.cli, row.sessionId);
      if (checkout.kind !== 'bound' || checkout.projectId !== row.projectId ||
          checkout.projectRoot !== resolution.projectRoot || !checkout.profile) return false;
      return (await readOwner(resolution, row.cli, checkout.profile))?.ownerId === frozen.ownerId;
    } catch { return false; }
  };
  if (!await checkConsent()) return blocked('auto_publish_revoked');
  if (!await checkOriginOwner()) return blocked('auto_publish_owner_mismatch');
  const outbox = options.outbox ?? createOutbox(resolution.stateDir);
  const checkpointRow = (await outbox.pending()).find(item => item.operationId === row.operationId);
  if (!checkpointRow) {
    const receipt = await outbox.readDisposition(row.operationId);
    return receipt?.policyVersion === POLICY_VERSION && row.policyVersion === POLICY_VERSION &&
      receipt.projectId === row.projectId && receipt.cli === row.cli &&
      receipt.sessionId === row.sessionId && receipt.start === row.start &&
      receipt.end === row.end && receipt.sliceHash === row.sliceHash
      ? { kind: 'published', published: 0, pending: 0 } : blocked('source_policy_unproved');
  }
  if (checkpointRow.policyVersion !== POLICY_VERSION || row.policyVersion !== POLICY_VERSION ||
      checkpointRow.projectId !== row.projectId || checkpointRow.cli !== row.cli ||
      checkpointRow.sessionId !== row.sessionId || checkpointRow.start !== row.start ||
      checkpointRow.end !== row.end || checkpointRow.sliceHash !== row.sliceHash ||
      JSON.stringify(checkpointRow.messages) !== JSON.stringify(row.messages)) {
    return blocked('source_policy_unproved');
  }
  const source = await outbox.futureSourceAllowed(checkpointRow, { cli: row.cli,
    sessionId: row.sessionId, projectId: row.projectId, ownerId: frozen.ownerId,
    consentHash: frozen.consentHash });
  if (source.kind !== 'allowed') return blocked('source_policy_unproved');
  const manifest = await outbox.readManifest(row.operationId);
  if (manifest.kind === 'blocked') {
    const receipt = await outbox.readDisposition(row.operationId);
    return receipt?.disposition ? { kind: 'published', published: 0, pending: 0 } :
      blocked(manifest.reason);
  }
  let published = 0;
  let pending = 0;
  for (const entry of manifest.candidates) {
    if (entry.status === 'remote_acked' || entry.status === 'duplicate') continue;
    if (entry.status !== 'pending') { pending++; continue; }
    const payload = await outbox.readCandidatePayload(row.operationId, entry.candidateKey);
    const source = checkpointRow.messages?.find(message => message.messageId === payload.source_message_id &&
      message.start === payload.source_offsets?.start && message.end === payload.source_offsets?.end);
    let conversationValid = false;
    if (payload.format_version === 4) {
      try {
        conversationValid = validateConversationProof(payload, checkpointRow).eligible &&
          payload.dedup_key === dedupKeyFor({ projectId: payload.project_id,
            scope: payload.scope, ownerId: payload.owner_id, type: payload.type,
            text: payload.text, condition: payload.condition,
            validFrom: payload.valid_from, validTo: payload.valid_to });
      } catch { conversationValid = false; }
    }
    const literalValid = payload.format_version === 3 && source?.origin === 'human' &&
      validateCandidate(payload, source).eligible && redactSource(source.text) === source.text &&
      source.text.includes(payload.text) && !/\?/.test(payload.text);
    if (payload.kind === 'blocked' || payload.policy_version !== POLICY_VERSION ||
        containsSecret(payload) || !literalValid && !conversationValid) {
      pending++;
      continue;
    }
    if (!await checkConsent()) return { kind: 'blocked', published, pending, reason: 'auto_publish_revoked' };
    if (!await checkOriginOwner()) return { kind: 'blocked', published, pending,
      reason: 'auto_publish_owner_mismatch' };
    const operation = storeOperation(payload, payload.text);
    operation.metadata.review_mode = 'automatic';
    operation.metadata.auto_actor = 'project_auto_publisher';
    operation.metadata.auto_consent_hash = frozen.consentHash;
    operation.approval.mode = 'automatic';
    let sealed = await outbox.readReview(row.operationId, entry.candidateKey);
    if (sealed.kind === 'blocked' && sealed.reason === 'missing_review') {
      sealed = await outbox.sealReview(row.operationId, entry.candidateKey,
        { decision: 'approve', mode: 'automatic', actor: 'project_auto_publisher',
          consentHash: frozen.consentHash, reviewedAt: new Date().toISOString(),
          payloadSha256: entry.payloadRef.sha256, operation });
    }
    if (sealed.kind === 'blocked' || sealed.kind === 'full') {
      return { kind: sealed.kind === 'full' ? 'retry' : 'blocked', published, pending,
        reason: sealed.reason ?? 'outbox_full' };
    }
    if (sealed.review?.mode !== 'automatic' || sealed.review.consentHash !== frozen.consentHash ||
        JSON.stringify(sealed.review.operation) !== JSON.stringify(operation)) {
      return { kind: 'blocked', published, pending, reason: 'review_mismatch' };
    }
    if (!await checkConsent()) return { kind: 'blocked', published, pending, reason: 'auto_publish_revoked' };
    if (!await checkOriginOwner()) return { kind: 'blocked', published, pending,
      reason: 'auto_publish_owner_mismatch' };
    const ackLocal = (id, proof) => id === entry.externalId
      ? outbox.ackCandidate(row.operationId, entry.candidateKey, proof)
      : blocked('child_id_mismatch');
    const store = options.store ?? ((op, ack) => storeMemory(options.cwd ?? resolution.projectRoot,
      row.sessionId, op, options.readSecret ?? readQdrantSecret, { ...options, ackLocal: ack,
        autoPublishConsent: frozen }));
    const result = await store(operation, ackLocal);
    if (result?.kind === 'duplicate' && conversationValid) {
      if (result.dedupKey !== payload.dedup_key) return { kind: 'blocked', published, pending,
        reason: 'duplicate_proof_mismatch' };
      const disposed = await outbox.duplicateCandidate(row.operationId, entry.candidateKey,
        { projectId: row.projectId, dedupKey: payload.dedup_key,
          duplicateOf: result.duplicateOf, evidenceDigest: result.evidenceDigest });
      if (disposed?.kind !== 'duplicate') return { kind: 'retry', published, pending,
        reason: disposed?.reason ?? 'duplicate_unconfirmed' };
      continue;
    }
    if (result?.kind === 'blocked') return {
      kind: ['destination_unavailable', 'broker_unavailable'].includes(result.reason)
        ? 'retry' : 'blocked',
      published, pending, reason: result.reason ?? 'store_blocked' };
    if (result?.kind === 'conflict') return { kind: 'blocked', published, pending,
      reason: result.reason ?? 'store_conflict' };
    const saved = await outbox.readManifest(row.operationId);
    const child = saved.kind === 'blocked' ? null : saved.candidates.find(item =>
      item.candidateKey === entry.candidateKey);
    if (child?.status !== 'remote_acked' || !child.sdkId || !child.qdrantId ||
        !['stored', 'acked'].includes(result?.kind)) {
      return { kind: 'retry', published, pending, reason: result?.reason ?? 'store_unconfirmed' };
    }
    published++;
  }
  if (!pending) {
    const completed = await outbox.completeCheckpoint(row.operationId);
    if (!['processed', 'acked'].includes(completed.kind)) {
      return { kind: 'retry', published, pending, reason: completed.reason ?? 'checkpoint_unconfirmed' };
    }
    return { kind: 'published', published, pending };
  }
  return { kind: 'pending', published, pending, reason: 'automatic_validation_failed' };
}
