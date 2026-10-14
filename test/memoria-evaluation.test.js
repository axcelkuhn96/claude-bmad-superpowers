import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMemoryCorpus, loadMemoryOutputs, evaluateMemoryOutputs } from '../base/memoria/evaluation.mjs';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/memoria-eval/curation-v1.json');

const outputFor = (entry, candidates) => ({ case_id: entry.id,
  output: { no_facts: candidates.length === 0, candidates } });
const candidateFor = (entry, text, type = 'rule', scope = 'project') => ({ text, type, scope,
  evidence: entry.messages.map(message => ({ source_message_id: message.id,
    excerpt: message.text.slice(0, 70) })) });

test('versioned corpus has both partitions, human/assistant turns and reasoned labels', async () => {
  const { corpus, sha256 } = await loadMemoryCorpus(fixturePath);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.equal(corpus.cases.length, 9);
  assert.equal(corpus.cases.filter(item => item.split === 'holdout').length, 3);
  assert.ok(corpus.cases.every(item => item.messages.some(message => message.role === 'human') &&
    item.messages.some(message => message.role === 'assistant') &&
    item.expected.every(expected => expected.rationale)));
});

test('offline preflight uses production contract, evidence, transient, secret and exact dedup rules', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const cases = Object.fromEntries(corpus.cases.map(item => [item.id, item]));
  const outputs = { version: 1, results: [
    outputFor(cases['mizu-transient-cbs-status'], [candidateFor(
      cases['mizu-transient-cbs-status'],
      'Nesta sessão a memória CBS estava somente leitura: automaticWriteConfigured: false.', 'fact')]),
    outputFor(cases['mizu-known-compile-path'], [candidateFor(
      cases['mizu-known-compile-path'], 'Compilar em HML_TRIPEX_COMP e depois promover o RPO.')]),
    outputFor(cases['secret-in-source'], [candidateFor(
      cases['secret-in-source'], 'password=EXAMPLE_VALUE_FOR_TESTS')]),
    outputFor(cases['mizu-new-helper'], [{ ...candidateFor(cases['mizu-new-helper'],
      'Executar U_MZAScrUsr antes de promover o RPO.'), evidence: [{
      source_message_id: 'missing', excerpt: 'invalid' }, { source_message_id: 'a1', excerpt: 'Entendido' }] }]),
  ] };
  const report = evaluateMemoryOutputs(corpus, outputs);
  assert.equal(report.deterministic.candidates, 4);
  assert.equal(report.deterministic.transient_status, 1);
  assert.equal(report.deterministic.exact_duplicate, 1);
  assert.equal(report.deterministic.secret_retention, 1);
  assert.equal(report.deterministic.ungrounded_evidence, 1);
  assert.deepEqual(report.cases.find(item => item.case_id === 'mizu-new-helper')
    .flags[0], { candidate_index: 0, reasons: ['ungrounded_evidence'] });
  assert.equal(report.semantic.status, 'unmeasured');
  assert.equal(report.semantic.false_save, null);
  assert.equal(report.operational.first_attempt_success, null);
});

test('declared fixture adjudication scores keep/omit/correct and stays separate from model quality', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const cases = Object.fromEntries(corpus.cases.map(item => [item.id, item]));
  const corrected = cases['mizu-correction-condition'];
  const durable = cases['durable-project-rule'];
  const secret = cases['secret-in-source'];
  const outputs = { version: 1, run: { model: 'fixture-only',
    prompt_sha256: 'a'.repeat(64), model_sha256: 'b'.repeat(64),
    recorded_at: '2026-10-14T22:00:00Z' }, results: [
    { ...outputFor(corrected, [candidateFor(corrected,
      'Não testar MizuAprov antes da promoção; testar somente depois do aviso do usuário de que o RPO foi promovido.')]),
    adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
      expected_id: 'correct-test-rule', verdict: 'full', rationale: 'Negação e aviso preservados.' }] },
    attempts: ['error', 'success'], usage: { input_tokens: 12, output_tokens: 8,
      duration_ms: 200, cost_usd: 0.001 } },
    { ...outputFor(durable, [candidateFor(durable,
      'O REST do MizuAprov usa HML_MIZUCONECTA_COMP na porta 8400.', 'fact')]),
    adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
      expected_id: 'rest-environment', verdict: 'full', rationale: 'Mesmo ambiente e porta.' }] },
    attempts: ['success'] },
    { ...outputFor(secret, [candidateFor(secret, 'password=EXAMPLE_VALUE_FOR_TESTS')]),
    adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
      expected_id: 'secret-value', verdict: 'full', rationale: 'Mesmo valor sintético.' }] },
    attempts: ['success'] },
  ] };
  const report = evaluateMemoryOutputs(corpus, outputs, { split: 'holdout' });
  assert.equal(report.coverage.selected, 3);
  assert.equal(report.semantic.status, 'fixture_control');
  assert.deepEqual(report.semantic.false_save, { count: 1, denominator: 3 });
  assert.deepEqual(report.semantic.missed_durable, { count: 0, denominator: 2 });
  assert.deepEqual(report.semantic.correction_retention, { count: 1, denominator: 1 });
  assert.deepEqual(report.operational.first_attempt_success, { count: 2, denominator: 3 });
  assert.deepEqual(report.usage, { provided_cases: 1, input_tokens: 12, output_tokens: 8,
    duration_ms: 200, cost_usd: 0.001,
    field_cases: { input_tokens: 1, output_tokens: 1, duration_ms: 1, cost_usd: 1 } });
  assert.equal(report.run.prompt_sha256, 'a'.repeat(64));
  assert.equal(report.assessment_scope, 'supplied_extractor_candidates_not_confirmed_Qdrant_writes');
});

test('partial labels, forged human evidence and negative usage are rejected', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const entry = corpus.cases[0];
  const candidate = candidateFor(entry, 'Temporary status.');
  const base = outputFor(entry, [candidate]);
  assert.throws(() => evaluateMemoryOutputs(corpus, { version: 1, results: [{ ...base,
    adjudication: { source: 'human', labels: [] } }] }), /invalid_adjudication/);
  assert.throws(() => evaluateMemoryOutputs(corpus, { version: 1, results: [{ ...base,
    usage: { cost_usd: -1 } }] }), /invalid_usage/);
  const report = evaluateMemoryOutputs(corpus, { version: 1, results: [{ ...base,
    adjudication: { source: 'human', labels: [{ candidate_index: 0,
      expected_id: null, verdict: 'unmatched', rationale: 'Unrelated.' }] } }] });
  assert.equal(report.semantic.status, 'declared_human');
  assert.equal(report.semantic.review_verified, false);
  assert.equal(report.usage.cost_usd, null);
});

test('semantic duplicates, corrections and scope are counted only from declared labels', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const newHelper = corpus.cases.find(item => item.id === 'mizu-new-helper');
  const correction = corpus.cases.find(item => item.id === 'mizu-correction-condition');
  const outputs = { version: 1, results: [
    { ...outputFor(newHelper, [
      candidateFor(newHelper, 'Executar U_MZAScrUsr antes de promover o RPO.'),
      candidateFor(newHelper, 'Antes da promoção do RPO, executar U_MZAScrUsr.'),
    ]), adjudication: { source: 'fixture', labels: [
      { candidate_index: 0, expected_id: 'new-helper', verdict: 'full', rationale: 'Mesmo helper.' },
      { candidate_index: 1, expected_id: 'new-helper', verdict: 'full', rationale: 'Paráfrase.' },
    ] } },
    { ...outputFor(correction, [candidateFor(correction,
      'Testar MizuAprov antes da promoção.', 'rule', 'personal')]),
    adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
      expected_id: 'correct-test-rule', verdict: 'partial',
      rationale: 'Inverte a negação e omite o aviso.' }] } },
  ] };
  const report = evaluateMemoryOutputs(corpus, outputs);
  assert.deepEqual(report.semantic.duplicate, { count: 1, denominator: 3 });
  assert.deepEqual(report.semantic.correction_retention, { count: 0, denominator: 1 });
  assert.deepEqual(report.semantic.missed_durable, { count: 1, denominator: 2 });
  assert.equal(report.deterministic.exact_duplicate, 0);
});

test('a semantically matching claim in the wrong scope is still a false save', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const entry = corpus.cases.find(item => item.id === 'durable-project-rule');
  const output = { version: 1, results: [{ ...outputFor(entry,
    [candidateFor(entry, 'O REST do MizuAprov usa HML_MIZUCONECTA_COMP na porta 8400.',
      'fact', 'personal')]),
  adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
    expected_id: 'rest-environment', verdict: 'full', rationale: 'Texto igual, escopo errado.' }] } }] };
  const report = evaluateMemoryOutputs(corpus, output, { split: 'holdout' });
  assert.deepEqual(report.semantic.scope_error, { count: 1, denominator: 1 });
  assert.deepEqual(report.semantic.type_error, { count: 0, denominator: 1 });
  assert.deepEqual(report.semantic.false_save, { count: 1, denominator: 1 });
  assert.deepEqual(report.semantic.missed_durable, { count: 1, denominator: 1 });
  assert.deepEqual(report.cases.find(item => item.case_id === entry.id).missed_expected_ids,
    ['rest-environment']);
});

test('JSON loaders reject oversized or malformed files without executing corpus text', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-eval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'too-large.json');
  await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(loadMemoryCorpus(file), /corpus_too_large/);
  await assert.rejects(loadMemoryOutputs(file), /outputs_too_large/);
  await fs.writeFile(file, JSON.stringify({ version: 1, results: [{ case_id: 'missing', output: {
    no_facts: false, candidates: [] } }] }));
  await assert.rejects(loadMemoryOutputs(file), /invalid_outputs/);
});

test('invalid model candidates produce diagnostics without crashing the evaluator', async () => {
  const { corpus } = await loadMemoryCorpus(fixturePath);
  const report = evaluateMemoryOutputs(corpus, { version: 1, results: [{
    case_id: 'durable-project-rule',
    output: { no_facts: false, candidates: [null] },
    adjudication: { source: 'fixture', labels: [{ candidate_index: 0,
      expected_id: null, verdict: 'unmatched', rationale: 'Malformed output.' }] },
  }] });
  assert.equal(report.deterministic.invalid_contract, 1);
  assert.equal(report.deterministic.ungrounded_evidence, 1);
  assert.deepEqual(report.semantic.false_save, { count: 1, denominator: 1 });
});
