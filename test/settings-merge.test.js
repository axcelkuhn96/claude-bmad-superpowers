// Merge idempotente dos hooks CBS no ~/.claude/settings.json (src/hooks-settings.js).
// Nunca toca o ~/.claude real: todo arquivo vive num diretório temporário (mkdtemp) apagado no t.after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HOOKS_CBS, scriptCbs, comandoHook, mesclarHooksCbs, removerHooksCbs, listarHooksCbs, lerSettings, aplicarHooks, retirarHooks,
} from '../src/hooks-settings.js';

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
  assert.deepEqual(HOOKS_CBS.map((h) => h.script).sort(), ['cbs-config-protect.js', 'cbs-format.js', 'cbs-no-verify.js', 'cbs-typecheck.js']);
  for (const h of HOOKS_CBS) assert.ok(h.matcher === null || !h.matcher.includes('.*'), h.script);
  assert.ok(Object.isFrozen(HOOKS_CBS));
});

test('comando é o node absoluto do instalador + caminho absoluto do hook, ambos entre aspas, sem npx', () => {
  const c = comandoHook(DIR, 'cbs-format.js');
  assert.ok(path.isAbsolute(process.execPath));
  assert.equal(c, `"${process.execPath}" "${path.join(DIR, 'cbs-format.js')}"`);
  assert.doesNotMatch(c, /npx/);
});

test('scriptCbs reconhece o hook com node absoluto, node nu e caminho Windows; ignora alheio', () => {
  assert.equal(scriptCbs(comandoHook(DIR, 'cbs-no-verify.js')), 'cbs-no-verify.js');
  assert.equal(scriptCbs('"/opt/node v22/bin/node" "/home/u/.claude/hooks/cbs-format.js"'), 'cbs-format.js');
  assert.equal(scriptCbs('node "/velho/.claude/hooks/cbs-typecheck.js"'), 'cbs-typecheck.js');
  assert.equal(scriptCbs('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.claude\\hooks\\cbs-config-protect.js"'), 'cbs-config-protect.js');
  assert.equal(scriptCbs('/home/u/.claude/hooks/rtk-rewrite.sh'), null);
  assert.equal(scriptCbs('node /proj/hooks/cbs-format.js'), null);
  assert.equal(scriptCbs(undefined), null);
});

test('merge em settings vazio cria as 4 entradas', () => {
  const { settings, mudou } = mesclarHooksCbs({}, DIR);
  assert.equal(mudou, true);
  assert.deepEqual(contar(settings), { 'cbs-no-verify.js': 1, 'cbs-config-protect.js': 1, 'cbs-format.js': 1, 'cbs-typecheck.js': 1 });
  const stop = listarHooksCbs(settings).find((h) => h.script === 'cbs-typecheck.js');
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
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/velho/.claude/hooks/cbs-no-verify.js"' }] });
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/velho/.claude/hooks/cbs-no-verify.js"' }] });
  const { settings, mudou } = mesclarHooksCbs(s, DIR);
  assert.equal(mudou, true);
  assert.equal(contar(settings)['cbs-no-verify.js'], 1);
  assert.equal(listarHooksCbs(settings).find((h) => h.script === 'cbs-no-verify.js').command, comandoHook(DIR, 'cbs-no-verify.js'));
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
  const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }, { type: 'command', command: 'node "/h/.claude/hooks/cbs-typecheck.js"' }] }] } };
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
  assert.deepEqual(contar(JSON.parse(await fs.readFile(arq, 'utf8'))), { 'cbs-no-verify.js': 1, 'cbs-config-protect.js': 1, 'cbs-format.js': 1, 'cbs-typecheck.js': 1 });
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
  assert.deepEqual(contar(depois), { 'cbs-no-verify.js': 1, 'cbs-config-protect.js': 1, 'cbs-format.js': 1, 'cbs-typecheck.js': 1 });
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
