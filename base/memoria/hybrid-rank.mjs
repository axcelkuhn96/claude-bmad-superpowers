import { isDeepStrictEqual } from 'node:util';

const identifier = /[A-Za-z0-9_.:/-]+/g;
const boundary = /[\p{L}\p{N}]/u;
const normalized = value => value.normalize('NFKC').toLowerCase();
const idFor = row => row?.sdkId ?? row?.memory_id ?? row?.id;
const sameMemory = (a, b) => (a.text ?? a.memory) === (b.text ?? b.memory) &&
  a.projectId === b.projectId && a.status === b.status &&
  a.externalId === b.externalId &&
  ['scope', 'owner_id', 'source', 'actor', 'origin', 'speaker_role', 'evidence_at',
    'valid_from', 'valid_to', 'format_version', 'dedup_key'].every(key =>
    isDeepStrictEqual(a.metadata?.[key], b.metadata?.[key]));

export function technicalIdentifiers(query) {
  if (typeof query !== 'string') return [];
  const found = new Set();
  for (const match of query.normalize('NFKC').matchAll(identifier)) {
    const token = match[0].replace(/^[_.:/-]+|[_.:/-]+$/g, '');
    if (token.length < 2 || token.length > 80) continue;
    if (!(/^[A-Za-z0-9]+(?:[_.:/-][A-Za-z0-9]+)+$/.test(token) &&
        /[A-Za-z]/.test(token) && token.length >= 4 ||
      /[A-Z]{2,}\d/.test(token) && /^[A-Z0-9]+$/.test(token))) continue;
    found.add(normalized(token));
  }
  return [...found];
}
export function verifiedLiteralSpans(query, content) {
  if (typeof content !== 'string') return [];
  const text = normalized(content);
  return technicalIdentifiers(query).filter(token => {
    let start = 0;
    while ((start = text.indexOf(token, start)) !== -1) {
      const before = text[start - 1];
      const after = text[start + token.length];
      if ((!before || !boundary.test(before)) && (!after || !boundary.test(after))) return true;
      start += token.length;
    }
    return false;
  }).map(token => token.toUpperCase());
}

function coverage(query, text) {
  if (!query || !text) return 0;
  const terms = new Set(normalized(query).match(/[\p{L}\p{N}]+/gu) ?? []);
  const present = new Set(normalized(text).match(/[\p{L}\p{N}]+/gu) ?? []);
  return [...terms].filter(term => present.has(term)).length;
}

export function rankHybrid(vectorRows, lexicalRows, { limit = 20, rrfK = 60,
  query = '' } = {}) {
  if (!Array.isArray(vectorRows) || !Array.isArray(lexicalRows)) return [];
  const lexical = [...lexicalRows].sort((a, b) =>
    (b.retrievalEvidence?.literalSpans?.length ?? 0) -
      (a.retrievalEvidence?.literalSpans?.length ?? 0) ||
    coverage(query, b.text ?? b.memory) - coverage(query, a.text ?? a.memory) ||
    String(idFor(a)).localeCompare(String(idFor(b))));
  const rows = new Map();
  const vectorOrder = [];
  const add = (row, channel, rank) => {
    const id = idFor(row);
    if (typeof id !== 'string' || !id) return;
    const existing = rows.get(id);
    if (existing && !sameMemory(existing.row, row)) return;
    const entry = existing ?? { row, evidence: {}, rank: 0 };
    if (entry.evidence[`${channel}Rank`]) return;
    entry.rank += 1 / (rrfK + rank);
    entry.evidence[`${channel}Rank`] = rank;
    if (channel === 'vector') entry.evidence.vectorScore = row.score;
    else entry.evidence.literalSpans = row.retrievalEvidence.literalSpans;
    rows.set(id, entry);
    if (channel === 'vector' && !existing) vectorOrder.push(id);
  };
  vectorRows.forEach((row, index) => add(row, 'vector', index + 1));
  lexical.forEach((row, index) => add(row, 'lexical', index + 1));
  const tail = [...rows.keys()].filter(id => !vectorOrder.includes(id)).sort((a, b) =>
    rows.get(b).rank - rows.get(a).rank || a.localeCompare(b));
  return [...vectorOrder, ...tail].slice(0, Math.min(20, limit)).map(id => {
    const value = rows.get(id);
    if (value.evidence.vectorRank && !value.evidence.lexicalRank) return value.row;
    return { ...value.row, scoreSource: 'hybrid_verified', retrievalEvidence: value.evidence };
  });
}
