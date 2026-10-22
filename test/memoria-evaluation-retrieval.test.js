import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateMemoryCorpusV2, loadMemoryCorpus, evaluateMemoryOutputs } from '../base/memoria/evaluation.mjs';
import { evaluateRetrieval, hashCandidateSet, replayRetrievalCase,
  retrievalAlgorithmSources, hashCorpusSplits, hashExpectedLabel,
  validateRetrievalAdjudication, validateRetrievalIdentities } from '../base/memoria/evaluation-retrieval.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const corpus = JSON.parse(await fs.readFile(fileURLToPath(new URL('./fixtures/memoria-quality-v2-minimal.json', import.meta.url))));
const metadata = { scope: 'project', source: 'synthetic', actor: 'user', origin: 'user_direct',
  speaker_role: 'user', evidence_at: '2026-10-01T00:00:00Z' };
const row = (id, score, text = `${id.toUpperCase()}_42`, extra = {}) => ({ id, projectId: 'synthetic-project',
  status: 'active', text, score, scoreSource: 'mem0_sdk_search', metadata: { ...metadata, ...extra } });
const eligibility = rows => Object.fromEntries(rows.map(r => [r.id, { project_id: r.projectId,
  status: r.status, scope: r.metadata.scope, owner_id: r.metadata.owner_id ?? null,
  valid_from: r.metadata.valid_from ?? null, valid_to: r.metadata.valid_to ?? null }]));
function artifact(entry, vectors, lexical = [], baselineIds = [], candidateIds = baselineIds) {
  const rows = [...vectors, ...lexical];
  const points = [...new Map(rows.map(r => [r.id, [r.id, { data: r.text }]])).values()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const item = { case_id: entry.id, query: entry.query,
    observed_at: '2026-10-22T00:00:00Z',
    owner_id: 'synthetic-owner',
    collection_observation_sha256: sha(stable(points)), vector_candidates: vectors,
    lexical_candidates: lexical, payload_hashes: Object.fromEntries(rows.map(r => [r.id, sha(r.text)])),
    eligibility_metadata: eligibility(rows) };
  item.candidate_set_sha256 = hashCandidateSet(item);
  item.baseline = { candidate_set_sha256: item.candidate_set_sha256,
    collection_observation_sha256: item.collection_observation_sha256, returned_ids: baselineIds,
    retrieval_version: 'vector_selector_current',
    algorithm_sha256: retrievalAlgorithmSources.vector_selector_sha256 };
  item.candidate = { candidate_set_sha256: item.candidate_set_sha256,
    collection_observation_sha256: item.collection_observation_sha256, returned_ids: candidateIds,
    retrieval_version: 'hybrid_rank_current',
    algorithm_sha256: retrievalAlgorithmSources.hybrid_algorithm_sha256 };
  return item;
}
const runs = cases => ({ version: 1, kind: 'frozen_retrieval',
  corpus_sha256: sha(JSON.stringify(corpus)),
  split_sha256: hashCorpusSplits(corpus), cases });
const sidecar = (entries = corpus.cases) => ({ version: 1,
  kind: 'retrieval_label_adjudication', source: 'agent_reviewed',
  corpus_sha256: sha(JSON.stringify(corpus)), split_sha256: hashCorpusSplits(corpus),
  cases: entries.map(entry => ({ case_id: entry.id,
    expected_sha256: hashExpectedLabel(entry), status: 'approved' })) });
const identities = (source = corpus) => ({ version: 1,
  kind: 'retrieval_identity_authority', source: 'validated_local_config',
  authority_observation_sha256: 'd'.repeat(64),
  corpus_sha256: sha(JSON.stringify(source)), split_sha256: hashCorpusSplits(source),
  cases: source.cases.map(entry => ({ case_id: entry.id,
    project_id: entry.projectId, owner_id: 'synthetic-owner' })) });
const stable = value => JSON.stringify(value, (_, object) => object &&
  !Array.isArray(object) && typeof object === 'object' ?
    Object.fromEntries(Object.entries(object).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0)) : object);
function observationsFor(input, source = corpus) {
  return { version: 1, kind: 'retrieval_collection_observations',
    source: 'trusted_external_collector', corpus_sha256: sha(JSON.stringify(source)),
    split_sha256: hashCorpusSplits(source), cases: source.cases.map(entry => {
      const item = input.cases.find(x => x.case_id === entry.id);
      const rows = item ? [...item.vector_candidates, ...item.lexical_candidates] : [];
      const points = [...new Map(rows.map(r => [r.id, [r.id, { data: r.text }]])).values()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const payload_sha256 = sha(stable(points));
      const observation = { snapshot_file: '/synthetic/collector-snapshot.json',
        snapshot_file_sha256: payload_sha256, payload_sha256, count: points.length,
        cursor_complete: true, points };
      return { case_id: entry.id,
        candidate_set_sha256: item?.candidate_set_sha256 ?? 'a'.repeat(64),
        collection_observation_sha256: item?.collection_observation_sha256 ?? payload_sha256,
        before: structuredClone(observation), after: structuredClone(observation) };
    }) };
}

test('independent owner authority blocks a forged personal return and absence stays unmeasured', () => {
  const personal = row('foreign', 0.95, 'FOREIGN_42',
    { scope: 'personal', owner_id: 'foreign-owner' });
  const one = artifact(corpus.cases[0], [personal], [], ['foreign'], ['foreign']);
  one.owner_id = 'foreign-owner';
  one.candidate_set_sha256 = hashCandidateSet(one);
  one.baseline.candidate_set_sha256 = one.candidate_set_sha256;
  one.candidate.candidate_set_sha256 = one.candidate_set_sha256;
  const without = evaluateRetrieval(corpus, runs([one]),
    { split: 'dev', adjudication: sidecar() });
  assert.equal(without.candidate.owner_leak, null);
  assert.equal(without.comparison, null);
  const report = evaluateRetrieval(corpus, runs([one]),
    { split: 'dev', adjudication: sidecar(), identities: identities() });
  assert.equal(report.paired_replay, false);
  assert.deepEqual(report.candidate.owner_leak, { count: 1, denominator: 1 });
  assert.ok(report.cases[0].errors.includes('owner_authority_mismatch'));
});

test('independently bound personal return is eligible without an owner leak', () => {
  const personal = row('a', 0.95, 'ALPHA_42',
    { scope: 'personal', owner_id: 'synthetic-owner' });
  const one = artifact(corpus.cases[0], [personal], [], ['a'], ['a']);
  const input = runs([one]);
  const report = evaluateRetrieval(corpus, input,
    { split: 'dev', identities: identities(), observations: observationsFor(input) });
  assert.equal(report.paired_replay, true);
  assert.deepEqual(report.candidate.owner_leak, { count: 0, denominator: 1 });
});

test('approved conditional label does not resolve frozen unmeasured truth', () => {
  const uncertain = structuredClone(corpus);
  uncertain.cases[0].expected.unmeasured = true;
  const one = artifact(uncertain.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  one.owner_id = 'synthetic-owner';
  one.candidate_set_sha256 = hashCandidateSet(one);
  one.baseline.candidate_set_sha256 = one.candidate_set_sha256;
  one.candidate.candidate_set_sha256 = one.candidate_set_sha256;
  const input = runs([one]);
  input.corpus_sha256 = sha(JSON.stringify(uncertain));
  const review = sidecar(uncertain.cases);
  review.corpus_sha256 = input.corpus_sha256;
  review.cases[0].expected_sha256 = hashExpectedLabel(uncertain.cases[0]);
  const report = evaluateRetrieval(uncertain, input,
    { split: 'dev', adjudication: review, identities: identities(uncertain) });
  assert.equal(report.coverage.truth_unmeasured, 1);
  assert.equal(report.cases[0].ground_truth, 'unmeasured');
  assert.equal(report.cases[0].conditional_relevance_review, 'approved');
  assert.equal(report.baseline.hit_at_1, null);
  assert.equal(report.comparison, null);
});

test('identity authority requires an exact corpus and split bound owner for every case', () => {
  const base = identities();
  assert.equal(validateRetrievalIdentities(corpus, base), true);
  for (const edit of [
    x => { x.corpus_sha256 = 'f'.repeat(64); },
    x => { x.split_sha256 = 'f'.repeat(64); },
    x => { x.authority_observation_sha256 = ''; },
    x => { x.cases[0].owner_id = ''; },
    x => { x.cases[0].project_id = 'foreign-project'; },
    x => { x.cases[0].case_id = x.cases[1].case_id; },
    x => { x.cases.pop(); },
  ]) {
    const invalid = structuredClone(base);
    edit(invalid);
    assert.equal(validateRetrievalIdentities(corpus, invalid), false);
    assert.throws(() => evaluateRetrieval(corpus, runs([]), { identities: invalid }),
      /invalid_identities/);
  }
});

test('same memory ID with changed metadata across channels cannot claim paired replay', () => {
  const vector = row('a', 0.95);
  const lexical = { ...row('a', 0.95, 'A_42', { source: 'different-source' }),
    scoreSource: 'lexical_verified', retrievalEvidence: { lexicalRank: 1 } };
  const one = artifact(corpus.cases[0], [vector], [lexical], ['a'], ['a']);
  one.owner_id = 'synthetic-owner';
  one.candidate_set_sha256 = hashCandidateSet(one);
  one.baseline.candidate_set_sha256 = one.candidate_set_sha256;
  one.candidate.candidate_set_sha256 = one.candidate_set_sha256;
  const report = evaluateRetrieval(corpus, runs([one]),
    { split: 'dev', identities: identities() });
  assert.equal(report.paired_replay, false);
  assert.ok(report.cases[0].errors.includes('candidate_payload_mismatch'));
});

test('adapter vector sessionId transport differs from lexical without changing shared payload', () => {
  const vector = { ...row('a', 0.95), sessionId: 'run-id-only-in-vector' };
  const lexical = { ...row('a', 0.7), scoreSource: 'lexical_verified',
    retrievalEvidence: { lexicalRank: 1 } };
  const one = artifact(corpus.cases[0], [vector], [lexical], ['a'], ['a']);
  one.collection_observation_sha256 = sha(stable([['a', { data: vector.text }]]));
  one.candidate_set_sha256 = hashCandidateSet(one);
  for (const arm of ['baseline', 'candidate']) {
    one[arm].candidate_set_sha256 = one.candidate_set_sha256;
    one[arm].collection_observation_sha256 = one.collection_observation_sha256;
  }
  const input = runs([one]);
  const report = evaluateRetrieval(corpus, input,
    { split: 'dev', identities: identities(), observations: observationsFor(input) });
  assert.equal(report.paired_replay, true);
  assert.equal(report.cases[0].errors.includes('candidate_payload_mismatch'), false);
  lexical.metadata.source = 'foreign-source';
  const changed = artifact(corpus.cases[0], [vector], [lexical], ['a'], ['a']);
  changed.collection_observation_sha256 = one.collection_observation_sha256;
  changed.candidate_set_sha256 = hashCandidateSet(changed);
  for (const arm of ['baseline', 'candidate']) {
    changed[arm].candidate_set_sha256 = changed.candidate_set_sha256;
    changed[arm].collection_observation_sha256 = changed.collection_observation_sha256;
  }
  const drifted = runs([changed]);
  const mismatch = evaluateRetrieval(corpus, drifted,
    { split: 'dev', identities: identities(), observations: observationsFor(drifted) });
  assert.equal(mismatch.paired_replay, false);
  assert.ok(mismatch.cases[0].errors.includes('candidate_payload_mismatch'));
});

test('external collection receipts gate paired replay and reject drift or case binding changes', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  const payload = sha(stable([['a', { data: one.vector_candidates[0].text }]]));
  one.collection_observation_sha256 = payload;
  one.candidate_set_sha256 = hashCandidateSet(one);
  for (const arm of ['baseline', 'candidate']) {
    one[arm].candidate_set_sha256 = one.candidate_set_sha256;
    one[arm].collection_observation_sha256 = payload;
  }
  const input = runs([one]);
  const base = observationsFor(input);
  const options = { split: 'dev', identities: identities(), adjudication: sidecar() };
  const absent = evaluateRetrieval(corpus, input, options);
  assert.equal(absent.paired_replay, false);
  assert.equal(absent.comparison, null);
  const valid = evaluateRetrieval(corpus, input, { ...options, observations: base });
  assert.equal(valid.paired_replay, true);
  assert.equal(valid.operational_revision_verified, true);
  assert.notEqual(valid.comparison, null);
  for (const edit of [
    x => { x.corpus_sha256 = 'f'.repeat(64); },
    x => { x.split_sha256 = 'f'.repeat(64); },
    x => { x.cases.pop(); },
    x => { x.cases[0].case_id = x.cases[1].case_id; },
    x => { x.cases[0].candidate_set_sha256 = 'f'.repeat(64); },
    x => { x.cases[0].before.count++; },
    x => { x.cases[0].before.cursor_complete = false; },
    x => { x.cases[0].after.points[0][1].data = 'changed'; },
  ]) {
    const invalid = structuredClone(base);
    edit(invalid);
    const report = evaluateRetrieval(corpus, input, { ...options, observations: invalid });
    assert.equal(report.paired_replay, false);
    assert.equal(report.comparison, null);
    assert.equal(report.operational_revision_verified, false);
  }
});

test('operator trusted digest proof binds counts without claiming retained raw snapshots', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  const input = runs([one]);
  const receipts = observationsFor(input);
  receipts.source = 'operator_trusted_collector';
  receipts.collector_source_sha256 = 'e'.repeat(64);
  receipts.proof_file = '/synthetic/collector-proof.json';
  receipts.proof_file_sha256 = 'f'.repeat(64);
  receipts.proof = { corpus_sha256: input.corpus_sha256,
    cases: receipts.cases.map(entry => ({ case_id: entry.case_id,
      collection_observation_sha256: entry.before.payload_sha256,
      after_sha256: entry.after.payload_sha256,
      point_count_before: entry.before.count, point_count_after: entry.after.count,
      stable: true, candidate_payloads_stable: true, duplicate_consistent: true })) };
  for (const entry of receipts.cases) {
    delete entry.before.points;
    delete entry.after.points;
  }
  const options = { split: 'dev', identities: identities(), observations: receipts };
  const verified = evaluateRetrieval(corpus, input, options);
  assert.equal(verified.paired_replay, true);
  assert.equal(verified.operational_revision_verified, true);
  assert.match(verified.trust_assumptions.collection_observation, /raw_snapshot_unretained/);
  assert.equal(verified.live_qdrant_paired, false);
  const altered = structuredClone(receipts);
  altered.proof.cases[0].point_count_after++;
  const mismatch = evaluateRetrieval(corpus, input, { ...options, observations: altered });
  assert.equal(mismatch.paired_replay, false);
  assert.ok(mismatch.cases[0].errors.includes('collection_receipt_proof_mismatch'));
});

test('v2 requires source excerpt and hash, rejects secrets and unauthenticated human label', () => {
  assert.equal(validateMemoryCorpusV2(corpus), true);
  const changed = edit => { const copy = structuredClone(corpus); edit(copy.cases[0]); return copy; };
  assert.equal(validateMemoryCorpusV2(changed(e => { delete e.source.excerpt; })), false);
  assert.equal(validateMemoryCorpusV2(changed(e => { delete e.source.source_sha256; })), false);
  assert.equal(validateMemoryCorpusV2(changed(e => { e.source.excerpt = 'password=example'; })), false);
  assert.equal(validateMemoryCorpusV2(changed(e => { e.adjudication.source = 'human'; })), false);
});

test('two relevant IDs produce case hit, recall, precision and MRR with explicit denominators', () => {
  const a = row('a', 0.94, 'ALPHA_42'), b = row('b', 0.91, 'BETA_42');
  const x = row('x', 0.96, 'UNRELATED_42');
  const lexical = [a, b].map((r, i) => ({ ...r, scoreSource: 'lexical_verified',
    retrievalEvidence: { lexicalRank: i + 1 } }));
  const input = runs([artifact(corpus.cases[0], [x, a, b], lexical,
    ['x', 'a', 'b'], ['x', 'a', 'b'])]);
  const result = evaluateRetrieval(corpus, input,
    { split: 'dev', identities: identities(), observations: observationsFor(input) });
  assert.equal(result.paired_replay, true);
  assert.equal(result.comparison, null);
  assert.deepEqual(result.baseline.hit_at_1, { count: 0, denominator: 1 });
  assert.deepEqual(result.candidate.hit_at_1, { count: 0, denominator: 1 });
  assert.deepEqual(result.candidate.hit_at_3, { count: 1, denominator: 1 });
  assert.deepEqual(result.candidate.recall_at_5, { count: 2, denominator: 2 });
  assert.deepEqual(result.candidate.precision_at_5, { count: 2, denominator: 5 });
  assert.deepEqual(result.baseline.mrr, { sum: 0.5, denominator: 1 });
});

test('abstention and false positive are measured separately from positive recall', () => {
  const x = row('x', 0.9, 'GAMMA_99');
  const result = evaluateRetrieval(corpus, runs([artifact(corpus.cases[1], [x], [], [], ['x'])]),
    { split: 'holdout' });
  assert.deepEqual(result.baseline.abstention_accuracy, { count: 1, denominator: 1 });
  assert.deepEqual(result.candidate.false_positive, { count: 1, denominator: 1 });
  assert.equal(result.candidate.hit_at_1, null);
});

test('unmeasured truth never contributes to positive retrieval denominators', () => {
  const uncertain = structuredClone(corpus);
  uncertain.cases[0].expected.unmeasured = true;
  const one = artifact(uncertain.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  const input = runs([one]);
  input.corpus_sha256 = sha(JSON.stringify(uncertain));
  input.split_sha256 = sha(JSON.stringify(uncertain.cases.map(entry => [entry.id, entry.split])));
  const report = evaluateRetrieval(uncertain, input, { split: 'dev' });
  assert.equal(report.candidate.hit_at_1, null);
  assert.equal(report.coverage.truth_unmeasured, 1);
});

test('unknown ID, cross owner/project and stale/superseded remain ineligible for paired proof', () => {
  const base = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['invented']);
  const unknown = evaluateRetrieval(corpus, runs([base]), { split: 'dev', identities: identities() });
  assert.equal(unknown.paired_replay, false);
  assert.equal(unknown.comparison, null);
  assert.ok(unknown.cases[0].errors.includes('unknown_returned_id'));
  const bad = artifact(corpus.cases[0], [row('a', 0.95),
    row('foreign', 0.94, 'FOREIGN_42', { scope: 'personal', owner_id: 'someone-else' }),
    row('stale', 0.93, 'STALE_42', { valid_to: '2026-01-01T00:00:00Z' }),
    { ...row('superseded', 0.92), status: 'superseded' }], [], ['a'],
    ['foreign', 'stale', 'superseded']);
  bad.vector_candidates[0].projectId = 'synthetic-project';
  const result = evaluateRetrieval(corpus, runs([bad]), { split: 'dev', identities: identities() });
  assert.equal(result.paired_replay, false);
  assert.deepEqual(result.candidate.owner_leak, { count: 1, denominator: 3 });
  assert.deepEqual(result.candidate.stale, { count: 1, denominator: 3 });
  assert.deepEqual(result.candidate.superseded, { count: 1, denominator: 3 });
  const crossProject = artifact(corpus.cases[0], [{ ...row('foreign', 0.95),
    projectId: 'another-project' }], [], ['foreign'], ['foreign']);
  const other = evaluateRetrieval(corpus, runs([crossProject]), { split: 'dev', identities: identities() });
  assert.equal(other.paired_replay, false);
  assert.deepEqual(other.candidate.project_leak, { count: 1, denominator: 1 });
  const metadataProject = artifact(corpus.cases[0], [row('a', 0.95, 'ALPHA_42',
    { project_id: 'another-project' })], [], ['a'], ['a']);
  const mismatched = evaluateRetrieval(corpus, runs([metadataProject]), { split: 'dev', identities: identities() });
  assert.equal(mismatched.paired_replay, false);
  assert.deepEqual(mismatched.candidate.project_leak, { count: 1, denominator: 1 });
});

test('different candidate hashes or operational revisions disable gains', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  one.candidate.candidate_set_sha256 = 'd'.repeat(64);
  const result = evaluateRetrieval(corpus, runs([one]), { split: 'dev' });
  assert.equal(result.paired_replay, false);
  assert.equal(result.comparison, null);
  one.candidate.candidate_set_sha256 = one.candidate_set_sha256;
  one.candidate.collection_observation_sha256 = 'e'.repeat(64);
  assert.equal(evaluateRetrieval(corpus, runs([one]), { split: 'dev' }).paired_replay, false);
  one.candidate.collection_observation_sha256 = one.collection_observation_sha256;
  one.candidate.algorithm_sha256 = 'f'.repeat(64);
  assert.equal(evaluateRetrieval(corpus, runs([one]), { split: 'dev' }).paired_replay, false);
  const badSplit = runs([artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a'])]);
  badSplit.split_sha256 = 'f'.repeat(64);
  assert.equal(evaluateRetrieval(corpus, badSplit, { split: 'dev' }).paired_replay, false);
});

test('agent-proposed source labels stay provisional even after source audit', () => {
  const proposed = structuredClone(corpus);
  proposed.cases[0].adjudication = { source: 'agent_proposed', independent_review: 'pending' };
  const input = runs([]);
  input.corpus_sha256 = sha(JSON.stringify(proposed));
  const report = evaluateRetrieval(proposed, input, { split: 'dev' });
  assert.equal(report.label_status, 'agent_proposed_provisional');
  assert.equal(report.cases[0].ground_truth, 'agent_proposed_provisional');
});

test('independent sidecar permits approved truth and excludes rejected labels', () => {
  const a = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  const b = artifact(corpus.cases[1], [], [], [], []);
  const review = sidecar();
  review.cases[1].status = 'rejected';
  assert.equal(validateRetrievalAdjudication(corpus, review), true);
  const input = runs([a, b]);
  const report = evaluateRetrieval(corpus, input,
    { adjudication: review, identities: identities(), observations: observationsFor(input) });
  assert.equal(report.paired_replay, true);
  assert.equal(report.label_status, 'agent_reviewed_partial');
  assert.equal(report.coverage.approved, 1);
  assert.equal(report.coverage.rejected, 1);
  assert.equal(report.baseline.hit_at_1.denominator, 1);
  assert.equal(report.baseline.abstention_accuracy, null);
  assert.equal(report.comparison, null);
  review.cases[1].status = 'approved';
  const approved = evaluateRetrieval(corpus, input,
    { adjudication: review, identities: identities(), observations: observationsFor(input) });
  assert.equal(approved.label_status, 'agent_reviewed');
  assert.notEqual(approved.comparison, null);
});

test('sidecar rejects mismatched expected hash, corpus hash, missing IDs and human source', () => {
  const base = sidecar();
  const changed = edit => { const copy = structuredClone(base); edit(copy); return copy; };
  for (const bad of [
    changed(x => { x.corpus_sha256 = 'f'.repeat(64); }),
    changed(x => { x.cases[0].expected_sha256 = 'f'.repeat(64); }),
    changed(x => { x.cases.pop(); }),
    changed(x => { x.source = 'human'; }),
  ]) {
    assert.equal(validateRetrievalAdjudication(corpus, bad), false);
    assert.throws(() => evaluateRetrieval(corpus, runs([]), { adjudication: bad }),
      /invalid_adjudication/);
  }
});

test('forged algorithm outputs and missing observation time cannot claim paired improvement', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.95)], [], [], ['a']);
  const input = runs([one]);
  let report = evaluateRetrieval(corpus, input, { split: 'dev', identities: identities(),
    observations: observationsFor(input) });
  assert.equal(report.paired_replay, false);
  assert.ok(report.cases[0].errors.includes('algorithm_output_mismatch'));
  one.baseline.returned_ids = ['a'];
  delete one.observed_at;
  report = evaluateRetrieval(corpus, input, { split: 'dev', identities: identities(),
    observations: observationsFor(input) });
  assert.equal(report.paired_replay, false);
  assert.ok(report.cases[0].errors.includes('missing_observation_time'));
});

test('missing observed latency, tokens and cost remain null with coverage', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.95)], [], ['a'], ['a']);
  const report = evaluateRetrieval(corpus, runs([one]), { split: 'dev' });
  assert.equal(report.usage.latency_ms, null);
  assert.equal(report.usage.tokens, null);
  assert.equal(report.usage.cost_usd, null);
  assert.deepEqual(report.usage.coverage, { latency_ms: 0, tokens: 0, cost_usd: 0 });
  one.usage = { latency_ms: 17, tokens: 3, cost_usd: 0 };
  const observed = evaluateRetrieval(corpus, runs([one]), { split: 'dev' });
  assert.deepEqual(observed.usage.coverage, { latency_ms: 1, tokens: 1, cost_usd: 1 });
  assert.equal(observed.usage.cost_usd, 0);
});

test('pure replay ranks both arms from one frozen candidate set', () => {
  const one = artifact(corpus.cases[0], [row('a', 0.9)], [], ['a'], ['a']);
  const replay = replayRetrievalCase(corpus.cases[0], one, { now: '2026-10-22T00:00:00Z' });
  assert.deepEqual(replay.baseline.returned_ids, ['a']);
  assert.deepEqual(replay.candidate.returned_ids, ['a']);
  assert.equal(replay.baseline.candidate_set_sha256, one.candidate_set_sha256);
  assert.equal(replay.baseline.retrieval_version, 'vector_selector_current');
});

test('v2 extractor assessment preserves unmeasured curation truth and proposed labels', () => {
  const proposed = structuredClone(corpus);
  proposed.cases[0].adjudication = { source: 'agent_proposed', independent_review: 'pending' };
  const report = evaluateMemoryOutputs(proposed, { version: 1, results: [{
    case_id: proposed.cases[0].id, output: { no_facts: true, candidates: [] },
    usage: { input_tokens: 2 },
  }] }, { split: 'dev' });
  assert.equal(report.label_status, 'agent_proposed_provisional');
  assert.equal(report.semantic.false_save, null);
  assert.equal(report.usage.input_tokens, 2);
  assert.equal(report.usage.cost_usd, null);
});

test('CLI reads a v2 corpus and frozen retrieval artifact without printing candidate payloads', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-retrieval-eval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const corpusFile = path.join(dir, 'corpus.json');
  const retrievalFile = path.join(dir, 'retrieval.json');
  const identitiesFile = path.join(dir, 'identities.json');
  const observationsFile = path.join(dir, 'observations.json');
  const proofFile = path.join(dir, 'collector-proof.json');
  const adjudicationFile = path.join(dir, 'adjudication.json');
  const outputsFile = path.join(dir, 'outputs.json');
  await fs.writeFile(corpusFile, JSON.stringify(corpus), { mode: 0o600 });
  const { corpus: loaded } = await loadMemoryCorpus(corpusFile);
  assert.equal(loaded.version, 2);
  const input = runs([artifact(corpus.cases[0], [row('a', 0.95, 'ALPHA_42')], [], ['a'], ['a'])]);
  const observation = observationsFor(input);
  for (const [index, entry] of observation.cases.entries()) {
    for (const arm of ['before', 'after']) {
      const snap = entry[arm];
      snap.snapshot_file = path.join(dir, `snapshot-${index}-${arm}.json`);
      await fs.writeFile(snap.snapshot_file, stable(snap.points), { mode: 0o600 });
      delete snap.points;
    }
  }
  await fs.writeFile(observationsFile, JSON.stringify(observation), { mode: 0o600 });
  await fs.writeFile(retrievalFile, JSON.stringify(input), { mode: 0o600 });
  await fs.writeFile(identitiesFile, JSON.stringify(identities()), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../base/memoria/evaluation-cli.mjs', import.meta.url));
  const script = `import { evaluateCli } from ${JSON.stringify(new URL('file://' + cli).href)}; process.exitCode = await evaluateCli(process.argv.slice(1));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--identities', identitiesFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.paired_replay, false);
  assert.equal(report.coverage.selected, 1);
  assert.equal(result.stdout.includes('ALPHA_42'), false);
  const withObservations = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--identities', identitiesFile, '--observations', observationsFile], { encoding: 'utf8' });
  assert.equal(withObservations.status, 0, withObservations.stderr);
  assert.equal(JSON.parse(withObservations.stdout).paired_replay, true);
  assert.equal(withObservations.stdout.includes('ALPHA_42'), false);
  const oldReceipt = observationsFor(input);
  oldReceipt.source = 'operator_trusted_collector';
  oldReceipt.collector_source_sha256 = 'e'.repeat(64);
  oldReceipt.proof_file = proofFile;
  const proof = { corpus_sha256: input.corpus_sha256,
    cases: oldReceipt.cases.map(entry => ({ case_id: entry.case_id,
      collection_observation_sha256: entry.before.payload_sha256,
      after_sha256: entry.after.payload_sha256,
      point_count_before: entry.before.count, point_count_after: entry.after.count,
      stable: true, candidate_payloads_stable: true, duplicate_consistent: true })) };
  const proofBytes = JSON.stringify(proof);
  await fs.writeFile(proofFile, proofBytes, { mode: 0o600 });
  oldReceipt.proof_file_sha256 = sha(proofBytes);
  for (const entry of oldReceipt.cases) {
    delete entry.before.points;
    delete entry.after.points;
  }
  await fs.writeFile(observationsFile, JSON.stringify(oldReceipt), { mode: 0o600 });
  const oldObserved = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--identities', identitiesFile, '--observations', observationsFile], { encoding: 'utf8' });
  assert.equal(oldObserved.status, 0, oldObserved.stderr);
  assert.equal(JSON.parse(oldObserved.stdout).paired_replay, true);
  await fs.writeFile(proofFile, `${proofBytes} `, { mode: 0o600 });
  const tamperedProof = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--identities', identitiesFile, '--observations', observationsFile], { encoding: 'utf8' });
  assert.equal(tamperedProof.status, 2);
  assert.equal(tamperedProof.stdout, '');
  await fs.writeFile(adjudicationFile, JSON.stringify(sidecar()), { mode: 0o600 });
  const reviewed = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--adjudication', adjudicationFile, '--identities', identitiesFile], { encoding: 'utf8' });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).label_status, 'agent_reviewed');
  const badIdentity = identities();
  badIdentity.cases[0].owner_id = '';
  await fs.writeFile(identitiesFile, JSON.stringify(badIdentity), { mode: 0o600 });
  const rejectedIdentity = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--identities', identitiesFile], { encoding: 'utf8' });
  assert.equal(rejectedIdentity.status, 2);
  assert.equal(rejectedIdentity.stdout, '');
  await fs.writeFile(outputsFile, JSON.stringify({ version: 1, results: [] }), { mode: 0o600 });
  const legacy = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--outputs', outputsFile, '--split', 'dev'], { encoding: 'utf8' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).version, 1);
});
