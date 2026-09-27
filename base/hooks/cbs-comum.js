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

// Erro de leitura (stdin fechado, diretório, etc.) → aviso curto no stderr e payload vazio (hook sai 0).
export function lerStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { avisar(`stdin ilegível ignorado (${e.code || e.message})`); return ''; }
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

// Confiança (POSIX): só roda binário/config que outro usuário local não consegue plantar nem trocar.
// Dono = usuário ou root. "Gravável por outros" = bit de outros, ou de grupo que não seja o grupo privado
// do usuário (UPG: gid == uid, comum com umask 002 — node_modules 775 continua aceito).
const UID = WIN ? -1 : process.getuid();
const GID = WIN ? -1 : process.getgid();
const donoOk = (st, uid) => st.uid === uid || st.uid === 0;
const gravavelPorOutros = (st) => (st.mode & 0o002) !== 0 || ((st.mode & 0o020) !== 0 && !(st.gid === GID && GID === UID));
// Diretório que pode ser raiz de projeto: nunca gravável por outros, nem com sticky (/tmp não é projeto).
function dirConfiavel(dir, uid) {
  try { const st = fs.statSync(dir); return donoOk(st, uid) && !gravavelPorOutros(st); } catch { return false; }
}
// `p` e cada ancestral até a raiz do disco (lstat): dono ok; entrada não gravável por outros; ancestral
// gravável por outros só com sticky (ninguém renomeia a entrada do usuário). Symlink: vale o dono do link
// (os bits dele não significam nada) e depois o alvo real passa pela mesma checagem.
function cadeiaConfiavel(p, uid) {
  for (let atual = p; ; atual = path.dirname(atual)) {
    const st = fs.lstatSync(atual);
    if (!donoOk(st, uid)) return false;
    const sticky = atual !== p && st.isDirectory() && (st.mode & 0o1000) !== 0;
    if (!st.isSymbolicLink() && gravavelPorOutros(st) && !sticky) return false;
    if (atual === path.dirname(atual)) return true;
  }
}

// Sobe a partir de `inicio` até achar um dos marcadores; para na raiz do disco, no HOME ou no primeiro
// diretório não confiável (gravável por outros, ex.: /tmp; ou de outro dono) — sem aceitá-lo nem subir além.
export function acharRaiz(inicio, marcadores, uid = UID) {
  let dir = path.resolve(inicio);
  const raizDisco = path.parse(dir).root;
  const home = os.homedir();
  for (;;) {
    if (!WIN && !dirConfiavel(dir, uid)) return null;
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
// Só com raiz, binário e toda a cadeia de diretórios confiáveis (link e alvo real): nada plantado por outro usuário.
// No Windows retorna null (SP-8: shims .cmd/.bat exigem shell → hook sai 0 em silêncio).
export function binLocal(raiz, rel, uid = UID) {
  if (WIN) return null;
  const p = path.join(raiz, rel);
  if (!executavel(p) || !dirConfiavel(raiz, uid)) return null;
  try { return cadeiaConfiavel(p, uid) && cadeiaConfiavel(fs.realpathSync(p), uid) ? p : null; } catch { return null; }
}

// Resolve no PATH sem shell. No Windows retorna null (SP-8: shims .cmd exigem shell).
// Só diretórios absolutos: entrada relativa ('.', 'bin') resolveria contra o cwd do projeto.
export function noPath(nome, env = process.env) {
  if (WIN) return null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
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

// Acumulador por sessão (PostToolUse registra, Stop consome). Só extensões com typecheck.
export const EXT_TIPADAS = new Set(['.ts', '.tsx', '.mts', '.cts', '.php', '.py', '.pyi']);
export function arquivoAcumulador(sessionId, dirTmp = os.tmpdir()) {
  const id = String(sessionId || 'sem-sessao').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return path.join(dirTmp, `cbs-editados-${id}.txt`);
}
// O_NOFOLLOW: o tmp é compartilhado; symlink plantado no caminho do acumulador não é seguido (lança).
const FLAG_ACUMULADOR = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
export function registrarEdicao(sessionId, arquivos, dirTmp = os.tmpdir()) {
  const tipados = arquivos.filter((a) => EXT_TIPADAS.has(path.extname(a).toLowerCase()));
  if (tipados.length) fs.appendFileSync(arquivoAcumulador(sessionId, dirTmp), tipados.map((a) => a + '\n').join(''), { mode: 0o600, flag: FLAG_ACUMULADOR });
  return tipados.length;
}
export function lerAcumulador(sessionId, dirTmp = os.tmpdir()) {
  try {
    return [...new Set(fs.readFileSync(arquivoAcumulador(sessionId, dirTmp), 'utf8').split('\n').filter(Boolean))];
  } catch { return []; }
}
