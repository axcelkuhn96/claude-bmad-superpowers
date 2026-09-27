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
  // Hunk com lado antigo de uma linha em branco: o timeout do rodarHook (10 s) transforma travamento em falha.
  test('E2E: hunk de apply_patch com lado antigo em branco não trava (pyproject com e sem [tool.*])', (t) => {
    const p = projeto(t);
    const q = tmpDoTeste(t, 'cbs-config-'); escrever(q, 'pyproject.toml', '[project]\nname = "x"\n\ndependencies = []\n');
    for (const dir of [q, p]) for (const velho of ['-', ' ']) {
      const r = rodarHook('cbs-config-protect.js', ap(dir, `*** Update File: pyproject.toml\n@@\n${velho}\n+dependencies = ["b"]`));
      assert.equal(r.code, 0, `'${velho}' ${dir === p ? 'com' : 'sem'} [tool.*]: ${r.err}`);
    }
  });
  test('apply_patch em pyproject: linha em branco de [tool.mypy] (pelo contexto do @@) e acréscimo puro na última seção bloqueiam', (t) => {
    const p = projeto(t);
    assert.equal(av(ap(p, '*** Update File: pyproject.toml\n@@ strict = true\n-\n+ignore_missing_imports = true')).bloquear, true);
    assert.equal(av(ap(p, '*** Update File: pyproject.toml\n@@\n+disallow_untyped_defs = false')).bloquear, true);
    assert.equal(av(ap(p, '*** Update File: pyproject.toml\n@@\n+\n+[tool.pytest.ini_options]\n+testpaths = ["tests"]')).bloquear, false);
  });
  test('apply_patch: Add File sobre pyproject existente compara as seções protegidas', (t) => {
    const p = projeto(t);
    const add = (txt) => ap(p, `*** Add File: pyproject.toml\n${txt.split('\n').slice(0, -1).map((l) => '+' + l).join('\n')}`);
    assert.equal(av(add(PYPROJECT.replace('[tool.ruff]\nline-length = 100\n\n', ''))).bloquear, true);
    assert.equal(av(add(PYPROJECT.replace('name = "x"', 'name = "y"'))).bloquear, false);
  });
  test('apply_patch: Move to / Add File sobre pyproject com [tool.*] ou config protegida existente bloqueia', (t) => {
    const p = projeto(t); escrever(p, 'tmp.toml', '[project]\nname = "y"\n'); escrever(p, 'x.json', '{}');
    assert.equal(av(ap(p, '*** Update File: tmp.toml\n*** Move to: pyproject.toml\n@@\n-name = "y"\n+name = "z"')).bloquear, true);
    assert.equal(av(ap(p, '*** Update File: x.json\n*** Move to: .eslintrc.json')).bloquear, true);
    assert.equal(av(ap(p, '*** Add File: .eslintrc.json\n+{}')).bloquear, true);
    const q = tmpDoTeste(t, 'cbs-config-'); escrever(q, 'pyproject.toml', '[project]\nname = "x"\n'); escrever(q, 'tmp.toml', '[project]\nname = "y"\n');
    // Update sem hunk o Codex rejeita ("hunk is empty"): o Move precisa de um hunk para ser um patch válido
    assert.equal(av(ap(q, '*** Update File: tmp.toml\n*** Move to: pyproject.toml\n@@\n-name = "y"\n+name = "z"')).bloquear, false);
  });
  test('apply_patch com CRLF em pyproject: hunk em [tool.ruff] bloqueia', (t) => {
    const p = projeto(t);
    const patch = ['*** Begin Patch', '*** Update File: pyproject.toml', '@@', '-line-length = 100', '+line-length = 200', '*** End Patch'].join('\r\n');
    assert.equal(av({ cwd: p, tool_name: 'apply_patch', tool_input: { input: patch } }).bloquear, true);
  });
  test('symlink com nome comum apontando para config protegida bloqueia', { skip: !POSIX && 'POSIX' }, (t) => {
    const p = projeto(t);
    fs.symlinkSync(path.join(p, '.eslintrc.json'), path.join(p, 'lint.json'));
    fs.symlinkSync(path.join(p, 'pyproject.toml'), path.join(p, 'cfg.toml'));
    assert.equal(av(ed(p, 'lint.json')).bloquear, true);
    assert.equal(av(ed(p, 'cfg.toml', 'line-length = 100', 'line-length = 200')).bloquear, true);
    assert.equal(av(ed(p, 'cfg.toml', 'name = "x"', 'name = "y"')).bloquear, false);
  });
  test('bloqueia phpstan.dist.neon, .mypy.ini e stylelint.config.* existentes', (t) => {
    const p = projeto(t);
    for (const f of ['phpstan.dist.neon', '.mypy.ini', 'stylelint.config.js', 'stylelint.config.mjs', 'stylelint.config.cjs']) {
      escrever(p, f, 'x'); assert.equal(av(ed(p, f)).bloquear, true, f);
    }
  });
  test('MultiEdit em config protegida existente bloqueia', (t) => {
    const p = projeto(t);
    const payload = { cwd: p, tool_name: 'MultiEdit', tool_input: { file_path: '.eslintrc.json', edits: [{ old_string: '{"rules":{}}', new_string: '{}' }] } };
    assert.equal(av(payload).bloquear, true);
  });
  // Variante de caixa: FS case-insensitive (macOS, Windows, WSL /mnt/c) abre a mesma config → bloqueia;
  // Linux case-sensitive: outro arquivo, que ferramenta nenhuma lê → passa, a não ser que seja hardlink da config.
  test('variante de caixa do nome: protegida só quando abre a mesma config', (t) => {
    const p = projeto(t);
    const insensivel = fs.existsSync(path.join(p, '.ESLINTRC.JSON'));
    assert.equal(av(ed(p, '.ESLINTRC.JSON')).bloquear, insensivel);
    if (insensivel) return;
    escrever(p, '.ESLINTRC.JSON', '{}');
    assert.equal(av(ed(p, '.ESLINTRC.JSON')).bloquear, false);
    fs.linkSync(path.join(p, 'pint.json'), path.join(p, 'PINT.json'));
    assert.equal(av(ed(p, 'PINT.json')).bloquear, true);
  });
  // Fix round 2: comparação antes/depois das seções protegidas (re-review da Task 5).
  const py = (t, texto) => { const d = tmpDoTeste(t, 'cbs-config-'); escrever(d, 'pyproject.toml', texto); return d; };
  const upd = (d, corpo) => ap(d, `*** Update File: pyproject.toml\n${corpo}`);
  test('apply_patch: linha em branco de [tool.mypy] trocada por cabeçalho novo tira chaves da seção → bloqueia', (t) => {
    const d = py(t, '[project]\nname = "x"\n\n[tool.mypy]\nstrict = true\n\nwarn_unused_ignores = true\ndisallow_untyped_defs = true\n');
    assert.equal(av(upd(d, '@@ strict = true\n-\n+[tool.x]')).bloquear, true);
  });
  test('apply_patch: linha vazia no hunk é contexto em branco (Codex), não acréscimo no fim → bloqueia', (t) => {
    const d = py(t, '[tool.mypy]\nstrict = true\n\n[project]\nname = "x"\n');
    assert.equal(av(upd(d, '@@ strict = true\n\n+ignore_missing_imports = true')).bloquear, true);
  });
  // "@@ " (espaço à direita): Codex 0.156 lê sem contexto (medido); versões antigas, contexto = 1ª linha em branco.
  // Bloqueia se QUALQUER das duas leituras mexe em [tool.ruff]; passa quando as duas caem fora.
  test('apply_patch: "@@ " com espaço — as duas leituras do Codex são conferidas', (t) => {
    assert.equal(av(upd(py(t, '[project]\nx = 1\n\n[tool.ruff]\nx = 1\n'), '@@ \n-x = 1\n+x = 2')).bloquear, true);
    assert.equal(av(upd(py(t, '[tool.ruff]\nx = 1\n\n[tool.other]\nx = 1\n'), '@@ \n-x = 1\n+x = 2')).bloquear, true);
    assert.equal(av(upd(py(t, '[project]\nx = 1\n\n[tool.other]\nx = 1\n\n[tool.ruff]\ny = 1\n'), '@@ \n-x = 1\n+x = 2')).bloquear, false);
  });
  test('apply_patch: cabeçalho *** Update File: indentado (o Codex apara) bloqueia', (t) => {
    const p = projeto(t);
    assert.equal(av(ap(p, '  *** Update File: pyproject.toml\n@@\n-line-length = 100\n+line-length = 200')).bloquear, true);
  });
  test('pyproject: chaves pontilhadas tool.ruff.x na raiz e mypy.x em [tool] são protegidas', (t) => {
    const d = py(t, 'tool.ruff.line-length = 100\n\n[project]\nname = "x"\n');
    assert.equal(av(ed(d, 'pyproject.toml', 'line-length = 100', 'line-length = 200')).bloquear, true);
    assert.equal(av(ed(d, 'pyproject.toml', 'name = "x"', 'name = "y"')).bloquear, false);
    const e = py(t, '[project]\nname = "x"\n\n[tool]\nmypy.strict = true\n');
    assert.equal(av(ed(e, 'pyproject.toml', 'mypy.strict = true', 'mypy.strict = false')).bloquear, true);
  });
  test('pyproject: linha de array começando com [ dentro de [tool.mypy] não encerra a seção', (t) => {
    const d = py(t, '[tool.mypy]\nplugins = [\n  ["a"]\n]\nstrict = true\n');
    assert.equal(av(ed(d, 'pyproject.toml', 'strict = true', 'strict = false')).bloquear, true);
  });
  test('pyproject: edição que não aplica no conteúdo atual bloqueia (Edit, MultiEdit, apply_patch)', (t) => {
    const p = projeto(t);
    assert.equal(av(ed(p, 'pyproject.toml', 'nao existe', 'x')).bloquear, true);
    const multi = { cwd: p, tool_name: 'MultiEdit', tool_input: { file_path: 'pyproject.toml', edits: [
      { old_string: 'name = "x"', new_string: 'name = "y"' }, { old_string: 'nao existe', new_string: 'x' }] } };
    assert.equal(av(multi).bloquear, true);
    assert.equal(av(upd(p, '@@\n-nao existe\n+x = 1')).bloquear, true);
  });
  test('pyproject: Edit com replace_all aplica em todas as ocorrências', (t) => {
    const d = py(t, '[project]\nv = "1"\n\n[tool.ruff]\nv = "1"\n');
    assert.equal(av({ cwd: d, tool_name: 'Edit', tool_input: { file_path: 'pyproject.toml', old_string: 'v = "1"', new_string: 'v = "2"', replace_all: true } }).bloquear, true);
    const e = py(t, '[project]\nv = "1"\nw = "1"\n\n[tool.ruff]\nx = 1\n');
    assert.equal(av({ cwd: e, tool_name: 'Edit', tool_input: { file_path: 'pyproject.toml', old_string: '"1"', new_string: '"2"', replace_all: true } }).bloquear, false);
  });
  test('variante de caixa via symlink para o mesmo alvo da config bloqueia (stat, não lstat)', { skip: !POSIX && 'POSIX' }, (t) => {
    const p = projeto(t);
    if (fs.existsSync(path.join(p, '.ESLINTRC.JSON'))) return; // FS case-insensitive: coberto pelo teste anterior
    escrever(p, 'compartilhado.json', '{}');
    fs.rmSync(path.join(p, '.eslintrc.json'));
    fs.symlinkSync(path.join(p, 'compartilhado.json'), path.join(p, '.eslintrc.json'));
    fs.symlinkSync(path.join(p, 'compartilhado.json'), path.join(p, '.ESLINTRC.JSON'));
    assert.equal(av(ed(p, '.ESLINTRC.JSON')).bloquear, true);
  });
  test('E2E: payload acima de 16 MiB para pyproject.toml bloqueia', (t) => {
    const p = projeto(t);
    const r = rodarHook('cbs-config-protect.js', wr(p, 'pyproject.toml', 'x'.repeat(comum.LIMITE_STDIN)));
    assert.equal(r.code, 2); assert.match(r.err, /CBS_PERMITIR_CONFIG=1/);
  });
  // Fix round 3: cada ponto em que a simulação pode divergir da ferramenta real fecha (re-review 2 da Task 5).
  test('pyproject: [[tool]]/[tool] (prefixo de tool.ruff/tool.mypy) inserido ou mudado bloqueia', (t) => {
    const d = py(t, '[project]\nname = "x"\n# nota\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n');
    assert.equal(av(ed(d, 'pyproject.toml', '# nota', '# nota\n[[tool]]')).bloquear, true);
    assert.equal(av(ed(d, 'pyproject.toml', '# nota', '# nota\n[tool]')).bloquear, true);
    assert.equal(av(ed(d, 'pyproject.toml', '[tool.ruff]', '[[tool.ruff]]')).bloquear, true);
    assert.equal(av(ed(d, 'pyproject.toml', '# nota', '# outra nota')).bloquear, false);
  });
  test('Edit com new_string vazio: confere também a leitura que apaga o \\n seguinte (Claude Code)', (t) => {
    const d = py(t, '[project]\nname = "x"\n# see\n[tool.mypy]\nstrict = true\n');
    assert.equal(av(ed(d, 'pyproject.toml', 'see', '')).bloquear, true);
    const e = py(t, '[project]\nname = "x"\nversion = "0"\n\n[tool.mypy]\nstrict = true\n');
    assert.equal(av(ed(e, 'pyproject.toml', 'version = "0"', '')).bloquear, false);
    const multi = { cwd: d, tool_name: 'MultiEdit', tool_input: { file_path: 'pyproject.toml', edits: [
      { old_string: 'name = "x"', new_string: 'name = "y"' }, { old_string: 'see', new_string: '' }] } };
    assert.equal(av(multi).bloquear, true);
  });
  test('apply_patch: cabeçalho com espaço Unicode (U+0085, U+FEFF) à esquerda conta como tocando o arquivo', (t) => {
    const p = projeto(t);
    const nel = String.fromCharCode(0x85); const bom = String.fromCharCode(0xfeff);
    assert.equal(av(ap(p, `${nel}*** Update File: pyproject.toml\n@@\n-line-length = 100\n+line-length = 200`)).bloquear, true);
    assert.equal(av(ap(p, `${bom}*** Update File: .eslintrc.json\n@@\n-{"rules":{}}\n+{}`)).bloquear, true);
  });
  test('apply_patch: linha de contexto " *** End Patch" não encerra o patch (parser linha a linha)', (t) => {
    const p = projeto(t); escrever(p, 'docs.md', 'foo\n*** End Patch\n');
    const corpo = '*** Update File: pyproject.toml\n@@\n-name = "x"\n+name = "y"\n*** Update File: docs.md\n@@\n foo\n *** End Patch\n'
      + '*** Update File: pyproject.toml\n@@\n-line-length = 100\n+line-length = 200';
    assert.equal(av(ap(p, corpo)).bloquear, true);
  });
  test('apply_patch grande (pyproject 39 KB + patch 23 KB) decide em menos de 3 s', (t) => {
    const d = py(t, '[project]\nname = "x"\ndeps = [\n' + '"x",\n'.repeat(8000) + '"x-",\n]\n\n[tool.ruff]\nline-length = 100\n');
    const hifen = String.fromCharCode(0x2010);
    for (const [ultima, esperado] of [[`-"x${hifen}",`, false], ['-"nope",', true]]) {
      const ini = Date.now();
      assert.equal(av(upd(d, '@@\n' + '-"x",\n'.repeat(4000) + ultima + '\n+"y",')).bloquear, esperado, ultima);
      assert.ok(Date.now() - ini < 3000, `${Date.now() - ini} ms`);
    }
  });
  test('orçamento de tempo estourado bloqueia com a escape na mensagem (fail closed)', (t) => {
    const p = projeto(t);
    const r = cp.avaliarEdicao(upd(p, '@@\n-name = "x"\n+name = "y"'), { env: {}, prazoMs: 0 });
    assert.equal(r.bloquear, true); assert.match(r.motivo, /CBS_PERMITIR_CONFIG=1/);
  });
});
