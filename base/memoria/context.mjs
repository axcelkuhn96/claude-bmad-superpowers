import { createHash } from 'node:crypto';
import { dedupKeyFor } from './dedup-key.mjs';
import { rankHybrid, verifiedLiteralSpans } from './hybrid-rank.mjs';
import { verifiedGeneratedContext } from './generated-context.mjs';

// Conservative interim floor; Task7 must calibrate it against frozen negative queries.
export const MIN_RECALL_SCORE = 0.85;

function fields(row) {
  return { projectId: row.projectId ?? row.project_id, status: row.status,
    text: row.text ?? row.memory, metadata: row.metadata ?? {},
    id: row.sdkId ?? row.memory_id ?? row.id };
}

function date(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}

function generatedConversation(metadata, text) {
  const refs = metadata.source_refs;
  let expectedKey;
  try { expectedKey = dedupKeyFor({ projectId: metadata.project_id ?? metadata.projectId,
    scope: metadata.scope, ownerId: metadata.owner_id, type: metadata.type,
    text, condition: metadata.condition, validFrom: metadata.valid_from,
    validTo: metadata.valid_to }); }
  catch { return false; }
  return metadata.format_version === 4 && metadata.origin === 'conversation_summary' &&
    metadata.speaker_role === 'mixed' && metadata.actor === 'conversation' &&
    Array.isArray(refs) && refs.length >= 2 && refs.length <= 10 &&
    metadata.source === refs[0]?.message_id &&
    metadata.source_offsets?.start === refs[0]?.offsets?.start &&
    metadata.source_offsets?.end === refs[0]?.offsets?.end &&
    metadata.source_text_sha256 === refs[0]?.source_text_sha256 &&
    metadata.dedup_key === expectedKey &&
    refs.every(ref => ref && typeof ref.message_id === 'string' && ref.message_id &&
      (ref.origin === 'human' && ref.role === 'user' ||
        ref.origin === 'assistant' && ref.role === 'assistant') &&
      typeof ref.actor === 'string' && ref.actor &&
      Number.isSafeInteger(ref.offsets?.start) && ref.offsets.start >= 0 &&
      Number.isSafeInteger(ref.offsets?.end) && ref.offsets.end > ref.offsets.start &&
      /^[a-f0-9]{64}$/.test(ref.source_text_sha256 ?? '') &&
      typeof ref.excerpt === 'string' && ref.excerpt.trim() &&
      Buffer.byteLength(ref.excerpt, 'utf8') <= 512) &&
    refs.some(ref => ref?.origin === 'human' && ref.role === 'user') &&
    refs.some(ref => ref?.origin === 'assistant' && ref.role === 'assistant');
}

function explicitMcpRequest(metadata, text, projectId) {
  let expectedKey;
  try { expectedKey = dedupKeyFor({ projectId, scope: metadata.scope,
    ownerId: metadata.owner_id, type: metadata.type, text,
    condition: metadata.condition, validFrom: metadata.valid_from,
    validTo: metadata.valid_to }); }
  catch { return false; }
  return metadata.format_version === 5 && metadata.origin === 'assistant_report' &&
    metadata.speaker_role === 'assistant' && metadata.actor === 'mcp_agent' &&
    metadata.review_mode === 'explicit_mcp' &&
    /^mcp_request:[a-f0-9]{64}$/.test(metadata.source ?? '') &&
    /^[a-f0-9]{64}$/.test(metadata.source_text_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(metadata.auto_consent_hash ?? '') &&
    metadata.dedup_key === expectedKey;
}

export function selectRecall(results, { projectId, now, ownerId, query,
  preserveHybridOrder = false } = {}) {
  const instant = date(now);
  if (!projectId || !Number.isFinite(instant) || !Array.isArray(results)) return [];
  return results.filter(row => {
    const item = fields(row);
    const m = item.metadata;
    const from = date(m.valid_from ?? row.valid_from);
    const to = date(m.valid_to ?? row.valid_to);
    const vectorScore = row.scoreSource === 'mem0_sdk_search' ? row.score :
      row.scoreSource === 'hybrid_verified' ? row.retrievalEvidence?.vectorScore : undefined;
    const vectorProof = typeof vectorScore === 'number' && Number.isFinite(vectorScore) &&
      vectorScore >= MIN_RECALL_SCORE && vectorScore <= 1;
    const spans = verifiedLiteralSpans(query, item.text);
    const lexicalProof = (row.scoreSource === 'lexical_verified' ||
      row.scoreSource === 'hybrid_verified') &&
      Number.isSafeInteger(row.retrievalEvidence?.lexicalRank) &&
      row.retrievalEvidence.lexicalRank > 0 && spans.length > 0;
    return item.projectId === projectId && item.status === 'active' &&
      (row.scoreSource === 'mem0_sdk_search' && vectorProof ||
        row.scoreSource === 'lexical_verified' && lexicalProof ||
        row.scoreSource === 'hybrid_verified' && (vectorProof || lexicalProof)) &&
      typeof item.text === 'string' && item.text.length > 0 && item.id &&
      typeof m.source === 'string' && m.source && typeof m.actor === 'string' && m.actor &&
      ((m.origin === 'user_direct' && m.speaker_role === 'user') ||
        (m.origin === 'assistant_report' && m.speaker_role === 'assistant' &&
          m.format_version !== 5) ||
        explicitMcpRequest(m, item.text, item.projectId) ||
        (m.origin === 'tool_observation' && m.speaker_role === 'tool') ||
        (m.origin === 'external_reference' && m.speaker_role === 'external') ||
        generatedConversation({ ...m, projectId: item.projectId }, item.text)) &&
      Number.isFinite(date(m.evidence_at)) &&
      (m.scope === 'project' || m.scope === 'personal' && ownerId && m.owner_id === ownerId ||
        m.scope === 'episode' && Number.isFinite(to)) &&
      (from === null || Number.isFinite(from) && from <= instant) &&
      (to === null || Number.isFinite(to) && instant < to);
  }).sort(preserveHybridOrder ? () => 0 : (a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function selectSearchRecall(answer, options = {}) {
  if (answer?.kind !== 'items' || !Array.isArray(answer.items)) return [];
  const unique = rows => {
    const seen = new Set();
    return rows.filter(row => {
      const id = fields(row).id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const vectors = unique(selectRecall(answer.items, options).filter(row =>
    row.scoreSource === 'mem0_sdk_search'));
  if (!Array.isArray(answer.lexical_items) || !answer.lexical_items.length) return vectors.slice(0, 20);
  const lexical = unique(selectRecall(answer.lexical_items, { ...options, preserveHybridOrder: true })
    .filter(row => row.scoreSource === 'lexical_verified')
    .map(row => ({ ...row, retrievalEvidence: {
      lexicalRank: row.retrievalEvidence.lexicalRank,
      literalSpans: verifiedLiteralSpans(options.query, row.text ?? row.memory),
    } })));
  if (!lexical.length) return vectors.slice(0, 20);
  const ranked = rankHybrid(vectors, lexical, { query: options.query });
  return selectRecall(ranked, { ...options, preserveHybridOrder: true }).slice(0, 20);
}

function renderWithItems(items, maxTokens) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) return { text: '', used: [] };
  // UTF-8 bytes are a conservative upper bound for common byte-level tokenizers.
  let remaining = maxTokens;
  const lines = [];
  const used = [];
  const append = line => {
    const size = Buffer.byteLength(line, 'utf8') + (lines.length ? 1 : 0);
    if (size > remaining) return false;
    lines.push(line);
    remaining -= size;
    return true;
  };
  append('Current human instruction takes precedence over recalled memory.');
  for (const row of items) {
    const item = fields(row);
    const m = item.metadata;
    const condition = typeof m.condition === 'string' && m.condition ? `; condition ${m.condition}` : '';
    const explicit = explicitMcpRequest(m, item.text, item.projectId);
    const line = generatedConversation({ ...m, projectId: item.projectId }, item.text)
      ? `[${item.id}; resumo gerado; referências ${m.source_refs.length}; date ${m.evidence_at.slice(0, 10)}${condition}] ${item.text}`
      : explicit
      ? `[${item.id}; pedido via MCP/agente; date ${m.evidence_at.slice(0, 10)}${condition}] ${item.text}`
      : m.type === 'source_note'
      ? `[${item.id}; date ${m.evidence_at.slice(0, 10)}; actor ${m.actor}; origin ${m.origin}] ${item.text}`
      : `[${item.id}; source ${m.source}; date ${m.evidence_at}; actor ${m.actor}; origin ${m.origin}; role ${m.speaker_role}${condition}] ${item.text}`;
    if (!append(line)) {
      if (!explicit || !append(`[${item.id}; pedido via MCP/agente; texto longo; use get source=curated memory_id=${item.id}]`)) continue;
    }
    used.push(row);
  }
  for (const row of used) {
    const item = fields(row);
    if (!generatedConversation({ ...item.metadata, projectId: item.projectId }, item.text)) continue;
    const generated = verifiedGeneratedContext(item.metadata.context_generated,
      item.metadata.source_refs, () => true);
    if (!generated) continue;
    for (const entry of generated.items) {
      const line = `[${item.id}; contexto gerado, não verificado; ${entry.kind}] ${entry.summary}`;
      if (!append(line)) break;
    }
  }
  return { text: lines.join('\n'), used };
}

export function renderContext(items, maxTokens = 500) { return renderWithItems(items, maxTokens).text; }
export function renderRecall(items, maxTokens = 500) { return renderWithItems(items, maxTokens); }

export function createRecall({ search, now = () => new Date().toISOString() }) {
  const seenBySession = new Map();
  const recall = async (session, query, deadlineMs = 1000) => {
    if (!session?.projectId || typeof query !== 'string' || !query.trim()) return { kind: 'abstain' };
    const controller = new AbortController();
    const timeout = Symbol('deadline');
    let timer;
    try {
      const raced = await Promise.race([
        Promise.resolve().then(() => search(session, query, { signal: controller.signal, deadlineMs })),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(timeout); }, deadlineMs); }),
      ]);
      if (raced === timeout) return { kind: 'unavailable', reason: 'deadline' };
      if (raced?.kind !== 'items') return raced?.kind === 'unavailable' ? raced : { kind: 'unavailable', reason: 'search_failed' };
      const sessionKey = session.nativeSessionId ?? session.sessionId ?? '';
      const seen = seenBySession.get(sessionKey) ?? new Set();
      seenBySession.set(sessionKey, seen);
      const eligible = selectSearchRecall(raced, { projectId: session.projectId,
        ownerId: session.ownerId, now: now(), query });
      const unseen = eligible.filter(row => {
        const item = fields(row);
        const key = `${item.id}:${createHash('sha256').update(item.text).digest('hex')}`;
        return !seen.has(key);
      });
      const items = renderWithItems(unseen, 500).used;
      for (const row of items) {
        const item = fields(row);
        seen.add(`${item.id}:${createHash('sha256').update(item.text).digest('hex')}`);
      }
      return items.length ? { kind: 'items', items } : { kind: 'abstain' };
    } catch { return { kind: 'unavailable', reason: 'search_failed' }; }
    finally { clearTimeout(timer); }
  };
  recall.compact = sessionId => sessionId === undefined ? seenBySession.clear() : seenBySession.delete(sessionId);
  return recall;
}
