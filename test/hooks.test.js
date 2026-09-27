// test/hooks.test.js — hooks CBS (base/hooks): decisões em unidade + E2E com payload JSON real.
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

// cbs-config-protect: casos derivados de affaan-m/ECC @ e482e57, tests/hooks/config-protection.test.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
const cp = await import(pathToFileURL(path.join(HOOKS, 'cbs-config-protect.js')).href);
describe('cbs-config-protect', () => {
  const PYPROJECT = '[project]\nname = "x"\ndependencies = ["a"]\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n\n[[tool.mypy.overrides]]\nmodule = "vendor.*"\nignore_errors = false\n';
  function projeto(t) {
    const p = tmpDoTeste(t, 'cbs-config-');
    escrever(p, '.eslintrc.json', '{"rules":{}}');
    escrever(p, 'eslint.config.mjs', 'export default [];');
    escrever(p, 'pint.json', '{"preset":"laravel"}');
    escrever(p, 'phpstan.neon.dist', 'parameters:\n  level: 8\n');
    escrever(p, 'package.json', '{"name":"x"}');
    escrever(p, 'tsconfig.json', '{}');
    escrever(p, 'composer.json', '{}');
    escrever(p, 'pyproject.toml', PYPROJECT);
    return p;
  }
  // env explícito: o do processo pode ter CBS_PERMITIR_CONFIG exportado
  const av = (payload, env = {}) => cp.avaliarEdicao(payload, { env });
  const ed = (p, rel, velho = 'a', novo = 'b') => ({ cwd: p, tool_name: 'Edit', tool_input: { file_path: rel, old_string: velho, new_string: novo } });
  const wr = (p, rel, content) => ({ cwd: p, tool_name: 'Write', tool_input: { file_path: rel, content } });
  const ap = (p, patch) => ({ cwd: p, tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n${patch}\n*** End Patch` } });

  test('bloqueia edição de .eslintrc.json existente', (t) => { const p = projeto(t); assert.equal(av(ed(p, '.eslintrc.json')).bloquear, true); });
  test('bloqueia eslint.config.mjs, pint.json e phpstan.neon.dist existentes', (t) => {
    const p = projeto(t);
    for (const f of ['eslint.config.mjs', 'pint.json', 'phpstan.neon.dist']) assert.equal(av(ed(p, f)).bloquear, true, f);
  });
  test('bloqueia as demais configs protegidas quando existem', (t) => {
    const p = projeto(t);
    const fs_ = ['phpstan.neon', 'phpstan-baseline.neon', '.php-cs-fixer.dist.php', '.php-cs-fixer.php', 'ruff.toml', '.ruff.toml', 'mypy.ini',
      '.prettierrc', '.prettierrc.json', 'prettier.config.mjs', 'biome.json', 'biome.jsonc', '.stylelintrc', '.stylelintrc.json', '.eslintrc', '.eslintrc.cjs', 'eslint.config.ts'];
    for (const f of fs_) { escrever(p, f, 'x'); assert.equal(av(wr(p, f, 'y')).bloquear, true, f); }
  });
  test('libera a criação inicial de biome.json (SP-3)', (t) => { const p = projeto(t); assert.equal(av(wr(p, 'biome.json', '{}')).bloquear, false); });
  test('symlink quebrado numa config protegida conta como existente', { skip: !POSIX && 'POSIX' }, (t) => {
    const p = projeto(t); fs.symlinkSync(path.join(p, 'nao-existe'), path.join(p, '.prettierrc.js'));
    assert.equal(av(wr(p, '.prettierrc.js', 'module.exports = {}')).bloquear, true);
  });
  test('não bloqueia package.json, tsconfig.json e composer.json', (t) => {
    const p = projeto(t);
    for (const f of ['package.json', 'tsconfig.json', 'composer.json']) assert.equal(av(ed(p, f)).bloquear, false, f);
  });
  test('pyproject: edição em [project] passa', (t) => {
    const p = projeto(t);
    assert.equal(av(ed(p, 'pyproject.toml', 'dependencies = ["a"]', 'dependencies = ["a", "b"]')).bloquear, false);
  });
  test('pyproject: edição dentro de [tool.ruff] bloqueia', (t) => {
    const p = projeto(t);
    assert.equal(av(ed(p, 'pyproject.toml', 'line-length = 100', 'line-length = 200')).bloquear, true);
  });
  test('pyproject: edição dentro de [[tool.mypy.overrides]] bloqueia', (t) => {
    const p = projeto(t);
    assert.equal(av(ed(p, 'pyproject.toml', 'ignore_errors = false', 'ignore_errors = true')).bloquear, true);
  });
  test('pyproject: MultiEdit com um trecho em [tool.mypy] bloqueia', (t) => {
    const p = projeto(t);
    const payload = { cwd: p, tool_name: 'MultiEdit', tool_input: { file_path: 'pyproject.toml', edits: [
      { old_string: 'name = "x"', new_string: 'name = "y"' }, { old_string: 'strict = true', new_string: 'strict = false' }] } };
    assert.equal(av(payload).bloquear, true);
  });
  test('pyproject: Write que muda [tool.mypy] bloqueia; que muda só [project] passa', (t) => {
    const p = projeto(t);
    const atual = fs.readFileSync(path.join(p, 'pyproject.toml'), 'utf8');
    assert.equal(av(wr(p, 'pyproject.toml', atual.replace('strict = true', 'strict = false'))).bloquear, true);
    assert.equal(av(wr(p, 'pyproject.toml', atual.replace('name = "x"', 'name = "y"'))).bloquear, false);
  });
  test('pyproject: criação inicial com [tool.ruff] passa (SP-3)', (t) => {
    const p = tmpDoTeste(t, 'cbs-config-');
    assert.equal(av(wr(p, 'pyproject.toml', PYPROJECT)).bloquear, false);
    assert.equal(av(ap(p, `*** Add File: pyproject.toml\n${PYPROJECT.split('\n').map((l) => '+' + l).join('\n')}`)).bloquear, false);
  });
  test('CBS_PERMITIR_CONFIG=1 libera', (t) => { const p = projeto(t); assert.equal(av(ed(p, '.eslintrc.json'), { CBS_PERMITIR_CONFIG: '1' }).bloquear, false); });
  test('arquivo de código comum passa', (t) => { const p = projeto(t); assert.equal(av(ed(p, 'src/app.ts')).bloquear, false); });
  test('apply_patch do Codex em .prettierrc existente bloqueia', (t) => {
    const p = projeto(t); escrever(p, '.prettierrc', '{}');
    assert.equal(av(ap(p, '*** Update File: .prettierrc\n@@\n-{}\n+{"semi":false}')).bloquear, true);
  });
  test('apply_patch: Delete File e Move de config existente bloqueiam; Add File de config nova passa', (t) => {
    const p = projeto(t);
    assert.equal(av(ap(p, '*** Delete File: .eslintrc.json')).bloquear, true);
    assert.equal(av(ap(p, '*** Update File: pint.json\n*** Move to: pint.json.bak')).bloquear, true);
    assert.equal(av(ap(p, '*** Add File: ruff.toml\n+line-length = 100')).bloquear, false);
  });
  test('apply_patch em pyproject: hunk em [tool.ruff] sem cabeçalho bloqueia; hunk em [project] passa', (t) => {
    const p = projeto(t);
    assert.equal(av(ap(p, '*** Update File: pyproject.toml\n@@\n-line-length = 100\n+line-length = 200')).bloquear, true);
    assert.equal(av(ap(p, '*** Update File: pyproject.toml\n@@\n name = "x"\n-dependencies = ["a"]\n+dependencies = ["a", "b"]')).bloquear, false);
  });
  test('apply_patch apagando pyproject com [tool.ruff] bloqueia', (t) => {
    const p = projeto(t);
    assert.equal(av(ap(p, '*** Delete File: pyproject.toml')).bloquear, true);
  });
  test('E2E: exit 2, motivo com a escape no stderr, stdout vazio', (t) => {
    const p = projeto(t); const r = rodarHook('cbs-config-protect.js', ed(p, '.eslintrc.json'));
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /CBS_PERMITIR_CONFIG=1/);
  });
  test('E2E: apply_patch do Codex com command em argv bloqueia', (t) => {
    const p = projeto(t);
    const payload = { cwd: p, tool_name: 'apply_patch', tool_input: { command: ['apply_patch', '*** Begin Patch\n*** Update File: pint.json\n@@\n-{"preset":"laravel"}\n+{}\n*** End Patch'] } };
    assert.equal(rodarHook('cbs-config-protect.js', payload).code, 2);
  });
  test('E2E: CBS_PERMITIR_CONFIG=1 e CBS_HOOKS_DESLIGADOS=config liberam', (t) => {
    const p = projeto(t);
    assert.equal(rodarHook('cbs-config-protect.js', ed(p, '.eslintrc.json'), { CBS_PERMITIR_CONFIG: '1' }).code, 0);
    assert.equal(rodarHook('cbs-config-protect.js', ed(p, '.eslintrc.json'), { CBS_HOOKS_DESLIGADOS: 'config' }).code, 0);
  });
  test('E2E: arquivo comum sai 0 em silêncio', (t) => {
    const p = projeto(t); const r = rodarHook('cbs-config-protect.js', ed(p, 'src/app.ts'));
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: payload inválido sai 0 em silêncio', () => {
    const r = rodarHook('cbs-config-protect.js', '{'); assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: payload acima de 16 MiB citando config protegida bloqueia; sem citar passa', (t) => {
    const p = projeto(t); const enorme = 'x'.repeat(comum.LIMITE_STDIN);
    const r = rodarHook('cbs-config-protect.js', wr(p, '.eslintrc.json', enorme));
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /CBS_PERMITIR_CONFIG=1/);
    assert.equal(rodarHook('cbs-config-protect.js', wr(p, 'src/app.ts', enorme)).code, 0);
  });
});
