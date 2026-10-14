import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateConversationOutput } from './extract-contract.mjs';
import { transientCbsRuntimeStatus, transientDevelopmentReviewStatus,
  selectExistingMemories } from './curation-policy.mjs';
import { containsSecret } from './candidates.mjs';
import { dedupKeyFor } from './dedup-key.mjs';

const CORPUS_LIMIT = 1024 * 1024;
const OUTPUTS_LIMIT = 2 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const nonEmpty = value => typeof value === 'string' && !!value.trim();
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unique = values => new Set(values).size === values.length;
const fail = reason => { throw new Error(reason); };
const byteSize = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

export function validateMemoryCorpus(corpus) {
  if (!corpus || corpus.version !== 1 || !Array.isArray(corpus.cases) ||
      corpus.cases.length < 1 || corpus.cases.length > 100 ||
      byteSize(corpus) > CORPUS_LIMIT ||
      !unique(corpus.cases.map(item => item?.id))) return false;
  for (const entry of corpus.cases) {
    if (!nonEmpty(entry.id) || !['dev', 'holdout'].includes(entry.split) ||
        !nonEmpty(entry.project_id) || !nonEmpty(entry.owner_id) ||
        !Array.isArray(entry.messages) || entry.messages.length < 2 ||
        entry.messages.length > 10 ||
        !unique(entry.messages.map(message => message?.id)) ||
        !entry.messages.some(message => message.role === 'human') ||
        !entry.messages.some(message => message.role === 'assistant') ||
        entry.messages.some(message => !nonEmpty(message.id) ||
          !['human', 'assistant'].includes(message.role) || !nonEmpty(message.text) ||
          Buffer.byteLength(message.text, 'utf8') > 4096) ||
        !Array.isArray(entry.existing_memories) || entry.existing_memories.length > 64 ||
        !unique(entry.existing_memories.map(memory => memory?.id)) ||
        entry.existing_memories.some(memory => !nonEmpty(memory.id) || !nonEmpty(memory.text) ||
          !['rule', 'fact', 'preference', 'decision'].includes(memory.type) ||
          !['project', 'personal'].includes(memory.scope) ||
          Buffer.byteLength(memory.text, 'utf8') > 512 ||
          memory.project_id != null && !nonEmpty(memory.project_id) ||
          memory.scope === 'personal' && !nonEmpty(memory.owner_id)) ||
        !Array.isArray(entry.expected) || entry.expected.length < 1 ||
        entry.expected.length > 10 || !unique(entry.expected.map(item => item?.id))) return false;
    for (const expected of entry.expected) {
      if (!nonEmpty(expected.id) || !['keep', 'omit', 'correct'].includes(expected.decision) ||
          !nonEmpty(expected.text) || !nonEmpty(expected.rationale) ||
          expected.decision !== 'omit' &&
            (!['rule', 'fact', 'preference', 'decision'].includes(expected.type) ||
             !['project', 'personal'].includes(expected.scope)) ||
          expected.decision === 'correct' &&
            !entry.existing_memories.some(memory => memory.id === expected.corrects)) return false;
    }
  }
  return true;
}

function validateRun(run) {
  if (run === undefined) return true;
  if (!run || typeof run !== 'object' || Array.isArray(run) ||
      Object.keys(run).some(key => !['model', 'prompt_sha256', 'model_sha256',
        'recorded_at'].includes(key))) return false;
  return (run.model == null || nonEmpty(run.model) && run.model.length <= 160) &&
    (run.prompt_sha256 == null || validSha(run.prompt_sha256)) &&
    (run.model_sha256 == null || validSha(run.model_sha256)) &&
    (run.recorded_at == null || nonEmpty(run.recorded_at) &&
      Number.isFinite(Date.parse(run.recorded_at)));
}

function validateUsage(usage) {
  if (usage === undefined) return true;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) ||
      Object.keys(usage).some(key => !['input_tokens', 'output_tokens',
        'duration_ms', 'cost_usd'].includes(key))) return false;
  return Object.entries(usage).every(([key, value]) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
    (key === 'cost_usd' || Number.isSafeInteger(value)));
}

export function validateMemoryOutputs(outputs) {
  if (!outputs || outputs.version !== 1 || !Array.isArray(outputs.results) ||
      outputs.results.length > 100 || byteSize(outputs) > OUTPUTS_LIMIT ||
      !validateRun(outputs.run) || !unique(outputs.results.map(item => item?.case_id))) return false;
  for (const entry of outputs.results) {
    if (!nonEmpty(entry.case_id) || !entry.output ||
        !Array.isArray(entry.output.candidates) ||
        entry.output.candidates.length > 5 ||
        typeof entry.output.no_facts !== 'boolean' ||
        entry.output.no_facts !== (entry.output.candidates.length === 0) ||
        !validateUsage(entry.usage) ||
        entry.attempts !== undefined &&
          (!Array.isArray(entry.attempts) || !entry.attempts.length ||
           entry.attempts.length > 10 ||
           entry.attempts.some(attempt => !['success', 'error'].includes(attempt)))) return false;
    if (entry.adjudication === undefined) continue;
    const { source, labels } = entry.adjudication ?? {};
    if (!['fixture', 'human'].includes(source) || !Array.isArray(labels) ||
        labels.length !== entry.output.candidates.length ||
        !unique(labels.map(label => label?.candidate_index)) ||
        labels.some(label => !Number.isSafeInteger(label?.candidate_index) ||
          label.candidate_index < 0 || label.candidate_index >= labels.length ||
          !['full', 'partial', 'unmatched'].includes(label.verdict) ||
          !nonEmpty(label.rationale) ||
          (label.verdict === 'unmatched') !== (label.expected_id === null) ||
          label.expected_id !== null && !nonEmpty(label.expected_id))) return false;
  }
  return true;
}

async function loadJson(file, limit, label, validate) {
  const stat = await fs.stat(file);
  if (stat.size > limit) fail(`${label}_too_large`);
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) fail(`${label}_too_large`);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail(`invalid_${label}`); }
  if (!validate(parsed)) fail(`invalid_${label}`);
  return { [label === 'corpus' ? 'corpus' : 'outputs']: parsed,
    sha256: sha256(bytes) };
}

export const loadMemoryCorpus = file => loadJson(file, CORPUS_LIMIT, 'corpus',
  validateMemoryCorpus);
export const loadMemoryOutputs = file => loadJson(file, OUTPUTS_LIMIT, 'outputs',
  validateMemoryOutputs);

function grounded(candidate, entry) {
  if (!Array.isArray(candidate?.evidence)) return false;
  const seen = new Set();
  const roles = new Set();
  for (const ref of candidate.evidence) {
    const message = entry.messages.find(item => item.id === ref.source_message_id);
    if (!message || seen.has(message.id) || !nonEmpty(ref.excerpt) ||
        !message.text.includes(ref.excerpt)) return false;
    seen.add(message.id);
    roles.add(message.role);
  }
  return roles.has('human') && roles.has('assistant');
}

function selectedExisting(entry) {
  const points = entry.existing_memories.map(memory => ({ id: memory.id, payload: {
    project_id: memory.project_id ?? entry.project_id,
    user_id: memory.project_id ?? entry.project_id,
    status: 'active', scope: memory.scope, data: memory.text,
  } }));
  const selected = selectExistingMemories(points, { projectId: entry.project_id,
    ownerId: entry.owner_id, query: entry.messages.map(message => message.text).join(' '),
    now: '2026-10-14T00:00:00Z' });
  return entry.existing_memories.filter(memory => selected.some(item => item.memory_id === memory.id));
}

function exactKey(entry, value) {
  try { return dedupKeyFor({ projectId: entry.project_id, scope: value.scope,
    ownerId: value.scope === 'personal' ? (value.owner_id ?? entry.owner_id) : null,
    type: value.type, text: value.text, condition: value.condition ?? null }); }
  catch { return null; }
}

const ratio = (count, denominator) => ({ count, denominator });

// This analyzes supplied extractor output only. Adjudication is a declaration in
// the input file; the evaluator cannot establish its author or semantic accuracy.
export function evaluateMemoryOutputs(corpus, outputs, { split = 'all' } = {}) {
  if (!validateMemoryCorpus(corpus)) fail('invalid_corpus');
  if (!validateMemoryOutputs(outputs)) {
    if (outputs?.results?.some(item => !validateUsage(item?.usage))) fail('invalid_usage');
    if (outputs?.results?.some(item => item?.adjudication !== undefined)) fail('invalid_adjudication');
    fail('invalid_outputs');
  }
  if (!['all', 'dev', 'holdout'].includes(split)) fail('invalid_split');
  const cases = corpus.cases.filter(entry => split === 'all' || entry.split === split);
  const byId = new Map(corpus.cases.map(entry => [entry.id, entry]));
  if (outputs.results.some(item => !byId.has(item.case_id))) fail('unknown_case');
  const resultById = new Map(outputs.results.map(item => [item.case_id, item]));
  const report = { version: 1, corpus_sha256: sha256(JSON.stringify(corpus)),
    outputs_sha256: sha256(JSON.stringify(outputs)), split,
    assessment_scope: 'supplied_extractor_candidates_not_confirmed_Qdrant_writes',
    holdout_note: 'Reserved for operator review; published cases do not prove statistical independence.',
    metric_definitions: {
      correction_retention: 'Counts expected corrections matched by a full new candidate in the expected type and scope; does not verify deletion or deactivation of the old memory.',
    },
    run: { ...(outputs.run ?? {}), provenance: 'supplied_metadata' },
    coverage: { selected: cases.length, submitted: 0, adjudicated: 0 },
    cases: [],
    deterministic: { candidates: 0, invalid_contract: 0, ungrounded_evidence: 0,
      transient_status: 0, secret_retention: 0, exact_duplicate: 0 },
    semantic: { status: 'unmeasured', review_verified: false, false_save: null,
      missed_durable: null, duplicate: null, correction_retention: null,
      scope_error: null, type_error: null },
    operational: { first_attempt_success: null },
    usage: { provided_cases: 0, input_tokens: null, output_tokens: null,
      duration_ms: null, cost_usd: null,
      field_cases: { input_tokens: 0, output_tokens: 0, duration_ms: 0, cost_usd: 0 } } };
  let first = 0;
  let attempts = 0;
  let falseSaves = 0;
  let candidateCount = 0;
  let missed = 0;
  let durableCount = 0;
  let semanticDuplicate = 0;
  let corrected = 0;
  let correctionCount = 0;
  let scopeErrors = 0;
  let typeErrors = 0;
  const adjudicationSources = new Set();
  for (const entry of cases) {
    const supplied = resultById.get(entry.id);
    const caseReport = { case_id: entry.id, split: entry.split,
      submitted: !!supplied, adjudicated: !!supplied?.adjudication,
      contract_valid: null, flags: [], missed_expected_ids: [] };
    report.cases.push(caseReport);
    if (!supplied) continue;
    report.coverage.submitted++;
    const output = supplied.output;
    caseReport.contract_valid = validateConversationOutput(output);
    if (!caseReport.contract_valid) report.deterministic.invalid_contract++;
    const seenKeys = new Set(selectedExisting(entry).map(memory => exactKey(entry, memory)));
    for (const [candidateIndex, rawCandidate] of output.candidates.entries()) {
      const candidate = rawCandidate ?? {};
      const reasons = [];
      report.deterministic.candidates++;
      if (!grounded(candidate, entry)) {
        report.deterministic.ungrounded_evidence++;
        reasons.push('ungrounded_evidence');
      }
      if (containsSecret(candidate)) {
        report.deterministic.secret_retention++;
        reasons.push('secret_retention');
      }
      if (transientCbsRuntimeStatus(candidate.text) ||
          transientDevelopmentReviewStatus(candidate.text, candidate.type)) {
        report.deterministic.transient_status++;
        reasons.push('transient_status');
      }
      const key = exactKey(entry, candidate);
      if (key && seenKeys.has(key)) {
        report.deterministic.exact_duplicate++;
        reasons.push('exact_duplicate');
      }
      if (key) seenKeys.add(key);
      if (reasons.length) caseReport.flags.push({ candidate_index: candidateIndex, reasons });
    }
    if (supplied.attempts) {
      attempts++;
      if (supplied.attempts[0] === 'success') first++;
    }
    if (supplied.usage) {
      report.usage.provided_cases++;
      for (const key of ['input_tokens', 'output_tokens', 'duration_ms', 'cost_usd']) {
        if (supplied.usage[key] !== undefined) {
          report.usage[key] = (report.usage[key] ?? 0) + supplied.usage[key];
          report.usage.field_cases[key]++;
        }
      }
    }
    if (!supplied.adjudication) continue;
    report.coverage.adjudicated++;
    adjudicationSources.add(supplied.adjudication.source);
    candidateCount += output.candidates.length;
    const expectedById = new Map(entry.expected.map(item => [item.id, item]));
    const matches = new Map();
    for (const label of supplied.adjudication.labels) {
      const candidate = output.candidates[label.candidate_index] ?? {};
      const expected = label.expected_id === null ? null : expectedById.get(label.expected_id);
      if (label.expected_id !== null && !expected) fail('invalid_adjudication');
      if (!expected || expected.decision === 'omit' || label.verdict !== 'full') {
        falseSaves++;
        continue;
      }
      if (candidate.scope !== expected.scope || candidate.type !== expected.type) {
        if (candidate.scope !== expected.scope) scopeErrors++;
        if (candidate.type !== expected.type) typeErrors++;
        falseSaves++;
        continue;
      }
      matches.set(expected.id, (matches.get(expected.id) ?? 0) + 1);
    }
    for (const expected of entry.expected) {
      if (expected.decision === 'omit') continue;
      durableCount++;
      const count = matches.get(expected.id) ?? 0;
      if (!count) {
        missed++;
        caseReport.missed_expected_ids.push(expected.id);
      }
      if (count > 1) semanticDuplicate += count - 1;
      if (expected.decision === 'correct') {
        correctionCount++;
        if (count) corrected++;
      }
    }
  }
  if (attempts) report.operational.first_attempt_success = ratio(first, attempts);
  if (report.coverage.adjudicated) {
    report.semantic.status = adjudicationSources.size === 1 &&
      adjudicationSources.has('fixture') ? 'fixture_control' :
      adjudicationSources.size === 1 && adjudicationSources.has('human') ?
        'declared_human' : 'mixed_declared';
    report.semantic.false_save = ratio(falseSaves, candidateCount);
    report.semantic.missed_durable = ratio(missed, durableCount);
    report.semantic.duplicate = ratio(semanticDuplicate, candidateCount);
    report.semantic.correction_retention = ratio(corrected, correctionCount);
    report.semantic.scope_error = ratio(scopeErrors, candidateCount);
    report.semantic.type_error = ratio(typeErrors, candidateCount);
  }
  return report;
}
