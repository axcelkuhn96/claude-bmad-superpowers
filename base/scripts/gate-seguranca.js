#!/usr/bin/env node
// gate-seguranca.js — gate de segurança (camada 2) do claude-bmad-superpowers.
// Node >= 18 (ESM; o package.json ao lado declara "type": "module"), sem dependências, sem shell (spawnSync com shell:false). Windows / Linux / macOS.
//
// Roda antes de marcar uma task como DONE e antes de push:
//   gitleaks (segredos)  +  semgrep (SAST, só o que é novo vs base)  +  audit da stack  +  agentshield (se o diff toca config de agente)
//   PHP: composer audit (+ psalm se psalm.xml)   Python: pip-audit + ruff --select S (ou bandit)
//   Node: npm|pnpm|yarn|bun audit (high+)
//
// Uso:  node gate-seguranca.js [diretório] [--base <ref>] [--saida <dir>]
//   diretório  raiz do projeto (padrão: diretório atual)
//   --base     commit/branch de origem pra baseline (padrão: merge-base com origin/HEAD, main ou master)
//   --saida    onde gravar os JSON completos (padrão: .superpowers/sdd)
//
// Exit: 0 = aprovado (com ou sem ressalvas)  ·  1 = segredo/vulnerabilidade encontrada, OU gitleaks ausente/com erro
// (segredos nunca ficam sem varredura). As demais ferramentas ausentes saem como aviso "gate parcial".
// Supressão só com justificativa no Dev Agent Record: `# nosemgrep: <id> — <motivo>`, `.gitleaks.toml`, `--ignore-vuln`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
// Toda operação que interpreta objetos Git deve ignorar substituições locais e
// proibir lazy fetch. O mesmo ambiente é passado ao Gitleaks porque seus scans
// `git` delegam ao executável Git durante toda a execução, não apenas no
// precheck. Assim uma replace-ref criada entre duas chamadas não altera a
// fotografia, os blobs ou o histórico que serão verificados.
const ambienteGitImutavel = Object.freeze({
  ...process.env,
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
});

function citarShellPosix(valor) {
  return `'${String(valor).replace(/'/g, `'\\''`)}'`;
}

// Gitleaks chama Git por conta própria. Algumas versões constroem um ambiente
// novo para esse filho e descartam as variáveis herdadas; o shim mantém as duas
// defesas inclusive nesse salto, sem confiar em uma janela entre precheck e
// leitura de objetos. O diretório é privado e removido logo após cada scan.
function ambienteGitleaksImutavel() {
  const guarda = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-git-guard-'));
  const gitBin = resolverBin('git');
  if (!gitBin) {
    fs.rmSync(guarda, { recursive: true, force: true });
    throw new Error('git não encontrado para proteger subprocesso Gitleaks');
  }
  const alvo = path.join(guarda, WIN ? 'git.cmd' : 'git');
  if (WIN) {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    fs.writeFileSync(alvo, `@echo off\r\nset "GIT_NO_REPLACE_OBJECTS=1"\r\nset "GIT_NO_LAZY_FETCH=1"\r\n${q(gitBin)} %*\r\n`, { mode: 0o700 });
  } else {
    fs.writeFileSync(alvo, `#!/bin/sh\nexport GIT_NO_REPLACE_OBJECTS=1\nexport GIT_NO_LAZY_FETCH=1\nexec ${citarShellPosix(gitBin)} "$@"\n`, { mode: 0o700 });
  }
  return {
    env: { ...ambienteGitImutavel, PATH: `${guarda}${path.delimiter}${process.env.PATH || ''}` },
    limpar: () => fs.rmSync(guarda, { recursive: true, force: true }),
  };
}

function hashAchadoHistorico(x) {
  if (!/^[0-9a-f]{40}$/i.test(x.Commit || '') || !Number.isInteger(x.StartLine) || x.StartLine < 1
    || !x.File || path.isAbsolute(x.File) || x.File.split(/[\\/]/).includes('..')) return null;
  const blob = gitBytes(['show', `${x.Commit}:${x.File}`]);
  if (blob.status !== 0) return null;
  const texto = blob.stdout.toString('utf8');
  if (!Buffer.from(texto, 'utf8').equals(blob.stdout)) return null;
  const linha = texto.split('\n')[x.StartLine - 1];
  if (linha === undefined) return null;
  const linhaHash = createHash('sha256').update(linha, 'utf8').digest('hex');
  return createHash('sha256').update([x.Commit, x.File, String(x.StartLine), x.RuleID, linhaHash].join('\0')).digest('hex');
}

// ── argumentos ─────────────────────────────────────────────────────────────
let dir = '.';
let baseRef = '';
let saida = path.join('.superpowers', 'sdd');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') baseRef = argv[++i] || '';
  else if (a.startsWith('--base=')) baseRef = a.slice(7);
  else if (a === '--saida') saida = argv[++i] || saida;
  else if (a.startsWith('--saida=')) saida = a.slice(8);
  else if (a === '-h' || a === '--help') {
    const cab = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, ''));
    console.log(cab.join('\n'));
    process.exit(0);
  } else dir = a;
}

try { process.chdir(dir); } catch { console.log(`✗ diretório não encontrado: ${dir}`); process.exit(1); }
fs.mkdirSync(saida, { recursive: true });

let achados = 0;      // segredos/vulnerabilidades que reprovam o gate
let falhaSeguranca = false; // uma falha operacional em secrets também reprova o gate
const parciais = [];  // ferramentas ausentes ou com erro (gate parcial)
const linhas = [];    // resumo (≤ 20 linhas impressas no final)
const linha = (l) => linhas.push(l);
const parcial = (tool, msg) => { parciais.push(tool); linha(`⚠ ${msg}`); };
const arq = (nome) => path.join(saida, nome);
const existe = (p) => fs.existsSync(p);
const lerTxt = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const lerJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listar = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const contem = (arquivos, re) => arquivos.some((f) => re.test(lerTxt(f)));

// Achados históricos revisados (fora do pacote): ~/.claude/cbs-overrides/gate-achados-revisados.json
// { "<caminho absoluto do projeto>": ["<sha256>", ...] }. Só vale para o projeto cujo caminho real é a chave.
// Ausente, inválido ou sem a chave → nenhuma supressão (fail closed).
function carregarAchadosRevisados(raizProjeto) {
  const arquivo = path.join(os.homedir(), '.claude', 'cbs-overrides', 'gate-achados-revisados.json');
  const vazio = (aviso = '') => ({ hashes: new Set(), aviso });
  if (!fs.existsSync(arquivo)) return vazio();
  let dados;
  try { dados = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return vazio(`achados revisados: ${arquivo} inválido — ignorado (nenhuma supressão)`); }
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return vazio(`achados revisados: ${arquivo} inválido — ignorado (nenhuma supressão)`);
  let alvo;
  try { alvo = fs.realpathSync(raizProjeto); } catch { return vazio(); }
  const hashes = new Set();
  for (const [chave, lista] of Object.entries(dados)) {
    if (!path.isAbsolute(chave)) continue; // chave relativa resolveria contra o cwd e casaria qualquer projeto
    let real;
    try { real = fs.realpathSync(chave); } catch { continue; }
    if (real !== alvo || !Array.isArray(lista)) continue;
    for (const h of lista) if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) hashes.add(h);
  }
  return { hashes, aviso: '' };
}
const revisados = carregarAchadosRevisados(process.cwd());
const achadosHistoricosRevisados = revisados.hashes;
if (revisados.aviso) linha(`⚠ ${revisados.aviso}`);

// resolve um executável no PATH sem shell (respeita PATHEXT no Windows)
function resolverBin(nome) {
  const exts = WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue;
    for (const ext of exts) {
      const cand = path.join(p, nome + ext.toLowerCase());
      try { fs.accessSync(cand, fs.constants.X_OK); if (fs.statSync(cand).isFile()) return cand; } catch {}
      if (WIN) { try { const c2 = path.join(p, nome + ext); if (fs.statSync(c2).isFile()) return c2; } catch {} }
    }
  }
  return null;
}
const tem = (nome) => resolverBin(nome) !== null;

// roda um binário sem shell. `nome` pode ser um comando do PATH ou um caminho de arquivo.
// No Windows, .cmd/.bat só rodam via cmd.exe (Node recusa spawn direto): nesse caso chamamos
// cmd.exe com argv fixo — os argumentos são constantes deste script, nunca input de usuário.
function rodar(nome, args, opts = {}) {
  const ehCaminho = nome.includes(path.sep) || nome.includes('/');
  const bin = ehCaminho ? (existe(nome) ? path.resolve(nome) : null) : resolverBin(nome);
  if (!bin) return { status: 127, stdout: '', stderr: `${nome}: não encontrado` };
  let cmd = bin, av = args;
  if (WIN && /\.(cmd|bat)$/i.test(bin)) {
    const q = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    cmd = process.env.ComSpec || 'cmd.exe';
    av = ['/d', '/s', '/c', `"${[q(bin), ...args.map(q)].join(' ')}"`];
    opts = { ...opts, windowsVerbatimArguments: true };
  }
  const r = spawnSync(cmd, av, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}
// npm: preferimos rodar o npm-cli.js com o próprio node (sem .cmd, sem cmd.exe)
function rodarNpm(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli2 = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const alvo = existe(cli) ? cli : existe(cli2) ? cli2 : null;
  if (alvo) {
    const r = spawnSync(process.execPath, [alvo, ...args], { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  return rodar('npm', args);
}
const git = (...args) => rodar('git', args, { env: ambienteGitImutavel });
const gravar = (nome, r) => fs.writeFileSync(arq(nome), (r.stdout || '') + (r.stderr || ''), 'utf8');

function gitBytes(args, cwd = process.cwd()) {
  const bin = resolverBin('git');
  if (!bin) throw new Error('git não encontrado');
  const r = spawnSync(bin, args, { cwd, encoding: null, shell: false, maxBuffer: 64 * 1024 * 1024, env: ambienteGitImutavel });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0) };
}

function caminhosNul(r, descricao) {
  if (r.status !== 0) throw new Error(`${descricao} falhou`);
  const saida = [];
  for (const bruto of r.stdout.toString('binary').split('\0').filter(Boolean)) {
    const bytes = Buffer.from(bruto, 'binary');
    const texto = bytes.toString('utf8');
    if (!Buffer.from(texto, 'utf8').equals(bytes)) throw new Error(`${descricao} retornou caminho UTF-8 inválido`);
    saida.push(texto);
  }
  return saida;
}

function arquivosGit() {
  const rastreados = caminhosNul(gitBytes(['ls-files', '--cached', '-z']), 'git ls-files rastreados');
  const naoRastreados = caminhosNul(gitBytes(['ls-files', '--others', '--exclude-standard', '-z']), 'git ls-files não rastreados');
  const removidos = new Set(caminhosNul(gitBytes(['ls-files', '--deleted', '-z']), 'git ls-files removidos'));
  return { rastreados: new Set(rastreados), naoRastreados, removidos };
}

function caminhoSeguro(raiz, relativo) {
  if (!relativo || path.isAbsolute(relativo) || /^[\\/]/.test(relativo) || relativo.split(/[\\/]/).includes('..')) {
    throw new Error('git retornou caminho inseguro para a fotografia');
  }
  const origem = path.resolve(raiz, relativo);
  if (origem !== raiz && !origem.startsWith(raiz + path.sep)) throw new Error('git retornou caminho fora do repositório');
  let atual = raiz;
  for (const parte of relativo.split(/[\\/]/).slice(0, -1)) {
    atual = path.join(atual, parte);
    try {
      if (fs.lstatSync(atual).isSymbolicLink()) throw new Error('git retornou caminho sob diretório simbólico');
    } catch (erro) {
      if (erro.code === 'ENOENT') return origem;
      throw erro;
    }
  }
  return origem;
}

function lerIndiceGit(raiz, relativo) {
  const bin = resolverBin('git');
  const r = spawnSync(bin, ['show', `:${relativo}`], { cwd: raiz, encoding: null, shell: false, maxBuffer: 64 * 1024 * 1024, env: ambienteGitImutavel });
  if (r.status !== 0) throw new Error(`git show falhou para arquivo rastreado (exit ${r.status ?? 1})`);
  return r.stdout;
}

const artefatosGerados = new Set([
  'gitleaks-commits.json', 'gitleaks-commits-reviewed.json', 'gitleaks-commits.err', 'gitleaks-staged.json', 'gitleaks-indice.err',
  'gitleaks-snapshot.json', 'gitleaks-working-tree.err', 'gitleaks-dir.json', 'gitleaks-dir.err',
  'semgrep.json', 'semgrep.err', 'composer-audit.txt', 'pip-audit.txt', 'ruff-S.txt', 'bandit.txt',
  'npm-audit.txt', 'psalm.txt', 'agentshield.json', 'agentshield.err',
]);

function sobSaida(relativo, raiz, rastreados) {
  const relSaida = path.relative(raiz, path.resolve(saida));
  if (!relSaida || relSaida.startsWith('..' + path.sep) || path.isAbsolute(relSaida) || rastreados.has(relativo)) return false;
  return path.dirname(relativo) === relSaida && artefatosGerados.has(path.basename(relativo));
}

function criarFotografiaGit(raiz, fonte) {
  const foto = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-snapshot-'));
  try {
    const { rastreados, naoRastreados, removidos } = arquivosGit();
    // A fotografia do índice é deliberadamente só o índice. Arquivos não
    // rastreados pertencem exclusivamente à fotografia do working tree.
    const todos = fonte === 'indice' ? [...rastreados] : [...rastreados, ...naoRastreados];
    for (const relativo of todos) {
      if (sobSaida(relativo, raiz, rastreados)) continue;
      const destino = path.resolve(foto, relativo);
      if (!destino.startsWith(foto + path.sep)) throw new Error('destino fora da fotografia');
      const doIndice = fonte === 'indice' && rastreados.has(relativo);
      if (doIndice) {
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.writeFileSync(destino, lerIndiceGit(raiz, relativo));
        continue;
      }
      const arquivoOrigem = caminhoSeguro(raiz, relativo);
      let stat;
      try { stat = fs.lstatSync(arquivoOrigem); } catch (erro) {
        // ENOENT é tolerado somente para uma remoção que o próprio Git já
        // observou em arquivo rastreado; corrida/untracked nunca é omitida.
        if (erro.code === 'ENOENT' && rastreados.has(relativo) && removidos.has(relativo)) continue;
        throw erro;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      if (stat.isSymbolicLink()) fs.writeFileSync(destino, fs.readlinkSync(arquivoOrigem), 'utf8');
      else fs.copyFileSync(arquivoOrigem, destino);
    }
    return foto;
  } catch (erro) {
    fs.rmSync(foto, { recursive: true, force: true });
    throw erro;
  }
}

function blobGit(especificacao, descricao) {
  const r = gitBytes(['show', especificacao]);
  if (r.status !== 0) return null;
  return r.stdout;
}

function modoGit(especificacao, descricao) {
  const r = gitBytes(especificacao.startsWith(':')
    ? ['ls-files', '-s', '-z', '--', especificacao.slice(1)]
    : ['ls-tree', '-z', especificacao.split(':')[0], '--', especificacao.split(':').slice(1).join(':')]);
  if (r.status !== 0) {
    // Só "ausente" vira null: HEAD sem commit ainda. Qualquer outra falha do Git reprova (fail closed).
    const rev = especificacao.startsWith(':') ? '' : especificacao.split(':')[0];
    if (rev && gitBytes(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).status === 1) return null;
    throw new Error(`git falhou ao ler a política ${descricao}`);
  }
  if (r.stdout.length === 0) return null;
  const primeira = r.stdout.subarray(0, r.stdout.indexOf(0)).toString('utf8');
  const modo = primeira.split(/\s+/)[0];
  if (modo === '120000') throw new Error(`política ${descricao} é link simbólico`);
  return modo;
}

// Toda política é copiada de um objeto Git, nunca lida do worktree. Isso
// impede que uma configuração não rastreada/unstaged mascare a fotografia.
function materializarPolitica(foto, origem, nome = '.gitleaks.toml', destinoNome = nome) {
  const especificacao = origem === 'indice' ? `:${nome}` : `HEAD:${nome}`;
  const modo = modoGit(especificacao, nome);
  const destino = path.join(foto, destinoNome);
  try { fs.unlinkSync(destino); } catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
  if (!modo) return null;
  const conteudo = blobGit(especificacao, nome);
  if (!conteudo) throw new Error(`política ${nome} ausente do objeto Git`);
  fs.writeFileSync(destino, conteudo, { mode: 0o600 });
  const stat = fs.lstatSync(destino);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`política ${nome} inválida`);
  return destino;
}

function registrarDeltaPolitica(foto, candidata, confiavel) {
  if (!fs.existsSync(candidata)) return;
  const brutoCandidato = fs.readFileSync(candidata);
  const brutoConfiavel = fs.readFileSync(confiavel);
  const textoCandidato = brutoCandidato.toString('utf8');
  const textoConfiavel = brutoConfiavel.toString('utf8');
  if (!Buffer.from(textoCandidato, 'utf8').equals(brutoCandidato)
    || !Buffer.from(textoConfiavel, 'utf8').equals(brutoConfiavel)) {
    throw new Error('política candidata contém UTF-8 inválido');
  }
  const conhecidos = new Map();
  for (const linha of textoConfiavel.split('\n')) conhecidos.set(linha, (conhecidos.get(linha) || 0) + 1);
  const novos = [];
  for (const linha of textoCandidato.split('\n')) {
    const n = conhecidos.get(linha) || 0;
    if (n > 0) conhecidos.set(linha, n - 1);
    else novos.push(linha);
  }
  if (novos.length > 0) fs.writeFileSync(path.join(foto, '.gitleaks-candidate-delta.txt'), novos.join('\n'), 'utf8');
}

function politicaHistorica() {
  const foto = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-history-policy-'));
  try {
    // Histórico nunca lê policy do candidato/range. A baseline mínima é
    // externa e sem allowlist; exceções históricas só passam pelo hash acima.
    const config = path.join(foto, '.gitleaks-bootstrap.toml');
    fs.writeFileSync(config, 'title = "bootstrap fail-closed policy"\n[extend]\nuseDefault = true\n[[rules]]\nid = "synthetic-gate-test"\ndescription = "Synthetic gate test detector"\nregex = \'\'\'SYNTHETIC_GATE_[A-Z_]+\'\'\'\nsecretGroup = 0\n', { mode: 0o600 });
    return { foto, config };
  } catch (erro) {
    fs.rmSync(foto, { recursive: true, force: true });
    throw erro;
  }
}

function normalizarRelatorio(relatorio, raiz) {
  const dados = lerJson(relatorio);
  if (!Array.isArray(dados)) return [];
  const normalizados = dados.map((achado) => ({
    ...achado,
    File: path.relative(raiz, path.resolve(raiz, achado.File || '')).split(path.sep).join('/'),
  }));
  fs.writeFileSync(relatorio, JSON.stringify(normalizados, null, 2) + '\n', 'utf8');
  return normalizados;
}

function validarRelatorioGitleaks(relatorio, status) {
  const dados = lerJson(relatorio);
  const valido = Array.isArray(dados) && dados.every((x) => x && typeof x.File === 'string' && typeof x.RuleID === 'string' && Number.isInteger(x.StartLine) && x.StartLine > 0);
  if (!valido) throw new Error('relatório Gitleaks inválido');
  if (status === 0 && dados.length !== 0) throw new Error('Gitleaks aprovou relatório não vazio');
  if (status === 1 && dados.length === 0) throw new Error('Gitleaks reprovou sem achado válido');
  return dados;
}

// ── stack ──────────────────────────────────────────────────────────────────
const raiz = listar('.');
const reqs = raiz.filter((n) => /^requirements.*\.txt$/.test(n));
const PHP = existe('composer.json');
const PY = existe('pyproject.toml') || reqs.length > 0;
const NODE = existe('package.json');
const packs = [];
const stacks = [];
if (PHP) { stacks.push('php'); packs.push('p/php'); }            // (p/laravel não existe no registry — verificado 2026-09-10)
if (PY) {
  stacks.push('python'); packs.push('p/python');
  const cfgs = ['pyproject.toml', ...reqs].filter(existe);
  if (contem(cfgs, /django/i)) packs.push('p/django');
  else if (contem(cfgs, /flask/i)) packs.push('p/flask');
}
if (NODE) {
  stacks.push('node'); packs.push('p/nodejs', 'p/javascript');   // (p/express não existe no registry)
  if (existe('tsconfig.json')) packs.push('p/typescript');
}
const stackTxt = stacks.length ? ' ' + stacks.join(' ') : ' (nenhuma detectada — só segredos e OWASP genérico)';

// ── base git ───────────────────────────────────────────────────────────────
let GIT = false, base = '', commitsAFrente = 0, sujo = false, baseInvalida = false, gitReplaceAtivo = false;
if (tem('git') && git('rev-parse', '--is-inside-work-tree').status === 0) {
  GIT = true;
  const refs = baseRef ? [baseRef] : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of refs) {
    const r = git('merge-base', ref, 'HEAD');
    if (r.status === 0 && r.stdout.trim()) { base = r.stdout.trim(); break; }
  }
  if (base) {
    const r = git('rev-list', '--count', `${base}..HEAD`);
    commitsAFrente = r.status === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
  }
  if (baseRef && !base) baseInvalida = true;
  const replaces = git('replace', '-l');
  if (replaces.status !== 0 || replaces.stdout.trim()) gitReplaceAtivo = true;
  sujo = git('status', '--porcelain').stdout.trim() !== '';
}
let baseTxt = base ? `${base.slice(0, 8)} (+${commitsAFrente} commit(s))` : 'nenhuma';
if (sujo) baseTxt += ' · working tree sujo';
linha(`Gate de segurança · stack:${stackTxt} · base: ${baseTxt}`);

// ── 1. gitleaks ────────────────────────────────────────────────────────────
if (tem('gitleaks')) {
  let falhou = 0;
  let erroGitleaks = false;
  const detalhes = [];
  const fingerprints = new Set();
  const erroOperacionalGitleaks = (r) => /(?:\b(?:ERR|FTL)\b|\bWRN\b.*(?:skipp(?:ed|ing)|unreadable|incomplete)|unable to load gitleaks config|skipp(?:ed|ing)|unreadable|incomplete)/i.test(`${r.stdout || ''}\n${r.stderr || ''}`);
  const apagarRelatorio = (relatorio) => { try { fs.unlinkSync(relatorio); } catch (erro) { if (erro.code !== 'ENOENT') throw erro; } };
  const coletar = (dados) => {
    for (const x of dados) {
      const chave = `${x.RuleID}:${x.File}:${x.StartLine}`;
      if (fingerprints.has(chave)) continue;
      fingerprints.add(chave);
      if (detalhes.length < 3) detalhes.push(`${x.File}:${x.StartLine} — ${x.RuleID}`);
    }
  };
  const temCommits = GIT && base && commitsAFrente > 0;
  if (gitReplaceAtivo) {
    falhou = 1;
    erroGitleaks = true;
    gravar('gitleaks-commits.err', { stdout: '', stderr: 'git replace ativo: a varredura histórica não é confiável' });
  } else if (baseInvalida) {
    falhou = 1;
    erroGitleaks = true;
    gravar('gitleaks-commits.err', { stdout: '', stderr: 'base Git inválida para a varredura de commits' });
  } else if (temCommits) {
    apagarRelatorio(arq('gitleaks-commits.json'));
    try {
      const politica = politicaHistorica();
      const relatorio = path.join(politica.foto, 'gitleaks-commits.json');
      const args = ['git', `--log-opts=${base}..HEAD`, '--no-banner', '--redact', '--exit-code', '1',
        '--report-format', 'json', '--report-path', relatorio, '--config', politica.config, '.'];
      const guardaGit = ambienteGitleaksImutavel();
      let r;
      try { r = rodar('gitleaks', args, { env: guardaGit.env }); }
      finally { guardaGit.limpar(); }
      if (erroOperacionalGitleaks(r)) throw new Error('Gitleaks histórico incompleto');
      if (r.status !== 0 && r.status !== 1) throw new Error('Gitleaks histórico falhou');
      if (!existe(relatorio)) throw new Error('relatório histórico ausente');
      const achadosHistoricos = validarRelatorioGitleaks(relatorio, r.status);
      const suprimidos = achadosHistoricos.filter((x) => achadosHistoricosRevisados.has(hashAchadoHistorico(x)));
      const naoSuprimidos = achadosHistoricos.filter((x) => !achadosHistoricosRevisados.has(hashAchadoHistorico(x)));
      fs.writeFileSync(arq('gitleaks-commits.json'), JSON.stringify(naoSuprimidos, null, 2) + '\n', 'utf8');
      fs.writeFileSync(arq('gitleaks-commits-reviewed.json'), JSON.stringify(suprimidos.map((x) => ({
        Commit: x.Commit, File: x.File, StartLine: x.StartLine, RuleID: x.RuleID,
        fingerprintSha256: hashAchadoHistorico(x),
      })), null, 2) + '\n', 'utf8');
      gravar('gitleaks-commits.err', { stdout: '', stderr: r.stderr });
      coletar(naoSuprimidos);
      fs.rmSync(politica.foto, { recursive: true, force: true });
    } catch (erro) {
      falhou = 1;
      erroGitleaks = true;
      gravar('gitleaks-commits.err', { stdout: '', stderr: `histórico: ${erro.message}` });
    }
  }
  if (GIT) {
    let avisouRegrasDefault = false;
    const escanearFotografia = (fonte, nome) => {
      let foto = '', fotoPolitica = '';
      const relatorio = path.resolve(arq(nome));
      try {
        apagarRelatorio(relatorio);
        fotoPolitica = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-authority-'));
        // A política é sempre retirada do último commit confiável. A política
        // candidata permanece no seu caminho original como dado e portanto não
        // pode autorizar a si mesma nem ocultar conteúdo staged/unstaged.
        let config = materializarPolitica(fotoPolitica, 'head');
        if (config && fonte === 'indice' && !modoGit(':.gitleaks.toml', 'política candidata')) {
          throw new Error('política candidata ausente do índice');
        }
        if (!config) {
          // Sem política no HEAD: regras default do gitleaks, sem allowlist. A política do
          // índice/working tree nunca vira autoridade (--config explícito impede o autoload).
          config = path.join(fotoPolitica, '.gitleaks-default.toml');
          fs.writeFileSync(config, '[extend]\nuseDefault = true\n', { mode: 0o600 });
          if (!avisouRegrasDefault) {
            avisouRegrasDefault = true;
            linha('✓ gitleaks: sem .gitleaks.toml no HEAD — regras default');
          }
        }
        foto = criarFotografiaGit(process.cwd(), fonte);
      registrarDeltaPolitica(foto, path.join(foto, '.gitleaks.toml'), config);
      const args = ['dir', '--no-banner', '--redact', '--exit-code', '1',
        '--report-format', 'json', '--report-path', relatorio];
      if (config) args.push('--config', config);
      args.push('.');
      const guardaGit = ambienteGitleaksImutavel();
      let r;
      try { r = rodar('gitleaks', args, { cwd: foto, env: guardaGit.env }); }
      finally { guardaGit.limpar(); }
      gravar(`gitleaks-${fonte}.err`, { stdout: '', stderr: r.stderr });
      if (erroOperacionalGitleaks(r)) { falhou = 1; erroGitleaks = true; }
      else if (r.status === 1 && existe(relatorio)) {
        validarRelatorioGitleaks(relatorio, r.status);
        coletar(normalizarRelatorio(relatorio, foto));
      }
      else if (r.status === 1) { falhou = 1; erroGitleaks = true; }
      else if (r.status !== 0) { falhou = r.status; erroGitleaks = true; }
      else if (r.status === 0 && existe(relatorio)) {
        validarRelatorioGitleaks(relatorio, r.status);
        normalizarRelatorio(relatorio, foto);
      }
      else { falhou = 1; erroGitleaks = true; }
      } catch (erro) {
        falhou = 1;
        erroGitleaks = true;
        gravar(`gitleaks-${fonte}.err`, { stdout: '', stderr: `fotografia Git: ${erro.message}` });
      } finally {
        if (foto) fs.rmSync(foto, { recursive: true, force: true });
        if (fotoPolitica) fs.rmSync(fotoPolitica, { recursive: true, force: true });
      }
    };
    escanearFotografia('indice', 'gitleaks-staged.json');
    escanearFotografia('working-tree', 'gitleaks-snapshot.json');
  } else {
    apagarRelatorio(arq('gitleaks-dir.json'));
    const r = rodar('gitleaks', ['dir', '.', '--no-banner', '--redact', '--exit-code', '1',
      '--report-format', 'json', '--report-path', arq('gitleaks-dir.json')], { env: ambienteGitImutavel });
    try {
      gravar('gitleaks-dir.err', { stdout: '', stderr: r.stderr });
      if (erroOperacionalGitleaks(r)) { falhou = 1; erroGitleaks = true; }
      else if (r.status === 1 && existe(arq('gitleaks-dir.json'))) coletar(validarRelatorioGitleaks(arq('gitleaks-dir.json'), r.status));
      else if (r.status === 1) { falhou = 1; erroGitleaks = true; }
      else if (r.status !== 0) { falhou = r.status; erroGitleaks = true; }
      else if (r.status === 0 && existe(arq('gitleaks-dir.json'))) validarRelatorioGitleaks(arq('gitleaks-dir.json'), r.status);
      else if (!existe(arq('gitleaks-dir.json'))) { falhou = 1; erroGitleaks = true; }
    } catch (erro) {
      falhou = 1;
      erroGitleaks = true;
      gravar('gitleaks-dir.err', { stdout: '', stderr: `relatório de diretório: ${erro.message}` });
    }
  }
  const n = fingerprints.size;
  if (n > 0) {
    achados += n;
    linha(`✗ gitleaks: ${n} segredo(s) — ${arq('gitleaks-*.json')}`);
    for (const d of detalhes.slice(0, 3)) linha(`    ${d}`);
  }
  if (falhou || erroGitleaks) {
    falhaSeguranca = true;
    parcial('gitleaks', `gitleaks: erro (exit ${falhou || 1}) — ver ${arq('gitleaks-*.err')} — gate parcial`);
  } else if (n === 0) {
    linha('✓ gitleaks: 0 segredos');
  }
} else {
  falhaSeguranca = true;
  parcial('gitleaks', 'gitleaks: não instalado — reprova o gate (instale o binário do release em ~/.local/bin ou no PATH)');
}

// ── 2. semgrep ─────────────────────────────────────────────────────────────
// Desligado temporariamente enquanto existir scripts/.semgrep-desligado (CPU alta). Apague o arquivo pra religar.
const SEMGREP_DESLIGADO = path.join(path.dirname(fileURLToPath(import.meta.url)), '.semgrep-desligado');
if (fs.existsSync(SEMGREP_DESLIGADO)) {
  parcial('semgrep', `semgrep: desligado temporariamente pelo usuário (${SEMGREP_DESLIGADO}) — gate parcial; NÃO instalar/rodar semgrep`);
} else if (tem('semgrep')) {
  const baseline = GIT && base && commitsAFrente > 0 ? ['--baseline-commit', base] : [];
  const args = ['scan', '--config', 'p/owasp-top-ten', '--config', 'p/secrets'];
  for (const p of packs) args.push('--config', p);
  args.push(...baseline, '--metrics=off', '--quiet', '--json', '-o', arq('semgrep.json'), '.');
  const r = rodar('semgrep', args);
  gravar('semgrep.err', { stdout: '', stderr: r.stderr });
  const d = lerJson(arq('semgrep.json'));
  if (d && Array.isArray(d.results)) {
    const sev = {};
    for (const x of d.results) { const s = String((x.extra && x.extra.severity) || '?').toUpperCase(); sev[s] = (sev[s] || 0) + 1; }
    const graves = d.results.filter((x) => ['ERROR', 'WARNING'].includes(String((x.extra && x.extra.severity) || '').toUpperCase()));
    const sevs = Object.keys(sev).sort().map((k) => `${k}=${sev[k]}`).join(' ') || '-';
    const erros = (d.errors || []).slice(0, 2).map((e) => String(e.message || '').slice(0, 110));
    if (graves.length > 0) {
      achados += graves.length;
      linha(`✗ semgrep: ${graves.length} achado(s) ERROR/WARNING${baseline.length ? ' novo(s) vs base' : ''} (${sevs}) — ${arq('semgrep.json')}`);
      for (const x of graves.slice(0, 4)) linha(`    ${x.path}:${x.start.line} ${String(x.check_id).split('.').pop()} [${x.extra.severity}]`);
    } else if (r.status === 0 || r.status === 1) {
      const nota = baseline.length ? '' : ' · sem baseline: inclui código pré-existente';
      linha(`✓ semgrep: 0 achados ERROR/WARNING${baseline.length ? ' novos vs base' : ''} (${d.results.length} no total)${nota}`);
    } else {
      parcial('semgrep', `semgrep: erro (exit ${r.status}) — ver ${arq('semgrep.json')} — gate parcial`);
      for (const e of erros) linha(`    erro: ${e}`);
    }
  } else {
    parcial('semgrep', `semgrep: erro (exit ${r.status}, sem relatório) — ver ${arq('semgrep.err')} — gate parcial`);
  }
} else {
  parcial('semgrep', 'semgrep: não instalado — gate parcial (pipx install semgrep)');
}

// ── 3. audit por stack ─────────────────────────────────────────────────────
if (PHP) {
  if (tem('composer')) {
    const r = rodar('composer', ['audit', '--no-interaction', '--format=plain']);
    gravar('composer-audit.txt', r);
    const txt = r.stdout + r.stderr;
    if (r.status === 0) linha('✓ composer audit: sem advisories');
    else if (/advisor|CVE|vulnerab/i.test(txt)) {
      const n = (txt.match(/CVE-|PKSA-|GHSA-/g) || []).length || 1;
      achados += n; linha(`✗ composer audit: ${n} advisory(ies) — ${arq('composer-audit.txt')}`);
    } else parcial('composer', `composer audit: erro (exit ${r.status}) — ver ${arq('composer-audit.txt')} — gate parcial`);
  } else parcial('composer', 'composer: não instalado — gate parcial (audit de PHP não rodou)');
  const psalm = path.join('vendor', 'bin', WIN ? 'psalm.bat' : 'psalm');
  if (existe('psalm.xml') && existe(psalm)) {
    const r = rodar(psalm, ['--no-cache', '--output-format=compact']);
    gravar('psalm.txt', r);
    if (r.status === 0) linha('✓ psalm: sem erros');
    else { achados += 1; linha(`✗ psalm: erros (exit ${r.status}) — ${arq('psalm.txt')}`); }
  }
}

if (PY) {
  if (tem('pip-audit')) {
    const args = existe('requirements.txt') ? ['--strict', '--no-deps', '-r', 'requirements.txt'] : ['--strict'];
    const r = rodar('pip-audit', args);
    gravar('pip-audit.txt', r);
    const m = (r.stdout + r.stderr).match(/Found (\d+) known vulnerabilit/);
    if (r.status === 0) linha('✓ pip-audit: sem vulnerabilidades');
    else if (m) { const n = parseInt(m[1], 10) || 1; achados += n; linha(`✗ pip-audit: ${n} vulnerabilidade(s) — ${arq('pip-audit.txt')}`); }
    else parcial('pip-audit', `pip-audit: erro (exit ${r.status}) — ver ${arq('pip-audit.txt')} — gate parcial`);
  } else parcial('pip-audit', 'pip-audit: não instalado — gate parcial (pipx install pip-audit)');
  if (tem('ruff')) {
    const r = rodar('ruff', ['check', '--select', 'S', '--output-format', 'concise', '.']);
    gravar('ruff-S.txt', r);
    const hits = (r.stdout + r.stderr).split('\n').filter((l) => /: S\d/.test(l));
    if (r.status === 0) linha('✓ ruff --select S: 0 achados');
    else if (r.status === 1) {
      const n = hits.length || 1; achados += n;
      linha(`✗ ruff --select S: ${n} achado(s) — ${arq('ruff-S.txt')}`);
      for (const h of hits.slice(0, 3)) linha(`    ${h.trim()}`);
    } else parcial('ruff', `ruff: erro (exit ${r.status}) — ver ${arq('ruff-S.txt')} — gate parcial`);
  } else if (tem('bandit')) {
    const r = rodar('bandit', ['-r', '.', '-ll', '-ii', '-q', '-x', './.venv,./venv,./node_modules']);
    gravar('bandit.txt', r);
    if (r.status === 0) linha('✓ bandit: 0 achados MEDIUM+');
    else if (r.status === 1) {
      const n = ((r.stdout + r.stderr).match(/^>> Issue/gm) || []).length || 1; achados += n;
      linha(`✗ bandit: ${n} achado(s) MEDIUM+ — ${arq('bandit.txt')}`);
    } else parcial('bandit', `bandit: erro (exit ${r.status}) — ver ${arq('bandit.txt')} — gate parcial`);
  } else parcial('ruff', 'ruff/bandit: nenhum instalado — gate parcial (pipx install ruff ou bandit)');
}

if (NODE) {
  let pm = 'npm';
  if (existe('pnpm-lock.yaml')) pm = 'pnpm';
  else if (existe('yarn.lock')) pm = 'yarn';
  else if (existe('bun.lock') || existe('bun.lockb')) pm = 'bun';
  const disponivel = pm === 'npm' ? true : tem(pm);
  if (disponivel) {
    let r;
    if (pm === 'npm') r = rodarNpm(['audit', '--audit-level=high']);
    else if (pm === 'pnpm') r = rodar('pnpm', ['audit', '--audit-level', 'high']);
    else if (pm === 'bun') r = rodar('bun', ['audit', '--audit-level=high']);
    else {
      const v = rodar('yarn', ['--version']).stdout.trim();
      if (/^[2-9]/.test(v)) r = rodar('yarn', ['npm', 'audit', '--severity', 'high']);
      else { r = rodar('yarn', ['audit', '--level', 'high']); r.status = r.status >= 8 ? 1 : 0; } // yarn 1: bitmask (8 high, 16 critical)
    }
    gravar('npm-audit.txt', r);
    const txt = r.stdout + r.stderr;
    if (r.status === 0) linha(`✓ ${pm} audit: sem vulnerabilidades high/critical`);
    else if (r.status === 127 || /ENOLOCK|ERR_PNPM_NO_LOCKFILE|no lockfile|lockfile.*not found|ERR!|npm error|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(txt)) {
      parcial(pm, `${pm} audit: não rodou (sem lockfile, sem rede ou não instalado) — ver ${arq('npm-audit.txt')} — gate parcial`);
    } else {
      let n = 0;
      for (const m of txt.matchAll(/(\d+) (high|critical)/g)) n += parseInt(m[1], 10);
      if (!n) n = 1;
      achados += n;
      linha(`✗ ${pm} audit: ${n} vulnerabilidade(s) high/critical — ${arq('npm-audit.txt')}`);
      const det = txt.split('\n').filter((l) => /severity|^[a-z@].*  \*/i.test(l)).slice(0, 3);
      for (const l of det) linha(`    ${l.trim()}`);
    }
  } else parcial(pm, `${pm}: não instalado — gate parcial (audit de Node não rodou)`);
}

// ── 4. agentshield (config de agente) ─────────────────────────────────────
// Só quando o diff desde a base (ou o working tree) toca config de agente. Modo estático; NUNCA --opus
// (sem --opus/--injection/--deep/--supply-chain-online o scan não abre socket — verificado no 1.6.0).
// ecc-agentshield (MIT) é opcional: não é dependência do pacote.
// Contrato do `scan --format json` (1.6.0): stdout = { findings: [{ severity: critical|high|medium|low|info, file, ... }], summary, ... };
// exit 0 = sem crítico · 2 = há crítico · 1 = erro (sem JSON). O diretório alvo vai logo após os argumentos (`--path <dir>`).
const RE_CONFIG_AGENTE = /^(?:\.claude|\.codex)\/|(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.mcp\.json)$|(?:^|\/)hooks(?:\/|$)/;
const ARGS_AGENTSHIELD = ['scan', '--format', 'json', '--path'];
function contarAltosAgentshield(json) {
  return json.findings.filter((x) => x && ['critical', 'high'].includes(String(x.severity).toLowerCase())).length;
}
// -z: nomes crus (sem as aspas/escapes do core.quotePath), pra regex casar qualquer caminho.
const nomesGit = (...args) => { const r = gitBytes(args); return r.status === 0 ? r.stdout.toString('utf8').split('\0') : []; };
const tocados = GIT ? [
  ...(base ? nomesGit('diff', '--name-only', '-z', `${base}..HEAD`) : []),
  ...nomesGit('diff', '--name-only', '-z', '--cached'),
  ...nomesGit('diff', '--name-only', '-z'),
  ...nomesGit('ls-files', '--others', '--exclude-standard', '-z'),
].filter(Boolean) : [];
if (tocados.some((f) => RE_CONFIG_AGENTE.test(f))) {
  if (tem('agentshield')) {
    const r = rodar('agentshield', [...ARGS_AGENTSHIELD, '.']);
    fs.writeFileSync(arq('agentshield.json'), r.stdout || '', 'utf8');
    let dados = null;
    try { dados = JSON.parse(r.stdout || ''); } catch { dados = null; }
    if (!dados || !Array.isArray(dados.findings) || (r.status !== 0 && r.status !== 2)) {
      gravar('agentshield.err', r);
      parcial('agentshield', `agentshield: erro (exit ${r.status}, saída ilegível) — ver ${arq('agentshield.err')} — gate parcial`);
    } else {
      const n = contarAltosAgentshield(dados);
      if (n > 0) { achados += n; linha(`✗ agentshield: ${n} achado(s) alto/crítico — ${arq('agentshield.json')}`); }
      else linha('✓ agentshield: sem achado alto/crítico');
    }
  } else parcial('agentshield', 'agentshield: não instalado — gate parcial (npm i -g ecc-agentshield)');
}

// ── resumo (≤ 20 linhas) ───────────────────────────────────────────────────
if (achados > 0 || falhaSeguranca) {
  linha(`GATE: REPROVADO — ${achados} achado(s). Corrija ou justifique (nosemgrep / .gitleaks.toml / --ignore-vuln) no Dev Agent Record.`);
} else if (parciais.length > 0) {
  linha(`GATE: APROVADO COM RESSALVAS — ferramentas ausentes/com erro: ${parciais.join(' ')}. Registre no report; não é aprovação plena.`);
} else {
  linha('GATE: APROVADO');
}
console.log(linhas.slice(0, 20).join('\n'));
process.exit(achados > 0 || falhaSeguranca ? 1 : 0);
