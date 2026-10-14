const bytes = text => Buffer.byteLength(text, 'utf8');
const words = text => new Set((text.normalize('NFKD').toLowerCase()
  .replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9_]{3,}/g) ?? [])
  .filter(word => !['para', 'como', 'essa', 'esse', 'with', 'that', 'from', 'this', 'when',
    'the', 'and', 'uma', 'dos', 'das', 'com', 'por'].includes(word)));

// This recognizes a temporary observation about this CBS installation, not a
// durable statement describing how CBS should behave.
export function transientCbsRuntimeStatus(text) {
  if (typeof text !== 'string') return false;
  const value = text.normalize('NFKC').toLowerCase().split(/[.!?]/, 1)[0];
  return /\bcbs\b/.test(value) &&
    /(?:\bqdrant\b|mem[oó]ria)/.test(value) &&
    /(?:at the time of this session|nesta sess[aã]o|no momento|atualmente|currently|agora|hoje)/.test(value) &&
    /(?:automaticwriteconfigured\s*[:=]\s*false|read.only|somente leitura|escrita autom[aá]tica (?:desabilitada|desativada))/.test(value) &&
    !/(?:\bbug\b|erro|incorret|deve|should|requirement|regra)/.test(value);
}

export function selectExistingMemories(points, { projectId, ownerId, now, query = '',
  isSafe = () => true } = {}) {
  if (!Array.isArray(points) || points.length > 64 || !projectId || !ownerId) return [];
  const at = Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(at)) return [];
  const terms = words(query);
  return points.flatMap(point => {
    const p = point?.payload;
    if (!p || p.project_id !== projectId || p.user_id !== projectId ||
        p.status !== 'active' || p.scope !== 'project' ||
        typeof p.data !== 'string' || !p.data.trim() || bytes(p.data) > 512 ||
        p.condition != null && (typeof p.condition !== 'string' || bytes(p.condition) > 512) ||
        p.valid_from != null || p.valid_to != null ||
        !isSafe(p.data) || p.condition && !isSafe(p.condition)) return [];
    const memory_id = String(point.id ?? '');
    if (!memory_id) return [];
    const overlap = [...words(p.data + ' ' + (p.condition ?? ''))]
      .filter(term => terms.has(term)).length;
    const recent = Date.parse(p.ingested_at ?? p.created_at ?? p.evidence_at ?? '');
    return [{ memory_id, text: p.data, ...(p.condition ? { condition: p.condition } : {}),
      overlap, recent: Number.isFinite(recent) ? recent : 0 }];
  }).sort((a, b) => b.overlap - a.overlap || b.recent - a.recent ||
    a.memory_id.localeCompare(b.memory_id))
    .reduce((picked, item) => {
      if (picked.length >= 8) return picked;
      const bytesUsed = picked.reduce((n, prior) => n + bytes(prior.text) +
        bytes(prior.condition ?? ''), 0);
      if (bytesUsed + bytes(item.text) + bytes(item.condition ?? '') <= 4096) {
        picked.push(item);
      }
      return picked;
    }, []).map(({ memory_id, text, condition }) => ({
      memory_id, text, ...(condition ? { condition } : {}) }));
}
