const keyPattern = '^[a-z][a-z0-9_]*$';
const key = /^[a-z][a-z0-9_]{0,63}$/;
const types = ['rule', 'fact', 'preference', 'decision', 'report', 'episode'];
const scopes = ['project', 'personal', 'episode'];
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const conversationExtractionSchema = { type: 'object', additionalProperties: false,
  required: ['candidates', 'no_facts'], properties: {
    no_facts: { type: 'boolean' }, candidates: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['text', 'type', 'scope', 'evidence'], properties: {
        text: { type: 'string' }, type: { type: 'string', enum: ['rule', 'fact', 'preference', 'decision'] },
        scope: { type: 'string', enum: ['project', 'personal'] },
        evidence: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['source_message_id', 'excerpt'], properties: {
            source_message_id: { type: 'string' }, excerpt: { type: 'string' },
          } } },
        context: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['kind', 'summary', 'source_message_ids'], properties: {
            kind: { type: 'string', enum: ['problem', 'reason', 'attempt', 'pending'] },
            summary: { type: 'string' },
            source_message_ids: { type: 'array', items: { type: 'string' } },
          } } },
      },
    } },
  },
};

export function validateConversationOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).some(key => !['candidates', 'no_facts'].includes(key)) ||
      typeof output.no_facts !== 'boolean' || !Array.isArray(output.candidates) ||
      output.candidates.length > 5 || output.no_facts !== (output.candidates.length === 0)) return false;
  for (const item of output.candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['text', 'type', 'scope', 'evidence', 'context'].includes(key)) ||
        typeof item.text !== 'string' || !item.text.trim() ||
        Buffer.byteLength(item.text, 'utf8') > 2048 ||
        !['rule', 'fact', 'preference', 'decision'].includes(item.type) ||
        !['project', 'personal'].includes(item.scope) || !Array.isArray(item.evidence) ||
        item.evidence.length < 2 || item.evidence.length > 10) return false;
    const seen = new Set();
    for (const ref of item.evidence) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
          Object.keys(ref).some(key => !['source_message_id', 'excerpt'].includes(key)) ||
          typeof ref.source_message_id !== 'string' || !ref.source_message_id ||
          seen.has(ref.source_message_id) || typeof ref.excerpt !== 'string' ||
          !ref.excerpt.trim() || Buffer.byteLength(ref.excerpt, 'utf8') > 512) return false;
      seen.add(ref.source_message_id);
    }
  }
  return true;
}

// Keep the CLI schema within Anthropic's supported structured-output subset.
// Length, array size and cross-field requirements are enforced locally below.
export const extractionSchema = { type: 'object', additionalProperties: false,
  required: ['candidates', 'no_facts'], properties: {
    no_facts: { type: 'boolean' }, candidates: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['candidate_key', 'source_message_id', 'text', 'type', 'scope'], properties: {
        candidate_key: { type: 'string', pattern: keyPattern },
        source_message_id: { type: 'string' },
        logical_key: { type: 'string', pattern: keyPattern },
        text: { type: 'string' }, type: { type: 'string', enum: types },
        scope: { type: 'string', enum: scopes },
        condition: { type: 'string' },
        valid_from: { type: 'string', format: 'date-time' },
        valid_to: { type: 'string', format: 'date-time' },
      },
    } },
  },
};

// The model chooses claims or abstains for each supplied message. Source identity and
// candidate keys are assigned only by the local extraction process.
export const haikuExtractionSchema = { type: 'object', additionalProperties: false,
  required: ['decisions'], properties: { decisions: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['source_message_id', 'candidates', 'abstain_reason'], properties: {
      source_message_id: { type: 'string' }, abstain_reason: { type: 'string' },
      candidates: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['text', 'type', 'scope'], properties: {
          text: { type: 'string' }, type: { type: 'string', enum: types },
          scope: { type: 'string', enum: scopes }, condition: { type: 'string' },
        } } },
    },
  } } },
};

export function validateHaikuOutput(output, expectedIds = null) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).some(key => key !== 'decisions') || !Array.isArray(output.decisions)) return false;
  if (expectedIds && output.decisions.length !== expectedIds.length) return false;
  const seen = new Set();
  let count = 0;
  for (const decision of output.decisions) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
        Object.keys(decision).some(key => !['source_message_id', 'candidates', 'abstain_reason'].includes(key)) ||
        typeof decision.source_message_id !== 'string' || !decision.source_message_id ||
        seen.has(decision.source_message_id) ||
        expectedIds && !expectedIds.includes(decision.source_message_id) ||
        typeof decision.abstain_reason !== 'string' || !Array.isArray(decision.candidates) ||
        decision.candidates.length > 5 ||
        decision.candidates.length === 0 && !decision.abstain_reason.trim() ||
        decision.candidates.length > 0 && decision.abstain_reason !== '') return false;
    seen.add(decision.source_message_id);
    count += decision.candidates.length;
    if (count > 5) return false;
    for (const item of decision.candidates) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(key => !['text', 'type', 'scope', 'condition'].includes(key)) ||
          typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8192 ||
          !types.includes(item.type) || !scopes.includes(item.scope) ||
          (item.type === 'episode' || item.scope === 'episode') ||
          Object.hasOwn(item, 'condition') &&
            (typeof item.condition !== 'string' || !item.condition.trim())) return false;
    }
  }
  return true;
}

export function validDateTime(value) {
  if (typeof value !== 'string' || !dateTime.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10);
}

export function validateExtractionOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).some(field => !['candidates', 'no_facts'].includes(field)) ||
      typeof output.no_facts !== 'boolean' || !Array.isArray(output.candidates) ||
      output.candidates.length > 5 || output.no_facts !== (output.candidates.length === 0)) return false;
  const seen = new Set();
  const properties = extractionSchema.properties.candidates.items.properties;
  for (const item of output.candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(field => !(field in properties)) ||
        typeof item.candidate_key !== 'string' || !key.test(item.candidate_key) ||
        seen.has(item.candidate_key) ||
        typeof item.source_message_id !== 'string' || !item.source_message_id ||
        typeof item.text !== 'string' || !item.text.trim() ||
        !types.includes(item.type) || !scopes.includes(item.scope) ||
        Object.hasOwn(item, 'logical_key') &&
          (typeof item.logical_key !== 'string' || !key.test(item.logical_key)) ||
        Object.hasOwn(item, 'condition') && (typeof item.condition !== 'string' || !item.condition.trim()) ||
        Object.hasOwn(item, 'valid_from') && !validDateTime(item.valid_from) ||
        Object.hasOwn(item, 'valid_to') && !validDateTime(item.valid_to) ||
        (item.type === 'episode' || item.scope === 'episode') && !item.valid_to) return false;
    seen.add(item.candidate_key);
  }
  return true;
}
