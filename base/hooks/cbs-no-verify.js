#!/usr/bin/env node
// cbs-no-verify.js — PreToolUse (Bash): bloqueia bypass de hooks git (--no-verify, commit/am -n, -c core.hooksPath=…).
// Fail-closed por construção: o gatilho é o TEXTO CRU — palavra `git` + flag de bypass (--no-verify ou prefixo,
// core.hooksPath=, ou -n agrupado quando há commit/am) → BLOQUEIA. O parser só REBAIXA para liberar quando a análise
// é certa E cada flag está provadamente em dado: argumento de echo/printf/grep/rg/gh, valor de -m/-F em commit/tag/merge,
// comentário, -n de comando onde ele não é --no-verify (head, git log…), ou script de sh -c/eval que, analisado
// sozinho, libera. Bug de parser vira falso positivo, nunca falso negativo.
// Incerto (heredoc, $'…', aspa sem fechar, comando > 64 KB, sh -c aninhado demais) → vale o texto cru. Trade-off
// aceito: heredoc cujo texto contém "--no-verify" bloqueia — escape: CBS_HOOKS_DESLIGADOS=no-verify.
// Adaptado de affaan-m/ECC @ e482e57, scripts/hooks/block-no-verify.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import { hookDesligado, lerStdin, lerPayload, comandoBash, ehEntrada, avisar } from './cbs-comum.js';

// --- Do ECC (block-no-verify.js:21-31, 38-84, 210-275, 396-404), sem mudança: subcomandos, flags de bypass e
// opções de valor do git commit. O resto do ECC (scanner por string) foi substituído pela lógica fail-closed abaixo. ---

/**
 * Git commands that support the --no-verify flag.
 */
const GIT_COMMANDS_WITH_NO_VERIFY = [
  'commit',
  'push',
  'merge',
  'cherry-pick',
  'rebase',
  'am',
];

// Git config section and variable names are case-insensitive
// (subsection names are case-sensitive but core.hooksPath has none),
// so we normalize the candidate token to lowercase before matching.
// See https://git-scm.com/docs/git-config — "The variable names are
// case-insensitive."
const GIT_CONFIG_KEY_PREFIX = 'core.hookspath=';

const COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-C',
  '--reuse-message',
  '-c',
  '--reedit-message',
  '--author',
  '--date',
  '--template',
  '--fixup',
  '--squash',
  '--pathspec-from-file',
]);

const COMMIT_OPTIONS_WITH_INLINE_VALUE = [
  '--message=',
  '--file=',
  '--reuse-message=',
  '--reedit-message=',
  '--author=',
  '--date=',
  '--template=',
  '--fixup=',
  '--squash=',
  '--pathspec-from-file=',
];

// Short options that take a value. When seen as part of a combined
// short-option token (e.g. -tn), git's parser treats the rest of the
// token as the option's value (template path 'n' here), so the scanner
// must stop at this character — anything after it is the inline value,
// not another flag.
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
// Short options whose value is OPTIONAL and must be stuck to the flag
// (`-uno`, `-S<keyid>`). The rest of the cluster is that value, so an `n`
// after them is not the -n flag: `git commit -uno` means --untracked-files=no.
const COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE = new Set(['u', 'S']);

function commitOptionConsumesNextValue(value) {
  if (isCommitNoVerifyShortFlag(value)) {
    return false;
  }

  if (COMMIT_OPTIONS_WITH_VALUE.has(value)) {
    return true;
  }

  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.consumesNextValue);
}

function commitOptionContainsInlineValue(value) {
  if (isCommitNoVerifyShortFlag(value)) {
    return false;
  }

  if (COMMIT_OPTIONS_WITH_INLINE_VALUE.some(prefix => value.startsWith(prefix))) {
    return true;
  }

  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.containsInlineValue);
}

function getCommitShortValueOption(value) {
  if (!value.startsWith('-') || value.startsWith('--') || value === '-') {
    return null;
  }

  const options = value.slice(1);
  for (let i = 0; i < options.length; i++) {
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(options.charAt(i))) {
      return {
        consumesNextValue: i === options.length - 1,
        containsInlineValue: i < options.length - 1,
      };
    }
  }

  return null;
}

function isCommitNoVerifyShortFlag(value) {
  if (!value.startsWith('-') || value.startsWith('--') || value === '-') {
    return false;
  }

  // Short options cluster, so -n need not lead: `git commit -an` is -a plus -n
  // and bypasses the hooks just as `-n` does. Anchoring on the first character
  // let -an, -sn and -vn through.
  //
  // Scanning stops at a value-taking option because that option swallows the
  // rest of the cluster as its inline value — the n in `-mn` is message text,
  // not a flag.
  const options = value.slice(1);
  for (let i = 0; i < options.length; i++) {
    const option = options.charAt(i);
    if (option === 'n') return true;
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(option)) return false;
    if (COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE.has(option)) return false;
  }

  return false;
}

/**
 * git's option parser accepts any unambiguous prefix of a long option, so
 * `--no-veri` and `--no-verif` run as --no-verify. Shorter prefixes such as
 * `--no-ver` are ambiguous with --no-verbose and git rejects them itself, so
 * refusing every prefix from `--no-v` up blocks nothing that would have run.
 */
function isNoVerifyLongFlag(value) {
  return value.length >= '--no-v'.length && '--no-verify'.startsWith(value);
}

// --- CBS: fail-closed por construção ---

const MAX_COMMAND = 64 * 1024;
const MAX_NESTING = 3;
const LITERAL = 0;
const CODE = 1;
const COMMENT = 2;
const EXPANSION = 3;  // `$` dentro de aspas duplas: expande antes do comando ver o texto

// Subcomandos em que -n é --no-verify.
const SHORT_N_SUBCOMMANDS = new Set(['commit', 'am']);
// Subcomandos git em que -n é outra coisa (dry-run, no-stat, no-commit, contagem…).
const GIT_SUBCOMMANDS_N_IS_OTHER = new Set(['log', 'show', 'shortlog', 'reflog', 'rev-list', 'whatchanged', 'format-patch',
  'grep', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick', 'revert', 'clean', 'add', 'rm', 'mv', 'tag', 'diff',
  'status', 'blame']);
// Comandos cujos argumentos são só dado (não executam nada).
const DATA_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'gh']);
// Comandos em que -n é opção própria (e que não executam outro comando).
const N_IS_OTHER_COMMANDS = new Set([...DATA_COMMANDS, 'head', 'tail', 'ls', 'sort', 'uniq', 'cut', 'wc', 'nl', 'cat',
  'diff', 'sed', 'jq']);
// Palavras reservadas antes do comando de verdade.
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', 'time']);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix']);
const MESSAGE_OPTIONS = new Set(['-m', '--message', '-F', '--file']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

const isGitWord = (w) => /(^|\/)git(\.exe)?$/i.test(w);

// Palavras do texto cru: corta em qualquer metacaractere (mesmo entre aspas) e tira aspas, \, $ e variáveis —
// superconjunto de toda palavra que o shell poderia montar.
function rawWords(text) {
  return text.split(/[\s;&|()`<>{},]+/)
    .map(w => w.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9#?!@*$-]/g, '').replace(/[\\"'$]/g, ''))
    .filter(Boolean);
}

function nearestSubcommand(words, i, forwardFirst) {
  const find = (from, step) => {
    for (let j = from; j >= 0 && j < words.length; j += step) if (GIT_COMMANDS_WITH_NO_VERIFY.includes(words[j])) return words[j];
    return null;
  };
  return forwardFirst ? find(i + 1, 1) ?? find(i - 1, -1) : find(i - 1, -1) ?? find(i + 1, 1);
}

/**
 * Gatilho cru: `git` (em `context`) + flag de bypass (em `text`). -n só conta se `context` tem commit/am.
 */
function findBypass(text, context = text) {
  const contextWords = rawWords(context);
  if (!contextWords.some(isGitWord)) return null;
  const nCounts = contextWords.some(w => SHORT_N_SUBCOMMANDS.has(w));
  const words = text === context ? contextWords : rawWords(text);
  for (let i = 0; i < words.length; i++) {
    const hooksPath = words[i].toLowerCase().includes(GIT_CONFIG_KEY_PREFIX);
    if (hooksPath || isNoVerifyLongFlag(words[i]) || (nCounts && isCommitNoVerifyShortFlag(words[i]))) {
      return { hooksPath, command: nearestSubcommand(words, i, hooksPath) };
    }
  }
  return null;
}

/**
 * Classifica cada posição: CODE (sintaxe do shell), LITERAL (entre aspas ou escapado), COMMENT, EXPANSION.
 * Devolve null quando a análise é incerta: heredoc, $'…' ou aspa / substituição sem fechar.
 */
function scanShell(input) {
  const n = input.length;
  const kind = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    const c = input[i];
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (c === "'") { stack.pop(); kind[i] = CODE; }
      continue;
    }
    if (top === '"') {
      if (c === '\\') { if ('"\\$`\n'.includes(input[i + 1] ?? '')) kind[i] = CODE; i++; continue; }
      if (c === '"') { stack.pop(); kind[i] = CODE; continue; }
      if (c === '$' && input[i + 1] === '(') { kind[i] = kind[i + 1] = CODE; i++; stack.push('$('); continue; }
      if (c === '$') { kind[i] = EXPANSION; continue; }
      if (c === '`') { kind[i] = CODE; stack.push('`'); }
      continue;
    }
    kind[i] = CODE;
    if (c === '\\') { i++; continue; }
    if (c === '$' && input[i + 1] === "'") return null;
    if (c === '<' && input[i + 1] === '<' && input[i + 2] !== '<' && input[i - 1] !== '<') return null;
    if (c === "'" || c === '"') { stack.push(c); continue; }
    if (c === '#' && (i === 0 || (kind[i - 1] === CODE && /[\s;&|()`]/.test(input[i - 1])))) {
      for (; i < n && input[i] !== '\n'; i++) kind[i] = COMMENT;
      i--;
      continue;
    }
    if (c === '$' && input[i + 1] === '(') { kind[i + 1] = CODE; i++; stack.push('$('); continue; }
    if (c === '(') { stack.push('('); continue; }
    if (c === ')') { if (top === '$(' || top === '(') stack.pop(); continue; }
    if (c === '`') { if (top === '`') stack.pop(); else stack.push('`'); }
  }
  return stack.length ? null : kind;
}

/**
 * Comandos simples do input: listas de palavras { start, end, value (sem aspas), target (alvo de
 * redirecionamento), subst (contém $( ) / crase), expands (contém $var) }. $( ), ( ) e crase abrem um contexto
 * próprio; a palavra de fora que contém a substituição continua depois dela.
 */
function simpleCommands(input, kind) {
  const commands = [];
  const stack = [];
  const context = (opener) => ({ opener, words: [], word: null, redirectNext: false });
  let ctx = context(null);
  const startWord = (i) => {
    if (!ctx.word) {
      ctx.word = { start: i, end: i, value: '', target: ctx.redirectNext, subst: false, expands: false };
      ctx.redirectNext = false;
    }
    ctx.word.end = i + 1;
    return ctx.word;
  };
  const endWord = () => { if (ctx.word) { ctx.words.push(ctx.word); ctx.word = null; } };
  const endCommand = () => { endWord(); if (ctx.words.length) commands.push(ctx.words); ctx.words = []; };
  const open = (opener) => { stack.push(ctx); ctx = context(opener); };
  const close = (i) => {
    endCommand();
    ctx = stack.pop();
    if (ctx.word) ctx.word.end = i + 1;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (kind[i] === COMMENT) { endCommand(); continue; }
    if (kind[i] === LITERAL || kind[i] === EXPANSION) {
      const w = startWord(i);
      w.value += c;
      if (kind[i] === EXPANSION) w.expands = true;
      continue;
    }
    if (c === '$' && input[i + 1] === '(') { startWord(i).subst = true; i++; open('$('); continue; }
    if (c === '`') {
      if (ctx.opener === '`') close(i); else { startWord(i).subst = true; open('`'); }
      continue;
    }
    if (c === '(') { endCommand(); open('('); continue; }
    if (c === ')') {
      if (ctx.opener === '$(' || ctx.opener === '(') close(i); else endCommand();
      continue;
    }
    if (/\s/.test(c)) { if (c === '\n') endCommand(); else endWord(); continue; }
    const redirect = c === '<' || c === '>' ||
      (c === '&' && (input[i - 1] === '>' || input[i - 1] === '<' || input[i + 1] === '>')) ||
      (c === '|' && input[i - 1] === '>');
    if (redirect) {
      // `2>x`: o número colado no operador é o descritor, não argumento.
      if (ctx.word && ctx.word.end === i && /^\d+$/.test(ctx.word.value)) ctx.word.target = true;
      endWord();
      ctx.redirectNext = true;
      continue;
    }
    if (c === ';' || c === '|' || c === '&') { endCommand(); continue; }
    const w = startWord(i);
    if (c === '"' || c === "'" || c === '\\') continue;  // sintaxe de aspas: não entra no valor
    w.value += c;
    if (c === '$') w.expands = true;
  }
  endCommand();
  return commands;
}

// Opções de mensagem do git commit/tag/merge: o valor delas é dado.
function clearGitData(args, clear) {
  let i = 0;
  while (i < args.length && args[i].value.startsWith('-')) i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(args[i].value) ? 2 : 1;
  const sub = args[i]?.value;
  const rest = args.slice(i + 1);
  if (GIT_SUBCOMMANDS_N_IS_OTHER.has(sub)) rest.filter(w => isCommitNoVerifyShortFlag(w.value)).forEach(clear);
  let skipNext = false;
  for (const w of rest) {
    if (skipNext) { skipNext = false; clear(w); continue; }
    if (w.value === '--') break;
    if (sub === 'commit') {
      if (commitOptionConsumesNextValue(w.value)) skipNext = true;
      else if (commitOptionContainsInlineValue(w.value)) clear(w);
    } else if (sub === 'tag' || sub === 'merge') {
      if (MESSAGE_OPTIONS.has(w.value)) skipNext = true;
      else if (/^--(message|file)=|^-[a-zA-Z]*[mF][\s\S]/.test(w.value)) clear(w);
    }
  }
}

// Script de sh -c / eval só vira dado se não expande nada fora e, analisado sozinho, libera.
function scriptIsClean(words, depth, info) {
  if (!words.length || words.some(w => w.subst || w.expands)) return false;
  if (depth >= MAX_NESTING) { info.uncertain ??= 'sh -c / eval aninhado demais'; return false; }
  const r = analyze(words.map(w => w.value).join(' '), depth + 1);
  if (r?.uncertain) info.uncertain ??= r.uncertain;
  return !r;
}

function shellScriptWord(args) {
  let hasC = false;
  for (let j = 0; j < args.length; j++) {
    const value = args[j].value;
    if (SHELL_OPTIONS_WITH_VALUE.has(value)) { j++; continue; }
    if (/^[-+]/.test(value)) { if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(value)) hasC = true; continue; }
    return hasC ? args[j] : null;
  }
  return null;
}

/**
 * Máscara do que é dado provado (vira espaço antes da segunda passada do gatilho cru).
 */
function dataMask(input, kind, depth, info) {
  const cleared = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) if (kind[i] === COMMENT) cleared[i] = 1;
  const clear = (w) => { if (!w.subst) cleared.fill(1, w.start, w.end); };
  for (const words of simpleCommands(input, kind)) {
    const args = words.filter(w => !w.target);
    let k = 0;
    while (k < args.length && (KEYWORDS.has(args[k].value) || /^[A-Za-z_]\w*=/.test(args[k].value))) k++;
    if (k >= args.length) continue;
    const name = args[k].value.split('/').pop();
    const rest = args.slice(k + 1);
    if (DATA_COMMANDS.has(name)) rest.forEach(clear);
    else if (N_IS_OTHER_COMMANDS.has(name)) rest.filter(w => isCommitNoVerifyShortFlag(w.value)).forEach(clear);
    else if (isGitWord(args[k].value)) clearGitData(rest, clear);
    else if (SHELLS.has(name)) {
      const script = shellScriptWord(rest);
      if (script && scriptIsClean([script], depth, info)) clear(script);
    } else if (name === 'eval' && scriptIsClean(rest, depth, info)) rest.forEach(clear);
  }
  return cleared;
}

/**
 * null = libera; senão { hooksPath, command, uncertain? } = bloqueia.
 */
function analyze(input, depth = 0) {
  const hit = findBypass(input);
  if (!hit) return null;
  if (input.length > MAX_COMMAND) return { ...hit, uncertain: 'comando acima de 64 KB' };
  const kind = scanShell(input);
  if (!kind) return { ...hit, uncertain: "heredoc, $'…' ou aspa sem fechar" };
  const info = {};
  const cleared = dataMask(input, kind, depth, info);
  const leftover = input.replace(/[\s\S]/g, (c, i) => (cleared[i] ? ' ' : c));
  const r = findBypass(leftover, input);
  return r ? { ...r, uncertain: info.uncertain } : null;
}

// --- CBS ---

export function checarComando(comando) {
  if (typeof comando !== 'string') return { bloquear: false };
  const r = analyze(comando);
  if (!r) return { bloquear: false };
  const sub = r.command ? `git ${r.command}` : 'git';
  const tipo = r.hooksPath ? 'sobrescrever core.hooksPath' : 'usar --no-verify / -n';
  const extra = r.uncertain
    ? ` Análise incerta (${r.uncertain}): na dúvida o CBS bloqueia; se for falso positivo, rode com CBS_HOOKS_DESLIGADOS=no-verify.`
    : '';
  return { bloquear: true, motivo: `CBS: bloqueado — não é permitido ${tipo} em ${sub}. Os hooks git do projeto não podem ser pulados; corrija o que o hook reprovou.${extra}` };
}

function main() {
  if (hookDesligado('no-verify')) return 0;
  const payload = lerPayload(lerStdin());
  if (!payload) return 0;
  const r = checarComando(comandoBash(payload));
  if (!r.bloquear) return 0;
  process.stderr.write(r.motivo + '\n');
  return 2;
}

if (ehEntrada(import.meta.url)) {
  let code = 0;
  try { code = main(); } catch (e) { avisar(`no-verify: erro interno ignorado (${e.message})`); code = 0; }
  process.exit(code);
}
