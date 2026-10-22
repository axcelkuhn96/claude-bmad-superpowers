import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { selectRecall } from './context.mjs';
import { rankHybrid, verifiedLiteralSpans } from './hybrid-rank.mjs';
import { validateMemoryCorpusV2 } from './evaluation.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha256(JSON.stringify(value));
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonEmpty = value => typeof value === 'string' && !!value.trim();
const ratio = (count, denominator) => denominator ? { count, denominator } : null;
const fail = reason => { throw new Error(reason); };
const idFor = row => row?.sdkId ?? row?.memory_id ?? row?.id;
const sourceHash = path => sha256(readFileSync(new URL(path, import.meta.url)));
export const retrievalAlgorithmSources = Object.freeze({
  vector_selector_sha256: sourceHash('./context.mjs'),
  hybrid_rank_sha256: sourceHash('./hybrid-rank.mjs'),
  hybrid_algorithm_sha256: sha256(sourceHash('./context.mjs') + sourceHash('./hybrid-rank.mjs')),
  vector_reference: 'current_selectRecall_default_preserved_vector_path',
  comparability_limit: 'The vector selector is current source, not a byte-for-byte 0.15.10 executable; historical 0.15.10 observations are separate and unpaired.',
});
const RETRIEVAL_LIMIT = 8 * 1024 * 1024;
const ADJUDICATION_LIMIT = 1024 * 1024;

export const hashCorpusSplits = corpus => hash(corpus.cases.map(entry => [entry.id, entry.split]));
export const hashExpectedLabel = entry => hash(entry.expected);

export function validateRetrievalAdjudication(corpus, adjudication, { corpusSha256 } = {}) {
  if (!validateMemoryCorpusV2(corpus) || !adjudication ||
      adjudication.version !== 1 || adjudication.kind !== 'retrieval_label_adjudication' ||
      adjudication.source !== 'agent_reviewed' ||
      adjudication.corpus_sha256 !== (corpusSha256 ?? hash(corpus)) ||
      adjudication.split_sha256 !== hashCorpusSplits(corpus) ||
      !Array.isArray(adjudication.cases) ||
      adjudication.cases.length !== corpus.cases.length ||
      new Set(adjudication.cases.map(item => item?.case_id)).size !== corpus.cases.length)
    return false;
  const byId = new Map(corpus.cases.map(entry => [entry.id, entry]));
  return adjudication.cases.every(item => byId.has(item.case_id) &&
    item.expected_sha256 === hashExpectedLabel(byId.get(item.case_id)) &&
    ['approved', 'rejected', 'unmeasured'].includes(item.status));
}

export async function loadRetrievalAdjudication(file) {
  const stat = await fs.stat(file);
  if (stat.size > ADJUDICATION_LIMIT) fail('adjudication_too_large');
  const bytes = await fs.readFile(file);
  if (bytes.length > ADJUDICATION_LIMIT) fail('adjudication_too_large');
  let adjudication;
  try { adjudication = JSON.parse(bytes.toString('utf8')); }
  catch { fail('invalid_adjudication'); }
  return { adjudication, sha256: sha256(bytes) };
}

export async function loadRetrievalArtifact(file) {
  const stat = await fs.stat(file);
  if (stat.size > RETRIEVAL_LIMIT) fail('retrieval_too_large');
  const bytes = await fs.readFile(file);
  if (bytes.length > RETRIEVAL_LIMIT) fail('retrieval_too_large');
  let retrieval;
  try { retrieval = JSON.parse(bytes.toString('utf8')); }
  catch { fail('invalid_retrieval'); }
  if (!retrieval || retrieval.version !== 1 || retrieval.kind !== 'frozen_retrieval' ||
      !Array.isArray(retrieval.cases) || retrieval.cases.length > 100)
    fail('invalid_retrieval');
  return { retrieval, sha256: sha256(bytes) };
}

// Hash exactly the candidate material both arms receive. No raw payload enters reports.
export function hashCandidateSet(item) {
  return hash({ query: item.query, collection_observation_sha256: item.collection_observation_sha256,
    observed_at: item.observed_at, owner_id: item.owner_id ?? null,
    vector_candidates: item.vector_candidates, lexical_candidates: item.lexical_candidates,
    payload_hashes: item.payload_hashes, eligibility_metadata: item.eligibility_metadata });
}

function caseErrors(entry, item) {
  const errors = [];
  const add = reason => { if (!errors.includes(reason)) errors.push(reason); };
  if (!item || item.case_id !== entry.id || item.query !== entry.query) add('case_or_query_mismatch');
  if (!Array.isArray(item?.vector_candidates) || !Array.isArray(item?.lexical_candidates) ||
      item.vector_candidates.length > 2048 || item.lexical_candidates.length > 32 ||
      !item.payload_hashes || typeof item.payload_hashes !== 'object' ||
      !item.eligibility_metadata || typeof item.eligibility_metadata !== 'object') {
    add('invalid_candidate_set');
    return errors;
  }
  if (!validSha(item.candidate_set_sha256) || !validSha(item.collection_observation_sha256) ||
      hashCandidateSet(item) !== item.candidate_set_sha256) add('candidate_set_hash_mismatch');
  const all = [...item.vector_candidates, ...item.lexical_candidates];
  const ids = new Set();
  for (const row of all) {
    const id = idFor(row);
    if (!nonEmpty(id) || !nonEmpty(row?.text) || !row?.metadata ||
        typeof row.metadata !== 'object') { add('invalid_candidate'); continue; }
    ids.add(id);
    if (item.payload_hashes[id] !== sha256(row.text)) add('payload_hash_mismatch');
    if (row.metadata.project_id != null && row.metadata.project_id !== row.projectId)
      add('eligibility_metadata_mismatch');
    const e = item.eligibility_metadata[id];
    if (!e || e.project_id !== row.projectId || e.status !== row.status ||
        e.scope !== row.metadata.scope || e.owner_id !== (row.metadata.owner_id ?? null) ||
        e.valid_from !== (row.metadata.valid_from ?? null) ||
        e.valid_to !== (row.metadata.valid_to ?? null)) add('eligibility_metadata_mismatch');
  }
  if (Object.keys(item.payload_hashes).some(id => !ids.has(id)) ||
      Object.keys(item.eligibility_metadata).some(id => !ids.has(id))) add('candidate_universe_mismatch');
  for (const arm of ['baseline', 'candidate']) {
    const output = item[arm];
    if (!output || !Array.isArray(output.returned_ids) ||
        output.returned_ids.length > 20 ||
        new Set(output.returned_ids).size !== output.returned_ids.length ||
        !validSha(output.candidate_set_sha256) ||
        !validSha(output.collection_observation_sha256)) { add('invalid_returned_ids'); continue; }
    if (output.returned_ids.some(id => !ids.has(id))) add('unknown_returned_id');
    for (const id of output.returned_ids) {
      const row = all.find(candidate => idFor(candidate) === id);
      if (!row) continue;
      if (row.projectId !== entry.projectId ||
          row.metadata?.project_id != null && row.metadata.project_id !== entry.projectId ||
          row.metadata?.scope === 'personal' &&
            (!nonEmpty(item.owner_id) || row.metadata.owner_id !== item.owner_id))
        add('ineligible_returned_id');
      if (row.status !== 'active') add('ineligible_returned_id');
      const at = Date.parse(item.observed_at ?? '');
      const end = Date.parse(row.metadata?.valid_to ?? '');
      if (Number.isFinite(at) && Number.isFinite(end) && end <= at)
        add('ineligible_returned_id');
      const start = Date.parse(row.metadata?.valid_from ?? '');
      if (Number.isFinite(at) && Number.isFinite(start) && start > at)
        add('ineligible_returned_id');
    }
    if (output.candidate_set_sha256 !== item.candidate_set_sha256) add('arm_candidate_set_mismatch');
    if (output.collection_observation_sha256 !== item.collection_observation_sha256)
      add('arm_observation_mismatch');
    const version = arm === 'baseline' ? 'vector_selector_current' : 'hybrid_rank_current';
    const algorithmSha = arm === 'baseline' ? retrievalAlgorithmSources.vector_selector_sha256 :
      retrievalAlgorithmSources.hybrid_algorithm_sha256;
    if (output.retrieval_version !== version || output.algorithm_sha256 !== algorithmSha)
      add('algorithm_version_mismatch');
  }
  return errors;
}

// The caller freezes this item once, then replays both local algorithms. The
// result is ranking conditional on that set, never a Qdrant MVCC/live comparison.
export function replayRetrievalCase(entry, item, { now, ownerId } = {}) {
  const errors = caseErrors(entry, { ...item, baseline: { candidate_set_sha256: item.candidate_set_sha256,
    collection_observation_sha256: item.collection_observation_sha256, returned_ids: [],
    retrieval_version: 'vector_selector_current',
    algorithm_sha256: retrievalAlgorithmSources.vector_selector_sha256 },
  candidate: { candidate_set_sha256: item.candidate_set_sha256,
    collection_observation_sha256: item.collection_observation_sha256, returned_ids: [],
    retrieval_version: 'hybrid_rank_current',
    algorithm_sha256: retrievalAlgorithmSources.hybrid_algorithm_sha256 } });
  if (errors.length) fail('invalid_retrieval');
  if (!nonEmpty(now)) fail('invalid_observation_time');
  const options = { projectId: entry.projectId, ownerId, now, query: entry.query };
  const vectors = selectRecall(item.vector_candidates, options).slice(0, 20);
  const lexical = selectRecall(item.lexical_candidates, { ...options, preserveHybridOrder: true })
    .filter(row => row.scoreSource === 'lexical_verified').map(row => ({ ...row,
      retrievalEvidence: { ...row.retrievalEvidence,
        literalSpans: verifiedLiteralSpans(entry.query, row.text ?? row.memory) } }));
  const candidate = lexical.length ? selectRecall(rankHybrid(vectors, lexical,
    { query: entry.query }), { ...options, preserveHybridOrder: true }).slice(0, 20) : vectors;
  const arm = rows => ({ candidate_set_sha256: item.candidate_set_sha256,
    collection_observation_sha256: item.collection_observation_sha256,
    returned_ids: rows.map(idFor) });
  return { baseline: { ...arm(vectors), retrieval_version: 'vector_selector_current',
    algorithm_sha256: retrievalAlgorithmSources.vector_selector_sha256 },
  candidate: { ...arm(candidate), retrieval_version: 'hybrid_rank_current',
    algorithm_sha256: retrievalAlgorithmSources.hybrid_algorithm_sha256 },
  algorithm_sources: retrievalAlgorithmSources };
}

function emptyMetrics() {
  return { hit_at_1: null, hit_at_3: null, hit_at_5: null,
    precision_at_5: null, recall_at_5: null, mrr: null,
    abstention_accuracy: null, false_positive: null, owner_leak: null,
    project_leak: null, stale: null, superseded: null, context_error: null };
}

function scoreArm(cases, records, arm, truthEligible) {
  const counts = { hit1: 0, hit3: 0, hit5: 0, precision: 0, recall: 0,
    relevant: 0, positives: 0, reciprocal: 0, negative: 0, abstain: 0,
    falsePositive: 0, returned: 0, owner: 0, project: 0, stale: 0, superseded: 0 };
  for (const entry of cases) {
    const item = records.get(entry.id);
    if (!item || !Array.isArray(item[arm]?.returned_ids)) continue;
    const ids = item[arm].returned_ids;
    const rows = new Map([...item.vector_candidates, ...item.lexical_candidates]
      .map(row => [idFor(row), row]));
    const now = Date.parse(item.observed_at ?? '');
    const ownerId = item.owner_id;
    for (const id of ids) {
      counts.returned++;
      const row = rows.get(id);
      if (!row) continue;
      if (row.projectId !== entry.projectId || row.metadata?.project_id != null &&
          row.metadata.project_id !== entry.projectId) counts.project++;
      if (row.metadata?.scope === 'personal' &&
          (!nonEmpty(ownerId) || row.metadata.owner_id !== ownerId)) counts.owner++;
      if (row.status === 'superseded') counts.superseded++;
      if (Number.isFinite(now) && (row.metadata?.valid_to &&
          Number.isFinite(Date.parse(row.metadata.valid_to)) &&
          Date.parse(row.metadata.valid_to) <= now ||
          row.metadata?.valid_from && Number.isFinite(Date.parse(row.metadata.valid_from)) &&
          Date.parse(row.metadata.valid_from) > now)) counts.stale++;
    }
    if (!truthEligible.has(entry.id)) continue;
    if (entry.expected.abstain) {
      counts.negative++;
      if (!ids.length) counts.abstain++;
      else counts.falsePositive++;
      continue;
    }
    counts.positives++;
    const relevant = new Set(entry.expected.relevant_ids);
    counts.relevant += relevant.size;
    for (const [k, key] of [[1, 'hit1'], [3, 'hit3'], [5, 'hit5']]) {
      if (ids.slice(0, k).some(id => relevant.has(id))) counts[key]++;
    }
    const top = ids.slice(0, 5);
    const found = top.filter(id => relevant.has(id)).length;
    counts.precision += found;
    counts.recall += found;
    const first = ids.findIndex(id => relevant.has(id));
    if (first !== -1) counts.reciprocal += 1 / (first + 1);
  }
  return { ...emptyMetrics(), hit_at_1: ratio(counts.hit1, counts.positives),
    hit_at_3: ratio(counts.hit3, counts.positives),
    hit_at_5: ratio(counts.hit5, counts.positives),
    precision_at_5: ratio(counts.precision, counts.positives * 5),
    recall_at_5: ratio(counts.recall, counts.relevant),
    mrr: counts.positives ? { sum: counts.reciprocal, denominator: counts.positives } : null,
    abstention_accuracy: ratio(counts.abstain, counts.negative),
    false_positive: ratio(counts.falsePositive, counts.negative),
    owner_leak: ratio(counts.owner, counts.returned),
    project_leak: ratio(counts.project, counts.returned),
    stale: ratio(counts.stale, counts.returned),
    superseded: ratio(counts.superseded, counts.returned) };
}

function observedUsage(cases) {
  const usage = { latency_ms: null, tokens: null, cost_usd: null,
    coverage: { latency_ms: 0, tokens: 0, cost_usd: 0 } };
  for (const item of cases) {
    for (const key of Object.keys(usage.coverage)) {
      const value = item.usage?.[key] ?? item[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      usage[key] = (usage[key] ?? 0) + value;
      usage.coverage[key]++;
    }
  }
  return usage;
}

export function evaluateRetrieval(corpus, runs, { split = 'all', corpusSha256,
  adjudication, adjudicationSha256 } = {}) {
  if (!validateMemoryCorpusV2(corpus)) fail('invalid_corpus');
  if (!['all', 'dev', 'holdout'].includes(split)) fail('invalid_split');
  if (!runs || runs.version !== 1 || runs.kind !== 'frozen_retrieval' ||
      !Array.isArray(runs.cases) || runs.cases.length > 100 ||
      new Set(runs.cases.map(item => item?.case_id)).size !== runs.cases.length)
    fail('invalid_retrieval');
  const ids = new Set(corpus.cases.map(entry => entry.id));
  if (runs.cases.some(item => !ids.has(item.case_id))) fail('unknown_case');
  const selected = corpus.cases.filter(entry => split === 'all' || entry.split === split);
  const records = new Map(runs.cases.map(item => [item.case_id, item]));
  const expectedCorpusSha = corpusSha256 ?? hash(corpus);
  if (adjudication !== undefined &&
      !validateRetrievalAdjudication(corpus, adjudication, { corpusSha256: expectedCorpusSha }))
    fail('invalid_adjudication');
  const reviews = adjudication ? new Map(adjudication.cases.map(item => [item.case_id, item.status])) : null;
  const corpusMatched = runs.corpus_sha256 === expectedCorpusSha;
  const expectedSplitSha = hashCorpusSplits(corpus);
  const splitMatched = runs.split_sha256 === expectedSplitSha;
  const labelStatus = reviews ? selected.every(entry => reviews.get(entry.id) === 'approved') ?
    'agent_reviewed' : 'agent_reviewed_partial' :
    selected.some(entry => entry.adjudication.source === 'agent_proposed') ?
      'agent_proposed_provisional' : 'agent_reviewed_provisional';
  const caseReports = selected.map(entry => {
    const item = records.get(entry.id);
    const errors = item ? caseErrors(entry, item) : ['missing_case'];
    if (item && !Number.isFinite(Date.parse(item.observed_at ?? '')))
      errors.push('missing_observation_time');
    if (!corpusMatched) errors.push('corpus_hash_mismatch');
    if (!splitMatched) errors.push('split_hash_mismatch');
    if (item && errors.length === 0) {
      try {
        const replay = replayRetrievalCase(entry, item, { now: item.observed_at,
          ownerId: item.owner_id });
        if (['baseline', 'candidate'].some(arm => JSON.stringify(item[arm].returned_ids) !==
            JSON.stringify(replay[arm].returned_ids))) errors.push('algorithm_output_mismatch');
      } catch { errors.push('algorithm_replay_unavailable'); }
    }
    return { case_id: entry.id, split: entry.split, paired_replay: errors.length === 0,
      ground_truth: reviews ? reviews.get(entry.id) :
        entry.expected.unmeasured === true ? 'unmeasured' :
        entry.adjudication.source === 'agent_proposed' ?
          'agent_proposed_provisional' : 'agent_reviewed_provisional', errors };
  });
  const paired = caseReports.length > 0 && caseReports.every(item => item.paired_replay);
  const submitted = selected.filter(entry => records.has(entry.id));
  const valid = submitted.filter(entry => !caseReports.find(item => item.case_id === entry.id).errors
    .some(error => ['invalid_candidate_set', 'invalid_candidate', 'unknown_returned_id',
      'invalid_returned_ids'].includes(error)));
  const truthEligible = new Set(selected.filter(entry => reviews ?
    reviews.get(entry.id) === 'approved' : entry.expected.unmeasured !== true).map(entry => entry.id));
  const baseline = scoreArm(valid, records, 'baseline', truthEligible);
  const candidate = scoreArm(valid, records, 'candidate', truthEligible);
  const comparisonEligible = paired && reviews && selected.some(entry => reviews.get(entry.id) === 'approved') &&
    selected.every(entry => reviews.get(entry.id) === 'approved' ||
      reviews.get(entry.id) === 'unmeasured' && entry.expected.unmeasured === true);
  const comparison = comparisonEligible ? Object.fromEntries(['hit_at_1', 'hit_at_3', 'hit_at_5',
    'precision_at_5', 'recall_at_5', 'mrr', 'abstention_accuracy', 'false_positive']
    .map(key => [key, baseline[key] && candidate[key] ?
      (candidate[key].count ?? candidate[key].sum) / candidate[key].denominator -
        (baseline[key].count ?? baseline[key].sum) / baseline[key].denominator : null])) : null;
  return { version: 1, split, corpus_sha256: expectedCorpusSha,
    split_sha256: expectedSplitSha,
    adjudication_sha256: adjudication ? adjudicationSha256 ?? hash(adjudication) : null,
    retrieval_sha256: hash(runs), label_status: labelStatus,
    assessment_scope: 'offline_ranking_conditional_on_frozen_candidates',
    live_qdrant_paired: false, historical_baseline_paired: false, paired_replay: paired,
    metric_definitions: { context_error: 'unmeasured_without_rendered_context_and_source_review' },
    algorithm_sources: retrievalAlgorithmSources,
    coverage: { selected: selected.length, submitted: submitted.length,
      paired: caseReports.filter(item => item.paired_replay).length,
      approved: reviews ? selected.filter(entry => reviews.get(entry.id) === 'approved').length : 0,
      rejected: reviews ? selected.filter(entry => reviews.get(entry.id) === 'rejected').length : 0,
      truth_unmeasured: selected.filter(entry => reviews ?
        reviews.get(entry.id) === 'unmeasured' : entry.expected.unmeasured === true).length },
    cases: caseReports, baseline, candidate, comparison,
    usage: observedUsage(submitted.map(entry => records.get(entry.id))) };
}
