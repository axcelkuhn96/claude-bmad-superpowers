// test/hooks.test.js — hooks CBS (base/hooks): decisões em unidade + E2E com payload JSON real.
// Casos do cbs-no-verify portados de affaan-m/ECC @ e482e57, tests/hooks/block-no-verify.test.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'base', 'hooks');
const POSIX = process.platform !== 'win32';
const tmp = (prefixo = 'cbs-hook-') => fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
// Temporário com limpeza garantida ao fim do teste.
function tmpDoTeste(t, prefixo) {
  const d = tmp(prefixo);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// Env do processo sem as chaves CBS_* (o usuário pode tê-las exportado).
function envLimpo() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CBS_')) delete env[k];
  return env;
}
// Roda o hook como o Claude Code/Codex: node absoluto, payload no stdin, HOME temporário.
function rodarHook(nome, payload, env = {}) {
  const home = tmp('cbs-home-');
  try {
    const r = spawnSync(process.execPath, [path.join(HOOKS, nome)], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8', timeout: 10_000, env: { ...envLimpo(), HOME: home, USERPROFILE: home, ...env },
    });
    // Hook travado (timeout) ou que nem subiu: falha visível em vez de congelar o npm test.
    if (r.error) throw new Error(`hook ${nome} não terminou: ${r.error.message}`);
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
function escrever(raiz, rel, conteudo = '', modo) {
  const p = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, conteudo);
  if (modo) fs.chmodSync(p, modo);
  return p;
}
const comum = await import(pathToFileURL(path.join(HOOKS, 'cbs-comum.js')).href);

describe('cbs-comum', () => {
  test('CBS_HOOKS=off desliga os quatro', () => {
    for (const n of ['format', 'typecheck', 'no-verify', 'config']) assert.equal(comum.hookDesligado(n, { CBS_HOOKS: 'off' }), true);
  });
  test('CBS_HOOKS_DESLIGADOS desliga só os listados', () => {
    const env = { CBS_HOOKS_DESLIGADOS: 'format, no-verify' };
    assert.equal(comum.hookDesligado('format', env), true);
    assert.equal(comum.hookDesligado('no-verify', env), true);
    assert.equal(comum.hookDesligado('config', env), false);
    assert.equal(comum.hookDesligado('typecheck', env), false);
  });
  test('sem env nada é desligado', () => assert.equal(comum.hookDesligado('format', {}), false));
  test('lerPayload rejeita vazio, inválido e não-objeto', () => {
    for (const t of ['', '   ', '{', '[1]', '"x"']) assert.equal(comum.lerPayload(t), null);
    assert.deepEqual(comum.lerPayload('{"a":1}'), { a: 1 });
  });
  test('limite do stdin é 16 MiB: JSON válido acima dá null, abaixo é lido', () => {
    assert.equal(comum.LIMITE_STDIN, 16 * 1024 * 1024);
    assert.equal(comum.lerPayload('{"a":"' + 'x'.repeat(comum.LIMITE_STDIN) + '"}'), null);
    const grande = 'x'.repeat(comum.LIMITE_STDIN - 16);
    assert.deepEqual(comum.lerPayload('{"a":"' + grande + '"}'), { a: grande });
  });
  test('caminhosEditados resolve file_path relativo contra cwd', () => {
    assert.deepEqual(comum.caminhosEditados({ cwd: '/p', tool_input: { file_path: 'src/a.ts' } }), [path.resolve('/p', 'src/a.ts')]);
  });
  test('caminhosEditados lê apply_patch do Codex (Add/Update/Move)', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** Update File: c.js\n*** Move to: d.js\n*** End Patch';
    const esperado = ['src/a.py', 'b.ts', 'c.js', 'd.js'].map((p) => path.resolve('/p', p)).sort();
    assert.deepEqual(comum.caminhosEditados({ cwd: '/p', tool_input: { input: patch } }).sort(), esperado);
  });
  test('caminhosEditados lê apply_patch do Codex com command em array (argv)', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** End Patch';
    assert.deepEqual(comum.caminhosEditados({ cwd: '/p', tool_input: { command: ['apply_patch', patch] } }), [path.resolve('/p', 'src/a.py')]);
  });
  test('comandoBash aceita string e array (Codex)', () => {
    assert.equal(comum.comandoBash({ tool_input: { command: 'git status' } }), 'git status');
    assert.equal(comum.comandoBash({ tool_input: { command: ['git', 'status'] } }), 'git status');
    assert.equal(comum.comandoBash({ tool_input: {} }), null);
  });
  test('caminhosEditados lê o payload real do apply_patch do Codex 0.156.1 (patch em tool_input.command, string)', () => {
    const payload = {
      session_id: 's', turn_id: 't', transcript_path: null, cwd: '/p', hook_event_name: 'PreToolUse', model: 'm',
      permission_mode: 'bypassPermissions', tool_name: 'apply_patch', tool_use_id: 'exec-1',
      tool_input: { command: '*** Begin Patch\n*** Update File: nota.txt\n@@\n-oi\n+ola\n*** End Patch' },
    };
    assert.deepEqual(comum.caminhosEditados(payload), [path.resolve('/p', 'nota.txt')]);
  });
  test('acharRaiz sobe até o marcador e para sem marcador', (t) => {
    const r = tmpDoTeste(t, 'cbs-raiz-');
    escrever(r, 'composer.json', '{}');
    fs.mkdirSync(path.join(r, 'app', 'X'), { recursive: true });
    assert.equal(comum.acharRaiz(path.join(r, 'app', 'X'), ['composer.json']), r);
    assert.equal(comum.acharRaiz(path.join(r, 'app', 'X'), ['nao-existe-cbs.marcador']), null);
  });
  test('binLocal só aceita arquivo executável', { skip: !POSIX && 'POSIX' }, (t) => {
    const r = tmpDoTeste(t);
    escrever(r, 'vendor/bin/pint', '#!/bin/sh\n', 0o755);
    escrever(r, 'vendor/bin/nao-exec', '#!/bin/sh\n', 0o644);
    assert.equal(comum.binLocal(r, 'vendor/bin/pint'), path.join(r, 'vendor/bin/pint'));
    assert.equal(comum.binLocal(r, 'vendor/bin/nao-exec'), null);
  });
  test('noPath resolve só pelo PATH do env recebido', { skip: !POSIX && 'POSIX' }, (t) => {
    const r = tmpDoTeste(t);
    const bin = escrever(r, 'bin/ferramenta-cbs', '#!/bin/sh\n', 0o755);
    assert.equal(comum.noPath('ferramenta-cbs', { PATH: path.join(r, 'bin') }), bin);
    assert.equal(comum.noPath('ferramenta-cbs', { PATH: '' }), null);
  });
  test('lerTexto devolve o conteúdo ou vazio quando não dá pra ler', (t) => {
    const r = tmpDoTeste(t);
    assert.equal(comum.lerTexto(escrever(r, 'a.txt', 'olá')), 'olá');
    assert.equal(comum.lerTexto(path.join(r, 'nao-existe.txt')), '');
  });
  test('ehEntrada é falso quando o módulo é importado', () => {
    assert.equal(comum.ehEntrada(pathToFileURL(path.join(HOOKS, 'cbs-comum.js')).href), false);
  });
});

const noVerify = await import(pathToFileURL(path.join(HOOKS, 'cbs-no-verify.js')).href);
describe('cbs-no-verify', () => {
  const BLOQUEIA = [
    'git commit --no-verify -m "msg"',
    'git commit -n -m "msg"',
    'git -c core.hooksPath=/dev/null commit -m "msg"',
    'git -c "core.hooksPath=/dev/null" commit -m "msg"',
    'git -c core.HOOKSPATH=/dev/null commit -m "msg"',
    'git log -n 5 && git commit --no-verify -m "msg"',
    'git commit "--no-verify" -m "msg"',
    'git commit -m "msg" && git push --no-verify',
    'git push --no-verify',
    'git commit -an -m "msg"',
    'git commit -sn -m "msg"',
    'git commit -nu -m "msg"',
    'git commit --no-veri -m "msg"',
    'git push --no-verif origin main',
    'git merge --no-verify feature',
    'git rebase --no-verify main',
    'git cherry-pick --no-verify abc123',
    'git am --no-verify 0001.patch',
    // Achados do review (desvios do ECC): comentário, subshell/substituição, aspas no gap, shell -c/eval.
    'git commit -m "fix #12" && git push --no-verify',
    "echo '#'; git push --no-verify",
    '(cd r && git commit -m x --no-verify)',
    '$(git push --no-verify)',
    '`git push --no-verify`',
    'echo "$(git push --no-verify)"',
    'git commit -m "$(git push --no-verify)"',
    'git commit -m "$(echo x)" --no-verify',
    'git -C "dir x" commit --no-verify',
    'git -c user.name="A B" commit -n',
    '"git" push --no-verify',
    'bash -c "git commit --no-verify -m x"',
    "sh -lc 'git push --no-verify'",
    'eval "git push --no-verify"',
    'git push 2>&1 --no-verify',
    'git push &>/dev/null --no-verify',
    'git "commit" --no-verify',
    'x=$(git push --no-verify)',
    'bash -o pipefail -c "git push --no-verify"',
    // Re-review do fix round 1: \git, redirecionamento colado, heredoc/ANSI-C e incerteza de parse (fail-closed).
    '\\git push --no-verify',
    'git push>/dev/null --no-verify',
    'git commit>log -n -m x',
    'git push&>/dev/null --no-verify',
    'git push --no-verify>/dev/null',
    "cat >f <<'EOF'\ndon't\nEOF\ngit commit -n -m x",
    "echo $'\\''; git push --no-verify",
    'echo "x; git push --no-verify',
    'bash -O extglob -c "git push --no-verify"',
    "su -c 'git push --no-verify' deploy",
    "mksh -c 'git push --no-verify'",
    "tcsh -c 'git push --no-verify'",
    "ash -c 'git push --no-verify'",
    "echo \"$(bash -c 'git push --no-verify')\"",
    // Re-review do fix round 2 (N4, N5) e inversão fail-closed: flag fora de dado provado = bloqueia.
    'git commit -m">" --no-verify',
    'git commit -m"<wip> x" -n',
    "git commit -am'<x>' -n",
    "echo $$'\\'; git push --no-verify #'",
    "git push $'--no-verify'",
    'git push $"--no-verify"',
    'git push "--no-verify"',
    'git push $(echo) echo --no-verify',
    "X='; git push'; eval echo $X --no-verify",
    "X='; git push'; bash -c \"echo $X --no-verify\"",
    "bash -c 'git commit \"$@\"' _ -n",
    "bash -c 'git push \"$@\"' _ --no-verify",
    '{ git push --no-verify; }',
    'if git push --no-verify; then :; fi',
    'sudo git push --no-verify',
    'git push {--no-verify,}',
    'git am -n 0001.patch',
  ];
  const LIBERA = [
    'git commit -m "hello"',
    'git log -n 10 && git commit -m "msg"',
    'echo --no-verify && git commit -m "msg"',
    'git commit -m "fix: --no-verify edge case"',
    "git commit -m 'fix: --no-verify edge case'",
    'git commit -m "Fixed -n bug in module"',
    'git commit -am "--no-verify"',
    'git commit -mn',
    'git commit -m "doc: explain git push --no-verify risk"',
    'git push origin commit',
    'git commit -tn -m "msg"',
    'git commit -uno -m "msg"',
    'git commit -Sn -m "msg"',
    'git commit --no-verbose -m "msg"',
    'npm test -- --no-verify',
    'ls -la',
    'echo "git commit --no-verify"',
    'grep -rn "git commit -n" .',
    'git tag -m "bloqueia git commit --no-verify"',
    'gh pr create --body "x git push --no-verify"',
    'git commit -m "a) b; c | d" -m "e `f` g"',
    'git commit -m "$(echo x)"',
    'echo a#b; git commit -m x',
    'bash -c "echo ok" && git push',
    'git commit -m x # --no-verify',
    "bash -c \"echo 'git push --no-verify'\"",
    "git commit -F- <<'EOF'\nfix: mensagem normal, don't panic\nEOF",
    "echo $'a\\'b' && git push origin main",
    'git commit -m "x" 2>&1 | tail -3',
    'head -n 3 f && git commit -m x',
    'if true; then echo --no-verify; fi; git status',
    'A=1 echo --no-verify && git status',
    'git log -n 3 | head -n 1 && git commit -m "x"',
    "bash -c 'echo $X --no-verify' && git status",
    'git push -n origin main && git commit -m "x"',
    'printf "%s\\n" "--no-verify" && git commit -m x',
  ];
  for (const c of BLOQUEIA) test(`bloqueia: ${c}`, () => assert.equal(noVerify.checarComando(c).bloquear, true));
  for (const c of LIBERA) test(`libera: ${c}`, () => assert.equal(noVerify.checarComando(c).bloquear, false));
  test('comando patológico (muitos git sem separador) decide em tempo linear', () => {
    for (const c of ['git a '.repeat(20000), 'git push '.repeat(20000), 'git ' + '-c a=b '.repeat(40000) + 'push --no-verify']) {
      const t0 = performance.now();
      noVerify.checarComando(c);
      assert.ok(performance.now() - t0 < 2000, `${c.slice(0, 20)}…: ${Math.round(performance.now() - t0)} ms`);
    }
  });
  test('teto de custo (> 64 KB ou orçamento de tokens) cai no texto cru e bloqueia rápido', () => {
    const casos = [
      ['git -c '.repeat(2e4) + '; git push --no-verify', true],        // > 64 KB
      ['git -c '.repeat(8000) + '; git push --no-verify', true],       // < 64 KB, estoura o orçamento
      ['eval '.repeat(8000) + 'git push --no-verify', true],           // eval aninhado
      ['git commit -m "' + 'x'.repeat(70000) + '"', false],            // > 64 KB sem flag de bypass
    ];
    for (const [c, bloquear] of casos) {
      const t0 = performance.now();
      const r = noVerify.checarComando(c);
      const ms = Math.round(performance.now() - t0);
      assert.equal(r.bloquear, bloquear, `${c.slice(0, 24)}…`);
      assert.ok(ms < 2000, `${c.slice(0, 24)}…: ${ms} ms`);
    }
  });
  test('sh -c aninhado além do limite cai no texto cru e bloqueia', () => {
    const aspas = (x) => "'" + x.replace(/'/g, "'\\''") + "'";
    let c = 'git push --no-verify';
    for (let i = 0; i < 5; i++) c = 'bash -c ' + aspas(c);
    const r = noVerify.checarComando(c);
    assert.equal(r.bloquear, true);
    assert.match(r.motivo, /Análise incerta/);
  });
  test('bloqueio por análise incerta explica o escape CBS_HOOKS_DESLIGADOS=no-verify', () => {
    const r = noVerify.checarComando("cat >f <<'EOF'\ndon't\nEOF\ngit commit -n -m x");
    assert.equal(r.bloquear, true);
    assert.match(r.motivo, /CBS_HOOKS_DESLIGADOS=no-verify/);
    assert.doesNotMatch(noVerify.checarComando('git push --no-verify').motivo, /CBS_HOOKS_DESLIGADOS/);
  });
  test('motivo cita o subcomando git', () => assert.match(noVerify.checarComando('git commit -m x && git push --no-verify').motivo, /git push/));
  test('E2E: bloqueio sai 2 com motivo no stderr e stdout vazio', () => {
    const r = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } });
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /no-verify/);
  });
  test('E2E: comando sem git sai 0 em silêncio', () => {
    const r = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
  });
  test('E2E: payload inválido sai 0 em silêncio', () => {
    const r = rodarHook('cbs-no-verify.js', '{');
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: CBS_HOOKS_DESLIGADOS=no-verify libera', () => {
    const r = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }, { CBS_HOOKS_DESLIGADOS: 'no-verify' });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
  });
  test('E2E: argv do Codex (array) também é checado', () => {
    for (const command of [['git', 'commit', '--no-verify', '-m', 'x'], ['bash', '-lc', 'git push --no-verify']]) {
      const r = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command } });
      assert.equal(r.code, 2, JSON.stringify(command)); assert.equal(r.out, ''); assert.match(r.err, /no-verify/);
    }
    const ok = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command: ['git', 'status'] } });
    assert.equal(ok.code, 0); assert.equal(ok.out + ok.err, '');
  });
  test('E2E: erro interno sai 0 com aviso [cbs] no stderr', (t) => {
    // Preload que quebra RegExp#test (usado já no caminho rápido de checarComando) simula falha interna.
    const boom = escrever(tmpDoTeste(t), 'boom.cjs', "RegExp.prototype.test = function () { throw new Error('boom'); };\n");
    const r = rodarHook('cbs-no-verify.js', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }, { NODE_OPTIONS: `--require=${boom}` });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.match(r.err, /^\[cbs\] no-verify: erro interno ignorado \(boom\)/);
  });
});

// Formato verificado com o Codex 0.156.1 (Task 10): shell = tool_name "Bash" e apply_patch = "apply_patch"; o comando
// do hook roda via `$SHELL -c` (expande $HOME); exit 2 + stderr bloqueia; timeout em segundos.
const { HOOKS_CBS } = await import(pathToFileURL(path.join(RAIZ, 'src', 'hooks-settings.js')).href);
describe('codex-hooks.json', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'base', 'codex', 'hooks', 'codex-hooks.json'), 'utf8'));
  const entradas = Object.entries(cfg.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ ev, matcher: g.matcher, ...h }))));
  const script = (e) => e.command.match(/cbs-[a-z-]+\.js/)[0];
  const comandoCodex = (s) => `[ ! -f "$HOME/.claude/hooks/cbs-node.sh" ] || sh "$HOME/.claude/hooks/cbs-node.sh" "$HOME/.claude/hooks/${s}"`;
  test('só eventos que o Codex aceita', () => {
    for (const ev of Object.keys(cfg.hooks)) assert.ok(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(ev), ev);
  });
  test('os 4 scripts CBS, cada um uma vez, com o evento e o timeout do settings.json do Claude Code', () => {
    assert.deepEqual(entradas.map(script).sort(), ['cbs-config-protect.js', 'cbs-format.js', 'cbs-no-verify.js', 'cbs-typecheck.js']);
    for (const e of entradas) {
      const h = HOOKS_CBS.find((d) => d.script === script(e));
      assert.equal(e.ev, h.evento, h.script); assert.equal(e.timeout, h.timeout, h.script);
    }
  });
  test('matchers com os nomes reais de ferramenta do Codex (Bash, apply_patch); Stop sem matcher', () => {
    const esperado = { 'cbs-no-verify.js': '^Bash$', 'cbs-config-protect.js': '^apply_patch$', 'cbs-format.js': '^apply_patch$', 'cbs-typecheck.js': undefined };
    for (const e of entradas) assert.equal(e.matcher, esperado[script(e)], script(e));
  });
  test('comando = launcher POSIX (H3); nenhum matcher .*, nenhum npx, todos com timeout', () => {
    for (const e of entradas) {
      assert.equal(e.command, comandoCodex(script(e)));
      assert.ok(!e.matcher || !e.matcher.includes('.*'), e.matcher);
      assert.doesNotMatch(e.command, /npx/);
      assert.ok(Number.isInteger(e.timeout) && e.timeout > 0);
      assert.equal(e.type, 'command');
    }
  });
  test('E2E: sem o launcher instalado o comando sai 0 (nunca bloqueia a sessão)', { skip: !POSIX && 'POSIX' }, (t) => {
    const home = tmpDoTeste(t, 'cbs-home-');
    for (const s of entradas.map(script)) {
      const r = spawnSync('sh', ['-c', comandoCodex(s)], { input: '{}', encoding: 'utf8', timeout: 10_000, env: { ...envLimpo(), HOME: home } });
      assert.equal(r.status, 0, s); assert.equal(r.stdout + r.stderr, '');
    }
  });
  test('E2E: comando do Codex com payload real (Bash) bloqueia --no-verify via launcher', { skip: !POSIX && 'POSIX' }, (t) => {
    const home = tmpDoTeste(t, 'cbs-home-');
    const dir = path.join(home, '.claude', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['cbs-node.sh', 'cbs-no-verify.js', 'cbs-comum.js', 'package.json']) fs.copyFileSync(path.join(HOOKS, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '.cbs-node-path'), `${process.execPath}\n`);
    const cmd = cfg.hooks.PreToolUse.find((g) => g.matcher === '^Bash$').hooks[0].command;
    const payload = (command) => JSON.stringify({
      session_id: 's', turn_id: 't', transcript_path: null, cwd: home, hook_event_name: 'PreToolUse', model: 'm',
      permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'exec-1',
    });
    const rodar = (command) => spawnSync('sh', ['-c', cmd], { input: payload(command), encoding: 'utf8', timeout: 10_000, env: { ...envLimpo(), HOME: home } });
    const r = rodar('git commit --no-verify --allow-empty -m teste');
    assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /CBS: bloqueado/);
    const ok = rodar('echo passo1');
    assert.equal(ok.status, 0); assert.equal(ok.stdout + ok.stderr, '');
  });
});
