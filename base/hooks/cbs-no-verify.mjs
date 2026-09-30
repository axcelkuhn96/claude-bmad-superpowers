#!/usr/bin/env node
// cbs-no-verify.mjs — PreToolUse (Bash): bloqueia bypass de hooks git (--no-verify, commit/am -n, -c core.hooksPath=…).
// A flag só conta na lista de argumentos da PRÓPRIA invocação do git (mesmo comando simples: `;`, `&&`, `||`, `|`, `&`,
// quebra de linha, subshell e $( ) separam), com git em qualquer posição (sudo, env, nice, timeout, xargs, find -exec…).
// --no-verify (ou prefixo) conta em commit/push/merge/rebase/am/cherry-pick; -n (inclusive agrupado) só em commit/am.
// Dado nunca conta: corpo de heredoc, argumento de echo/printf/grep/rg/gh, valor de -m/-F, comentário.
// Fail-closed onde o texto vira comando: sh -c / eval / su -c / ssh '…' / rebase -x '…' (palavra com git + flag é
// analisada como script), heredoc lido por shell (`bash <<EOF`, `cat <<EOF | sh`) e $( ) em heredoc sem aspas.
// Incerto (aspa ou heredoc sem fechar, $'…', comando > 64 KB, aninhamento ou custo demais) → texto cru EM ORDEM:
// flag só depois de `git` (e -n só depois de git … commit/am). Escape: CBS_HOOKS_DESLIGADOS=no-verify.
// Adaptado de affaan-m/ECC @ e482e57, scripts/hooks/block-no-verify.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import { hookDesligado, lerStdin, lerPayload, comandoBash, ehEntrada, avisar } from './cbs-comum.mjs';

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

// --- CBS: flag de bypass só na lista de argumentos do próprio git ---

const MAX_COMMAND = 64 * 1024;
const MAX_NESTING = 3;
const MAX_WORK = 200_000;  // palavras visitadas por chamada do hook; estourou → texto cru em ordem
const LITERAL = 0;
const CODE = 1;
const COMMENT = 2;
const EXPANSION = 3;  // `$` dentro de aspas duplas: expande antes do comando ver o texto
const BODY = 4;       // corpo (e linha terminadora) de heredoc: dado

// Subcomandos em que -n é --no-verify (nos outros é --dry-run, --no-commit, --no-stat…).
const SHORT_N_SUBCOMMANDS = new Set(['commit', 'am']);
// Comandos cujos argumentos são só dado (não executam nada).
const DATA_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'gh']);
// Palavras reservadas antes do comando de verdade.
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', 'time']);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix']);
const MESSAGE_OPTIONS = new Set(['-m', '--message', '-F', '--file']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Executam o stdin como script (corpo de heredoc que chega neles é código, não dado).
const STDIN_RUNNERS = new Set([...SHELLS, 'mksh', 'ash', 'tcsh', 'csh', 'ssh']);
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const ESTOURO = Symbol('orçamento de análise');

const isGitWord = (w) => /(^|\/)git(\.exe)?$/i.test(w);
const baseName = (w) => w.split('/').pop();

// Palavras do texto cru: corta em qualquer metacaractere (mesmo entre aspas) e tira aspas, \, $ e variáveis —
// superconjunto de toda palavra que o shell poderia montar. `X=valor` também rende `valor` (pode virar comando: $X).
function rawWords(text) {
  return text.split(/[\s;&|()`<>{},]+/)
    .map(w => w.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9#?!@*$-]/g, '').replace(/[\\"'$]/g, ''))
    .flatMap(w => (/^[A-Za-z_]\w*=./.test(w) ? [w, w.replace(/^[A-Za-z_]\w*=/, '')] : [w]))
    .filter(Boolean);
}

/**
 * Pré-filtro: `git` + flag de bypass em qualquer lugar do texto cru (-n só se há commit/am). Sem isso, libera.
 */
function mayBypass(text) {
  const words = rawWords(text);
  if (!words.some(isGitWord)) return false;
  const nCounts = words.some(w => SHORT_N_SUBCOMMANDS.has(w));
  return words.some(w => w.toLowerCase().includes(GIT_CONFIG_KEY_PREFIX) || isNoVerifyLongFlag(w) ||
    (nCounts && isCommitNoVerifyShortFlag(w)));
}

/**
 * Texto cru em ordem (análise incerta): a flag só conta depois de `git`; -n só depois de git … commit/am.
 */
function rawBypass(text) {
  let git = false;
  let command = null;
  let nCounts = false;
  for (const w of rawWords(text)) {
    if (isGitWord(w)) { git = true; continue; }
    if (!git) continue;
    if (GIT_COMMANDS_WITH_NO_VERIFY.includes(w)) { command = w; nCounts ||= SHORT_N_SUBCOMMANDS.has(w); continue; }
    const hooksPath = w.toLowerCase().includes(GIT_CONFIG_KEY_PREFIX);
    if (hooksPath || isNoVerifyLongFlag(w) || (nCounts && isCommitNoVerifyShortFlag(w))) return { hooksPath, command };
  }
  return null;
}

const uncertainRaw = (text, why) => { const r = rawBypass(text); return r && { ...r, uncertain: why }; };

/**
 * Classifica cada posição: CODE (sintaxe do shell), LITERAL (entre aspas ou escapado), COMMENT, EXPANSION, BODY.
 * Devolve { kind, heredocs } ou null quando a análise é incerta: $'…' ou aspa / substituição / heredoc sem fechar.
 */
function scanShell(input) {
  const kind = new Uint8Array(input.length);
  const heredocs = [];
  return scanRange(input, kind, heredocs, 0, input.length, 0) ? { kind, heredocs } : null;
}

// bodyLevel > 0: corpo de heredoc com delimitador sem aspas (dentro de $( ) de outro corpo, nível 2…) — o texto é
// dado, mas $( ) e crase executam. Aninhamento além de MAX_NESTING é incerto.
function scanRange(input, kind, heredocs, from, to, bodyLevel) {
  if (bodyLevel > MAX_NESTING) return false;
  const stack = bodyLevel ? ['H'] : [];
  const pending = [];
  for (let i = from; i < to; i++) {
    const c = input[i];
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (c === "'") { stack.pop(); kind[i] = CODE; }
      continue;
    }
    if (top === '"' || top === 'H') {
      if (top === 'H') kind[i] = BODY;
      if (c === '\\') {
        if (top === '"' && '"\\$`\n'.includes(input[i + 1] ?? '')) kind[i] = CODE;
        i++;
        if (top === 'H' && i < to) kind[i] = BODY;
        continue;
      }
      if (c === '"' && top === '"') { stack.pop(); kind[i] = CODE; continue; }
      if (c === '$' && input[i + 1] === '(') { kind[i] = kind[i + 1] = CODE; i++; stack.push('$('); continue; }
      if (c === '$') { if (top === '"') kind[i] = EXPANSION; continue; }
      if (c === '`') { kind[i] = CODE; stack.push('`'); }
      continue;
    }
    kind[i] = CODE;
    if (c === '\\') { i++; continue; }
    if (c === '\n' && pending.length) {
      const end = readBodies(input, kind, heredocs, i + 1, to, pending, bodyLevel + 1);
      if (end < 0) return false;
      pending.length = 0;
      i = end - 1;
      continue;
    }
    if (c === '$' && input[i + 1] === "'") return false;
    if (c === '<' && input[i + 1] === '<' && input[i + 2] !== '<' && input[i - 1] !== '<') {
      const h = heredocOperator(input, i, to);
      if (!h) return false;
      heredocs.push(h);
      pending.push(h);
      kind[i + 1] = CODE;
      i++;
      continue;
    }
    if (c === "'" || c === '"') { stack.push(c); continue; }
    if (c === '#' && (i === 0 || (kind[i - 1] === CODE && /[\s;&|()`]/.test(input[i - 1])))) {
      for (; i < to && input[i] !== '\n'; i++) kind[i] = COMMENT;
      i--;
      continue;
    }
    if (c === '$' && input[i + 1] === '(') { kind[i + 1] = CODE; i++; stack.push('$('); continue; }
    if (c === '(') { stack.push('('); continue; }
    if (c === ')') { if (top === '$(' || top === '(') stack.pop(); continue; }
    if (c === '`') { if (top === '`') stack.pop(); else stack.push('`'); }
  }
  return stack.length === (bodyLevel ? 1 : 0) && !pending.length;
}

// `<<` / `<<-` + delimitador. Aspas ou \ em qualquer parte do delimitador = corpo literal (sem $( ) nem crase).
function heredocOperator(input, i, to) {
  let j = i + 2;
  const dash = input[j] === '-';
  if (dash) j++;
  while (j < to && (input[j] === ' ' || input[j] === '\t')) j++;
  let delim = '';
  let quoted = false;
  while (j < to && !/[\s;&|<>()]/.test(input[j])) {
    const c = input[j];
    if (c === "'" || c === '"') {
      const close = input.indexOf(c, j + 1);
      if (close < 0 || close >= to) return null;
      delim += input.slice(j + 1, close);
      quoted = true;
      j = close + 1;
    } else if (c === '\\') {
      if (j + 1 >= to) return null;
      delim += input[j + 1];
      quoted = true;
      j += 2;
    } else {
      delim += c;
      j++;
    }
  }
  return delim ? { op: i, delimEnd: j, delim, dash, quoted, body: null } : null;
}

// Corpos dos heredocs pendentes, em sequência, a partir da linha seguinte ao operador. Devolve a posição da quebra
// de linha depois do último terminador (ou `to`); -1 se algum não fecha.
function readBodies(input, kind, heredocs, from, to, pending, bodyLevel) {
  let p = from;
  let end = to;
  for (const h of pending) {
    let q = p;
    let e;
    for (;;) {
      if (q > to) return -1;
      e = input.indexOf('\n', q);
      if (e < 0 || e > to) e = to;
      const line = input.slice(q, e);
      if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break;
      if (e >= to) return -1;
      q = e + 1;
    }
    h.body = [p, q];
    if (h.quoted) kind.fill(BODY, p, q);
    else if (!scanRange(input, kind, heredocs, p, q, bodyLevel)) return -1;
    kind.fill(BODY, q, e);
    if (e < to) kind[e] = BODY;
    end = e;
    p = e + 1;
  }
  return end;
}

/**
 * Comandos simples do input: { words, heredocs }. Cada palavra: { start, end, value (sem aspas), target (alvo de
 * redirecionamento), subst (contém $( ) / crase), expands (contém $var) }. $( ), ( ) e crase abrem um contexto
 * próprio; a palavra de fora que contém a substituição continua depois dela. Corpo de heredoc não vira palavra.
 */
function simpleCommands(input, { kind, heredocs }) {
  const commands = [];
  const stack = [];
  const operators = new Map(heredocs.map(h => [h.op, h]));
  const context = (opener) => ({ opener, words: [], word: null, redirectNext: false, heredocs: [] });
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
  const endCommand = () => {
    endWord();
    if (ctx.words.length || ctx.heredocs.length) commands.push({ words: ctx.words, heredocs: ctx.heredocs });
    ctx.words = [];
    ctx.heredocs = [];
  };
  const open = (opener) => { stack.push(ctx); ctx = context(opener); };
  const close = (i) => {
    endCommand();
    ctx = stack.pop();
    if (ctx.word) ctx.word.end = i + 1;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (kind[i] === COMMENT || kind[i] === BODY) { endCommand(); continue; }
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
    const heredoc = operators.get(i);
    if (heredoc) {
      endWord();
      ctx.heredocs.push(heredoc);
      i = heredoc.delimEnd - 1;
      continue;
    }
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
    if (c === '$' && input[i + 1] === '"') continue;       // $"…" (locale) é aspa dupla
    w.value += c;
    if (c === '$') w.expands = true;
  }
  endCommand();
  return commands;
}

// Expansão de chaves ({a,b}) só o bastante para achar a flag em `git push {--no-verify,}`; no máximo 64 variantes.
function braceVariants(value, out = [], left = { n: 64 }) {
  let open = -1;
  let comma = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '{') { open = i; comma = -1; } else if (c === ',' && open >= 0) comma = i;
    else if (c === '}' && open >= 0 && comma > open) {
      if (--left.n < 0) break;
      for (const alt of value.slice(open + 1, i).split(',')) braceVariants(value.slice(0, open) + alt + value.slice(i + 1), out, left);
      return out;
    }
  }
  out.push(value);
  return out;
}

/**
 * Argumentos de uma invocação do git (a partir de `start`, logo depois da palavra git). Marca em `data` os valores de
 * mensagem (-m/-F…). Bypass: core.hooksPath= nas opções globais; --no-verify (ou prefixo) em commit/push/merge/rebase/
 * am/cherry-pick; -n (inclusive agrupado) em commit/am. Subcomando que expande ($SUB) vale como qualquer um deles.
 */
function gitBypass(args, start, data, work) {
  let i = start;
  let hooksPath = false;
  for (; i < args.length && args[i].value.startsWith('-'); i++) {
    if (--work.left < 0) throw ESTOURO;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(args[i].value)) i++;
    if (args[i]?.value.toLowerCase().includes(GIT_CONFIG_KEY_PREFIX)) hooksPath = true;
  }
  const subWord = args[i];
  const sub = subWord?.value;
  const command = GIT_COMMANDS_WITH_NO_VERIFY.includes(sub) ? sub : null;
  if (hooksPath) return { hooksPath: true, command };
  const unknown = Boolean(subWord && (subWord.subst || subWord.expands));
  const nCounts = SHORT_N_SUBCOMMANDS.has(sub) || unknown;
  for (let j = i + 1; j < args.length; j++) {
    if (--work.left < 0) throw ESTOURO;
    const value = args[j].value;
    if ((command || unknown) && (value.includes('{') ? braceVariants(value) : [value])
      .some(v => isNoVerifyLongFlag(v) || (nCounts && isCommitNoVerifyShortFlag(v)))) {
      return { hooksPath: false, command };
    }
    if (sub === 'commit') {
      if (commitOptionConsumesNextValue(value)) { if (j + 1 < args.length) data.add(args[++j]); }
      else if (commitOptionContainsInlineValue(value)) data.add(args[j]);
    } else if (MESSAGE_OPTIONS.has(value)) {
      if (j + 1 < args.length) data.add(args[++j]);
    } else if (/^--(message|file)=|^-[a-zA-Z]*[mF][\s\S]/.test(value)) data.add(args[j]);
  }
  return null;
}

// Índice do script de `sh -c SCRIPT [args…]` (ou -1).
function shellScriptIndex(args, from) {
  let hasC = false;
  for (let j = from; j < args.length; j++) {
    const value = args[j].value;
    if (SHELL_OPTIONS_WITH_VALUE.has(value)) { j++; continue; }
    if (/^[-+]/.test(value)) { if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(value)) hasC = true; continue; }
    return hasC ? j : -1;
  }
  return -1;
}

// Shell que lê o script do stdin (`| sh`, `bash -s`, `sudo bash`), ou ssh: corpo de heredoc vira código.
function readsStdinScript(args) {
  const j = args.findIndex(w => STDIN_RUNNERS.has(baseName(w.value)));
  if (j < 0) return false;
  if (baseName(args[j].value) === 'ssh') return true;
  const rest = args.slice(j + 1);
  return rest.some(w => w.value === '-s') || rest.every(w => /^[-+]/.test(w.value) && !/^-[a-zA-Z]*c/.test(w.value));
}

function nested(text, depth, work) {
  if (depth >= MAX_NESTING) return uncertainRaw(text, 'sh -c / eval aninhado demais');
  return analyze(text, depth + 1, work);
}

const withAssigned = (env, text, why) =>
  uncertainRaw(`${env.assigned} ${text}`, why) ?? uncertainRaw(`${text} ${env.assigned}`, why);

// env: { input, depth, work, stdinScript (algum comando executa o stdin), assigned (valores de X=… do input) }.
function checkCommand({ words, heredocs }, env) {
  const { input, depth, work } = env;
  const args = words.filter(w => !w.target);
  let k = 0;
  while (k < args.length && (KEYWORDS.has(args[k].value) || /^[A-Za-z_]\w*=/.test(args[k].value))) k++;
  const cmd = args[k];
  const name = cmd ? baseName(cmd.value) : '';
  if (cmd && DATA_COMMANDS.has(name)) return null;
  const data = new Set();
  let r = null;
  // git em qualquer posição (sudo, env, nice, timeout, xargs, find -exec…); comando que expande ($GIT) também.
  for (let j = k; j < args.length && !r; j++) {
    const w = args[j];
    if ((isGitWord(w.value) && !w.subst) || (j === k && (w.subst || w.expands))) r = gitBypass(args, j + 1, data, work);
  }
  if (r) return r;
  // sh -c / eval com $var ou $( ): o texto só existe em tempo de execução — vale o texto cru em ordem do script junto
  // com os valores atribuídos no próprio input (X='; git push', F=-n); args posicionais ("$@") entram no script.
  const shell = args.findIndex((w, j) => j >= k && SHELLS.has(baseName(w.value)));
  const script = shell < 0 ? -1 : shellScriptIndex(args, shell + 1);
  if (script >= 0) {
    const text = args.slice(script).map(w => w.value).join(' ');
    if (args[script].subst || args[script].expands) r = withAssigned(env, text, 'sh -c com variável ou substituição');
    else if (script + 1 < args.length) r = rawBypass(text);
    if (r) return r;
  }
  if (name === 'eval') {
    const rest = args.slice(k + 1);
    const text = rest.map(w => w.value).join(' ');
    r = rest.some(w => w.subst || w.expands)
      ? withAssigned(env, text, 'eval com variável ou substituição')
      : nested(text, depth, work);
    if (r) return r;
  }
  // Palavra que contém um comando git com flag (sh -c '…', su -c '…', ssh h '…', rebase -x '…', <<< '…'): é script.
  for (const w of words) {
    if (data.has(w)) continue;
    const text = w.value.replace(/^[A-Za-z_]\w*=/, '');
    if (mayBypass(text) && (r = nested(text, depth, work))) return r;
  }
  if (env.stdinScript) {
    for (const h of heredocs) if ((r = nested(input.slice(h.body[0], h.body[1]), depth, work))) return r;
  }
  return null;
}

/**
 * null = libera; senão { hooksPath, command, uncertain? } = bloqueia.
 */
function analyze(input, depth = 0, work = { left: MAX_WORK }) {
  if (!mayBypass(input)) return null;
  if (input.length > MAX_COMMAND) return uncertainRaw(input, 'comando acima de 64 KB');
  const scan = scanShell(input);
  if (!scan) return uncertainRaw(input, "aspa ou heredoc sem fechar, $'…'");
  try {
    const commands = simpleCommands(input, scan);
    const env = {
      input, depth, work,
      stdinScript: commands.some(c => readsStdinScript(c.words.filter(w => !w.target))),
      assigned: commands.flatMap(c => c.words).filter(w => /^[A-Za-z_]\w*=/.test(w.value))
        .map(w => w.value.replace(/^[A-Za-z_]\w*=/, '')).join(' '),
    };
    for (const c of commands) {
      const r = checkCommand(c, env);
      if (r) return r;
    }
    return null;
  } catch (e) {
    if (e !== ESTOURO || depth > 0) throw e;
    return uncertainRaw(input, 'comando grande demais para analisar');
  }
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
