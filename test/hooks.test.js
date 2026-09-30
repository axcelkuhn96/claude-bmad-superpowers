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
import { HOOKS_CBS, comandoHook } from '../src/hooks-settings.js';

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
// Env do processo sem as chaves CBS_* (o usuário pode tê-las exportado) nem CLAUDE_PROJECT_DIR (npm test rodado
// dentro de uma sessão do Claude Code herda o projeto da sessão, que o cbs-typecheck usa como âncora).
function envLimpo() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CBS_') || k === 'CLAUDE_PROJECT_DIR') delete env[k];
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
const comum = await import(pathToFileURL(path.join(HOOKS, 'cbs-comum.mjs')).href);

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
    assert.equal(comum.ehEntrada(pathToFileURL(path.join(HOOKS, 'cbs-comum.mjs')).href), false);
  });
});

// ── Task 6: cbs-format (formatador do projeto) + acumulador por sessão ──
const fmt = await import(pathToFileURL(path.join(HOOKS, 'cbs-format.mjs')).href);
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
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'cbs-format.mjs')], {
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
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-fmt', cwd: p, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
    assert.match(fs.readFileSync(log, 'utf8'), /format --write .*src\/a\.ts/);
    assert.deepEqual(comum.lerAcumulador('e2e-fmt', p), [a]);
  });
  test('arquivo sem ferramenta → exit 0 sem saída', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'notas.txt', 'x');
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-fmt2', cwd: p, tool_name: 'Write', tool_input: { file_path: 'notas.txt' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('stdin vazio ou inválido → exit 0 sem saída', () => {
    for (const payload of ['', '{', '[1]']) {
      const r = rodarHook('cbs-format.mjs', payload);
      assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    }
  });
  test('CBS_HOOKS=off não formata nem acumula', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    rodarHook('cbs-format.mjs', { session_id: 'e2e-off', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS: 'off' });
    assert.equal(fs.existsSync(log), false);
    assert.deepEqual(comum.lerAcumulador('e2e-off', p), []);
  });
  test('format desligado ainda acumula para o typecheck', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    const a = escrever(p, 'a.ts', '');
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-sofmt', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS_DESLIGADOS: 'format' });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    assert.equal(fs.existsSync(log), false);
    assert.deepEqual(comum.lerAcumulador('e2e-sofmt', p), [a]);
  });
  test('typecheck desligado formata mas não acumula', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    rodarHook('cbs-format.mjs', { session_id: 'e2e-sotc', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p, CBS_HOOKS_DESLIGADOS: 'typecheck' });
    assert.equal(fs.existsSync(log), true);
    assert.deepEqual(comum.lerAcumulador('e2e-sotc', p), []);
  });
  test('apply_patch do Codex: descarta Delete File e origem de Move que não existem mais', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    const b = escrever(p, 'src/b.ts', ''); const novo = escrever(p, 'src/novo.ts', '');
    const patch = '*** Begin Patch\n*** Delete File: src/apagado.ts\n*** Update File: src/velho.ts\n*** Move to: src/novo.ts\n@@\n-x\n+y\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** End Patch';
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-patch', cwd: p, tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    const chamadas = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(chamadas, /apagado|velho/);
    assert.deepEqual(comum.lerAcumulador('e2e-patch', p).sort(), [b, novo].sort());
  });
  test('formatador que falha → exit 0, arquivo mantido, aviso curto', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'package.json', '{}'); escrever(p, 'biome.json', '{}');
    escrever(p, 'node_modules/.bin/biome', '#!/bin/sh\nexit 3\n', 0o755);
    const a = escrever(p, 'a.ts', 'const x=1');
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-falha', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.match(r.err, /^\[cbs\] format: biome falhou em a\.ts \(exit 3\)/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'const x=1');
  });
  test('acumulador impossível de gravar não impede a formatação', (t) => {
    const p = tmpDoTeste(t); const log = projetoBiome(p);
    escrever(p, 'a.ts', '');
    fs.symlinkSync(path.join(p, 'alvo'), comum.arquivoAcumulador('e2e-link', p));
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-link', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
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
    const res = rodarHook('cbs-format.mjs', { session_id: 'e2e-1777', cwd: shared, tool_name: 'Write', tool_input: { file_path: 'user-owned/sess/scratch.ts' } }, { TMPDIR: r });
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
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-ign', cwd: p, tool_input: { file_path: 'ignorado.ts' } }, { TMPDIR: p });
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
    const r = rodarHook('cbs-format.mjs', { session_id: 'e2e-sinal', cwd: p, tool_input: { file_path: 'a.ts' } }, { TMPDIR: p });
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

// ── Task 7: cbs-typecheck (Stop) — typecheck em lote das stacks tocadas na sessão ──
const tc = await import(pathToFileURL(path.join(HOOKS, 'cbs-typecheck.mjs')).href);
// H2: nunca lê *.tsbuildinfo velho nem grava buildinfo no repo; --composite false evita o TS6379 do composite;
// --emitDeclarationOnly false e --tsBuildInfoFile null evitam o TS5053/TS5069 que as próprias flags provocam no TS 4.9.
const ARGS_TSC = ['--noEmit', '--pretty', 'false', '--composite', 'false', '--incremental', 'false', '--tsBuildInfoFile', 'null', '--emitDeclarationOnly', 'false'];
const EXE0 = '#!/bin/sh\nexit 0\n';
describe('cbs-typecheck — decisão', () => {
  const falha = [{ stack: 'ts', raiz: '/p', linhas: ['src/a.ts(1,7): error TS2322: x'] }];
  test('sem falhas: silêncio e limpa o acumulador', () => {
    assert.deepEqual(tc.decidirSaida({ falhas: [], stopHookActive: false, estourou: false }), { stdout: '', stderr: '', limpar: true });
  });
  test('falha sem stop_hook_active: decision block, mantém o acumulador', () => {
    const s = tc.decidirSaida({ falhas: falha, stopHookActive: false, estourou: false });
    const j = JSON.parse(s.stdout);
    assert.equal(j.decision, 'block'); assert.match(j.reason, /TS2322/); assert.equal(s.stderr, ''); assert.equal(s.limpar, false);
  });
  test('falha com stop_hook_active: só avisa e limpa (sem loop)', () => {
    const s = tc.decidirSaida({ falhas: falha, stopHookActive: true, estourou: false });
    assert.equal(s.stdout, ''); assert.match(s.stderr, /só aviso/); assert.equal(s.limpar, true);
  });
  test('estourou o teto: só avisa', () => {
    const s = tc.decidirSaida({ falhas: [], stopHookActive: false, estourou: true });
    assert.equal(s.stdout, ''); assert.match(s.stderr, /teto/); assert.equal(s.limpar, true);
  });
  test('motivo é resumido', () => {
    const muitas = [{ stack: 'ts', raiz: '/p', linhas: Array.from({ length: 500 }, (_, i) => `src/a.ts(${i},1): error TS1: ${'x'.repeat(50)}`) }];
    assert.ok(JSON.parse(tc.decidirSaida({ falhas: muitas, stopHookActive: false, estourou: false }).stdout).reason.length <= 1600);
  });
});
describe('cbs-typecheck — plano por stack', { skip: !POSIX && 'POSIX' }, () => {
  const SEM_PATH = { PATH: '' };
  test('ts com tsconfig e tsc local → roda o projeto sem ler nem gravar buildinfo (H2)', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'tsconfig.json', '{}'); escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    const [pl] = tc.planejarChecagens([escrever(p, 'src/a.ts', '')], SEM_PATH);
    assert.equal(pl.stack, 'ts'); assert.equal(pl.raiz, p);
    assert.deepEqual(pl.args, [...ARGS_TSC, '-p', path.join(p, 'tsconfig.json')]);
  });
  test('ts sem tsc local → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'tsconfig.json', '{}');
    assert.deepEqual(tc.planejarChecagens([escrever(p, 'a.ts', '')], SEM_PATH), []);
  });
  test('tsconfig solution-style (files: [] + references, JSONC) → checa cada projeto referenciado (H4)', (t) => {
    const p = tmpDoTeste(t);
    escrever(p, 'tsconfig.json', '{\n  // raiz do template Vite react-ts\n  "files": [],\n  "references": [\n    { "path": "./tsconfig.app.json" },\n    { "path": "./tsconfig.node.json" }, /* vírgula final */\n  ],\n}\n');
    escrever(p, 'tsconfig.app.json', '{}'); escrever(p, 'tsconfig.node.json', '{}');
    escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    const planos = tc.planejarChecagens([escrever(p, 'src/a.ts', '')], SEM_PATH);
    assert.deepEqual(planos.map((x) => x.args), [
      [...ARGS_TSC, '-p', path.join(p, 'tsconfig.app.json')],
      [...ARGS_TSC, '-p', path.join(p, 'tsconfig.node.json')],
    ]);
    assert.ok(planos.every((x) => x.stack === 'ts' && x.raiz === p));
  });
  test('solution-style: referência a diretório, solution aninhada e ciclo', (t) => {
    const p = tmpDoTeste(t);
    escrever(p, 'tsconfig.json', '{ "files": [], "references": [{ "path": "./pkg" }, { "path": "./nao-existe.json" }] }');
    escrever(p, 'pkg/tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.lib.json" }, { "path": ".." }] }');
    escrever(p, 'pkg/tsconfig.lib.json', '{}');
    escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    const planos = tc.planejarChecagens([escrever(p, 'src/a.ts', '')], SEM_PATH);
    assert.deepEqual(planos.map((x) => x.args), [[...ARGS_TSC, '-p', path.join(p, 'pkg', 'tsconfig.lib.json')]]);
  });
  test('tsconfig com references e include próprio não é solution-style → roda a raiz', (t) => {
    const p = tmpDoTeste(t);
    escrever(p, 'tsconfig.json', '{ "include": ["src"], "files": [], "references": [{ "path": "./tsconfig.app.json" }] }');
    escrever(p, 'tsconfig.app.json', '{}'); escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    const [pl] = tc.planejarChecagens([escrever(p, 'src/a.ts', '')], SEM_PATH);
    assert.deepEqual(pl.args, [...ARGS_TSC, '-p', path.join(p, 'tsconfig.json')]);
  });
  test('php com phpstan + phpstan.neon.dist → phpstan nos arquivos tocados', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'phpstan.neon.dist', ''); escrever(p, 'vendor/bin/phpstan', EXE0, 0o755);
    const a = escrever(p, 'app/A.php', '<?php');
    const [pl] = tc.planejarChecagens([a], SEM_PATH);
    assert.equal(pl.stack, 'php'); assert.deepEqual(pl.args, ['analyse', '--no-progress', '--error-format=raw', a]);
  });
  test('php com phpstan sem neon → nada', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'vendor/bin/phpstan', EXE0, 0o755);
    assert.deepEqual(tc.planejarChecagens([escrever(p, 'A.php', '')], SEM_PATH), []);
  });
  test('py com [tool.mypy] e mypy no PATH → mypy nos arquivos', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', '[tool.mypy]\nstrict = true\n');
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'mypy', EXE0, 0o755);
    const a = escrever(p, 'm.py', '');
    const [pl] = tc.planejarChecagens([a], { PATH: bin });
    assert.equal(pl.stack, 'py'); assert.equal(pl.bin, path.join(bin, 'mypy')); assert.deepEqual(pl.args, [a]);
  });
  test('py com pyrightconfig.json e pyright local → pyright nos arquivos', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyrightconfig.json', '{}'); const bin = escrever(p, 'node_modules/.bin/pyright', EXE0, 0o755);
    const a = escrever(p, 'm.py', '');
    const [pl] = tc.planejarChecagens([a], SEM_PATH);
    assert.equal(pl.bin, bin); assert.deepEqual(pl.args, [a]);
  });
  test('py sem config de mypy/pyright → nada, mesmo com mypy no PATH', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'pyproject.toml', '[project]\nname = "x"\n');
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'mypy', EXE0, 0o755);
    assert.deepEqual(tc.planejarChecagens([escrever(p, 'm.py', '')], { PATH: bin }), []);
  });
  test('dois .ts do mesmo projeto → uma checagem só', (t) => {
    const p = tmpDoTeste(t); escrever(p, 'tsconfig.json', '{}'); escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    assert.equal(tc.planejarChecagens([escrever(p, 'a.ts', ''), escrever(p, 'b.ts', '')], SEM_PATH).length, 1);
  });
  test('.md → nada', () => assert.deepEqual(tc.planejarChecagens(['/p/README.md'], SEM_PATH), []));
  test('filtrarSaida de ts mantém só erros dos arquivos editados (SP-5)', () => {
    const plano = { stack: 'ts', raiz: '/p', arquivos: ['/p/src/a.ts'] };
    assert.deepEqual(tc.filtrarSaida(plano, 'src/a.ts(1,1): error TS1: x\nsrc/outro.ts(2,2): error TS2: y\n'), ['src/a.ts(1,1): error TS1: x']);
  });
  test('filtrarSaida de ts não atribui erro de a.tsx nem de outro src/a.ts ao arquivo editado', () => {
    const plano = { stack: 'ts', raiz: '/p', arquivos: ['/p/src/a.ts'] };
    const saida = 'src/a.tsx(1,1): error TS1: x\nlib/src/a.ts(1,1): error TS1: y\n/p/src/a.ts(3,3): error TS3: z\n';
    assert.deepEqual(tc.filtrarSaida(plano, saida), ['/p/src/a.ts(3,3): error TS3: z']);
  });
  test('filtrarSaida de php/py mantém toda a saída (só os arquivos tocados foram checados)', () => {
    assert.deepEqual(tc.filtrarSaida({ stack: 'php', raiz: '/p', arquivos: ['/p/A.php'] }, '/p/A.php:3:Erro\n\n'), ['/p/A.php:3:Erro']);
  });
});
describe('cbs-typecheck — arquivos do acumulador', { skip: !POSIX && 'POSIX' }, () => {
  test('aceita só arquivo regular existente dentro do projeto da sessão', (t) => {
    const p = tmpDoTeste(t, 'cbs-proj-'); const fora = tmpDoTeste(t, 'cbs-fora-');
    const dentro = escrever(p, 'src/a.ts', '');
    const alheio = escrever(fora, 'x.ts', '');
    fs.symlinkSync(alheio, path.join(p, 'src', 'link.ts'));
    fs.symlinkSync(fora, path.join(p, 'dirlink'));
    fs.mkdirSync(path.join(p, 'pasta.ts'));
    const lista = [dentro, path.join(p, 'apagado.ts'), alheio, path.join(p, 'src', 'link.ts'), path.join(p, 'dirlink', 'x.ts'),
      path.join(p, 'pasta.ts'), 'src/a.ts', path.join(p, '..', path.basename(fora), 'x.ts')];
    assert.deepEqual(tc.arquivosDoProjeto(lista, p), [dentro]);
  });
  test('cwd ausente, relativo ou inexistente → nenhum arquivo', (t) => {
    const p = tmpDoTeste(t); const a = escrever(p, 'a.ts', '');
    for (const cwd of [undefined, '', 'rel', path.join(p, 'nao-existe')]) assert.deepEqual(tc.arquivosDoProjeto([a], cwd), []);
  });
});
describe('cbs-typecheck — E2E Stop', { skip: !POSIX && 'POSIX' }, () => {
  function projetoTs(t, scriptTsc, tsconfig = '{}') {
    const p = tmpDoTeste(t, 'cbs-tc-');
    escrever(p, 'tsconfig.json', tsconfig);
    escrever(p, 'node_modules/.bin/tsc', scriptTsc, 0o755);
    return { p, a: escrever(p, 'src/a.ts', 'let x: number = "s";') };
  }
  test('bloqueia uma vez e, com stop_hook_active, só avisa e limpa', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\necho "src/a.ts(1,5): error TS2322: Type string is not assignable to type number."\nexit 2\n');
    comum.registrarEdicao('e2e-tc', [a], p);
    const r1 = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-tc', cwd: p, stop_hook_active: false }, { TMPDIR: p });
    assert.equal(r1.code, 0); assert.equal(r1.err, '');
    const j = JSON.parse(r1.out);
    assert.equal(j.decision, 'block'); assert.match(j.reason, /src\/a\.ts\(1,5\): error TS2322/);
    assert.equal(r1.out.trim().split('\n').length, 1, 'um único JSON no stdout');
    assert.deepEqual(comum.lerAcumulador('e2e-tc', p), [a], 'acumulador mantido após o bloqueio');
    const r2 = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-tc', cwd: p, stop_hook_active: true }, { TMPDIR: p });
    assert.equal(r2.code, 0); assert.equal(r2.out, ''); assert.match(r2.err, /só aviso/);
    assert.deepEqual(comum.lerAcumulador('e2e-tc', p), [], 'acumulador limpo');
  });
  test('passa em silêncio e limpa quando o tsc sai 0', (t) => {
    const { p, a } = projetoTs(t, EXE0);
    comum.registrarEdicao('e2e-ok', [a], p);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-ok', cwd: p }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, ''); assert.deepEqual(comum.lerAcumulador('e2e-ok', p), []);
  });
  test('erro só em arquivo não editado não bloqueia (SP-5)', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\necho "src/outro.ts(1,1): error TS2322: x"\nexit 2\n');
    comum.registrarEdicao('e2e-outro', [a], p);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-outro', cwd: p }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, ''); assert.deepEqual(comum.lerAcumulador('e2e-outro', p), []);
  });
  test('estouro do teto só avisa', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\nsleep 5\n');
    comum.registrarEdicao('e2e-teto', [a], p);
    const inicio = Date.now();
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-teto', cwd: p }, { TMPDIR: p, CBS_TYPECHECK_TETO_MS: '300' });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.match(r.err, /teto/);
    assert.ok(Date.now() - inicio < 4000, 'não espera o processo morto terminar');
    assert.deepEqual(comum.lerAcumulador('e2e-teto', p), []);
  });
  test('sem acumulador: silêncio total', (t) => {
    const p = tmpDoTeste(t);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-vazio', cwd: p }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('stdin vazio ou inválido → exit 0 sem saída', () => {
    for (const payload of ['', '{', '[1]']) {
      const r = rodarHook('cbs-typecheck.mjs', payload);
      assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    }
  });
  test('typecheck desligado: não roda nem consome o acumulador', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\necho "src/a.ts(1,5): error TS2322: x"\nexit 2\n');
    comum.registrarEdicao('e2e-desl', [a], p);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-desl', cwd: p }, { TMPDIR: p, CBS_HOOKS_DESLIGADOS: 'typecheck' });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, ''); assert.deepEqual(comum.lerAcumulador('e2e-desl', p), [a]);
  });
  test('solution-style do Vite com erro de tipo → bloqueia (H4)', (t) => {
    // tsc falso com o comportamento medido no TS 5.9/6.0/7.0: -p na raiz solution-style passa sem checar nada.
    const tsc = '#!/bin/sh\nfor a in "$@"; do cfg="$a"; done\ncase "$cfg" in\n  */tsconfig.app.json) echo "src/a.ts(1,5): error TS2322: Type string is not assignable to type number."; exit 2;;\nesac\nexit 0\n';
    const { p, a } = projetoTs(t, tsc, '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }');
    escrever(p, 'tsconfig.app.json', '{ "include": ["src"] }'); escrever(p, 'tsconfig.node.json', '{ "include": ["vite.config.ts"] }');
    comum.registrarEdicao('e2e-sol', [a], p);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-sol', cwd: p }, { TMPDIR: p });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /TS2322/);
  });
  test('incremental com *.tsbuildinfo velho: não lê nem regrava o buildinfo e bloqueia (H2)', (t) => {
    // tsc falso: em modo incremental confia no buildinfo velho (esconde o erro) e o regrava no repo.
    const tsc = '#!/bin/sh\ncase " $* " in\n  *" --incremental false "*) echo "src/a.ts(1,17): error TS1479: The current file is a CommonJS module."; exit 2;;\nesac\necho novo > .cache/app.tsbuildinfo\nexit 0\n';
    const { p, a } = projetoTs(t, tsc, '{ "compilerOptions": { "incremental": true, "tsBuildInfoFile": "./.cache/app.tsbuildinfo" } }');
    const buildinfo = escrever(p, '.cache/app.tsbuildinfo', 'velho');
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao('e2e-inc', [a], tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-inc', cwd: p }, { TMPDIR: tmpSessao });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /TS1479/);
    assert.equal(fs.readFileSync(buildinfo, 'utf8'), 'velho');
  });
  test('composite: não cai no TS6379 nem grava tsbuildinfo em outDir (H2)', (t) => {
    // tsc falso com o comportamento medido: composite + só --incremental false → TS6379 (erro de config, não cita o arquivo);
    // sem as flags grava dist/tsconfig.tsbuildinfo.
    const tsc = '#!/bin/sh\ncase " $* " in\n  *" --composite false "*) ;;\n  *" --incremental false "*) echo "tsconfig.json(1,3): error TS6379: Composite projects may not disable incremental compilation."; exit 2;;\n  *) mkdir -p dist; echo x > dist/tsconfig.tsbuildinfo;;\nesac\necho "src/a.ts(1,5): error TS2322: x"\nexit 2\n';
    const { p, a } = projetoTs(t, tsc, '{ "compilerOptions": { "composite": true, "outDir": "dist" } }');
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao('e2e-comp', [a], tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-comp', cwd: p }, { TMPDIR: tmpSessao });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /TS2322/);
    assert.equal(fs.existsSync(path.join(p, 'dist')), false);
  });
  test('phpstan recebe só os arquivos tocados e a falha bloqueia', (t) => {
    const p = tmpDoTeste(t, 'cbs-tc-'); const log = path.join(p, 'args.log');
    escrever(p, 'composer.json', '{}'); escrever(p, 'phpstan.neon', '');
    escrever(p, 'vendor/bin/phpstan', `#!/bin/sh\necho "$@" > "${log}"\necho "${p}/app/A.php:3:Undefined variable: \\$x"\nexit 1\n`, 0o755);
    const a = escrever(p, 'app/A.php', '<?php'); escrever(p, 'app/B.php', '<?php');
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao('e2e-php', [a], tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-php', cwd: p }, { TMPDIR: tmpSessao });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /A\.php:3:Undefined variable/);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), `analyse --no-progress --error-format=raw ${a}`);
  });
  test('acumulador com arquivo fora do projeto da sessão: não roda o binário de lá', (t) => {
    const fora = projetoTs(t, '');
    const marca = path.join(fora.p, 'rodou');
    escrever(fora.p, 'node_modules/.bin/tsc', `#!/bin/sh\ntouch "${marca}"\necho "src/a.ts(1,1): error TS1: x"\nexit 2\n`, 0o755);
    const p = tmpDoTeste(t, 'cbs-proj-');
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao('e2e-fora', [fora.a], tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: 'e2e-fora', cwd: p }, { TMPDIR: tmpSessao });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
    assert.equal(fs.existsSync(marca), false);
    assert.deepEqual(comum.lerAcumulador('e2e-fora', tmpSessao), []);
  });
});

// ── Task 7, fix round 1: erro de config do tsc avisa, solution-style com include: [] / BOM, âncora do projeto,
// teto com falhas já achadas, SIGKILL, .mypy.ini, cache do mypy fora do repo, ciclo de references por realpath ──
describe('cbs-typecheck — fix round 1 (unidade)', { skip: !POSIX && 'POSIX' }, () => {
  const SEM_PATH = { PATH: '' };
  const falha = [{ stack: 'ts', raiz: '/p', linhas: ['src/a.ts(1,7): error TS2322: x'] }];
  test('teto estourado depois de achar falha: só avisa, mas o aviso traz a falha achada', () => {
    const s = tc.decidirSaida({ falhas: falha, stopHookActive: false, estourou: true });
    assert.equal(s.stdout, ''); assert.match(s.stderr, /teto/); assert.match(s.stderr, /TS2322/); assert.equal(s.limpar, true);
  });
  test('stop_hook_active sem falhas: silêncio e limpa', () => {
    assert.deepEqual(tc.decidirSaida({ falhas: [], stopHookActive: true, estourou: false }), { stdout: '', stderr: '', limpar: true });
  });
  function solution(t, tsconfig) {
    const p = tmpDoTeste(t);
    escrever(p, 'tsconfig.json', tsconfig);
    escrever(p, 'tsconfig.app.json', '{}'); escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    return tc.planejarChecagens([escrever(p, 'src/a.ts', '')], SEM_PATH).map((x) => path.relative(p, x.args.at(-1)));
  }
  test('solution-style com include: [] (sem files) → checa as referências (H4)', (t) => {
    assert.deepEqual(solution(t, '{ "include": [], "references": [{ "path": "./tsconfig.app.json" }] }'), ['tsconfig.app.json']);
  });
  test('solution-style com files: [] e include: [] → checa as referências (H4)', (t) => {
    assert.deepEqual(solution(t, '{ "files": [], "include": [], "references": [{ "path": "./tsconfig.app.json" }] }'), ['tsconfig.app.json']);
  });
  test('tsconfig com BOM UTF-8 é lido (H4)', (t) => {
    assert.deepEqual(solution(t, '﻿{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }'), ['tsconfig.app.json']);
  });
  test('sem files nem include não é solution-style (include padrão) → roda a raiz', (t) => {
    assert.deepEqual(solution(t, '{ "references": [{ "path": "./tsconfig.app.json" }] }'), ['tsconfig.json']);
  });
  test('py só com .mypy.ini e mypy no PATH → mypy nos arquivos', (t) => {
    const p = tmpDoTeste(t); escrever(p, '.mypy.ini', '[mypy]\nstrict = True\n');
    const bin = tmpDoTeste(t, 'cbs-bin-'); escrever(bin, 'mypy', EXE0, 0o755);
    const a = escrever(p, 'm.py', '');
    const [pl] = tc.planejarChecagens([a], { PATH: bin });
    assert.equal(pl?.stack, 'py'); assert.equal(pl.bin, path.join(bin, 'mypy')); assert.deepEqual(pl.args, [a]);
  });
  test('references em ciclo via symlink para o próprio diretório terminam (vistos por realpath)', (t) => {
    const p = tmpDoTeste(t);
    escrever(p, 'tsconfig.json', '{ "files": [], "references": [{ "path": "./laco1" }, { "path": "./laco2" }, { "path": "./tsconfig.app.json" }] }');
    fs.symlinkSync(p, path.join(p, 'laco1')); fs.symlinkSync(p, path.join(p, 'laco2'));
    escrever(p, 'tsconfig.app.json', '{}'); escrever(p, 'node_modules/.bin/tsc', EXE0, 0o755);
    const a = escrever(p, 'src/a.ts', '');
    // Em subprocesso: sem a chave por realpath a recursão é exponencial e travaria o próprio npm test.
    const codigo = `const tc = await import(${JSON.stringify(pathToFileURL(path.join(HOOKS, 'cbs-typecheck.mjs')).href)});
      process.stdout.write(JSON.stringify(tc.planejarChecagens([${JSON.stringify(a)}], { PATH: '' }).map((x) => x.args.at(-1))));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { encoding: 'utf8', timeout: 5000, env: envLimpo() });
    assert.equal(r.error, undefined, 'terminou antes de 5 s');
    assert.deepEqual(JSON.parse(r.stdout), [path.join(p, 'tsconfig.app.json')]);
  });
});
describe('cbs-typecheck — fix round 1 (E2E)', { skip: !POSIX && 'POSIX' }, () => {
  function projetoTs(t, scriptTsc, tsconfig = '{}') {
    const p = tmpDoTeste(t, 'cbs-tc-');
    escrever(p, 'tsconfig.json', tsconfig);
    escrever(p, 'node_modules/.bin/tsc', scriptTsc, 0o755);
    return { p, a: escrever(p, 'src/a.ts', 'let x: number = "s";') };
  }
  function stop(t, sessao, arquivos, payload, env = {}) {
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao(sessao, arquivos, tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: sessao, ...payload }, { TMPDIR: tmpSessao, ...env });
    return { ...r, acumulador: comum.lerAcumulador(sessao, tmpSessao) };
  }
  const ERRO_A = 'echo "src/a.ts(1,5): error TS2322: Type string is not assignable to type number."';
  test('stop_hook_active com o typecheck passando: silêncio e limpa', (t) => {
    const { p, a } = projetoTs(t, EXE0);
    const r = stop(t, 'fr-ativo-ok', [a], { cwd: p, stop_hook_active: true });
    assert.equal(r.code, 0); assert.equal(r.out + r.err, ''); assert.deepEqual(r.acumulador, []);
  });
  test('erro de opção do tsconfig (TS5101) suprime o check: avisa "não verificado", não bloqueia e limpa', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\necho "tsconfig.json(1,40): error TS5101: Option \'baseUrl\' is deprecated and will stop functioning in TypeScript 7.0."\nexit 2\n');
    const r = stop(t, 'fr-ts5101', [a], { cwd: p });
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.match(r.err, /^\[cbs\] typecheck não verificado: tsconfig\.json\(1,40\): error TS5101: /);
    assert.deepEqual(r.acumulador, []);
  });
  test('erro global do tsc sem arquivo (TS5023) também avisa "não verificado"', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\necho "error TS5023: Unknown compiler option \'--x\'."\nexit 1\n');
    const r = stop(t, 'fr-ts5023', [a], { cwd: p });
    assert.equal(r.out, ''); assert.match(r.err, /typecheck não verificado: error TS5023/);
  });
  test('emitDeclarationOnly: --noEmit não provoca TS5053 e o erro do arquivo bloqueia', (t) => {
    // tsc falso com o comportamento medido no TS 4.9: --noEmit + emitDeclarationOnly → TS5053 e nenhum check semântico.
    const tsc = `#!/bin/sh\ncase " $* " in\n  *" --emitDeclarationOnly false "*) ${ERRO_A}; exit 2;;\nesac\necho "error TS5053: Option 'emitDeclarationOnly' cannot be specified with option 'noEmit'."\nexit 1\n`;
    const { p, a } = projetoTs(t, tsc, '{ "compilerOptions": { "declaration": true, "emitDeclarationOnly": true } }');
    const r = stop(t, 'fr-ts5053', [a], { cwd: p });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /TS2322/);
  });
  test('incremental + tsBuildInfoFile: --incremental false não provoca TS5069 e o erro do arquivo bloqueia', (t) => {
    // tsc falso com o comportamento medido no TS 4.9: --incremental false com tsBuildInfoFile no tsconfig → TS5069.
    const tsc = `#!/bin/sh\ncase " $* " in\n  *" --tsBuildInfoFile null "*) ${ERRO_A}; exit 2;;\nesac\necho "tsconfig.json(1,24): error TS5069: Option 'tsBuildInfoFile' cannot be specified without specifying option 'incremental' or option 'composite'."\nexit 2\n`;
    const { p, a } = projetoTs(t, tsc, '{ "compilerOptions": { "incremental": true, "tsBuildInfoFile": "./.cache/app.tsbuildinfo" } }');
    const r = stop(t, 'fr-ts5069', [a], { cwd: p });
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /TS2322/);
  });
  test('âncora é CLAUDE_PROJECT_DIR (cwd corrente num subdir não descarta a edição)', (t) => {
    const { p, a } = projetoTs(t, `#!/bin/sh\n${ERRO_A}\nexit 2\n`);
    const sub = path.join(p, 'docs'); fs.mkdirSync(sub);
    const r = stop(t, 'fr-ancora', [a], { cwd: sub }, { CLAUDE_PROJECT_DIR: p });
    assert.match(JSON.parse(r.out).reason, /TS2322/);
    const r2 = stop(t, 'fr-ancora2', [a], { cwd: p }, { CLAUDE_PROJECT_DIR: tmpDoTeste(t, 'cbs-outro-') });
    assert.equal(r2.out + r2.err, ''); assert.deepEqual(r2.acumulador, []);
  });
  test('teto estourado depois de uma falha: só avisa, com a falha achada, e limpa', (t) => {
    const tsc = `#!/bin/sh\nfor a in "$@"; do cfg="$a"; done\ncase "$cfg" in\n  */tsconfig.app.json) ${ERRO_A}; exit 2;;\nesac\nsleep 5\n`;
    const { p, a } = projetoTs(t, tsc, '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }');
    escrever(p, 'tsconfig.app.json', '{}'); escrever(p, 'tsconfig.node.json', '{}');
    const r = stop(t, 'fr-teto', [a], { cwd: p }, { CBS_TYPECHECK_TETO_MS: '1500' });
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.match(r.err, /teto/); assert.match(r.err, /src\/a\.ts\(1,5\): error TS2322/);
    assert.deepEqual(r.acumulador, []);
  });
  test('timeout mata com SIGKILL: tsc que ignora SIGTERM não prende o hook', (t) => {
    const { p, a } = projetoTs(t, '#!/bin/sh\ntrap "" TERM\nsleep 5\n');
    const inicio = Date.now();
    const r = stop(t, 'fr-kill', [a], { cwd: p }, { CBS_TYPECHECK_TETO_MS: '300' });
    assert.ok(Date.now() - inicio < 4000, `demorou ${Date.now() - inicio} ms`);
    assert.equal(r.out, ''); assert.match(r.err, /teto/);
  });
  test('mypy roda com cache num dir temporário apagado depois — nada de .mypy_cache no repo', (t) => {
    const p = tmpDoTeste(t, 'cbs-py-'); const log = path.join(p, 'cache.log');
    escrever(p, 'pyproject.toml', '[tool.mypy]\nstrict = true\n');
    // mypy falso: grava o cache onde --cache-dir mandar (sem a flag, em ./.mypy_cache, como o de verdade).
    escrever(p, '.venv/bin/mypy', `#!/bin/sh\ncache=.mypy_cache\nif [ "$1" = "--cache-dir" ]; then cache="$2"; fi\nmkdir -p "$cache" && echo x > "$cache/CACHEDIR.TAG"\necho "$cache" > "${log}"\necho "m.py:1: error: Incompatible types in assignment  [assignment]"\nexit 1\n`, 0o755);
    const a = escrever(p, 'm.py', 'x: int = "s"\n');
    const r = stop(t, 'fr-mypy', [a], { cwd: p });
    assert.match(JSON.parse(r.out).reason, /m\.py:1: error: Incompatible types/);
    assert.equal(fs.existsSync(path.join(p, '.mypy_cache')), false);
    const cache = fs.readFileSync(log, 'utf8').trim();
    assert.ok(path.isAbsolute(cache) && !cache.startsWith(p + path.sep), cache);
    assert.equal(fs.existsSync(cache), false, 'cache temporário apagado');
  });
});

// ── 0.13.1: ferramenta indisponível (vendor/bin/pint sem php, exit 127, ENOENT/EACCES) é silenciosa no format e no
// typecheck; só a falha real do formatador avisa. Evidência: 92 × "pint falhou (exit 127)" em projetos Laravel sem php. ──
const LINUX = process.platform === 'linux'; // shebang aninhado (interpretador que é script) só no Linux
describe('cbs-comum — interpretador do shebang', { skip: !POSIX && 'POSIX' }, () => {
  test('#!/usr/bin/env nome: resolve só por diretório absoluto do PATH', (t) => {
    const p = tmpDoTeste(t); const bin = escrever(p, 'bin/fmt', '#!/usr/bin/env cbs-interp\n', 0o755);
    const dir = tmpDoTeste(t, 'cbs-path-'); escrever(dir, 'cbs-interp', EXE0, 0o755);
    assert.equal(comum.interpretadorDisponivel(bin, { PATH: tmpDoTeste(t, 'cbs-vazio-') }), false);
    assert.equal(comum.interpretadorDisponivel(bin, { PATH: dir }), true);
    assert.equal(comum.interpretadorDisponivel(bin, { PATH: path.relative(process.cwd(), dir) }), false, 'entrada relativa do PATH não conta');
  });
  test('#!/usr/bin/env -S nome --flag: pula as opções do env', (t) => {
    const p = tmpDoTeste(t); const bin = escrever(p, 'fmt', '#!/usr/bin/env -S cbs-interp --flag\n', 0o755);
    const dir = tmpDoTeste(t, 'cbs-path-'); escrever(dir, 'cbs-interp', EXE0, 0o755);
    assert.equal(comum.interpretadorDisponivel(bin, { PATH: dir }), true);
    assert.equal(comum.interpretadorDisponivel(bin, { PATH: '' }), false);
  });
  test('#!/caminho/absoluto: precisa existir e ser executável', (t) => {
    const p = tmpDoTeste(t); const naoExec = escrever(p, 'naoexec', EXE0, 0o644);
    assert.equal(comum.interpretadorDisponivel(escrever(p, 'a', '#!/nao/existe/php\n', 0o755), {}), false);
    assert.equal(comum.interpretadorDisponivel(escrever(p, 'b', `#!${naoExec}\n`, 0o755), {}), false);
    assert.equal(comum.interpretadorDisponivel(escrever(p, 'c', '#!/bin/sh\nexit 0\n', 0o755), {}), true);
  });
  test('sem shebang (binário nativo) ou ilegível → disponível (o spawn decide)', (t) => {
    const p = tmpDoTeste(t);
    assert.equal(comum.interpretadorDisponivel(escrever(p, 'nativo', '\x7fELF\x02\x01', 0o755), {}), true);
    assert.equal(comum.interpretadorDisponivel(path.join(p, 'nao-existe'), {}), true);
  });
});
describe('cbs-format — ferramenta indisponível é silenciosa (0.13.1)', { skip: !POSIX && 'POSIX' }, () => {
  function laravel(t, pint) {
    const p = tmpDoTeste(t); escrever(p, 'composer.json', '{}'); escrever(p, 'artisan', '');
    escrever(p, 'vendor/bin/pint', pint, 0o755);
    return { p, a: escrever(p, 'app/A.php', '<?php\n$x=1;') };
  }
  const editar = (p, sessao, env = {}) => rodarHook('cbs-format.mjs', { session_id: sessao, cwd: p, tool_name: 'Edit', tool_input: { file_path: 'app/A.php' } }, { TMPDIR: p, ...env });
  test('E2E: vendor/bin/pint com #!/usr/bin/env php e sem php no PATH → exit 0, stderr vazio, arquivo mantido', (t) => {
    const { p, a } = laravel(t, '#!/usr/bin/env php\n<?php echo "rodou";\n');
    const r = editar(p, 'ind-pint', { PATH: tmpDoTeste(t, 'cbs-sem-php-') });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
    assert.equal(fs.readFileSync(a, 'utf8'), '<?php\n$x=1;');
  });
  test('E2E: pint, ruff, biome e prettier com interpretador ausente → silêncio', (t) => {
    const semInterp = '#!/usr/bin/env cbs-interpretador-ausente\n';
    const casos = {
      pint: [['composer.json', '{}'], ['artisan', ''], ['vendor/bin/pint', semInterp, 0o755], ['A.php', '<?php']],
      ruff: [['pyproject.toml', '[tool.ruff]\n'], ['.venv/bin/ruff', semInterp, 0o755], ['m.py', 'x=1']],
      biome: [['package.json', '{}'], ['biome.json', '{}'], ['node_modules/.bin/biome', semInterp, 0o755], ['a.ts', 'const x=1']],
      prettier: [['package.json', '{}'], ['.prettierrc', '{}'], ['node_modules/.bin/prettier', semInterp, 0o755], ['a.ts', 'const x=1']],
    };
    for (const [ferramenta, arquivos] of Object.entries(casos)) {
      const p = tmpDoTeste(t);
      for (const [rel, conteudo, modo] of arquivos) escrever(p, rel, conteudo, modo);
      const alvo = arquivos.at(-1)[0];
      assert.equal(fmt.escolherFormatador(path.join(p, alvo), { PATH: '' })?.ferramenta, ferramenta, 'o formatador é escolhido');
      const r = rodarHook('cbs-format.mjs', { session_id: `ind-${ferramenta}`, cwd: p, tool_input: { file_path: alvo } }, { TMPDIR: p, PATH: tmpDoTeste(t, 'cbs-vazio-') });
      assert.equal(r.code, 0, ferramenta); assert.equal(r.out + r.err, '', ferramenta);
    }
  });
  test('E2E: wrapper que sai 127 (comando interno ausente) → silêncio', (t) => {
    const { p } = laravel(t, '#!/bin/sh\necho "php: command not found" >&2\nexit 127\n');
    const r = editar(p, 'ind-127');
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: falha real do pint (exit 1) mantém o aviso curto', (t) => {
    const { p, a } = laravel(t, '#!/bin/sh\nexit 1\n');
    const r = editar(p, 'ind-falha');
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.equal(r.err, '[cbs] format: pint falhou em A.php (exit 1) — arquivo mantido\n');
    assert.equal(fs.readFileSync(a, 'utf8'), '<?php\n$x=1;');
  });
  test('rodarFormatador: ENOENT/EACCES do spawn (interpretador aninhado ausente ou sem permissão) → null', { skip: !LINUX && 'Linux' }, (t) => {
    const p = tmpDoTeste(t);
    const naoExec = escrever(p, 'naoexec', EXE0, 0o644);
    const semPy = escrever(p, 'sem-py', '#!/nao/existe/python3\n', 0o755);
    const semPerm = escrever(p, 'sem-perm', `#!${naoExec}\n`, 0o755);
    for (const interp of [semPy, semPerm]) {
      const bin = escrever(p, `fmt-${path.basename(interp)}`, `#!${interp}\n`, 0o755);
      assert.equal(comum.interpretadorDisponivel(bin, {}), true, 'o pré-check não pega o aninhado; o spawn pega');
      assert.equal(fmt.rodarFormatador({ bin, args: [], raiz: p }), null, interp);
    }
  });
});
describe('cbs-typecheck — ferramenta indisponível não bloqueia nem avisa (0.13.1)', { skip: !POSIX && 'POSIX' }, () => {
  function stop(t, sessao, arquivos, cwd, env = {}) {
    const tmpSessao = tmpDoTeste(t, 'cbs-tmp-');
    comum.registrarEdicao(sessao, arquivos, tmpSessao);
    const r = rodarHook('cbs-typecheck.mjs', { session_id: sessao, cwd }, { TMPDIR: tmpSessao, ...env });
    return { ...r, acumulador: comum.lerAcumulador(sessao, tmpSessao) };
  }
  function laravel(t, phpstan) {
    const p = tmpDoTeste(t, 'cbs-tc-'); escrever(p, 'composer.json', '{}'); escrever(p, 'phpstan.neon', '');
    escrever(p, 'vendor/bin/phpstan', phpstan, 0o755);
    return { p, a: escrever(p, 'app/A.php', '<?php') };
  }
  test('E2E: phpstan com #!/usr/bin/env php e sem php no PATH → sem bloqueio, silêncio, limpa', (t) => {
    const { p, a } = laravel(t, '#!/usr/bin/env php\n<?php exit(1);\n');
    const r = stop(t, 'ind-phpstan', [a], p, { PATH: tmpDoTeste(t, 'cbs-sem-php-') });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, ''); assert.deepEqual(r.acumulador, []);
  });
  test('E2E: wrapper do mypy que sai 127 → sem bloqueio, silêncio', (t) => {
    const p = tmpDoTeste(t, 'cbs-py-'); escrever(p, 'pyproject.toml', '[tool.mypy]\n');
    escrever(p, '.venv/bin/mypy', '#!/bin/sh\necho "python3: command not found" >&2\nexit 127\n', 0o755);
    const r = stop(t, 'ind-mypy', [escrever(p, 'm.py', '')], p);
    assert.equal(r.code, 0); assert.equal(r.out + r.err, ''); assert.deepEqual(r.acumulador, []);
  });
  test('E2E: interpretador aninhado ausente (spawn ENOENT) → silêncio, sem "não rodou"', { skip: !LINUX && 'Linux' }, (t) => {
    const { p, a } = laravel(t, '');
    const interp = escrever(p, 'interp', '#!/nao/existe/php\n', 0o755);
    escrever(p, 'vendor/bin/phpstan', `#!${interp}\n`, 0o755);
    const r = stop(t, 'ind-enoent', [a], p);
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: falha real do phpstan (exit 1) continua bloqueando', (t) => {
    const { p, a } = laravel(t, '#!/bin/sh\necho "app/A.php:1:Erro real"\nexit 1\n');
    const r = stop(t, 'ind-real', [a], p);
    assert.equal(r.code, 0); assert.match(JSON.parse(r.out).reason, /A\.php:1:Erro real/);
  });
});

const noVerify = await import(pathToFileURL(path.join(HOOKS, 'cbs-no-verify.mjs')).href);
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
    const r = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } });
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /no-verify/);
  });
  test('E2E: comando sem git sai 0 em silêncio', () => {
    const r = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
  });
  test('E2E: payload inválido sai 0 em silêncio', () => {
    const r = rodarHook('cbs-no-verify.mjs', '{');
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: CBS_HOOKS_DESLIGADOS=no-verify libera', () => {
    const r = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }, { CBS_HOOKS_DESLIGADOS: 'no-verify' });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
  });
  test('E2E: argv do Codex (array) também é checado', () => {
    for (const command of [['git', 'commit', '--no-verify', '-m', 'x'], ['bash', '-lc', 'git push --no-verify']]) {
      const r = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.equal(r.code, 2, JSON.stringify(command)); assert.equal(r.out, ''); assert.match(r.err, /no-verify/);
    }
    const ok = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command: ['git', 'status'] } });
    assert.equal(ok.code, 0); assert.equal(ok.out + ok.err, '');
  });
  test('E2E: erro interno sai 0 com aviso [cbs] no stderr', (t) => {
    // Preload que quebra RegExp#test (usado já no caminho rápido de checarComando) simula falha interna.
    const boom = escrever(tmpDoTeste(t), 'boom.cjs', "RegExp.prototype.test = function () { throw new Error('boom'); };\n");
    const r = rodarHook('cbs-no-verify.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }, { NODE_OPTIONS: `--require=${boom}` });
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.match(r.err, /^\[cbs\] no-verify: erro interno ignorado \(boom\)/);
  });
});

// Formato verificado com o Codex 0.156.1 (Task 10): shell = tool_name "Bash" e apply_patch = "apply_patch"; o comando
// do hook roda via `$SHELL -c` (expande $HOME); exit 2 + stderr bloqueia; timeout em segundos.
describe('codex-hooks.json', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'base', 'codex', 'hooks', 'codex-hooks.json'), 'utf8'));
  const entradas = Object.entries(cfg.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ ev, matcher: g.matcher, ...h }))));
  const script = (e) => e.command.match(/cbs-[a-z-]+\.mjs/)[0];
  // Mesma guarda do settings.json do Claude Code (comandoHook): launcher OU script ausente → no-op; aqui com $HOME literal.
  const comandoCodex = (s) => comandoHook('/CBS-HOME/.claude/hooks', s).replaceAll('/CBS-HOME', '$HOME');
  test('só eventos que o Codex aceita', () => {
    for (const ev of Object.keys(cfg.hooks)) assert.ok(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(ev), ev);
  });
  test('os 4 scripts CBS, cada um uma vez, com o evento e o timeout do settings.json do Claude Code', () => {
    assert.deepEqual(entradas.map(script).sort(), ['cbs-config-protect.mjs', 'cbs-format.mjs', 'cbs-no-verify.mjs', 'cbs-typecheck.mjs']);
    for (const e of entradas) {
      const h = HOOKS_CBS.find((d) => d.script === script(e));
      assert.equal(e.ev, h.evento, h.script); assert.equal(e.timeout, h.timeout, h.script);
    }
  });
  test('matchers com os nomes reais de ferramenta do Codex (Bash, apply_patch); Stop sem matcher', () => {
    // config-protect também em Bash: `apply_patch` rodado pelo shell chega como tool_name "Bash" (medido na review da T10).
    const esperado = { 'cbs-no-verify.mjs': '^Bash$', 'cbs-config-protect.mjs': '^(Bash|apply_patch)$', 'cbs-format.mjs': '^apply_patch$', 'cbs-typecheck.mjs': undefined };
    for (const e of entradas) assert.equal(e.matcher, esperado[script(e)], script(e));
  });
  for (const s of ['cbs-config-protect.mjs', 'cbs-format.mjs', 'cbs-no-verify.mjs', 'cbs-typecheck.mjs']) {
    test(`${s} existe em base/hooks`, () => assert.ok(fs.existsSync(path.join(HOOKS, s)), s));
  }
  test('base/hooks: hooks são .mjs (ESM pela extensão) — nenhum cbs-*.js nem package.json', () => {
    const nomes = fs.readdirSync(HOOKS);
    assert.deepEqual(nomes.filter((n) => n === 'package.json' || /^cbs-.*\.js$/.test(n)), []);
    assert.ok(nomes.includes('cbs-comum.mjs'));
  });
  test('comando = launcher POSIX (H3) com a guarda do comandoHook; nenhum matcher .*, nenhum npx, todos com timeout', { skip: !POSIX && 'POSIX' }, () => {
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
  test('E2E: launcher instalado e script ausente → sai 0 em silêncio', { skip: !POSIX && 'POSIX' }, (t) => {
    const home = tmpDoTeste(t, 'cbs-home-');
    const dir = path.join(home, '.claude', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(HOOKS, 'cbs-node.sh'), path.join(dir, 'cbs-node.sh'));
    fs.writeFileSync(path.join(dir, '.cbs-node-path'), `${process.execPath}\n`);
    for (const e of entradas) {
      const r = spawnSync('sh', ['-c', e.command], { input: '{}', encoding: 'utf8', timeout: 10_000, env: { ...envLimpo(), HOME: home } });
      assert.equal(r.status, 0, script(e)); assert.equal(r.stdout + r.stderr, '', script(e));
    }
  });
  test('E2E: comando do Codex com payload real (Bash) bloqueia --no-verify via launcher', { skip: !POSIX && 'POSIX' }, (t) => {
    const home = tmpDoTeste(t, 'cbs-home-');
    const dir = path.join(home, '.claude', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['cbs-node.sh', 'cbs-no-verify.mjs', 'cbs-comum.mjs']) fs.copyFileSync(path.join(HOOKS, f), path.join(dir, f));
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

// cbs-config-protect: casos derivados de affaan-m/ECC @ e482e57, tests/hooks/config-protection.test.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
const cp = await import(pathToFileURL(path.join(HOOKS, 'cbs-config-protect.mjs')).href);
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
    const p = projeto(t); const r = rodarHook('cbs-config-protect.mjs', ed(p, '.eslintrc.json'));
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /CBS_PERMITIR_CONFIG=1/);
  });
  test('E2E: apply_patch do Codex com command em argv bloqueia', (t) => {
    const p = projeto(t);
    const payload = { cwd: p, tool_name: 'apply_patch', tool_input: { command: ['apply_patch', '*** Begin Patch\n*** Update File: pint.json\n@@\n-{"preset":"laravel"}\n+{}\n*** End Patch'] } };
    assert.equal(rodarHook('cbs-config-protect.mjs', payload).code, 2);
  });
  test('E2E: CBS_PERMITIR_CONFIG=1 e CBS_HOOKS_DESLIGADOS=config liberam', (t) => {
    const p = projeto(t);
    assert.equal(rodarHook('cbs-config-protect.mjs', ed(p, '.eslintrc.json'), { CBS_PERMITIR_CONFIG: '1' }).code, 0);
    assert.equal(rodarHook('cbs-config-protect.mjs', ed(p, '.eslintrc.json'), { CBS_HOOKS_DESLIGADOS: 'config' }).code, 0);
  });
  test('E2E: arquivo comum sai 0 em silêncio', (t) => {
    const p = projeto(t); const r = rodarHook('cbs-config-protect.mjs', ed(p, 'src/app.ts'));
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: payload inválido sai 0 em silêncio', () => {
    const r = rodarHook('cbs-config-protect.mjs', '{'); assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('E2E: payload acima de 16 MiB citando config protegida bloqueia; sem citar passa', (t) => {
    const p = projeto(t); const enorme = 'x'.repeat(comum.LIMITE_STDIN);
    const r = rodarHook('cbs-config-protect.mjs', wr(p, '.eslintrc.json', enorme));
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /CBS_PERMITIR_CONFIG=1/);
    assert.equal(rodarHook('cbs-config-protect.mjs', wr(p, 'src/app.ts', enorme)).code, 0);
  });
  // Hunk com lado antigo de uma linha em branco: o timeout do rodarHook (10 s) transforma travamento em falha.
  test('E2E: hunk de apply_patch com lado antigo em branco não trava (pyproject com e sem [tool.*])', (t) => {
    const p = projeto(t);
    const q = tmpDoTeste(t, 'cbs-config-'); escrever(q, 'pyproject.toml', '[project]\nname = "x"\n\ndependencies = []\n');
    for (const dir of [q, p]) for (const velho of ['-', ' ']) {
      const r = rodarHook('cbs-config-protect.mjs', ap(dir, `*** Update File: pyproject.toml\n@@\n${velho}\n+dependencies = ["b"]`));
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
    const r = rodarHook('cbs-config-protect.mjs', wr(p, 'pyproject.toml', 'x'.repeat(comum.LIMITE_STDIN)));
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
  // Fix round 4: spread em splice/push estourava a pilha (RangeError → "erro interno" → exit 0 = fail open) e o
  // orçamento não era checado ao aplicar os hunks (pyproject de MiB + 200k hunks morria no timeout do hook = fail open).
  const patchBruto = (p, corpo) => ({ cwd: p, tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n${corpo}*** End Patch` } });
  const opsGrandes = (n) => { let s = ''; for (let i = 0; i < n; i++) s += `*** Add File: g/f${i}\n+x\n`; return s; };
  const hunkRuff = '*** Update File: pyproject.toml\n@@\n-line-length = 100\n+line-length = 200\n';
  test('apply_patch com 200k linhas novas num hunk: sem estouro de pilha, [tool.ruff] bloqueia (unitário e E2E)', (t) => {
    const p = projeto(t);
    const payload = patchBruto(p, `*** Update File: pyproject.toml\n@@\n-name = "x"\n+name = "x"\n${'+#\n'.repeat(200_000)}@@\n-line-length = 100\n+line-length = 200\n`);
    const r = av(payload);
    assert.equal(r.bloquear, true); assert.match(r.motivo, /pyproject\.toml \[tool\.ruff\]/);
    const e2e = rodarHook('cbs-config-protect.mjs', payload);
    assert.equal(e2e.code, 2, e2e.err); assert.equal(e2e.out, ''); assert.match(e2e.err, /CBS_PERMITIR_CONFIG=1/);
  });
  test('apply_patch com 200k operações: sem estouro de pilha, hunk em [tool.ruff] bloqueia pela análise', (t) => {
    const p = projeto(t);
    const r = av(patchBruto(p, hunkRuff + opsGrandes(200_000)));
    assert.equal(r.bloquear, true); assert.match(r.motivo, /pyproject\.toml \[tool\.ruff\]/);
  });
  test('erro interno na análise com config protegida no payload bloqueia; sem config citada segue como erro interno', (t) => {
    const p = projeto(t);
    const quebrado = (rel) => {
      const payload = ed(p, rel);
      Object.defineProperty(payload, 'cwd', { get() { throw new Error('boom'); }, enumerable: false }); // JSON.stringify ignora
      return payload;
    };
    const r = av(quebrado('.eslintrc.json'));
    assert.equal(r.bloquear, true); assert.match(r.motivo, /erro interno.*boom/); assert.match(r.motivo, /CBS_PERMITIR_CONFIG=1/);
    assert.throws(() => av(quebrado('src/app.ts')), /boom/);
  });
  // Orçamento de 1 s: decide (pela análise ou pelo estouro) perto do orçamento — nunca segue além dele sem checar.
  test('pyproject de 4 MiB + 60k hunks decide dentro do orçamento (fail closed), não no timeout do hook', (t) => {
    const pad = (i) => String(i).padStart(7, '0');
    const toml = ['[project]\nname = "x"\n'];
    for (let i = 0; i < 400_000; i++) toml.push(`# a${pad(i)}\n`);
    const d = py(t, toml.join('') + '\n[tool.ruff]\nline-length = 100\n');
    const corpo = ['*** Update File: pyproject.toml\n'];
    for (let i = 0; i < 60_000; i++) corpo.push(`@@\n-# a${pad(i)}\n+# b\n+# c\n`);
    corpo.push('@@\n-line-length = 100\n+line-length = 200\n');
    const ini = Date.now();
    const r = cp.avaliarEdicao(patchBruto(d, corpo.join('')), { env: {}, prazoMs: 1000 });
    const ms = Date.now() - ini;
    assert.equal(r.bloquear, true); assert.match(r.motivo, /CBS_PERMITIR_CONFIG=1/);
    assert.ok(ms < 2500, `${ms} ms`);
  });
});

// Codex: apply_patch rodado pelo shell chega como tool_name "Bash", sem workdir e com cwd = raiz da sessão (medido ao
// vivo na review da T10) — caminho relativo pode ser de outro diretório. Config protegida em caminho relativo → bloqueia.
describe('cbs-config-protect — apply_patch pelo shell no Codex (tool_name Bash)', () => {
  // Payload real capturado (Codex 0.156.1, exec_command com workdir "sub"); ids anonimizados, cwd = raiz do repo temporário.
  const capturado = (cwd, command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: .eslintrc.json\n@@\n-{}\n+{\"root\": true}\n*** End Patch\nEOF") => ({
    session_id: 's', turn_id: 't', transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'm',
    permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'exec-1',
  });
  const heredoc = (corpo) => `apply_patch <<'EOF'\n*** Begin Patch\n${corpo}\n*** End Patch\nEOF`;
  const repo = (t) => { const r = tmpDoTeste(t, 'cbs-codex-sh-'); escrever(r, 'sub/.eslintrc.json', '{}'); escrever(r, 'src/app.ts', 'x\n'); return r; };
  const av = (payload, env = {}) => cp.avaliarEdicao(payload, { env });

  test('payload capturado: .eslintrc.json relativo (arquivo só em sub/) bloqueia com o escape na mensagem', (t) => {
    const r = av(capturado(repo(t)));
    assert.equal(r.bloquear, true); assert.match(r.motivo, /\.eslintrc\.json/); assert.match(r.motivo, /CBS_PERMITIR_CONFIG=1/);
  });
  test('E2E: payload capturado sai 2 no stderr; CBS_PERMITIR_CONFIG=1 libera', (t) => {
    const p = repo(t);
    const r = rodarHook('cbs-config-protect.mjs', capturado(p));
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /^CBS: edição de \.eslintrc\.json \(apply_patch pelo shell.*\) bloqueada .*CBS_PERMITIR_CONFIG=1/);
    assert.equal(rodarHook('cbs-config-protect.mjs', capturado(p), { CBS_PERMITIR_CONFIG: '1' }).code, 0);
  });
  test('pyproject.toml, config em subdiretório, Add e Move to relativos também bloqueiam', (t) => {
    const p = repo(t);
    for (const corpo of ['*** Update File: pyproject.toml\n@@\n-a\n+b', '*** Add File: web/.prettierrc\n+{}', '*** Update File: sub/biome.json\n@@\n-a\n+b',
      '*** Update File: src/app.ts\n*** Move to: .ESLINTRC.JSON\n@@\n-x\n+y']) {
      assert.equal(av(capturado(p, heredoc(corpo))).bloquear, true, corpo);
    }
  });
  test('patch pelo shell só com arquivos relativos não protegidos passa (unidade e E2E)', (t) => {
    const p = repo(t);
    const cmd = heredoc('*** Update File: src/app.ts\n@@\n-x\n+y\n*** Add File: nota.txt\n+oi\n*** Add File: sub/package.json\n+{}');
    assert.equal(av(capturado(p, cmd)).bloquear, false);
    const r = rodarHook('cbs-config-protect.mjs', capturado(p, cmd));
    assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  });
  test('caminho absoluto segue a análise normal: criação libera (SP-3), edição de existente bloqueia', (t) => {
    const p = repo(t);
    assert.equal(av(capturado(p, heredoc(`*** Add File: ${path.join(p, '.eslintrc.json')}\n+{}`))).bloquear, false);
    assert.equal(av(capturado(p, heredoc(`*** Update File: ${path.join(p, 'sub', '.eslintrc.json')}\n@@\n-{}\n+{"root": true}`))).bloquear, true);
  });
  test('ferramenta apply_patch (cwd confiável) mantém a criação relativa liberada', (t) => {
    const p = repo(t);
    const payload = { cwd: p, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: .eslintrc.json\n+{}\n*** End Patch' } };
    assert.equal(av(payload).bloquear, false);
  });
});
