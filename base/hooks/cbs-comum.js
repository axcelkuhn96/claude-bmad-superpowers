// cbs-comum.js — utilitários dos hooks CBS (Claude Code + Codex). ESM, sem dependências.
// Regras: nunca quebrar a sessão (erro interno → exit 0), nada no stdout sem motivo, sem npx, sem shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 16 MiB (como ECC post-edit-format.js): payload grande de Write/Edit não pode pular a checagem em silêncio.
export const LIMITE_STDIN = 16 * 1024 * 1024;
export const WIN = process.platform === 'win32';

// CBS_HOOKS=off desliga todos; CBS_HOOKS_DESLIGADOS=format,typecheck,no-verify,config desliga os escolhidos.
export function hookDesligado(nome, env = process.env) {
  if (String(env.CBS_HOOKS || '').trim().toLowerCase() === 'off') return true;
  return String(env.CBS_HOOKS_DESLIGADOS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(nome);
}

export function lerStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Conteúdo do arquivo, ou '' quando não existe / não dá pra ler.
export function lerTexto(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function lerPayload(texto) {
  if (typeof texto !== 'string' || !texto.trim() || Buffer.byteLength(texto) > LIMITE_STDIN) return null;
  try {
    const o = JSON.parse(texto);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// Claude Code: tool_input.command (string). Codex: string ou array de argv (SUPOSIÇÃO SP-9, confirmada na Task 10).
export function comandoBash(payload) {
  const c = payload?.tool_input?.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return null;
}

const RE_PATCH = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
export function caminhosDoPatch(patch) {
  const out = [];
  for (const m of String(patch).matchAll(RE_PATCH)) out.push((m[1] || m[2]).trim());
  return out;
}

// Caminhos absolutos editados: Edit/Write/MultiEdit (file_path) e apply_patch do Codex.
export function caminhosEditados(payload) {
  const ti = payload?.tool_input || {};
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const brutos = [];
  if (typeof ti.file_path === 'string' && ti.file_path) brutos.push(ti.file_path);
  for (const v of [ti.input, ti.patch, comandoBash(payload)]) {
    if (typeof v === 'string' && v.includes('*** Begin Patch')) brutos.push(...caminhosDoPatch(v));
  }
  return [...new Set(brutos.map((p) => path.resolve(cwd, p)))];
}

// Sobe a partir de `inicio` até achar um dos marcadores; para na raiz do disco ou no HOME.
export function acharRaiz(inicio, marcadores) {
  let dir = path.resolve(inicio);
  const raizDisco = path.parse(dir).root;
  const home = os.homedir();
  for (;;) {
    if (marcadores.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    if (dir === raizDisco || dir === home) return null;
    dir = path.dirname(dir);
  }
}

export function executavel(p) {
  try {
    fs.accessSync(p, WIN ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}

// Binário do próprio projeto (vendor/bin, node_modules/.bin, .venv/bin). Nunca npx.
export function binLocal(raiz, rel) {
  const p = path.join(raiz, rel);
  return executavel(p) ? p : null;
}

// Resolve no PATH sem shell. No Windows retorna null (SP-8: shims .cmd exigem shell).
export function noPath(nome, env = process.env) {
  if (WIN) return null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, nome);
    if (executavel(p)) return p;
  }
  return null;
}

export function ehEntrada(metaUrl) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch { return false; }
}

export function avisar(msg) {
  try { process.stderr.write(`[cbs] ${msg}\n`); } catch {}
}
