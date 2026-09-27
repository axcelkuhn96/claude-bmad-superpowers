#!/usr/bin/env node
// cbs-no-verify.js — PreToolUse (Bash): bloqueia bypass de hooks git (--no-verify, commit -n, -c core.hooksPath=…)
// em commit/push/merge/cherry-pick/rebase/am — inclusive dentro de ( ), $( ), crase, sh -c e eval — sem falso
// positivo quando o texto está em string (echo, grep, mensagem de commit/tag/PR) ou em comentário.
// Adaptado de affaan-m/ECC @ e482e57, scripts/hooks/block-no-verify.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import { hookDesligado, lerStdin, lerPayload, comandoBash, ehEntrada, avisar } from './cbs-comum.js';

// --- Adaptado do ECC (block-no-verify.js:21-511); nomes internos em inglês como na fonte. ---
// Desvios do ECC (review da Task 4): scanShell (aspas, comentário só em início de palavra, ( ) $( ) e crase);
// findCommandSegmentEnd/findGit/detectGitCommand/checkCommand reescritos sobre ele (isInComment virou o COMMENT dele);
// subcomando achado por tokenizeShellWords (aspas no gap); scripts de sh -c / eval checados por recursão.

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

/**
 * Characters that can appear immediately before 'git' in a command string.
 */
const VALID_BEFORE_GIT = ' \t\n\r;&|$`(<{!"\']/.~\\';

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

function tokenizeShellWords(input, start = 0, end = input.length) {
  const tokens = [];
  let value = '';
  let tokenStart = null;
  let quote = null;
  let escaped = false;

  function beginToken(index) {
    if (tokenStart === null) {
      tokenStart = index;
    }
  }

  function pushToken(index) {
    if (tokenStart === null) {
      return;
    }

    tokens.push({
      value,
      start: tokenStart,
      end: index,
    });
    value = '';
    tokenStart = null;
  }

  for (let i = start; i < end; i++) {
    const char = input.charAt(i);

    if (escaped) {
      beginToken(i - 1);
      value += char;
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (quote === '"' && char === '\\') {
        beginToken(i);
        escaped = true;
        continue;
      }

      beginToken(i);
      value += char;
      continue;
    }

    if (char === '"' || char === "'") {
      beginToken(i);
      quote = char;
      continue;
    }

    if (char === '\\') {
      beginToken(i);
      escaped = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken(i);
      continue;
    }

    beginToken(i);
    value += char;
  }

  if (escaped) {
    value += '\\';
  }
  pushToken(end);

  return tokens;
}

const LITERAL = 0;
const CODE = 1;
const COMMENT = 2;
let lastScan = null;

/**
 * Classifica cada posição do comando: CODE (sintaxe do shell), LITERAL (dentro de aspas ou escapado)
 * ou COMMENT; `depth` conta ( ), $( ) e crases abertos; `end` marca separadores (; | & \n), o fechamento
 * de ( ) / $( ) / crase e o início de comentário (`#` só conta fora de aspas e em início de palavra).
 */
function scanShell(input) {
  if (lastScan && lastScan.input === input) return lastScan;
  const n = input.length;
  const kind = new Uint8Array(n);
  const depth = new Uint32Array(n);
  const end = new Uint8Array(n);
  const stack = [];
  let codeDepth = 0;
  const literalNext = (i) => { if (i < n) { kind[i] = LITERAL; depth[i] = codeDepth; } };

  for (let i = 0; i < n; i++) {
    const char = input.charAt(i);
    const top = stack[stack.length - 1];
    depth[i] = codeDepth;

    if (top === "'") {
      if (char === "'") { stack.pop(); kind[i] = CODE; } else { kind[i] = LITERAL; }
      continue;
    }

    if (top === '"') {
      kind[i] = LITERAL;
      if (char === '\\') { literalNext(i + 1); i++; continue; }
      if (char === '"') { stack.pop(); kind[i] = CODE; continue; }
      if (char === '$' && input.charAt(i + 1) === '(') {
        kind[i] = CODE; kind[i + 1] = CODE; depth[i + 1] = codeDepth; i++;
        stack.push('$('); codeDepth++;
        continue;
      }
      if (char === '`') { kind[i] = CODE; stack.push('`'); codeDepth++; }
      continue;
    }

    kind[i] = CODE;
    if (char === '\\') { literalNext(i + 1); i++; continue; }
    if (char === "'" || char === '"') { stack.push(char); continue; }
    if (char === '#' && (i === 0 || (kind[i - 1] === CODE && /[\s;&|()]/.test(input.charAt(i - 1))))) {
      end[i] = 1;
      for (; i < n && input.charAt(i) !== '\n'; i++) { kind[i] = COMMENT; depth[i] = codeDepth; }
      i--;
      continue;
    }
    if (char === '$' && input.charAt(i + 1) === '(') {
      kind[i + 1] = CODE; depth[i + 1] = codeDepth; i++;
      stack.push('$('); codeDepth++;
      continue;
    }
    if (char === '(') { stack.push('('); codeDepth++; continue; }
    if (char === ')') {
      end[i] = 1;
      if (top === '$(' || top === '(') { stack.pop(); codeDepth--; }
      continue;
    }
    if (char === '`') {
      if (top === '`') { end[i] = 1; stack.pop(); codeDepth--; } else { stack.push('`'); codeDepth++; }
      continue;
    }
    // `2>&1`, `&>arq` e `>|arq` são redirecionamento, não separador.
    if (char === '&' && (/[<>]/.test(input.charAt(i - 1)) || input.charAt(i + 1) === '>')) continue;
    if (char === '|' && input.charAt(i - 1) === '>') continue;
    if (char === ';' || char === '|' || char === '&' || char === '\n') end[i] = 1;
  }

  // segEnd[i]: próximo fim de segmento no mesmo nível de i (todo nível fecha com um `end` nele), em O(n).
  const segEnd = new Uint32Array(n);
  const nextEndAt = [];
  for (let i = n - 1; i >= 0; i--) {
    if (end[i]) nextEndAt[depth[i]] = i;
    segEnd[i] = nextEndAt[depth[i]] ?? n;
  }

  lastScan = { input, kind, depth, end, segEnd };
  return lastScan;
}

function findCommandSegmentEnd(input, start) {
  if (start >= input.length) return input.length;
  return scanShell(input).segEnd[start];
}

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
 * Find the next 'git' token in the input starting from a position.
 * Só conta `git` em contexto de código (fora de aspas e de comentário) ou a palavra inteira entre
 * aspas (`"git" push`); `len` inclui a aspa de fechamento nesse caso.
 */
function findGit(input, start) {
  const { kind } = scanShell(input);
  let pos = start;
  while (pos < input.length) {
    const idx = input.indexOf('git', pos);
    if (idx === -1) return null;
    pos = idx + 1;

    const isExe = input.slice(idx + 3, idx + 7).toLowerCase() === '.exe';
    const len = isExe ? 7 : 3;
    const after = input[idx + len] || ' ';
    if (!/[\s"']/.test(after)) continue;

    const before = idx > 0 ? input[idx - 1] : ' ';
    if (!VALID_BEFORE_GIT.includes(before)) continue;

    if (kind[idx] === CODE) return { idx, len };
    const wholeQuoted = kind[idx] === LITERAL && (before === '"' || before === "'") &&
      kind[idx - 1] === CODE && after === before && kind[idx + len] === CODE;
    if (wholeQuoted) return { idx, len: len + 1 };
  }
  return null;
}

// Opções globais do git que consomem o próximo token (git -C dir, git -c chave=valor…).
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix']);

/**
 * Primeira palavra depois de git que não é opção global (nem valor dela). Tokeniza numa janela que dobra
 * até achar a palavra inteira, pra não retokenizar o segmento todo a cada `git` (custo linear).
 */
function findGitSubcommand(input, start, segmentEnd) {
  for (let size = 256; ; size *= 2) {
    const windowEnd = Math.min(segmentEnd, start + size);
    let expectFlagArg = false;
    for (const t of tokenizeShellWords(input, start, windowEnd)) {
      if (t.end >= windowEnd && windowEnd < segmentEnd) break;  // token pode ter sido cortado pela janela
      if (expectFlagArg) { expectFlagArg = false; continue; }
      if (t.value.startsWith('-')) {
        if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(t.value)) expectFlagArg = true;
        continue;
      }
      return t;
    }
    if (windowEnd >= segmentEnd) return null;
  }
}

/**
 * Detect which git subcommand (commit, push, etc.) is being invoked.
 * Returns { command, offset } where offset is the position right after the
 * subcommand keyword, so callers can scope flag checks to only that portion.
 * O subcomando é a primeira palavra (com aspas resolvidas) depois de git e das opções globais.
 */
function detectGitCommand(input, start = 0) {
  while (start < input.length) {
    const git = findGit(input, start);
    if (!git) return null;

    const gitEnd = git.idx + git.len;
    const sub = findGitSubcommand(input, gitEnd, findCommandSegmentEnd(input, gitEnd));

    if (sub && GIT_COMMANDS_WITH_NO_VERIFY.includes(sub.value)) {
      return {
        command: sub.value,
        offset: sub.end,
        gitStart: git.idx,
        gitEnd,
        commandStart: sub.start,
      };
    }

    start = gitEnd;
  }
  return null;
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

/**
 * Check if the input contains a --no-verify flag for a specific git command.
 * Only inspects the portion of the input starting at `offset` (the position
 * right after the detected subcommand keyword) so that flags belonging to
 * earlier commands in a chain are not falsely matched.
 */
function hasNoVerifyFlag(input, command, offset) {
  const segmentEnd = findCommandSegmentEnd(input, offset);
  const tokens = tokenizeShellWords(input, offset, segmentEnd);
  let skipNext = false;

  for (const token of tokens) {
    const value = token.value;

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (value === '--') {
      break;
    }

    if (command === 'commit') {
      if (commitOptionConsumesNextValue(value)) {
        skipNext = true;
        continue;
      }

      if (commitOptionContainsInlineValue(value)) {
        continue;
      }
    }

    if (isNoVerifyLongFlag(value)) return true;

    // For commit, -n is shorthand for --no-verify.
    if (command === 'commit' && isCommitNoVerifyShortFlag(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the input contains a -c core.hooksPath= override.
 */
function hasHooksPathOverride(input, detected) {
  const tokens = tokenizeShellWords(input, detected.gitEnd, detected.commandStart);

  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    // Git config section + variable names are case-insensitive, so a
    // bypass attempt like `core.HOOKSPATH=...` or `core.hookspath=...`
    // must compare against the lowercased token.
    const lowered = value.toLowerCase();

    if (value === '-c') {
      const next = tokens[i + 1] && tokens[i + 1].value;
      if (typeof next === 'string' && next.toLowerCase().startsWith(GIT_CONFIG_KEY_PREFIX)) {
        return true;
      }
      i++;
      continue;
    }

    if (lowered.startsWith(`-c${GIT_CONFIG_KEY_PREFIX}`)) {
      return true;
    }
  }

  return false;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const MAX_NESTING = 3;

/**
 * Scripts passados a `sh|bash|… -c` e a `eval`: rodam como comando, então são checados por recursão.
 */
function nestedShellScripts(input) {
  const { kind } = scanShell(input);
  const tokens = tokenizeShellWords(input).filter(t => kind[t.start] === CODE);
  const scripts = [];
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i].value.split(/[/;&|(`]/).pop();
    if (name === 'eval') {
      const words = tokenizeShellWords(input, tokens[i].end, findCommandSegmentEnd(input, tokens[i].end));
      scripts.push(words.map(t => t.value).join(' '));
      continue;
    }
    if (!SHELLS.has(name)) continue;
    let hasC = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const value = tokens[j].value;
      if (value === '-o' || value === '+o') { j++; continue; }
      if (value.startsWith('-')) { if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(value)) hasC = true; continue; }
      if (hasC) scripts.push(value);
      break;
    }
  }
  return scripts;
}

/**
 * Check a command string for git hook bypass attempts.
 */
function checkCommand(input, nesting = 0) {
  let start = 0;
  // Segmentos já checados: um git no mesmo nível dentro deles é argumento (git push origin git), não comando.
  let checked = [];

  while (start < input.length) {
    const detected = detectGitCommand(input, start);
    if (!detected) break;

    const { command: gitCommand, offset } = detected;
    const level = scanShell(input).depth[detected.gitStart];
    checked = checked.filter(seg => seg.until > detected.gitStart);
    if (checked.some(seg => seg.level === level)) {
      start = offset;
      continue;
    }

    if (hasHooksPathOverride(input, detected)) {
      return {
        blocked: true,
        reason: `BLOCKED: Overriding core.hooksPath is not allowed with git ${gitCommand}. Git hooks must not be bypassed.`,
      };
    }

    if (hasNoVerifyFlag(input, gitCommand, offset)) {
      return {
        blocked: true,
        reason: `BLOCKED: --no-verify flag is not allowed with git ${gitCommand}. Git hooks must not be bypassed.`,
      };
    }

    // Continua logo após o subcomando: um git dentro de $( ) no próprio argumento também roda.
    checked.push({ level, until: findCommandSegmentEnd(input, offset) });
    start = offset;
  }

  if (nesting < MAX_NESTING) {
    for (const script of nestedShellScripts(input)) {
      const r = checkCommand(script, nesting + 1);
      if (r.blocked) return r;
    }
  }

  return { blocked: false };
}

// --- CBS ---

export function checarComando(comando) {
  if (typeof comando !== 'string' || !/\bgit\b/.test(comando)) return { bloquear: false };  // caminho rápido
  const r = checkCommand(comando);
  if (!r.blocked) return { bloquear: false };
  const sub = (r.reason.match(/git ([a-z-]+)/) || [])[1] || 'git';
  const tipo = /hooksPath/i.test(r.reason) ? 'sobrescrever core.hooksPath' : 'usar --no-verify / -n';
  return { bloquear: true, motivo: `CBS: bloqueado — não é permitido ${tipo} em git ${sub}. Os hooks git do projeto não podem ser pulados; corrija o que o hook reprovou.` };
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
