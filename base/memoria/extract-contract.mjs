const keyPattern = '^[a-z][a-z0-9_]*$';
const key = /^[a-z][a-z0-9_]{0,63}$/;
const types = ['rule', 'fact', 'preference', 'decision', 'report', 'episode'];
const scopes = ['project', 'personal', 'episode'];
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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
