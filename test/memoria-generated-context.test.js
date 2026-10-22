import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contextFromCandidate, verifiedGeneratedContext } from '../base/memoria/generated-context.mjs';
import { renderRecall } from '../base/memoria/context.mjs';
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';

const refs = [
  { message_id: 'u1', origin: 'human', source_text_sha256: 'a'.repeat(64), excerpt: 'Use tenant filters.' },
  { message_id: 'a1', origin: 'assistant', source_text_sha256: 'b'.repeat(64), excerpt: 'Tenant filter applied.' },
];
const context = [{ kind: 'reason', summary: 'Tenant isolation was required.', source_message_ids: ['u1', 'a1'] }];
const safe = value => !value.includes('api_key=');
const refsHash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');

test('context stays optional and binds to exact qualified source refs', () => {
  assert.equal(contextFromCandidate(undefined, refs, safe), undefined);
  assert.equal(contextFromCandidate([], refs, safe), undefined);
  const generated = contextFromCandidate(context, refs, safe);
  assert.deepEqual(generated, { version: 1, items: context, trust: 'generated_unverified',
    source_refs_sha256: refsHash(refs) });
  assert.deepEqual(verifiedGeneratedContext(generated, refs, safe), generated);
  assert.equal(verifiedGeneratedContext(generated, [...refs].reverse(), safe), undefined);
});

test('invalid model context drops the field while leaving the fact available', () => {
  for (const invalid of [
    [{ ...context[0], source_message_ids: ['invented'] }],
    [{ ...context[0], summary: 'api_key=secret' }],
    [{ ...context[0], summary: 'é'.repeat(129) }],
    Array(5).fill(context[0]),
    [{ ...context[0], source_message_ids: ['u1', 'u1'] }],
    [{ ...context[0], kind: 'rule' }],
  ]) assert.equal(contextFromCandidate(invalid, refs, safe), undefined);
  assert.equal(contextFromCandidate(context, refs, safe, ['a1']), undefined);
});

test('recall never promotes context on an unqualified fact', () => {
  const generated = contextFromCandidate(context, refs, safe);
  const row = { sdkId: 'old', projectId: 'project', status: 'active', text: 'Keep the existing fact.',
    metadata: { format_version: 3, source: 'u1', actor: 'user', origin: 'user_direct',
      speaker_role: 'user', evidence_at: '2026-10-01T00:00:00Z', source_refs: refs,
      context_generated: generated } };
  const result = renderRecall([row], 500);
  assert.match(result.text, /Keep the existing fact/);
  assert.doesNotMatch(result.text, /Tenant isolation was required/);
});

test('optional context uses only bytes left after the principal facts', () => {
  const qualifiedRefs = refs.map((ref, index) => ({ ...ref,
    role: index ? 'assistant' : 'user', actor: index ? 'assistant' : 'user',
    offsets: { start: index * 20, end: index * 20 + 19 } }));
  const fact = text => ({ projectId: 'project', status: 'active', text,
    metadata: { format_version: 4, source: 'u1', actor: 'conversation',
      origin: 'conversation_summary', speaker_role: 'mixed', scope: 'project',
      type: 'decision', evidence_at: '2026-10-01T00:00:00Z',
      source_offsets: qualifiedRefs[0].offsets,
      source_text_sha256: qualifiedRefs[0].source_text_sha256,
      source_refs: qualifiedRefs,
      dedup_key: dedupKeyFor({ projectId: 'project', scope: 'project',
        type: 'decision', text }),
      context_generated: contextFromCandidate([{ ...context[0], summary: 'x'.repeat(210) }],
        qualifiedRefs, safe) } });
  const result = renderRecall([{ ...fact('First fact.'), sdkId: 'f1' },
    { ...fact('Second fact.'), sdkId: 'f2' }], 380);
  assert.deepEqual(result.used.map(row => row.sdkId), ['f1', 'f2']);
  assert.match(result.text, /First fact/);
  assert.match(result.text, /Second fact/);
  assert.doesNotMatch(result.text, /x{100}/);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 380);
});
