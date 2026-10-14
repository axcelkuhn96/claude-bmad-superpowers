import { createHash } from 'node:crypto';
import { containsSecret, redactSource } from './candidates.mjs';
import { dedupKeyFor } from './dedup-key.mjs';
import { completedConversationPairs } from './conversation-batches.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const safe = value => typeof value === 'string' && !containsSecret(value) &&
  redactSource(value) === value;

// The model may paraphrase a conversation, but each cited excerpt must be
// literally present in a separately captured and authenticated native turn.
export function validateConversationProof(payload, row, { requireFinal = true } = {}) {
  const reasons = [];
  const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (payload?.format_version !== 4 || row?.conversationBatch !== true ||
      row.policyVersion !== 'native-v2' || payload.project_id !== row.projectId ||
      payload.session_id !== row.sessionId || payload.policy_version !== row.policyVersion ||
      payload.slice_start !== undefined && payload.slice_start !== row.start ||
      payload.slice_end !== undefined && payload.slice_end !== row.end ||
      payload.slice_hash !== undefined && payload.slice_hash !== row.sliceHash) add('source_mismatch');
  if (!Number.isSafeInteger(row?.conversationPairs) || row.conversationPairs < 1 ||
      row.conversationPairs > 5 ||
      completedConversationPairs(row.messages ?? []).length !== row.conversationPairs) {
    add('conversation_pairs_mismatch');
  }
  let sourceEnd = row?.start;
  if (!Array.isArray(row?.sourceSlices) || !row.sourceSlices.length ||
      row.sliceHash !== hash(JSON.stringify(row.sourceSlices))) add('slice_proof_mismatch');
  else {
    for (const part of row.sourceSlices) {
      if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) ||
          !Number.isSafeInteger(part.fullStart) || !Number.isSafeInteger(part.fullEnd) ||
          part.start !== sourceEnd || part.end <= part.start ||
          part.fullStart > part.start || part.fullEnd < part.end ||
          !/^[a-f0-9]{64}$/.test(part.sliceHash ?? '')) add('slice_proof_mismatch');
      sourceEnd = part.end;
    }
    if (sourceEnd !== row.end) add('slice_proof_mismatch');
  }
  if (payload?.origin !== 'conversation_summary' || payload.speaker_role !== 'mixed' ||
      payload.actor !== 'conversation' || !['rule', 'fact', 'preference', 'decision'].includes(payload.type) ||
      !['project', 'personal'].includes(payload.scope) ||
      typeof payload.text !== 'string' || !payload.text.trim() ||
      Buffer.byteLength(payload.text, 'utf8') > 2048 || !safe(payload.text) ||
      payload.condition != null || payload.valid_from != null || payload.valid_to != null ||
      payload.claim_sha256 !== hash(JSON.stringify([payload.text, payload.type, payload.scope,
        payload.condition ?? null, payload.valid_from ?? null, payload.valid_to ?? null])) ||
      !/^claude-haiku-5-5(?:-[a-z0-9-]+)?$/.test(payload.extractor_model ?? '')) {
    add('unsupported_claim');
  }
  let dedupKey;
  try { dedupKey = dedupKeyFor({ projectId: payload.project_id,
    scope: payload.scope, ownerId: payload.owner_id, type: payload.type,
    text: payload.text, condition: payload.condition,
    validFrom: payload.valid_from, validTo: payload.valid_to }); }
  catch { add('dedup_key_mismatch'); }
  if (payload.dedup_key !== dedupKey) add('dedup_key_mismatch');
  if (!Array.isArray(payload?.source_refs) || payload.source_refs.length < 2 ||
      payload.source_refs.length > 10) return { eligible: false, reasons: [...reasons, 'invalid_source_refs'] };
  const seen = new Set();
  let hasHuman = false;
  let hasAssistant = false;
  let personalOwner = false;
  let priorEnd = -1;
  for (const ref of payload.source_refs) {
    const message = row?.messages?.find(item => item.messageId === ref?.message_id &&
      item.start === ref?.offsets?.start && item.end === ref?.offsets?.end);
    const key = JSON.stringify([ref?.message_id, ref?.offsets?.start, ref?.offsets?.end]);
    if (!message || seen.has(key) || !Number.isSafeInteger(message.start) ||
        message.start < row.start || message.end > row.end || message.start < priorEnd ||
        !['human', 'assistant'].includes(message.origin) ||
        message.origin === 'assistant' && requireFinal && message.finalVisible !== true ||
        ref.role !== message.speakerRole || ref.origin !== message.origin ||
        ref.actor !== message.actor || ref.source_text_sha256 !== hash(message.text ?? '') ||
        typeof ref.excerpt !== 'string' || !ref.excerpt.trim() ||
        Buffer.byteLength(ref.excerpt, 'utf8') > 512 ||
        !message.text?.includes(ref.excerpt) || !safe(ref.excerpt) || !safe(message.text)) {
      add('source_ref_mismatch');
    }
    if (message?.origin === 'human') {
      hasHuman = true;
      personalOwner ||= typeof message.ownerId === 'string' && message.ownerId === payload.owner_id;
    }
    if (message?.origin === 'assistant' && (!requireFinal || message.finalVisible === true)) hasAssistant = true;
    seen.add(key);
    priorEnd = message?.end ?? priorEnd;
  }
  if (!hasHuman || !hasAssistant) add('missing_conversation_roles');
  if (payload.scope === 'personal' && (!personalOwner || !payload.owner_id) ||
      payload.scope === 'project' && payload.owner_id != null) add('missing_scope');
  const first = payload.source_refs[0];
  const original = row?.messages?.find(item => item.messageId === first.message_id &&
    item.start === first.offsets.start && item.end === first.offsets.end);
  if (!original || payload.source_message_id !== first.message_id ||
      JSON.stringify(payload.source_offsets) !== JSON.stringify(first.offsets) ||
      payload.source_text_sha256 !== first.source_text_sha256 ||
      payload.evidence_at !== original.timestamp) add('primary_source_mismatch');
  return { eligible: reasons.length === 0, reasons };
}
