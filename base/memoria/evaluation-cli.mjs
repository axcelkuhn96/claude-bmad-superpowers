import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMemoryOutputs, loadMemoryCorpus, loadMemoryOutputs } from './evaluation.mjs';
import { evaluateRetrieval, loadRetrievalArtifact,
  loadRetrievalAdjudication } from './evaluation-retrieval.mjs';

const defaultCorpus = fileURLToPath(new URL('./evals/curation-v1.json', import.meta.url));
const usage = `Uso: cbs memoria avaliar (--outputs|--retrieval) <arquivo.json> [--corpus <arquivo.json>] [--split dev|holdout|all] [--adjudication <arquivo.json>]

Avaliação offline de saídas de extração já gravadas. O corpus padrão é ${path.basename(defaultCorpus)}.
Não chama modelo, embedding, broker ou Qdrant. Rótulos sem adjudicação declarada
continuam como qualidade semântica não medida; rótulos declarados não são verificados.
O arquivo outputs usa {"version":1,"results":[{"case_id":"...","output":{"no_facts":true,"candidates":[]}}]}.
Retrieval v1 exige corpus v2 e artefatos de candidatos congelados; paired_replay compara apenas ranking offline.
Adjudicação opcional é sidecar privado ligado ao hash do corpus, sem rótulo humano presumido.
`;

function parse(args) {
  const options = { corpus: defaultCorpus, split: 'all' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--corpus', '--outputs', '--retrieval', '--split', '--adjudication'].includes(flag) ||
        seen.has(flag) ||
        !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_arguments');
    seen.add(flag);
    options[flag.slice(2)] = args[++i];
  }
  if (!!options.outputs === !!options.retrieval || options.adjudication && !options.retrieval ||
      !['all', 'dev', 'holdout'].includes(options.split)) {
    throw new Error('invalid_arguments');
  }
  return options;
}

export async function evaluateCli(args = []) {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
    process.stdout.write(usage);
    return 0;
  }
  let options;
  try { options = parse(args); }
  catch (error) {
    process.stderr.write(`${error.message}\n${usage}`);
    return 2;
  }
  try {
    const [{ corpus, sha256: corpusSha256 }, loaded, reviewed] = await Promise.all([
      loadMemoryCorpus(options.corpus), options.retrieval ?
        loadRetrievalArtifact(options.retrieval) : loadMemoryOutputs(options.outputs),
      options.adjudication ? loadRetrievalAdjudication(options.adjudication) : null,
    ]);
    const report = options.retrieval ?
      evaluateRetrieval(corpus, loaded.retrieval, { split: options.split, corpusSha256,
        adjudication: reviewed?.adjudication, adjudicationSha256: reviewed?.sha256 }) :
      evaluateMemoryOutputs(corpus, loaded.outputs, { split: options.split });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`CBS Mem0 avaliar: ${error.message}\n`);
    return /^(?:invalid_|unknown_case|corpus_too_large|outputs_too_large|retrieval_too_large|adjudication_too_large)/.test(error.message) ? 2 : 1;
  }
}
