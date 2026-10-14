import { createHash } from 'node:crypto';

const normalizeClaim = value => value.normalize('NFC').replace(/[ \t\r\n]+/g, ' ')
  .replace(/^ +| +$/g, '')
  .replace(/[A-Z]/g, letter => letter.toLowerCase());

export function dedupKeyFor({ projectId, scope, ownerId, type, text, condition,
  validFrom, validTo } = {}) {
  if (![projectId, scope, type, text].every(value => typeof value === 'string' && value.trim()) ||
      [ownerId, condition, validFrom, validTo].some(value => value != null && typeof value !== 'string')) {
    throw new Error('invalid_dedup_claim');
  }
  const fields = [projectId, scope, ownerId ?? '', type, normalizeClaim(text),
    normalizeClaim(condition ?? ''), validFrom ?? '', validTo ?? ''];
  const digest = createHash('sha256');
  digest.update('cbs-dedup-v1\0');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    digest.update(`${bytes.length}:`);
    digest.update(bytes);
  }
  return digest.digest('hex');
}
