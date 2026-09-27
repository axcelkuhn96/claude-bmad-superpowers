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
