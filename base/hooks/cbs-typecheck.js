#!/usr/bin/env node
// cbs-typecheck.js — Stop: typecheck em lote só das stacks tocadas na sessão (acumulador do cbs-format).
// tsc (node_modules/.bin + tsconfig.json) · phpstan (vendor/bin + phpstan.neon*) · mypy|pyright (configurados no projeto).
// Falha → {"decision":"block","reason":…} UMA vez; com stop_hook_active só avisa; teto de 60 s → só avisa. Nunca npx.
// Derivado de affaan-m/ECC @ e482e57, scripts/hooks/stop-format-typecheck.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookDesligado, lerStdin, lerPayload, lerTexto, acharRaiz, binLocal, noPath, ehEntrada, avisar, lerAcumulador, arquivoAcumulador } from './cbs-comum.js';

export const TETO_MS = 60_000;
const MAX_MOTIVO = 1500;
// Sem ler *.tsbuildinfo velho (esconde erro) nem gravar buildinfo/outDir no repo a cada Stop. Só --incremental false
// num projeto composite dá TS6379 (erro de config que o filtro por arquivo descartaria) — medido no TS 5.9, 6.0 e 7.0.
const ARGS_TSC = ['--noEmit', '--pretty', 'false', '--composite', 'false', '--incremental', 'false'];

// tsconfig aceita comentários e vírgula final (JSONC); strings são preservadas.
function lerJsonc(p) {
  const semComentario = lerTexto(p).replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
  try { return JSON.parse(semComentario.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, (m) => (m[0] === '"' ? m : ''))); } catch { return null; }
}

// tsconfig "solution style" (só references + files: [], ex. template Vite react-ts): `-p` nele passa sem checar
// nada (medido no TS 5.9/6.0/7.0), então cada projeto referenciado é checado. `tsc -b` gravaria buildinfo no repo.
function projetosTs(tsconfig, vistos = new Set()) {
  if (vistos.has(tsconfig)) return [];
  vistos.add(tsconfig);
  const cfg = lerJsonc(tsconfig);
  const solution = cfg && Array.isArray(cfg.files) && !cfg.files.length && !('include' in cfg) && Array.isArray(cfg.references) && cfg.references.length > 0;
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
  const add = (chave, stack, raiz, bin, args, arquivo) => {
    const k = `${stack}|${chave}`;
    if (!planos.has(k)) planos.set(k, { stack, raiz, bin, args, arquivos: [] });
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
      const raiz = acharRaiz(dir, ['pyproject.toml', 'mypy.ini', 'pyrightconfig.json', 'setup.cfg']);
      if (!raiz) continue;
      const py = lerTexto(path.join(raiz, 'pyproject.toml'));
      const mypyCfg = fs.existsSync(path.join(raiz, 'mypy.ini')) || /^\[tool\.mypy/m.test(py) || /^\[mypy/m.test(lerTexto(path.join(raiz, 'setup.cfg')));
      const pyrightCfg = fs.existsSync(path.join(raiz, 'pyrightconfig.json')) || /^\[tool\.pyright/m.test(py);
      const mypy = mypyCfg && (binLocal(raiz, path.join('.venv', 'bin', 'mypy')) || noPath('mypy', env));
      const pyright = !mypy && pyrightCfg && (binLocal(raiz, path.join('node_modules', '.bin', 'pyright')) || binLocal(raiz, path.join('.venv', 'bin', 'pyright')) || noPath('pyright', env));
      if (mypy) add(raiz, 'py', raiz, mypy, [], a);
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
    const r = spawnSync(p.bin, p.args, { cwd: p.raiz, encoding: 'utf8', timeout: resta, shell: false, maxBuffer: 16 << 20 });
    if (r.error && r.error.code === 'ETIMEDOUT') return { falhas, estourou: true };
    if (r.error) { avisar(`typecheck: ${path.basename(p.bin)} não rodou (${r.error.code})`); continue; }
    if (r.status !== 0) {
      const linhas = filtrarSaida(p, `${r.stdout || ''}\n${r.stderr || ''}`);
      if (linhas.length) falhas.push({ stack: p.stack, raiz: p.raiz, linhas });
    }
  }
  return { falhas, estourou: false };
}

export function decidirSaida({ falhas, stopHookActive, estourou }) {
  if (estourou) return { stdout: '', stderr: '[cbs] typecheck: estourou o teto de tempo — não verificado (só aviso).', limpar: true };
  if (!falhas.length) return { stdout: '', stderr: '', limpar: true };
  const resumo = falhas.map((f) => `${f.stack} (${f.raiz}):\n${f.linhas.slice(0, 10).join('\n')}`).join('\n\n').slice(0, MAX_MOTIVO);
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
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const arquivos = arquivosDoProjeto(lerAcumulador(payload.session_id), cwd);
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
