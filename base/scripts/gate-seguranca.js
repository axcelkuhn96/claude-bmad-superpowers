#!/usr/bin/env node
// gate-seguranca.js — gate de segurança (camada 2) do claude-bmad-superpowers.
// Node >= 18 (ESM; o package.json ao lado declara "type": "module"), sem dependências, sem shell (spawnSync com shell:false). Windows / Linux / macOS.
//
// Roda antes de marcar uma task como DONE e antes de push:
//   gitleaks (segredos)  +  semgrep (SAST, só o que é novo vs base)  +  audit da stack
//   PHP: composer audit (+ psalm se psalm.xml)   Python: pip-audit + ruff --select S (ou bandit)
//   Node: npm|pnpm|yarn|bun audit (high+)
//
// Uso:  node gate-seguranca.js [diretório] [--base <ref>] [--saida <dir>]
//   diretório  raiz do projeto (padrão: diretório atual)
//   --base     commit/branch de origem pra baseline (padrão: merge-base com origin/HEAD, main ou master)
//   --saida    onde gravar os JSON completos (padrão: .superpowers/sdd)
//
// Exit: 0 = aprovado (com ou sem ressalvas de ferramenta ausente)  ·  1 = segredo ou vulnerabilidade encontrada.
// Ferramenta não instalada NUNCA aprova em silêncio: sai como aviso "gate parcial" na saída.
// Supressão só com justificativa no Dev Agent Record: `# nosemgrep: <id> — <motivo>`, `.gitleaks.toml`, `--ignore-vuln`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';

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
const git = (...args) => rodar('git', args);
const gravar = (nome, r) => fs.writeFileSync(arq(nome), (r.stdout || '') + (r.stderr || ''), 'utf8');

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
let GIT = false, base = '', commitsAFrente = 0, sujo = false;
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
  sujo = git('status', '--porcelain').stdout.trim() !== '';
}
let baseTxt = base ? `${base.slice(0, 8)} (+${commitsAFrente} commit(s))` : 'nenhuma';
if (sujo) baseTxt += ' · working tree sujo';
linha(`Gate de segurança · stack:${stackTxt} · base: ${baseTxt}`);

// ── 1. gitleaks ────────────────────────────────────────────────────────────
if (tem('gitleaks')) {
  let n = 0, falhou = 0;
  const detalhes = [];
  const coletar = (relatorio) => {
    const d = lerJson(relatorio);
    if (!Array.isArray(d)) return 0;
    for (const x of d.slice(0, 3)) detalhes.push(`${x.File}:${x.StartLine} — ${x.RuleID}`);
    return d.length;
  };
  const temCommits = GIT && base && commitsAFrente > 0;
  if (temCommits) {
    const r = rodar('gitleaks', ['git', `--log-opts=${base}..HEAD`, '--no-banner', '--redact', '--exit-code', '1',
      '--report-format', 'json', '--report-path', arq('gitleaks-commits.json'), '.']);
    gravar('gitleaks.err', { stdout: '', stderr: r.stderr });
    if (r.status === 1) n += coletar(arq('gitleaks-commits.json'));
    else if (r.status !== 0) falhou = r.status;
  }
  if (!temCommits || sujo) {
    const r = rodar('gitleaks', ['dir', '.', '--no-banner', '--redact', '--exit-code', '1',
      '--report-format', 'json', '--report-path', arq('gitleaks-dir.json')]);
    gravar('gitleaks.err', { stdout: '', stderr: r.stderr });
    if (r.status === 1) n += coletar(arq('gitleaks-dir.json'));
    else if (r.status !== 0) falhou = r.status;
  }
  if (n > 0) {
    achados += n;
    linha(`✗ gitleaks: ${n} segredo(s) — ${arq('gitleaks-*.json')}`);
    for (const d of detalhes.slice(0, 3)) linha(`    ${d}`);
  } else if (falhou) {
    parcial('gitleaks', `gitleaks: erro (exit ${falhou}) — ver ${arq('gitleaks.err')} — gate parcial`);
  } else {
    linha('✓ gitleaks: 0 segredos');
  }
} else {
  parcial('gitleaks', 'gitleaks: não instalado — gate parcial (binário do release em ~/.local/bin ou no PATH)');
}

// ── 2. semgrep ─────────────────────────────────────────────────────────────
if (tem('semgrep')) {
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

// ── resumo (≤ 20 linhas) ───────────────────────────────────────────────────
if (achados > 0) {
  linha(`GATE: REPROVADO — ${achados} achado(s). Corrija ou justifique (nosemgrep / .gitleaks.toml / --ignore-vuln) no Dev Agent Record.`);
} else if (parciais.length > 0) {
  linha(`GATE: APROVADO COM RESSALVAS — ferramentas ausentes/com erro: ${parciais.join(' ')}. Registre no report; não é aprovação plena.`);
} else {
  linha('GATE: APROVADO');
}
console.log(linhas.slice(0, 20).join('\n'));
process.exit(achados > 0 ? 1 : 0);
