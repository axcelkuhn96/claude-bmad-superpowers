#!/usr/bin/env node
// cbs-typecheck.mjs — Stop: typecheck em lote só das stacks tocadas na sessão (acumulador do cbs-format).
// tsc (node_modules/.bin + tsconfig.json) · phpstan (vendor/bin + phpstan.neon*) · mypy|pyright (configurados no projeto).
// Falha → {"decision":"block","reason":…} UMA vez; com stop_hook_active só avisa; teto de 60 s → só avisa. Nunca npx.
// Derivado de affaan-m/ECC @ e482e57, scripts/hooks/stop-format-typecheck.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookDesligado, lerStdin, lerPayload, lerTexto, acharRaiz, binLocal, noPath, envComNode, ferramentaIndisponivel, ehEntrada, avisar, lerAcumulador, arquivoAcumulador } from './cbs-comum.mjs';

export const TETO_MS = 60_000;
const MAX_MOTIVO = 1500;
// Sem ler *.tsbuildinfo velho (esconde erro) nem gravar buildinfo/outDir no repo a cada Stop. Só --incremental false
// num projeto composite dá TS6379 (erro de config que o filtro por arquivo descartaria) — medido no TS 5.9, 6.0 e 7.0;
// no TS 4.9 as próprias flags suprimiriam o check: --noEmit + emitDeclarationOnly → TS5053, e --incremental false com
// tsBuildInfoFile no tsconfig → TS5069; --emitDeclarationOnly false e --tsBuildInfoFile null desfazem (4.9 a 7.0).
const ARGS_TSC = ['--noEmit', '--pretty', 'false', '--composite', 'false', '--incremental', 'false', '--tsBuildInfoFile', 'null', '--emitDeclarationOnly', 'false'];
// Linha de diagnóstico que cita um arquivo-fonte (`x.ts(l,c): …`, inclusive .d.ts/.tsx/.mts/.js); tsconfig.json(…) não conta.
const RE_FONTE = /^\S.*\.[cm]?[jt]sx?\(\d+,\d+\): /;

// tsconfig aceita BOM, comentários e vírgula final (JSONC); strings são preservadas. Só objeto conta.
function lerJsonc(p) {
  const semComentario = lerTexto(p).replace(/^\uFEFF/, '').replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
  try {
    const o = JSON.parse(semComentario.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, (m) => (m[0] === '"' ? m : '')));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// tsconfig "solution style" (references sem entrada própria: files: [] e/ou include: [], ex. template Vite react-ts):
// `-p` nele passa sem checar nada (medido no TS 5.9/6.0/7.0), então cada projeto referenciado é checado.
// `tsc -b` gravaria buildinfo no repo. Visitados por caminho real: symlink para o próprio diretório não vira laço.
function projetosTs(tsconfig, vistos = new Set()) {
  let real;
  try { real = fs.realpathSync(tsconfig); } catch { return []; }
  if (vistos.has(real)) return [];
  vistos.add(real);
  const cfg = lerJsonc(tsconfig);
  const vazio = (k) => !(k in cfg) || (Array.isArray(cfg[k]) && !cfg[k].length);
  const solution = cfg && ('files' in cfg || 'include' in cfg) && vazio('files') && vazio('include') && Array.isArray(cfg.references) && cfg.references.length > 0;
  if (!solution) return [tsconfig];
  return cfg.references.flatMap((ref) => {
    if (typeof ref?.path !== 'string') return [];
    let alvo = path.resolve(path.dirname(tsconfig), ref.path);
    try { if (fs.statSync(alvo).isDirectory()) alvo = path.join(alvo, 'tsconfig.json'); } catch { return []; }
    return fs.existsSync(alvo) ? projetosTs(alvo, vistos) : [];
  });
}

export function planejarChecagens(arquivos, env = process.env) {
  const planos = new Map();
  const add = (chave, stack, raiz, bin, args, arquivo, extra = {}) => {
    const k = `${stack}|${chave}`;
    if (!planos.has(k)) planos.set(k, { stack, raiz, bin, args, ...extra, arquivos: [] });
    planos.get(k).arquivos.push(arquivo);
  };
  for (const a of arquivos) {
    const ext = path.extname(a).toLowerCase();
    const dir = path.dirname(a);
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
      const raiz = acharRaiz(dir, ['tsconfig.json']);
      const bin = raiz && binLocal(raiz, path.join('node_modules', '.bin', 'tsc'));
      if (bin) for (const cfg of projetosTs(path.join(raiz, 'tsconfig.json'))) add(cfg, 'ts', raiz, bin, [...ARGS_TSC, '-p', cfg], a);
    } else if (ext === '.php') {
      const raiz = acharRaiz(dir, ['composer.json']);
      const bin = raiz && binLocal(raiz, path.join('vendor', 'bin', 'phpstan'));
      const cfg = raiz && ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'].some((n) => fs.existsSync(path.join(raiz, n)));
      if (bin && cfg) add(raiz, 'php', raiz, bin, ['analyse', '--no-progress', '--error-format=raw'], a);
    } else if (ext === '.py' || ext === '.pyi') {
      const raiz = acharRaiz(dir, ['pyproject.toml', 'mypy.ini', '.mypy.ini', 'pyrightconfig.json', 'setup.cfg']);
      if (!raiz) continue;
      const py = lerTexto(path.join(raiz, 'pyproject.toml'));
      const mypyCfg = ['mypy.ini', '.mypy.ini'].some((n) => fs.existsSync(path.join(raiz, n))) || /^\[tool\.mypy/m.test(py) || /^\[mypy/m.test(lerTexto(path.join(raiz, 'setup.cfg')));
      const pyrightCfg = fs.existsSync(path.join(raiz, 'pyrightconfig.json')) || /^\[tool\.pyright/m.test(py);
      const mypy = mypyCfg && (binLocal(raiz, path.join('.venv', 'bin', 'mypy')) || noPath('mypy', env));
      const pyright = !mypy && pyrightCfg && (binLocal(raiz, path.join('node_modules', '.bin', 'pyright')) || binLocal(raiz, path.join('.venv', 'bin', 'pyright')) || noPath('pyright', env));
      if (mypy) add(raiz, 'py', raiz, mypy, [], a, { cacheTemp: true });
      else if (pyright) add(raiz, 'py', raiz, pyright, [], a);
    }
  }
  // php/py recebem os arquivos tocados; ts roda o projeto e a saída é filtrada (SP-5)
  return [...planos.values()].map((p) => (p.stack === 'ts' ? p : { ...p, args: [...p.args, ...p.arquivos] }));
}

// ts: só linhas `arquivo(linha,col): …` de arquivos editados (caminho relativo ao cwd do tsc, ou absoluto).
export function filtrarSaida(plano, saida) {
  const linhas = String(saida).split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (plano.stack !== 'ts') return linhas;
  const prefixos = plano.arquivos.flatMap((a) => [path.relative(plano.raiz, a).split(path.sep).join('/'), a]).map((c) => `${c}(`);
  return linhas.filter((l) => prefixos.some((p) => l.startsWith(p)));
}

export function executar(planos, tetoMs = TETO_MS) {
  const inicio = Date.now();
  const falhas = [];
  for (const p of planos) {
    const resta = tetoMs - (Date.now() - inicio);
    if (resta <= 0) return { falhas, estourou: true };
    // mypy: cache num dir temporário apagado depois — nunca grava .mypy_cache no repo (espírito do H2).
    const cache = p.cacheTemp ? fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-mypy-')) : null;
    let r;
    try {
      // SIGKILL: ferramenta que ignora SIGTERM não prende o hook além do teto.
      r = spawnSync(p.bin, cache ? ['--cache-dir', cache, ...p.args] : p.args, { cwd: p.raiz, encoding: 'utf8', timeout: resta, killSignal: 'SIGKILL', shell: false, maxBuffer: 16 << 20, env: envComNode() });
    } finally {
      if (cache) fs.rmSync(cache, { recursive: true, force: true });
    }
    if (r.error && r.error.code === 'ETIMEDOUT') return { falhas, estourou: true };
    // Ferramenta indisponível (phpstan sem php, wrapper do mypy sem python): pula em silêncio — não bloqueia nem avisa.
    if (ferramentaIndisponivel(r)) continue;
    if (r.error) { avisar(`typecheck: ${path.basename(p.bin)} não rodou (${r.error.code})`); continue; }
    if (r.status !== 0) {
      const saida = `${r.stdout || ''}\n${r.stderr || ''}`;
      const linhas = filtrarSaida(p, saida);
      if (linhas.length) { falhas.push({ stack: p.stack, raiz: p.raiz, linhas }); continue; }
      // Erro de opção/config (TS5xxx/TS6xxx em tsconfig.json ou sem arquivo) suprime todo o check semântico: avisa.
      const todas = saida.split('\n').map((l) => l.trim()).filter(Boolean);
      if (p.stack === 'ts' && !todas.some((l) => RE_FONTE.test(l))) {
        avisar(`typecheck não verificado: ${(todas[0] ?? `${path.basename(p.bin)} saiu ${r.status ?? r.signal} sem saída`).slice(0, 300)}`);
      }
    }
  }
  return { falhas, estourou: false };
}

export function decidirSaida({ falhas, stopHookActive, estourou }) {
  const resumo = falhas.map((f) => `${f.stack} (${f.raiz}):\n${f.linhas.slice(0, 10).join('\n')}`).join('\n\n').slice(0, MAX_MOTIVO);
  // Teto só avisa (SP-4), mas não descarta as falhas já achadas antes de estourar.
  if (estourou) return { stdout: '', stderr: `[cbs] typecheck: estourou o teto de tempo — não verificado (só aviso).${resumo ? `\n${resumo}` : ''}`, limpar: true };
  if (!falhas.length) return { stdout: '', stderr: '', limpar: true };
  if (stopHookActive) return { stdout: '', stderr: `[cbs] typecheck ainda falha (só aviso, sem novo bloqueio):\n${resumo}`, limpar: true };
  return { stdout: JSON.stringify({ decision: 'block', reason: `Typecheck falhou nos arquivos editados — corrija antes de encerrar:\n${resumo}` }), stderr: '', limpar: false };
}

// O acumulador vive no tmp compartilhado e segue symlink: só vale arquivo regular que existe dentro do projeto da
// sessão (caminho real). Senão uma lista plantada apontaria para um tsconfig + node_modules/.bin/tsc alheio.
export function arquivosDoProjeto(arquivos, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
  let raiz;
  try { raiz = fs.realpathSync(cwd); } catch { return []; }
  const ok = [];
  for (const a of arquivos) {
    if (!path.isAbsolute(a)) continue;
    try {
      const real = fs.realpathSync(a);
      const rel = path.relative(raiz, real);
      if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && fs.statSync(real).isFile()) ok.push(real);
    } catch { /* apagado ou ilegível: nada a checar */ }
  }
  return [...new Set(ok)];
}

function main() {
  if (hookDesligado('typecheck')) return 0;
  const payload = lerPayload(lerStdin());
  if (!payload) return 0;
  const acumulador = arquivoAcumulador(payload.session_id);
  // Âncora = raiz do projeto da sessão (CLAUDE_PROJECT_DIR); payload.cwd é o cwd corrente e muda com `cd subdir`.
  const ancora = [process.env.CLAUDE_PROJECT_DIR, payload.cwd].find((d) => typeof d === 'string' && path.isAbsolute(d)) || process.cwd();
  const arquivos = arquivosDoProjeto(lerAcumulador(payload.session_id), ancora);
  if (!arquivos.length) { fs.rmSync(acumulador, { force: true }); return 0; }
  const tetoEnv = Number(process.env.CBS_TYPECHECK_TETO_MS);
  const teto = Number.isInteger(tetoEnv) && tetoEnv > 0 && tetoEnv <= TETO_MS ? tetoEnv : TETO_MS;
  const { falhas, estourou } = executar(planejarChecagens(arquivos), teto);
  const s = decidirSaida({ falhas, stopHookActive: payload.stop_hook_active === true, estourou });
  if (s.stdout) process.stdout.write(s.stdout + '\n');
  if (s.stderr) process.stderr.write(s.stderr + '\n');
  if (s.limpar) fs.rmSync(acumulador, { force: true });
  return 0;
}

if (ehEntrada(import.meta.url)) {
  try { main(); } catch (e) { avisar(`typecheck: erro interno ignorado (${e.message})`); }
  process.exit(0);
}
