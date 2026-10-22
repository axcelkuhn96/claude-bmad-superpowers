import { createHash } from 'node:crypto';

const kinds = new Set(['problem', 'reason', 'attempt', 'pending']);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const unsafe = /[\x00-\x1f\x7f]|["']?\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_ -]?key|private[_ -]?key|token|password|secret|bearer)["']?\s*[:= ]\s*\S+|\bsk-[a-z0-9-]{16,}|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function validItems(items, refs, safe, allowedIds) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 4 ||
      !Array.isArray(refs) || typeof safe !== 'function') return false;
  const ids = new Set(refs.map(ref => ref?.message_id));
  if (ids.size !== refs.length || ids.has(undefined)) return false;
  return items.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).sort().join(',') === 'kind,source_message_ids,summary' &&
    kinds.has(item.kind) && typeof item.summary === 'string' && !!item.summary.trim() &&
    Buffer.byteLength(item.summary, 'utf8') <= 256 && !unsafe.test(item.summary) && safe(item.summary) &&
    Array.isArray(item.source_message_ids) && item.source_message_ids.length >= 1 &&
    item.source_message_ids.length <= refs.length &&
    new Set(item.source_message_ids).size === item.source_message_ids.length &&
    item.source_message_ids.every(id => typeof id === 'string' && ids.has(id) &&
      (!allowedIds || allowedIds.includes(id))));
}

export function contextFromCandidate(items, refs, safe, allowedIds) {
  if (!validItems(items, refs, safe, allowedIds)) return undefined;
  return { version: 1, items: structuredClone(items), trust: 'generated_unverified',
    source_refs_sha256: hash(refs) };
}

export function verifiedGeneratedContext(value, refs, safe, allowedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'items,source_refs_sha256,trust,version' ||
      value.version !== 1 || value.trust !== 'generated_unverified' ||
      value.source_refs_sha256 !== hash(refs) ||
      !validItems(value.items, refs, safe, allowedIds)) return undefined;
  return value;
}
