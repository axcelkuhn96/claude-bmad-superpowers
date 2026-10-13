import { createHash } from 'node:crypto';

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

export function selectRecall(results, { projectId, now, ownerId } = {}) {
  const instant = date(now);
  if (!projectId || !Number.isFinite(instant) || !Array.isArray(results)) return [];
  return results.filter(row => {
    const item = fields(row);
    const m = item.metadata;
    const from = date(m.valid_from ?? row.valid_from);
    const to = date(m.valid_to ?? row.valid_to);
    return item.projectId === projectId && item.status === 'active' &&
      row.scoreSource === 'mem0_sdk_search' && typeof row.score === 'number' &&
      Number.isFinite(row.score) && row.score >= MIN_RECALL_SCORE && row.score <= 1 &&
      typeof item.text === 'string' && item.text.length > 0 && item.id &&
      typeof m.source === 'string' && m.source && typeof m.actor === 'string' && m.actor &&
      ((m.origin === 'user_direct' && m.speaker_role === 'user') ||
        (m.origin === 'assistant_report' && m.speaker_role === 'assistant') ||
        (m.origin === 'tool_observation' && m.speaker_role === 'tool') ||
        (m.origin === 'external_reference' && m.speaker_role === 'external')) &&
      Number.isFinite(date(m.evidence_at)) &&
      (m.scope === 'project' || m.scope === 'personal' && ownerId && m.owner_id === ownerId ||
        m.scope === 'episode' && Number.isFinite(to)) &&
      (from === null || Number.isFinite(from) && from <= instant) &&
      (to === null || Number.isFinite(to) && instant < to);
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
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
    const line = m.type === 'source_note'
      ? `[${item.id}; date ${m.evidence_at.slice(0, 10)}; actor ${m.actor}; origin ${m.origin}] ${item.text}`
      : `[${item.id}; source ${m.source}; date ${m.evidence_at}; actor ${m.actor}; origin ${m.origin}; role ${m.speaker_role}${condition}] ${item.text}`;
    if (!append(line)) continue;
    used.push(row);
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
      const eligible = selectRecall(raced.items, { projectId: session.projectId, ownerId: session.ownerId, now: now() });
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
