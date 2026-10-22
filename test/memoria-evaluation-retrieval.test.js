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
  validateRetrievalAdjudication } from '../base/memoria/evaluation-retrieval.mjs';

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
  const item = { case_id: entry.id, query: entry.query,
    observed_at: '2026-10-22T00:00:00Z',
    collection_observation_sha256: 'c'.repeat(64), vector_candidates: vectors,
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
  const result = evaluateRetrieval(corpus, runs([artifact(corpus.cases[0], [x, a, b], lexical,
    ['x', 'a', 'b'], ['a', 'b', 'x'])]), { split: 'dev' });
  assert.equal(result.paired_replay, true);
  assert.equal(result.comparison, null);
  assert.deepEqual(result.baseline.hit_at_1, { count: 0, denominator: 1 });
  assert.deepEqual(result.candidate.hit_at_1, { count: 1, denominator: 1 });
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
  const unknown = evaluateRetrieval(corpus, runs([base]), { split: 'dev' });
  assert.equal(unknown.paired_replay, false);
  assert.equal(unknown.comparison, null);
  assert.deepEqual(unknown.cases[0].errors, ['unknown_returned_id']);
  const bad = artifact(corpus.cases[0], [row('a', 0.95),
    row('foreign', 0.94, 'FOREIGN_42', { scope: 'personal', owner_id: 'someone-else' }),
    row('stale', 0.93, 'STALE_42', { valid_to: '2026-01-01T00:00:00Z' }),
    { ...row('superseded', 0.92), status: 'superseded' }], [], ['a'],
    ['foreign', 'stale', 'superseded']);
  bad.vector_candidates[0].projectId = 'synthetic-project';
  const result = evaluateRetrieval(corpus, runs([bad]), { split: 'dev' });
  assert.equal(result.paired_replay, false);
  assert.deepEqual(result.candidate.owner_leak, { count: 1, denominator: 3 });
  assert.deepEqual(result.candidate.stale, { count: 1, denominator: 3 });
  assert.deepEqual(result.candidate.superseded, { count: 1, denominator: 3 });
  const crossProject = artifact(corpus.cases[0], [{ ...row('foreign', 0.95),
    projectId: 'another-project' }], [], ['foreign'], ['foreign']);
  const other = evaluateRetrieval(corpus, runs([crossProject]), { split: 'dev' });
  assert.equal(other.paired_replay, false);
  assert.deepEqual(other.candidate.project_leak, { count: 1, denominator: 1 });
  const metadataProject = artifact(corpus.cases[0], [row('a', 0.95, 'ALPHA_42',
    { project_id: 'another-project' })], [], ['a'], ['a']);
  const mismatched = evaluateRetrieval(corpus, runs([metadataProject]), { split: 'dev' });
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
  const report = evaluateRetrieval(corpus, runs([a, b]), { adjudication: review });
  assert.equal(report.paired_replay, true);
  assert.equal(report.label_status, 'agent_reviewed_partial');
  assert.equal(report.coverage.approved, 1);
  assert.equal(report.coverage.rejected, 1);
  assert.equal(report.baseline.hit_at_1.denominator, 1);
  assert.equal(report.baseline.abstention_accuracy, null);
  assert.equal(report.comparison, null);
  review.cases[1].status = 'approved';
  const approved = evaluateRetrieval(corpus, runs([a, b]), { adjudication: review });
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
  let report = evaluateRetrieval(corpus, runs([one]), { split: 'dev' });
  assert.equal(report.paired_replay, false);
  assert.ok(report.cases[0].errors.includes('algorithm_output_mismatch'));
  one.baseline.returned_ids = ['a'];
  delete one.observed_at;
  report = evaluateRetrieval(corpus, runs([one]), { split: 'dev' });
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
  const adjudicationFile = path.join(dir, 'adjudication.json');
  const outputsFile = path.join(dir, 'outputs.json');
  await fs.writeFile(corpusFile, JSON.stringify(corpus), { mode: 0o600 });
  const { corpus: loaded } = await loadMemoryCorpus(corpusFile);
  assert.equal(loaded.version, 2);
  const input = runs([artifact(corpus.cases[0], [row('a', 0.95, 'ALPHA_42')], [], ['a'], ['a'])]);
  await fs.writeFile(retrievalFile, JSON.stringify(input), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../base/memoria/evaluation-cli.mjs', import.meta.url));
  const script = `import { evaluateCli } from ${JSON.stringify(new URL('file://' + cli).href)}; process.exitCode = await evaluateCli(process.argv.slice(1));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.paired_replay, true);
  assert.equal(report.coverage.selected, 1);
  assert.equal(result.stdout.includes('ALPHA_42'), false);
  await fs.writeFile(adjudicationFile, JSON.stringify(sidecar()), { mode: 0o600 });
  const reviewed = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--retrieval', retrievalFile, '--corpus', corpusFile, '--split', 'dev',
    '--adjudication', adjudicationFile], { encoding: 'utf8' });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).label_status, 'agent_reviewed');
  await fs.writeFile(outputsFile, JSON.stringify({ version: 1, results: [] }), { mode: 0o600 });
  const legacy = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--',
    '--outputs', outputsFile, '--split', 'dev'], { encoding: 'utf8' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).version, 1);
});
