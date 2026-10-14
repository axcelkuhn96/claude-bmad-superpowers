import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateConversationProof } from '../base/memoria/conversation-proof.mjs';
import { containsSecret, redactSource, buildConversationPrompt } from '../base/memoria/candidates.mjs';
import { dedupKeyFor } from '../base/memoria/dedup-key.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const messages = [
  { messageId: 'u1', origin: 'human', speakerRole: 'user', actor: 'user',
    text: 'Use filtros por tenant neste projeto.', start: 0, end: 10,
    ownerId: 'axcel', timestamp: '2026-10-14T12:00:00Z' },
  { messageId: 'a1', origin: 'assistant', speakerRole: 'assistant', actor: 'assistant',
    text: 'Foi aplicado filtro por tenant ao endpoint.', finalVisible: true,
    start: 10, end: 20, timestamp: '2026-10-14T12:00:10Z' },
];
const sourceSlices = [{ start: 0, end: 20, fullStart: 0, fullEnd: 20,
  sliceHash: 'a'.repeat(64) }];
const row = { projectId: 'project', cli: 'codex', sessionId: 's',
  policyVersion: 'native-v2', conversationBatch: true, conversationPairs: 1, start: 0, end: 20,
  sliceHash: hash(JSON.stringify(sourceSlices)), sourceSlices, messages };
const ref = (message, excerpt) => ({ message_id: message.messageId, role: message.speakerRole,
  origin: message.origin, actor: message.actor,
  offsets: { start: message.start, end: message.end },
  source_text_sha256: hash(message.text), excerpt });
function payload() {
  const result = { format_version: 4, project_id: 'project', session_id: 's',
    policy_version: 'native-v2', origin: 'conversation_summary', speaker_role: 'mixed',
    actor: 'conversation', scope: 'project', owner_id: null, type: 'decision',
    text: 'O projeto adotou filtro por tenant no endpoint.', condition: null,
    valid_from: null, valid_to: null, source_message_id: 'u1',
    source_offsets: { start: 0, end: 10 }, source_text_sha256: hash(messages[0].text),
    evidence_at: messages[0].timestamp,
    source_refs: [ref(messages[0], 'Use filtros por tenant'),
      ref(messages[1], 'Foi aplicado filtro por tenant')],
    extractor_model: 'claude-haiku-5-5' };
  result.claim_sha256 = hash(JSON.stringify([result.text, result.type, result.scope,
    result.condition, result.valid_from, result.valid_to]));
  result.dedup_key = dedupKeyFor({ projectId: result.project_id, scope: result.scope,
    ownerId: result.owner_id, type: result.type, text: result.text,
    condition: result.condition, validFrom: result.valid_from, validTo: result.valid_to });
  return result;
}

test('conversation summary requires separate exact human and final assistant evidence', () => {
  assert.equal(validateConversationProof(payload(), row).eligible, true);
  const altered = payload();
  altered.source_refs[1].excerpt = 'Implantado filtro inexistente';
  assert.equal(validateConversationProof(altered, row).eligible, false);
  const nonFinal = structuredClone(row);
  nonFinal.messages[1].finalVisible = false;
  assert.equal(validateConversationProof(payload(), nonFinal).eligible, false);
  const wrongScope = payload();
  wrongScope.project_id = 'another-project';
  assert.equal(validateConversationProof(wrongScope, row).eligible, false);
  const cutTamper = structuredClone(row);
  cutTamper.sourceSlices[0].end = 19;
  assert.equal(validateConversationProof(payload(), cutTamper).eligible, false);
  const forgedDedup = payload();
  forgedDedup.dedup_key = '0'.repeat(64);
  assert.equal(validateConversationProof(forgedDedup, row).eligible, false);
  const forgedPairs = structuredClone(row);
  forgedPairs.conversationPairs = 5;
  assert.equal(validateConversationProof(payload(), forgedPairs).eligible, false);
});

test('conversation summary rejects forged speaker, missing owner support, and secret excerpts', () => {
  const forged = payload();
  forged.origin = 'user_direct';
  assert.equal(validateConversationProof(forged, row).eligible, false);
  const personal = payload();
  personal.scope = 'personal';
  personal.owner_id = 'another-owner';
  personal.claim_sha256 = hash(JSON.stringify([personal.text, personal.type, personal.scope,
    personal.condition, personal.valid_from, personal.valid_to]));
  assert.equal(validateConversationProof(personal, row).eligible, false);
  const secret = payload();
  secret.source_refs[0].excerpt = 'api_key=very-secret-value-123';
  assert.equal(validateConversationProof(secret, row).eligible, false);
});

test('quoted JSON secret labels are removed before any conversation prompt or candidate proof', () => {
  for (const key of ['password', 'client_secret', 'access_token', 'refresh_token',
    'private_key', 'db_password']) {
    const source = JSON.stringify({ [key]: 'fixture-canary' });
    assert.equal(containsSecret(source), true, key);
    assert.equal(redactSource(source).includes('fixture-canary'), false, key);
    const withSecret = structuredClone(row);
    withSecret.messages[0].text = source;
    assert.equal(buildConversationPrompt(withSecret), null, key);
    const forged = payload();
    forged.source_refs[0].source_text_sha256 = hash(source);
    forged.source_refs[0].excerpt = source;
    assert.equal(validateConversationProof(forged, withSecret).eligible, false, key);
  }
});
