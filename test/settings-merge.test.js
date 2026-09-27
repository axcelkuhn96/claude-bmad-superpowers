// Merge idempotente dos hooks CBS no ~/.claude/settings.json (src/hooks-settings.js).
// Nunca toca o ~/.claude real: todo arquivo vive num diretório temporário (mkdtemp) apagado no t.after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOOKS_CBS, scriptCbs, comandoHook, mesclarHooksCbs, removerHooksCbs, listarHooksCbs, lerSettings, aplicarHooks, retirarHooks,
  gravarCaminhoNode,
} from '../src/hooks-settings.js';

const LAUNCHER = fileURLToPath(new URL('../base/hooks/cbs-node.sh', import.meta.url));

const DIR = path.join(path.sep, 'home', 'u', '.claude', 'hooks');
const RTK = { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/.claude/hooks/rtk-rewrite.sh' }] };
const inicial = () => ({ model: 'opus', hooks: { PreToolUse: [structuredClone(RTK)] }, permissions: { allow: ['Bash(ls:*)'] } });
// Forma do settings.json real do usuário: hook alheio em ~/.claude/hooks, plugins e várias chaves soltas.
const real = () => ({
  env: { FOO: '1' }, permissions: { allow: ['Bash(ls:*)'], deny: [] }, model: 'opus',
  hooks: { PreToolUse: [structuredClone(RTK)] },
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  extraKnownMarketplaces: { x: { source: { source: 'github', repo: 'a/b' } } },
  theme: 'dark', autoCompactEnabled: true,
});
const contar = (s) => listarHooksCbs(s).reduce((m, h) => ({ ...m, [h.script]: (m[h.script] || 0) + 1 }), {});
const tmpDir = async (t) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-settings-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

test('HOOKS_CBS: 4 hooks, matchers estreitos, nunca .*', () => {
  assert.deepEqual(HOOKS_CBS.map((h) => h.script).sort(), ['cbs-config-protect.mjs', 'cbs-format.mjs', 'cbs-no-verify.mjs', 'cbs-typecheck.mjs']);
  for (const h of HOOKS_CBS) assert.ok(h.matcher === null || !h.matcher.includes('.*'), h.script);
  assert.ok(Object.isFrozen(HOOKS_CBS));
});

test('comando é launcher-e-script-se-existirem + sh cbs-node.sh + caminho absoluto do hook, entre aspas, sem npx', () => {
  const c = comandoHook(DIR, 'cbs-format.mjs');
  const l = path.join(DIR, 'cbs-node.sh');
  const js = path.join(DIR, 'cbs-format.mjs');
  assert.equal(c, `[ ! -f "${l}" ] || [ ! -f "${js}" ] || sh "${l}" "${js}"`);
  assert.doesNotMatch(c, /npx/);
  assert.equal(scriptCbs(c), 'cbs-format.mjs');
});

test('launcher sozinho não conta como hook CBS', () => {
  assert.equal(scriptCbs(`sh "${path.join(DIR, 'cbs-node.sh')}"`), null);
  assert.deepEqual(listarHooksCbs({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `sh "${path.join(DIR, 'cbs-node.sh')}"` }] }] } }), []);
});

test('comandoHook recusa HOME com $, crase, aspas ou quebra de linha', () => {
  for (const ruim of ['/home/a$b/.claude/hooks', '/home/a`id`/.claude/hooks', '/home/a"b/.claude/hooks', '/home/a\nb/.claude/hooks']) {
    assert.throws(() => comandoHook(ruim, 'cbs-format.mjs'), /caminho inseguro/, ruim);
  }
  assert.throws(() => mesclarHooksCbs({}, '/home/a$b/.claude/hooks'), /caminho inseguro/);
});

test('guarda: comandoHook falha se o comando gerado não for reconhecido como o próprio script', () => {
  assert.throws(() => comandoHook(DIR, 'rtk-rewrite.sh'), /não reconhecido/);
  assert.throws(() => comandoHook(path.join(path.sep, 'proj', 'hooks'), 'cbs-format.mjs'), /não reconhecido/);
  for (const h of HOOKS_CBS) assert.equal(scriptCbs(comandoHook(DIR, h.script)), h.script);
});

test('aplicarHooks com HOME inseguro não grava nada', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  await fs.writeFile(arq, '{}');
  await assert.rejects(aplicarHooks(arq, '/home/a$b/.claude/hooks'), /caminho inseguro/);
  assert.deepEqual(await fs.readdir(d), ['settings.json']);
  assert.equal(await fs.readFile(arq, 'utf8'), '{}');
});

test('gravarCaminhoNode grava process.execPath em .cbs-node-path e sobrescreve a cada instalação', async (t) => {
  const d = await tmpDir(t); const dir = path.join(d, '.claude', 'hooks');
  const arq = await gravarCaminhoNode(dir, '/velho/bin/node');
  assert.equal(arq, path.join(dir, '.cbs-node-path'));
  assert.equal(await fs.readFile(arq, 'utf8'), '/velho/bin/node\n');
  await gravarCaminhoNode(dir);
  assert.equal(await fs.readFile(arq, 'utf8'), `${process.execPath}\n`);
});

test('gravarCaminhoNode recusa node relativo ou com $, crase, aspas', async (t) => {
  const d = await tmpDir(t); const dir = path.join(d, 'hooks');
  for (const ruim of ['node', '/opt/a$b/node', '/opt/a`id`/node', '/opt/a"b/node', '/opt/a\nb/node']) {
    await assert.rejects(gravarCaminhoNode(dir, ruim), /caminho inseguro|absoluto/, ruim);
  }
  await assert.rejects(fs.access(path.join(dir, '.cbs-node-path')));
});

test('scriptCbs reconhece o hook com node absoluto, node nu e caminho Windows; ignora alheio', () => {
  assert.equal(scriptCbs(comandoHook(DIR, 'cbs-no-verify.mjs')), 'cbs-no-verify.mjs');
  assert.equal(scriptCbs('"/opt/node v22/bin/node" "/home/u/.claude/hooks/cbs-format.mjs"'), 'cbs-format.mjs');
  assert.equal(scriptCbs('node "/velho/.claude/hooks/cbs-typecheck.mjs"'), 'cbs-typecheck.mjs');
  assert.equal(scriptCbs('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.claude\\hooks\\cbs-config-protect.mjs"'), 'cbs-config-protect.mjs');
  assert.equal(scriptCbs('/home/u/.claude/hooks/rtk-rewrite.sh'), null);
  assert.equal(scriptCbs('node /proj/hooks/cbs-format.mjs'), null);
  assert.equal(scriptCbs(undefined), null);
});

// Builds 0.13-dev gravaram os hooks como .js (+ package.json type:module): entradas .js são CBS legadas, a trocar/remover.
const LEGADO = ['cbs-no-verify.js', 'cbs-config-protect.js', 'cbs-format.js', 'cbs-typecheck.js'];
const comandoLegado = (s) => { const l = path.join(DIR, 'cbs-node.sh'); const js = path.join(DIR, s); return `[ ! -f "${l}" ] || [ ! -f "${js}" ] || sh "${l}" "${js}"`; };
const comLegado = () => {
  const s = inicial();
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: comandoLegado('cbs-no-verify.js'), timeout: 10 }] });
  s.hooks.PreToolUse.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: comandoLegado('cbs-config-protect.js'), timeout: 10 }] });
  s.hooks.PostToolUse = [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: comandoLegado('cbs-format.js'), timeout: 30 }] }];
  s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node "/velho/.claude/hooks/cbs-typecheck.js"', timeout: 90 }] }];
  return s;
};

test('scriptCbs reconhece entrada legada .js (build 0.13-dev) e o comandoHook só gera .mjs', () => {
  for (const s of LEGADO) assert.equal(scriptCbs(comandoLegado(s)), s);
  assert.equal(scriptCbs('node "/velho/.claude/hooks/cbs-typecheck.js"'), 'cbs-typecheck.js');
  assert.equal(scriptCbs('node /proj/hooks/cbs-format.js'), null);
  for (const h of HOOKS_CBS) assert.match(comandoHook(DIR, h.script), /cbs-[a-z-]+\.mjs"$/);
});

test('legado .js: merge troca as entradas .js pelas .mjs (uma por hook) sem tocar no alheio; é idempotente', () => {
  const { settings, mudou } = mesclarHooksCbs(comLegado(), DIR);
  assert.equal(mudou, true);
  assert.deepEqual(contar(settings), { 'cbs-no-verify.mjs': 1, 'cbs-config-protect.mjs': 1, 'cbs-format.mjs': 1, 'cbs-typecheck.mjs': 1 });
  assert.doesNotMatch(JSON.stringify(settings), /cbs-[a-z-]+\.js\b/);
  assert.deepEqual(settings.hooks.PreToolUse[0], RTK);
  assert.deepEqual(settings, mesclarHooksCbs(inicial(), DIR).settings);
  assert.equal(mesclarHooksCbs(settings, DIR).mudou, false);
});

test('legado .js: remover tira as entradas .js e volta ao estado anterior', () => {
  const r = removerHooksCbs(comLegado());
  assert.equal(r.removidos, 4);
  assert.deepEqual(r.settings, inicial());
});

test('merge em settings vazio cria as 4 entradas', () => {
  const { settings, mudou } = mesclarHooksCbs({}, DIR);
  assert.equal(mudou, true);
  assert.deepEqual(contar(settings), { 'cbs-no-verify.mjs': 1, 'cbs-config-protect.mjs': 1, 'cbs-format.mjs': 1, 'cbs-typecheck.mjs': 1 });
  const stop = listarHooksCbs(settings).find((h) => h.script === 'cbs-typecheck.mjs');
  assert.equal(stop.evento, 'Stop'); assert.equal(stop.matcher, null);
  for (const h of listarHooksCbs(settings)) {
    const def = HOOKS_CBS.find((d) => d.script === h.script);
    assert.deepEqual([h.evento, h.matcher, h.timeout, h.command], [def.evento, def.matcher, def.timeout, comandoHook(DIR, def.script)]);
  }
});

test('merge preserva hook alheio e chaves alheias', () => {
  const { settings } = mesclarHooksCbs(inicial(), DIR);
  assert.deepEqual(settings.hooks.PreToolUse[0], RTK);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
});

test('merge é idempotente: a segunda passada não muda nada', () => {
  const um = mesclarHooksCbs(inicial(), DIR).settings;
  const dois = mesclarHooksCbs(um, DIR);
  assert.equal(dois.mudou, false);
  assert.deepEqual(dois.settings, um);
  for (const n of Object.values(contar(dois.settings))) assert.equal(n, 1);
});

test('merge corrige duplicata e caminho antigo (node nu) sem tocar no alheio', () => {
  const s = inicial();
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/velho/.claude/hooks/cbs-no-verify.mjs"' }] });
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/velho/.claude/hooks/cbs-no-verify.mjs"' }] });
  const { settings, mudou } = mesclarHooksCbs(s, DIR);
  assert.equal(mudou, true);
  assert.equal(contar(settings)['cbs-no-verify.mjs'], 1);
  assert.equal(listarHooksCbs(settings).find((h) => h.script === 'cbs-no-verify.mjs').command, comandoHook(DIR, 'cbs-no-verify.mjs'));
  assert.deepEqual(settings.hooks.PreToolUse[0], RTK);
});

test('merge não altera o objeto de entrada', () => {
  const s = inicial(); const copia = structuredClone(s);
  mesclarHooksCbs(s, DIR);
  assert.deepEqual(s, copia);
});

test('remover tira só as entradas CBS e volta ao estado anterior', () => {
  const { settings } = mesclarHooksCbs(inicial(), DIR);
  const r = removerHooksCbs(settings);
  assert.equal(r.removidos, 4);
  assert.deepEqual(r.settings, inicial());
});

test('remover em settings que não tinha hooks não deixa "hooks" vazio', () => {
  const { settings } = mesclarHooksCbs({ model: 'x' }, DIR);
  assert.deepEqual(removerHooksCbs(settings).settings, { model: 'x' });
});

test('remover mantém hook alheio no mesmo grupo de um CBS', () => {
  const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }, { type: 'command', command: 'node "/h/.claude/hooks/cbs-typecheck.mjs"' }] }] } };
  assert.deepEqual(removerHooksCbs(s).settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }] }] } });
});

test('lerSettings: ausente → vazio; vazio → {}; inválido → erro que só manda corrigir o JSON', async (t) => {
  const d = await tmpDir(t);
  assert.deepEqual(await lerSettings(path.join(d, 'nao-existe.json')), { existe: false, dados: {} });
  const ruim = path.join(d, 'settings.json');
  await fs.writeFile(ruim, '  \n');
  assert.deepEqual(await lerSettings(ruim), { existe: true, dados: {} });
  for (const texto of ['{ "hooks": ', '[1,2]', 'null', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    await fs.writeFile(ruim, texto);
    await assert.rejects(lerSettings(ruim), (e) => {
      assert.match(e.message, /^settings\.json inválido em .*corrija o JSON\.$/s, texto);
      assert.doesNotMatch(e.message, /--sem-hooks/);
      return true;
    });
  }
});

test('aplicarHooks grava com backup; segunda vez não regrava', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  await fs.writeFile(arq, JSON.stringify(inicial()), { mode: 0o600 });
  const r1 = await aplicarHooks(arq, DIR);
  assert.equal(r1.mudou, true); assert.equal(r1.backup, `${arq}.cbs-backup`);
  assert.deepEqual(JSON.parse(await fs.readFile(r1.backup, 'utf8')), inicial());
  assert.equal((await fs.stat(arq)).mode & 0o777, 0o600, 'modo preservado');
  const conteudo = await fs.readFile(arq, 'utf8');
  const r2 = await aplicarHooks(arq, DIR);
  assert.equal(r2.mudou, false); assert.equal(r2.backup, null);
  assert.equal(await fs.readFile(arq, 'utf8'), conteudo);
  assert.deepEqual((await fs.readdir(d)).sort(), ['settings.json', 'settings.json.cbs-backup'], 'sem temporário esquecido');
});

test('aplicarHooks em settings.json ausente cria o arquivo sem backup', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'sub', 'settings.json');
  const r = await aplicarHooks(arq, DIR);
  assert.deepEqual(r, { mudou: true, backup: null });
  assert.deepEqual(contar(JSON.parse(await fs.readFile(arq, 'utf8'))), { 'cbs-no-verify.mjs': 1, 'cbs-config-protect.mjs': 1, 'cbs-format.mjs': 1, 'cbs-typecheck.mjs': 1 });
});

test('aplicarHooks com JSON inválido não grava nada e sugere --sem-hooks', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  await fs.writeFile(arq, '{ruim');
  await assert.rejects(aplicarHooks(arq, DIR), /settings\.json inválido.*corrija o JSON ou rode com --sem-hooks/s);
  assert.equal(await fs.readFile(arq, 'utf8'), '{ruim');
  await assert.rejects(fs.access(`${arq}.cbs-backup`));
  assert.deepEqual(await fs.readdir(d), ['settings.json']);
});

test('aplicarHooks em settings.json que é symlink grava no alvo e mantém o link', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const d = await tmpDir(t); const alvo = path.join(d, 'real.json'); const link = path.join(d, 'settings.json');
  await fs.writeFile(alvo, JSON.stringify(real()), { mode: 0o640 }); await fs.chmod(alvo, 0o640); await fs.symlink(alvo, link);
  const r = await aplicarHooks(link, DIR);
  assert.equal(r.backup, `${link}.cbs-backup`);
  assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.equal(await fs.readlink(link), alvo);
  assert.equal((await fs.stat(alvo)).mode & 0o777, 0o640, 'modo do alvo preservado');
  assert.equal(listarHooksCbs(JSON.parse(await fs.readFile(alvo, 'utf8'))).length, 4);
  const rr = await retirarHooks(link);
  assert.equal(rr.removidos, 4);
  assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.deepEqual(JSON.parse(await fs.readFile(alvo, 'utf8')), real());
});

test('settings real: instalar duas vezes = uma entrada por hook CBS; remover devolve o estado anterior', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  await fs.writeFile(arq, JSON.stringify(real(), null, 2));
  await aplicarHooks(arq, DIR);
  await aplicarHooks(arq, DIR);
  const depois = JSON.parse(await fs.readFile(arq, 'utf8'));
  assert.deepEqual(contar(depois), { 'cbs-no-verify.mjs': 1, 'cbs-config-protect.mjs': 1, 'cbs-format.mjs': 1, 'cbs-typecheck.mjs': 1 });
  assert.deepEqual(depois.hooks.PreToolUse[0], RTK);
  const { hooks: _h, ...semHooks } = depois; const { hooks: _r, ...realSemHooks } = real();
  assert.deepEqual(semHooks, realSemHooks);
  await retirarHooks(arq);
  assert.deepEqual(JSON.parse(await fs.readFile(arq, 'utf8')), real());
});

test('retirarHooks devolve o arquivo ao estado anterior menos as entradas CBS', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  await fs.writeFile(arq, JSON.stringify(inicial()));
  await aplicarHooks(arq, DIR);
  const r = await retirarHooks(arq);
  assert.equal(r.removidos, 4);
  assert.deepEqual(JSON.parse(await fs.readFile(arq, 'utf8')), inicial());
});

test('retirarHooks: ausente ou sem CBS não grava; inválido aborta só mandando corrigir o JSON', async (t) => {
  const d = await tmpDir(t); const arq = path.join(d, 'settings.json');
  assert.deepEqual(await retirarHooks(arq), { removidos: 0, backup: null });
  await assert.rejects(fs.access(arq));
  await fs.writeFile(arq, JSON.stringify(inicial()));
  assert.deepEqual(await retirarHooks(arq), { removidos: 0, backup: null });
  await assert.rejects(fs.access(`${arq}.cbs-backup`));
  await fs.writeFile(arq, '{ruim');
  await assert.rejects(retirarHooks(arq), (e) => {
    assert.match(e.message, /corrija o JSON\.$/);
    assert.doesNotMatch(e.message, /--sem-hooks/);
    return true;
  });
  assert.equal(await fs.readFile(arq, 'utf8'), '{ruim');
  assert.deepEqual(await fs.readdir(d), ['settings.json']);
});

// ---- launcher base/hooks/cbs-node.sh (POSIX) ----
// Ambiente montado à mão: HOME temporário, PATH só com as ferramentas que o launcher usa (sem node).
const FERRAMENTAS = ['sh', 'dirname', 'sed', 'sort', 'tail', 'cut'];
async function cenario(t) {
  const d = await tmpDir(t);
  const home = path.join(d, 'home'); const hooks = path.join(home, '.claude', 'hooks'); const bin = path.join(d, 'bin');
  await fs.mkdir(hooks, { recursive: true }); await fs.mkdir(bin);
  for (const f of FERRAMENTAS) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${f}`], { encoding: 'utf8' });
    await fs.symlink(r.stdout.trim(), path.join(bin, f));
  }
  await fs.copyFile(LAUNCHER, path.join(hooks, 'cbs-node.sh'));
  const js = path.join(hooks, 'cbs-x.mjs');
  await fs.writeFile(js, "let e='';process.stdin.on('data',(c)=>{e+=c}).on('end',()=>{process.stdout.write('real:'+e);process.exit(Number(process.argv[2]||0))});");
  const falso = async (arq, nome) => {
    await fs.mkdir(path.dirname(arq), { recursive: true });
    await fs.writeFile(arq, `#!/bin/sh\necho "${nome} $*"\n`, { mode: 0o755 });
  };
  const rodar = (args = [], input = '') => spawnSync('/bin/sh', [path.join(hooks, 'cbs-node.sh'), js, ...args], {
    encoding: 'utf8', input, env: { HOME: home, PATH: bin },
  });
  return { d, home, hooks, bin, js, falso, rodar };
}

test('launcher: usa o node gravado, repassa stdin/stdout e o código de saída (2 e 0)', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  await gravarCaminhoNode(c.hooks, process.execPath);
  const r2 = c.rodar(['2'], 'payload');
  assert.deepEqual([r2.status, r2.stdout, r2.stderr], [2, 'real:payload', '']);
  const r0 = c.rodar(['0'], 'x');
  assert.deepEqual([r0.status, r0.stdout], [0, 'real:x']);
});

test('launcher: node gravado sumiu → cai no node do PATH', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  await gravarCaminhoNode(c.hooks, path.join(c.d, 'nao-existe', 'node'));
  await c.falso(path.join(c.bin, 'node'), 'path-node');
  const r = c.rodar(['a']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `path-node ${c.js} a\n`);
});

test('launcher: sem node gravado nem no PATH → node mais novo do nvm (ordem numérica)', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  for (const v of ['v9.11.2', 'v18.20.4', 'v22.3.0', 'v22.10.1']) await c.falso(path.join(c.home, '.nvm', 'versions', 'node', v, 'bin', 'node'), v);
  const r = c.rodar();
  assert.equal(r.stdout, `v22.10.1 ${c.js}\n`);
});

test('launcher: respeita NVM_DIR e cai no fnm/volta quando não há nvm', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  const outro = path.join(c.d, 'nvm-custom');
  await c.falso(path.join(outro, 'versions', 'node', 'v20.1.0', 'bin', 'node'), 'nvmdir');
  let r = spawnSync('/bin/sh', [path.join(c.hooks, 'cbs-node.sh'), c.js], { encoding: 'utf8', env: { HOME: c.home, PATH: c.bin, NVM_DIR: outro } });
  assert.equal(r.stdout, `nvmdir ${c.js}\n`);
  await c.falso(path.join(c.home, '.local', 'share', 'fnm', 'node-versions', 'v21.0.0', 'installation', 'bin', 'node'), 'fnm');
  assert.equal(c.rodar().stdout, `fnm ${c.js}\n`);
  await fs.rm(path.join(c.home, '.local'), { recursive: true });
  await c.falso(path.join(c.home, '.volta', 'bin', 'node'), 'volta');
  assert.equal(c.rodar().stdout, `volta ${c.js}\n`);
});

test('launcher: nenhum node em lugar nenhum → exit 0 sem saída', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  const r = c.rodar(['2'], 'payload');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('launcher é POSIX: passa em sh -n e não usa bashismos óbvios', { skip: process.platform === 'win32' && 'POSIX' }, async () => {
  const texto = await fs.readFile(LAUNCHER, 'utf8');
  assert.equal(spawnSync('/bin/sh', ['-n', LAUNCHER]).status, 0);
  assert.match(texto, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(texto, /\[\[|^\s*(function|local|declare|shopt|source)\s|\$\(\(|<<<|\$\{[^}]*\/\/|&>/m);
});

// ---- comando exato gravado no settings.json, rodado como o Claude Code roda (sh -c) ----
test('comando: launcher apagado (desinstalação parcial) → exit 0 sem saída, não bloqueia a sessão', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  await gravarCaminhoNode(c.hooks, process.execPath);
  await fs.rm(path.join(c.hooks, 'cbs-node.sh'));
  const r = spawnSync('/bin/sh', ['-c', comandoHook(c.hooks, 'cbs-x.mjs')], { encoding: 'utf8', input: 'payload', env: { HOME: c.home, PATH: c.bin } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('comando: script do hook ausente (ainda não instalado ou apagado) → exit 0 sem saída', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  await gravarCaminhoNode(c.hooks, process.execPath);
  const r = spawnSync('/bin/sh', ['-c', comandoHook(c.hooks, 'cbs-nao-instalado.mjs')], { encoding: 'utf8', input: 'payload', env: { HOME: c.home, PATH: c.bin } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('comando: hook que sai com 2 devolve 2 (bloqueio intencional preservado); 0 devolve 0', { skip: process.platform === 'win32' && 'POSIX' }, async (t) => {
  const c = await cenario(t);
  await gravarCaminhoNode(c.hooks, process.execPath);
  await fs.writeFile(path.join(c.hooks, 'cbs-bloqueia.mjs'), "process.stderr.write('bloqueado');process.exit(2);");
  const env = { HOME: c.home, PATH: c.bin };
  const r2 = spawnSync('/bin/sh', ['-c', comandoHook(c.hooks, 'cbs-bloqueia.mjs')], { encoding: 'utf8', env });
  assert.deepEqual([r2.status, r2.stderr], [2, 'bloqueado']);
  const r0 = spawnSync('/bin/sh', ['-c', comandoHook(c.hooks, 'cbs-x.mjs')], { encoding: 'utf8', input: 'oi', env });
  assert.deepEqual([r0.status, r0.stdout], [0, 'real:oi']);
});
