import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';

const claim = { projectId: 'project', scope: 'project', ownerId: null, type: 'decision',
  text: 'Use PostgreSQL for persistence.', condition: null, validFrom: null, validTo: null };

test('exact dedup key ignores spelling case and repeated whitespace only', () => {
  const key = dedupKeyFor(claim);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(dedupKeyFor({ ...claim, text: '  use   postgresql\nfor persistence.  ' }), key);
  for (const changed of [
    { text: 'Do not use PostgreSQL for persistence.' },
    { projectId: 'other' }, { scope: 'personal', ownerId: 'owner' },
    { type: 'report' }, { condition: 'Only for staging' },
    { validTo: '2026-10-15T00:00:00Z' },
  ]) assert.notEqual(dedupKeyFor({ ...claim, ...changed }), key);
});
