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

// ── Task 6: cbs-format (formatador do projeto) + acumulador por sessão ──
const fmt = await import(pathToFileURL(path.join(HOOKS, 'cbs-format.js')).href);
const EXE = '#!/bin/sh\nexit 0\n';
describe('cbs-format — escolha do formatador', { skip: !POSIX && 'binários falsos POSIX' }, () => {
  test('php em projeto Laravel com vendor/bin/pint → pint', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'artisan', ''); escrever(p, 'vendor/bin/pint', EXE, 0o755);
    const a = escrever(p, 'app/Models/User.php', '<?php');
    const f = fmt.escolherFormatador(a);
    assert.equal(f?.ferramenta, 'pint'); assert.deepEqual(f.args, [a]);
  });
  test('php com pint.json (sem artisan) → pint', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'pint.json', '{}'); escrever(p, 'vendor/bin/pint', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'src/A.php', '<?php'))?.ferramenta, 'pint');
  });
  test('php com pint mas sem pint.json nem artisan → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'vendor/bin/pint', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'src/A.php', '<?php')), null);
  });
  test('py com [tool.ruff] e ruff no PATH → ruff format', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'ruff', EXE, 0o755);
    const a = escrever(p, 'pkg/m.py', 'x=1');
    const f = fmt.escolherFormatador(a, { PATH: bin });
    assert.equal(f?.ferramenta, 'ruff'); assert.deepEqual(f.args, ['format', a]);
  });
  test('py com ruff.toml e ruff na .venv do projeto → ruff da .venv', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'ruff.toml', ''); const venv = escrever(p, '.venv/bin/ruff', EXE, 0o755);
    const f = fmt.escolherFormatador(escrever(p, 'm.py', ''), { PATH: '' });
    assert.equal(f?.bin, venv);
  });
  test('py sem config de ruff → nada, mesmo com ruff no PATH', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', '[project]\nname = "x"\n');
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'ruff', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'm.py', ''), { PATH: bin }), null);
  });
  test('py com [tool.ruff] sem ruff instalado → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', '[tool.ruff]\n');
    assert.equal(fmt.escolherFormatador(escrever(p, 'm.py', ''), { PATH: '' }), null);
  });
  test('ts com biome local + biome.json → biome', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}'); escrever(p, 'node_modules/.bin/biome', EXE, 0o755);
    const a = escrever(p, 'src/a.ts', '');
    const f = fmt.escolherFormatador(a);
    assert.equal(f?.ferramenta, 'biome'); assert.deepEqual(f.args, ['format', '--write', '--no-errors-on-unmatched', a]); assert.equal(f.raiz, p);
  });
  test('tsx com prettier local + .prettierrc → prettier', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, '.prettierrc', '{}'); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    const a = escrever(p, 'src/A.tsx', '');
    const f = fmt.escolherFormatador(a);
    assert.equal(f?.ferramenta, 'prettier'); assert.deepEqual(f.args, ['--write', a]);
  });
  test('prettier configurado pela chave "prettier" do package.json → prettier', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{"prettier":{"semi":false}}'); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.js', ''))?.ferramenta, 'prettier');
  });
  test('prettier só em devDependencies, sem config → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{"devDependencies":{"prettier":"^3"}}'); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.js', '')), null);
  });
  test('package.json inválido não quebra a escolha → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{'); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.js', '')), null);
  });
  test('biome vence prettier quando os dois estão configurados', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}'); escrever(p, '.prettierrc', '{}');
    escrever(p, 'node_modules/.bin/biome', EXE, 0o755); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.ts', ''))?.ferramenta, 'biome');
  });
  test('config de prettier sem binário local → nada (nunca npx)', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, '.prettierrc', '{}');
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.ts', '')), null);
  });
  test('extensão sem formatador (.rb) → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}');
    assert.equal(fmt.escolherFormatador(escrever(p, 'a.rb', '')), null);
  });
});
describe('cbs-format — acumulador', () => {
  test('acumula só arquivos tipados, sem duplicar, por sessão', (t) => {
    const d = tmpDoTeste(t, 'cbs-acc-');
    assert.equal(comum.registrarEdicao('s-1', ['/p/a.ts', '/p/b.md', '/p/c.php', '/p/d.py'], d), 3);
    comum.registrarEdicao('s-1', ['/p/a.ts'], d);
    assert.deepEqual(comum.lerAcumulador('s-1', d), ['/p/a.ts', '/p/c.php', '/p/d.py']);
    assert.deepEqual(comum.lerAcumulador('s-2', d), []);
  });
  test('session_id é saneado no nome do arquivo', () => {
    assert.equal(path.basename(comum.arquivoAcumulador('../x y', '/t')), 'cbs-editados-___x_y.txt');
  });
  test('arquivo do acumulador nasce com modo 0600', { skip: !POSIX && 'POSIX' }, (t) => {
    const d = tmpDoTeste(t, 'cbs-acc-');
    comum.registrarEdicao('s-modo', ['/p/a.ts'], d);
    assert.equal(fs.statSync(comum.arquivoAcumulador('s-modo', d)).mode & 0o777, 0o600);
  });
  test('não segue symlink plantado no caminho do acumulador', { skip: !POSIX && 'POSIX' }, (t) => {
    const d = tmpDoTeste(t, 'cbs-acc-');
    const alvo = escrever(d, 'alvo.txt', 'intacto\n');
    fs.symlinkSync(alvo, comum.arquivoAcumulador('s-link', d));
    assert.throws(() => comum.registrarEdicao('s-link', ['/p/a.ts'], d));
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'intacto\n');
  });
});
describe('cbs-comum — endurecimento da Task 6', { skip: !POSIX && 'POSIX' }, () => {
  test('noPath ignora entradas relativas do PATH (nunca roda binário do cwd)', (t) => {
    const r = tmpDoTeste(t);
    escrever(r, 'bin/ferramenta-cbs', '#!/bin/sh\n', 0o755);
    const relativo = path.relative(process.cwd(), path.join(r, 'bin'));
    assert.equal(path.isAbsolute(relativo), false);
    assert.equal(comum.noPath('ferramenta-cbs', { PATH: relativo }), null);
    assert.equal(comum.noPath('ferramenta-cbs', { PATH: ['.', path.join(r, 'bin')].join(path.delimiter) }), path.join(r, 'bin', 'ferramenta-cbs'));
  });
  test('stdin ilegível → exit 0 com aviso curto no stderr', (t) => {
    const d = tmpDoTeste(t);
    const fd = fs.openSync(d, 'r');
    t.after(() => fs.closeSync(fd));
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'cbs-format.js')], {
      stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, env: { ...envLimpo(), HOME: d, TMPDIR: d },
    });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    assert.match(r.stderr, /^\[cbs\] .*stdin/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
  });
});
// Biome falso que registra os argumentos recebidos num log.
function projetoBiome(p) {
  escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}');
  const log = path.join(p, 'chamadas.log');
  escrever(p, 'node_modules/.bin/biome', `#!/bin/sh\necho "$@" >> "${log}"\n`, 0o755);
  return log;
}
describe('cbs-format — E2E', { skip: !POSIX && 'POSIX' }, () => {
  test('formata com o binário do projeto, acumula e fica em silêncio', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    const a = escrever(p, 'src/a.ts', 'const x=1');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-fmt', cwd: p, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
    assert.match(fs.readFileSync(log, 'utf8'), /format --write .*src\/a\.ts/);
    assert.deepEqual(comum.lerAcumulador('e2e-fmt', p), [a]);
  });
  test('arquivo sem ferramenta → exit 0 sem saída', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'notas.txt', 'x');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-fmt2', cwd: p, tool_name: 'Write', tool_input: { file_path: 'notas.txt' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('stdin vazio ou inválido → exit 0 sem saída', () => {
    for (const payload of ['', '{', '[1]']) {
      const r = rodarHook('cbs-format.js', payload);
      assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    }
  });
  test('CBS_HOOKS=off não formata nem acumula', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    rodarHook('cbs-format.js', { session_id: 'e2e-off', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS: 'off' });
    assert.equal(fs.existsSync(log), false);
    assert.deepEqual(comum.lerAcumulador('e2e-off', p), []);
  });
  test('format desligado ainda acumula para o typecheck', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    const a = escrever(p, 'a.ts', '');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-sofmt', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS_DESLIGADOS: 'format' });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    assert.equal(fs.existsSync(log), false);
    assert.deepEqual(comum.lerAcumulador('e2e-sofmt', p), [a]);
  });
  test('typecheck desligado formata mas não acumula', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    rodarHook('cbs-format.js', { session_id: 'e2e-sotc', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS_DESLIGADOS: 'typecheck' });
    assert.equal(fs.existsSync(log), true);
    assert.deepEqual(comum.lerAcumulador('e2e-sotc', p), []);
  });
  test('apply_patch do Codex: descarta Delete File e origem de Move que não existem mais', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    const b = escrever(p, 'src/b.ts', ''); const novo = escrever(p, 'src/novo.ts', '');
    const patch = '*** Begin Patch\n*** Delete File: src/apagado.ts\n*** Update File: src/velho.ts\n*** Move to: src/novo.ts\n@@\n-x\n+y\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** End Patch';
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-patch', cwd: p, tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    const chamadas = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(chamadas, /apagado|velho/);
    assert.deepEqual(comum.lerAcumulador('e2e-patch', p).sort(), [b, novo].sort());
  });
  test('formatador que falha → exit 0, arquivo mantido, aviso curto', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}');
    escrever(p, 'node_modules/.bin/biome', '#!/bin/sh\nexit 3\n', 0o755);
    const a = escrever(p, 'a.ts', 'const x=1');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-falha', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.match(r.err, /^\[cbs\] format: biome falhou em a\.ts \(exit 3\)/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'const x=1');
  });
  test('acumulador impossível de gravar não impede a formatação', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    fs.symlinkSync(path.join(p, 'alvo'), comum.arquivoAcumulador('e2e-link', p));
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-link', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.equal(fs.existsSync(log), true);
    assert.equal(fs.existsSync(path.join(p, 'alvo')), false);
  });
});

// ── Task 6, fix round 1: raiz/binário confiáveis, biome sem aviso falso, sinal, .mts/.cts, [tool.ruff] exato ──
const OUTRO_UID = 2 ** 31 - 7; // uid que não é o do processo nem root: simula dono estrangeiro sem chown
const GRUPO_PRIVADO = POSIX && process.getgid() === process.getuid();
const grupoAlheio = POSIX ? process.getgroups().find((g) => g !== process.getgid() && g !== 0) : undefined;
describe('cbs-comum — raiz e binário confiáveis', { skip: !POSIX && 'POSIX' }, () => {
  test('acharRaiz não aceita raiz gravável por todos (1777, como /tmp)', (t) => {
    const r = tmpDoTeste(t); const shared = path.join(r, 'shared');
    escrever(shared, 'package.json', '{}'); const a = escrever(shared, 'user-owned/sess/scratch.ts', '');
    fs.chmodSync(shared, 0o1777);
    assert.equal(comum.acharRaiz(path.dirname(a), ['package.json']), null);
  });
  test('acharRaiz para no diretório gravável por outros (não sobe além dele)', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'package.json', '{}');
    const a = escrever(r, 'pub/x/a.ts', ''); fs.chmodSync(path.join(r, 'pub'), 0o777);
    assert.equal(comum.acharRaiz(path.dirname(a), ['package.json']), null);
    fs.chmodSync(path.join(r, 'pub'), 0o755);
    assert.equal(comum.acharRaiz(path.dirname(a), ['package.json']), r);
  });
  test('acharRaiz recusa raiz de outro dono', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'package.json', '{}');
    assert.equal(comum.acharRaiz(r, ['package.json']), r);
    assert.equal(comum.acharRaiz(r, ['package.json'], OUTRO_UID), null);
  });
  test('acharRaiz para no HOME', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'package.json', '{}');
    const home = path.join(r, 'h'); const src = path.join(home, 'proj', 'src'); fs.mkdirSync(src, { recursive: true });
    const antes = process.env.HOME;
    process.env.HOME = home;
    try { assert.equal(comum.acharRaiz(src, ['package.json']), null); } finally { process.env.HOME = antes; }
  });
  test('binLocal recusa raiz gravável por outros mesmo com sticky (1777)', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'node_modules/.bin/biome', EXE, 0o755);
    fs.chmodSync(r, 0o1777);
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), null);
  });
  test('binLocal recusa binário gravável por todos', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'vendor/bin/pint', EXE, 0o757);
    assert.equal(comum.binLocal(r, 'vendor/bin/pint'), null);
  });
  test('binLocal recusa binário em diretório gravável por todos sem sticky', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'node_modules/.bin/biome', EXE, 0o755);
    fs.chmodSync(path.join(r, 'node_modules/.bin'), 0o777);
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), null);
    fs.chmodSync(path.join(r, 'node_modules/.bin'), 0o1777); // sticky: ninguém troca a entrada do usuário
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), path.join(r, 'node_modules/.bin/biome'));
  });
  test('binLocal aceita diretório gravável pelo grupo privado do usuário (umask 002)', { skip: !GRUPO_PRIVADO && 'sem grupo privado' }, (t) => {
    const r = tmpDoTeste(t); escrever(r, 'node_modules/.bin/biome', EXE, 0o775);
    fs.chmodSync(path.join(r, 'node_modules/.bin'), 0o775); fs.chmodSync(path.join(r, 'node_modules'), 0o775);
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), path.join(r, 'node_modules/.bin/biome'));
  });
  test('binLocal recusa diretório gravável por um grupo compartilhado', { skip: grupoAlheio === undefined && 'sem grupo suplementar' }, (t) => {
    const r = tmpDoTeste(t); escrever(r, 'node_modules/.bin/biome', EXE, 0o755);
    const bin = path.join(r, 'node_modules/.bin');
    fs.chownSync(bin, process.getuid(), grupoAlheio); fs.chmodSync(bin, 0o775);
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), null);
  });
  test('binLocal segue symlink do npm até alvo confiável e recusa alvo gravável por outros', (t) => {
    const r = tmpDoTeste(t);
    escrever(r, 'node_modules/@biomejs/biome/bin/biome', EXE, 0o755);
    fs.mkdirSync(path.join(r, 'node_modules/.bin'));
    fs.symlinkSync('../@biomejs/biome/bin/biome', path.join(r, 'node_modules/.bin/biome'));
    assert.equal(comum.binLocal(r, 'node_modules/.bin/biome'), path.join(r, 'node_modules/.bin/biome'));
    const mau = escrever(r, 'mau/biome', EXE, 0o755); fs.chmodSync(path.join(r, 'mau'), 0o777);
    fs.symlinkSync(mau, path.join(r, 'node_modules/.bin/prettier'));
    assert.equal(comum.binLocal(r, 'node_modules/.bin/prettier'), null);
  });
  test('binLocal recusa binário de outro dono e aceita o de root', (t) => {
    const r = tmpDoTeste(t); escrever(r, 'vendor/bin/pint', EXE, 0o755);
    assert.equal(comum.binLocal(r, 'vendor/bin/pint', OUTRO_UID), null);
    const env = fs.existsSync('/usr/bin/env') && fs.lstatSync('/usr/bin/env');
    if (env && env.isFile() && env.uid === 0) assert.equal(comum.binLocal('/usr', 'bin/env', OUTRO_UID), '/usr/bin/env');
  });
  test('escolherFormatador ignora projeto plantado em diretório 1777', (t) => {
    const r = tmpDoTeste(t); const shared = path.join(r, 'shared');
    escrever(shared, 'package.json', '{}'); escrever(shared, 'biome.json', '{}'); escrever(shared, 'node_modules/.bin/biome', EXE, 0o755);
    const a = escrever(shared, 'user-owned/sess/scratch.ts', '');
    fs.chmodSync(shared, 0o1777);
    assert.equal(fmt.escolherFormatador(a), null);
  });
});
describe('cbs-format — fix round 1', { skip: !POSIX && 'POSIX' }, () => {
  test('E2E: binário plantado numa raiz 1777 não roda', (t) => {
    const r = tmpDoTeste(t); const shared = path.join(r, 'shared');
    const log = projetoBiome(shared);
    escrever(shared, 'user-owned/sess/scratch.ts', 'const x=1');
    fs.chmodSync(shared, 0o1777);
    const res = rodarHook('cbs-format.js', { session_id: 'e2e-1777', cwd: shared, tool_name: 'Write', tool_input: { file_path: 'user-owned/sess/scratch.ts' } }, { TMPDIR: r });
    assert.equal(res.code, 0); assert.equal(res.out + res.err, '');
    assert.equal(fs.existsSync(log), false);
  });
  test('.md vai para o prettier mesmo com biome configurado (biome não formata markdown)', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}'); escrever(p, '.prettierrc', '{}');
    escrever(p, 'node_modules/.bin/biome', EXE, 0o755); escrever(p, 'node_modules/.bin/prettier', EXE, 0o755);
    const a = escrever(p, 'README.md', '');
    const f = fmt.escolherFormatador(a);
    assert.equal(f?.ferramenta, 'prettier'); assert.deepEqual(f.args, ['--write', a]);
  });
  test('.md em projeto só com biome → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}'); escrever(p, 'node_modules/.bin/biome', EXE, 0o755);
    assert.equal(fmt.escolherFormatador(escrever(p, 'README.md', '')), null);
  });
  test('E2E: arquivo que o biome.json ignora não gera aviso falso', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}');
    // Como o biome real: sem --no-errors-on-unmatched, arquivo ignorado sai com 1.
    escrever(p, 'node_modules/.bin/biome', '#!/bin/sh\nfor a in "$@"; do [ "$a" = --no-errors-on-unmatched ] && exit 0; done\nexit 1\n', 0o755);
    escrever(p, 'ignorado.ts', '');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-ign', cwd: p, tool_input: { file_path: 'ignorado.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('.mts e .cts são formatados como .ts', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}'); escrever(p, 'node_modules/.bin/biome', EXE, 0o755);
    for (const ext of ['.mts', '.cts']) assert.equal(fmt.escolherFormatador(escrever(p, 'a' + ext, ''))?.ferramenta, 'biome');
  });
  test('[tool.ruff] exato ou [tool.ruff.x] conta; [tool.ruffus] não', (t) => {
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'ruff', EXE, 0o755);
    const casos = { '[tool.ruffus]\n': null, '[tool.ruff.lint]\nselect = ["E"]\n': 'ruff', '[tool.ruff]\n': 'ruff' };
    for (const [toml, esperado] of Object.entries(casos)) {
      const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', toml);
      assert.equal(fmt.escolherFormatador(escrever(p, 'm.py', ''), { PATH: bin })?.ferramenta ?? null, esperado, toml);
    }
  });
  test('E2E: formatador morto por sinal → aviso mostra o sinal', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}');
    escrever(p, 'node_modules/.bin/biome', '#!/bin/sh\nkill -9 $$\n', 0o755);
    escrever(p, 'a.ts', '');
    const r = rodarHook('cbs-format.js', { session_id: 'e2e-sinal', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0);
    assert.match(r.err, /^\[cbs\] format: biome falhou em a\.ts \(exit SIGKILL\)/);
  });
  test('timeout mata com SIGKILL: formatador que ignora SIGTERM não prende o hook', (t) => {
    const p = tmpDoTeste(t);
    const bin = escrever(p, 'teimoso', '#!/bin/sh\ntrap "" TERM\nsleep 5\n', 0o755);
    const t0 = Date.now();
    const falha = fmt.rodarFormatador({ bin, args: [], raiz: p }, 300);
    assert.ok(Date.now() - t0 < 3000, `demorou ${Date.now() - t0} ms`);
    assert.equal(falha, 'ETIMEDOUT');
  });
});
