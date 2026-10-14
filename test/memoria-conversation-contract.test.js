import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConversationOutput } from '../base/memoria/extract-contract.mjs';

const evidence = [
  { source_message_id: 'u1', excerpt: 'Use filtros por tenant' },
  { source_message_id: 'a1', excerpt: 'Foi aplicado filtro por tenant' },
];
const candidate = { text: 'O projeto adotou filtros por tenant.', type: 'decision',
  scope: 'project', evidence };

test('conversation response selects grounded summaries or abstains without filler', () => {
  assert.equal(validateConversationOutput({ candidates: [candidate], no_facts: false }), true);
  assert.equal(validateConversationOutput({ candidates: [], no_facts: true }), true);
  assert.equal(validateConversationOutput({ candidates: [], no_facts: false }), false);
  assert.equal(validateConversationOutput({ candidates: [{ ...candidate, evidence: [] }], no_facts: false }), false);
  assert.equal(validateConversationOutput({ candidates: [{ ...candidate,
    evidence: [...evidence, evidence[0]] }], no_facts: false }), false);
});
