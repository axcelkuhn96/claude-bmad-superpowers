// Smoke test da CLI — roda com `node --test test/smoke.js` ou `npm test`.
// Usa um HOME temporário: nunca toca no ~/.claude real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RAIZ, 'bin', 'cli.js');
const BASE = path.join(RAIZ, 'base');
const MARCADOR = 'claude-bmad-superpowers:base';

let homeTmp;
let claude;

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeTmp, USERPROFILE: homeTmp },
    cwd: opts.cwd || homeTmp,
    input: '', // stdin fechado: simula ferramenta Bash sem TTY
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function existe(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listarMd(dir) {
  const out = [];
  async function rec(d) {
    let ents;
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.name.endsWith('.md')) out.push(path.relative(dir, p));
    }
  }
  await rec(dir);
  return out.sort();
}

const RTK_GRUPO = { matcher: 'Bash', hooks: [{ type: 'command', command: '/x/.claude/hooks/rtk-rewrite.sh' }] };
const SETTINGS_INICIAL = { model: 'opus', hooks: { PreToolUse: [RTK_GRUPO] } };
async function lerJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }
function hooksCbs(settings) {
  const out = [];
  for (const [ev, gs] of Object.entries(settings.hooks || {})) for (const g of gs) for (const h of g.hooks) {
    const m = String(h.command).match(/[\\/]\.claude[\\/]hooks[\\/](cbs-[a-z-]+\.mjs)/);
    if (m) out.push(`${ev}:${m[1]}`);
  }
  return out.sort();
}
const HOOKS_ESPERADOS = ['PostToolUse:cbs-format.mjs', 'PreToolUse:cbs-config-protect.mjs', 'PreToolUse:cbs-no-verify.mjs', 'Stop:cbs-typecheck.mjs'];
// arquivos instalados em ~/.claude/hooks (com marcador). TODO(T5): + 'cbs-config-protect.mjs' quando a T5 for mesclada.
const HOOKS_ARQUIVOS = ['cbs-comum.mjs', 'cbs-format.mjs', 'cbs-no-verify.mjs', 'cbs-typecheck.mjs', 'cbs-node.sh'];
const WIN = process.platform === 'win32';

before(async () => {
  homeTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-'));
  claude = path.join(homeTmp, '.claude');
});

after(async () => {
  if (homeTmp) await fs.rm(homeTmp, { recursive: true, force: true });
});

test('cli --help sai com 0 e lista os comandos', () => {
  const { code, out } = cli(['--help']);
  assert.equal(code, 0);
  for (const c of ['instalar', 'instalar-bmad', 'atualizar', 'remover', 'status']) {
    assert.match(out, new RegExp(`^\\s+${c}\\s`, 'm'), `comando ${c} na ajuda`);
  }
  assert.match(out, /--projetos/);
  assert.match(out, /--sem-hooks/);
});

test('comando desconhecido sai com 1', () => {
  const { code, out } = cli(['xyz']);
  assert.equal(code, 1);
  assert.match(out, /Comando desconhecido: xyz/);
});

test('status num HOME vazio não quebra e reporta não instalado', () => {
  const { code, out } = cli(['status']);
  assert.equal(code, 0, out);
  assert.match(out, /Versão instalada em ~\/.claude: \(não instalado\)/);
  assert.match(out, /Skills do pacote ativos \(0\)/);
  assert.match(out, /Projetos BMAD registrados \(0\)/);
  assert.match(out, /models\.yml ausente/);
});

test('instalar com settings.json inválido aborta sem gravar nada', async () => {
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(path.join(claude, 'settings.json'), '{ "hooks": ', 'utf8');
  const { code, out } = cli(['instalar', '--apenas-global', '--skip-superpowers']);
  assert.equal(code, 1, out);
  assert.match(out, /settings\.json inválido/);
  assert.match(out, /--sem-hooks/, 'instalar sugere --sem-hooks');
  assert.equal(await fs.readFile(path.join(claude, 'settings.json'), 'utf8'), '{ "hooks": ');
  assert.ok(!(await existe(path.join(claude, 'skills'))), 'nada copiado');
  assert.ok(!(await existe(path.join(claude, 'hooks'))), 'nenhum hook copiado');
  await fs.writeFile(path.join(claude, 'settings.json'), JSON.stringify(SETTINGS_INICIAL, null, 2), 'utf8');
});

test('instalar --apenas-global copia skills, commands, personas e models.yml', async () => {
  const { code, out } = cli(['instalar', '--apenas-global', '--skip-superpowers']);
  assert.equal(code, 0, out);
  assert.match(out, /Instalação concluída/);

  // versão registrada
  const versao = (await fs.readFile(path.join(BASE, 'VERSAO'), 'utf8')).trim();
  const instalada = (await fs.readFile(path.join(claude, 'cbs-overrides', '.versao-instalada'), 'utf8')).trim();
  assert.equal(instalada, versao);

  // skills: cada SKILL.md do base existe no destino com marcador
  const skillsBase = await listarMd(path.join(BASE, 'skills'));
  assert.ok(skillsBase.length >= 6, `esperava ≥6 skills no base, achei ${skillsBase.length}`);
  for (const rel of skillsBase) {
    const p = path.join(claude, 'skills', rel);
    assert.ok(await existe(p), `skill ${rel} copiada`);
    assert.match(await fs.readFile(p, 'utf8'), new RegExp(MARCADOR), `marcador em ${rel}`);
  }

  // commands
  const cmdsBase = await listarMd(path.join(BASE, 'commands'));
  assert.ok(cmdsBase.includes('atualizar.md') && cmdsBase.includes('instalar-bmad.md'));
assert.ok(cmdsBase.includes('blindar.md'), 'command /blindar no base');
  for (const rel of cmdsBase) {
    assert.ok(await existe(path.join(claude, 'commands', rel)), `command ${rel} copiado`);
  }

  // personas: árvore inteira (ponytail, dominios/, review/ se existir no base)
  const personasBase = await listarMd(path.join(BASE, 'personas'));
  assert.ok(personasBase.includes('ponytail.md'));
  assert.ok(personasBase.some((p) => p.startsWith('dominios' + path.sep)));
  const personasInst = await listarMd(path.join(claude, 'personas'));
  assert.deepEqual(personasInst, personasBase, 'personas instaladas == personas do base');
  const review = personasBase.filter((p) => p.startsWith('review' + path.sep));
  for (const rel of review) {
    assert.ok(await existe(path.join(claude, 'personas', rel)), `persona review ${rel} copiada`);
  }

  // models.yml default → cbs-overrides/models.yml (cópia fiel)
  const modelsBase = await fs.readFile(path.join(BASE, 'config', 'models.yml'), 'utf8');
  const modelsInst = await fs.readFile(path.join(claude, 'cbs-overrides', 'models.yml'), 'utf8');
  assert.equal(modelsInst, modelsBase);
  // papéis com os dois runtimes (claude: agente cbs-* ou modelo; codex: agente ~/.codex/agents)
  const papeis = {
    orchestrator: { claude: 'fable', codex: 'null' },
    architect: { claude: 'cbs-architect', codex: 'architect_sol' },
    implementer_backend: { claude: 'cbs-backend', codex: 'backend_terra' },
    implementer_frontend: { claude: 'cbs-frontend', codex: 'frontend_terra' },
    refactor: { claude: 'cbs-refactor', codex: 'refactor_terra' },
    reviewer: { claude: 'cbs-reviewer', codex: 'reviewer_sol' },
    final_reviewer: { claude: 'cbs-final-reviewer', codex: 'final_reviewer_sol' },
    tester: { claude: 'cbs-tester', codex: 'tester_luna' },
    explorer: { claude: 'cbs-explorer', codex: 'explorer_luna' },
    search: { claude: 'cbs-search', codex: 'search_spark' },
    build_fixer: { claude: 'cbs-build-fixer', codex: 'backend_terra' },
  };
  for (const [papel, esperado] of Object.entries(papeis)) {
    const bloco = modelsBase.match(new RegExp(`^${papel}:[^\\n]*\\n((?:[ \\t]+[^\\n]*\\n?)+)`, 'm'));
    assert.ok(bloco, `papel ${papel} em models.yml`);
    assert.match(bloco[1], new RegExp(`^\\s+claude:\\s*${esperado.claude}\\b`, 'm'), `${papel}.claude`);
    assert.match(bloco[1], new RegExp(`^\\s+codex:\\s*${esperado.codex}\\b`, 'm'), `${papel}.codex`);
  }
  assert.match(modelsBase, /^orchestrator:[\s\S]*?^\s+effort:\s*max/m);

  // agentes cbs-*: cada base/agents/*.md em ~/.claude/agents/ com marcador e frontmatter válido
  const agentsBase = await listarMd(path.join(BASE, 'agents'));
  assert.ok(agentsBase.length >= 10, `esperava ≥10 agentes no base, achei ${agentsBase.length}`);
  for (const rel of agentsBase) {
    const p = path.join(claude, 'agents', rel);
    assert.ok(await existe(p), `agente ${rel} copiado`);
    const txt = await fs.readFile(p, 'utf8');
    assert.match(txt, new RegExp(MARCADOR), `marcador em ${rel}`);
    const fm = txt.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `frontmatter em ${rel}`);
    assert.match(fm[1], new RegExp(`^name:\\s*${path.basename(rel, '.md')}$`, 'm'), `name == arquivo em ${rel}`);
    assert.match(fm[1], /^description:\s*\S/m, `description em ${rel}`);
    assert.match(fm[1], /^model:\s*(sonnet|opus|fable|inherit)$/m, `model em ${rel}`);
    assert.match(fm[1], /^effort:\s*(low|medium|high|xhigh|max)$/m, `effort em ${rel}`);
  }
  // todo agente cbs-* referenciado em models.yml existe
  for (const m of modelsBase.matchAll(/^\s+claude:\s*(cbs-[\w-]+)/gm)) {
    assert.ok(agentsBase.includes(`${m[1]}.md`), `agente ${m[1]} referenciado em models.yml existe em base/agents/`);
  }
  assert.ok(await existe(path.join(claude, 'cbs-overrides', 'agents')), 'cbs-overrides/agents/ criado');

  // hooks: arquivos com marcador (.mjs = ESM pela extensão, sem package.json) + 4 entradas no settings.json, rtk intacto, backup
  for (const h of HOOKS_ARQUIVOS) {
    const p = path.join(claude, 'hooks', h);
    assert.ok(await existe(p), `hook ${h} copiado`);
    assert.match(await fs.readFile(p, 'utf8'), new RegExp(MARCADOR), `marcador em ${h}`);
  }
  if (!WIN) assert.equal(spawnSync('/bin/sh', ['-n', path.join(claude, 'hooks', 'cbs-node.sh')]).status, 0, 'launcher com marcador continua sh válido');
  assert.equal(await fs.readFile(path.join(claude, 'hooks', '.cbs-node-path'), 'utf8'), `${process.execPath}\n`, 'node do instalador gravado pro launcher');
  assert.ok(!(await existe(path.join(claude, 'hooks', 'package.json'))), 'instalar não cria ~/.claude/hooks/package.json');
  const settings = await lerJson(path.join(claude, 'settings.json'));
  assert.deepEqual(hooksCbs(settings), HOOKS_ESPERADOS);
  assert.deepEqual(settings.hooks.PreToolUse[0], RTK_GRUPO);
  assert.equal(settings.model, 'opus');
  assert.ok(await existe(path.join(claude, 'settings.json.cbs-backup')));
});

test('hooks instalados rodam pelo launcher sem package.json; hook .js CommonJS do usuário em ~/.claude/hooks segue funcionando', { skip: WIN && 'POSIX' }, async () => {
  const env = { ...process.env, HOME: homeTmp };
  for (const k of Object.keys(env)) if (k.startsWith('CBS_')) delete env[k];
  const cmd = (await lerJson(path.join(claude, 'settings.json'))).hooks.PreToolUse
    .flatMap((g) => g.hooks).find((h) => /cbs-no-verify\.mjs/.test(h.command)).command;
  const rodar = (command) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) });
  const r = rodar('git commit --no-verify -m x');
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /CBS: bloqueado/);
  const ok = rodar('git status');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.equal(ok.stdout + ok.stderr, '');

  const cjs = path.join(claude, 'hooks', 'meu-hook.js');
  await fs.writeFile(cjs, "const fs = require('node:fs'); process.stdout.write(typeof fs.readFileSync);\n", 'utf8');
  try {
    const u = spawnSync(process.execPath, [cjs], { encoding: 'utf8', env });
    assert.equal(u.status, 0, u.stderr); assert.equal(u.stdout, 'function');
  } finally {
    await fs.rm(cjs);
  }
});

test('instalar --apenas-global copia base/scripts/*.js executáveis e com marcador', async (t) => {
  const origem = path.join(BASE, 'scripts');
  if (!(await existe(origem))) { t.skip('base/scripts/ ainda não existe'); return; }
  const shs = (await fs.readdir(origem)).filter((n) => n.endsWith('.js'));
  assert.ok(shs.length > 0, 'esperava ao menos um .js em base/scripts/');
  for (const nome of shs) {
    const p = path.join(claude, 'scripts', nome);
    assert.ok(await existe(p), `script ${nome} copiado pra ~/.claude/scripts/`);
    const st = await fs.stat(p);
    assert.ok(st.mode & 0o111, `script ${nome} executável`);
    assert.match(await fs.readFile(p, 'utf8'), new RegExp(`^//\\s*${MARCADOR}`, 'm'), `marcador // em ${nome}`);
  }
});

test('instalar de novo não sobrescreve models.yml customizado', async () => {
  const modelsInst = path.join(claude, 'cbs-overrides', 'models.yml');
  const custom = 'implementer: opus\nreviewer: opus\n';
  await fs.writeFile(modelsInst, custom, 'utf8');
  const settingsAntes = await fs.readFile(path.join(claude, 'settings.json'), 'utf8');

  const { code, out } = cli(['instalar', '--apenas-global', '--skip-superpowers']);
  assert.equal(code, 0, out);
  assert.match(out, /models\.yml já existe — preservado/);
  assert.equal(await fs.readFile(modelsInst, 'utf8'), custom);
  assert.equal(await fs.readFile(path.join(claude, 'settings.json'), 'utf8'), settingsAntes, 'segunda instalação não regrava o settings.json');
});

test('atualizar --skip-self-update --skip-bmad preserva models.yml e override sem marcador', async () => {
  const modelsInst = path.join(claude, 'cbs-overrides', 'models.yml');
  const custom = await fs.readFile(modelsInst, 'utf8');
  // persona editada pelo usuário (sem marcador) não pode ser sobrescrita
  const ponytail = path.join(claude, 'personas', 'ponytail.md');
  await fs.writeFile(ponytail, '# meu ponytail\n', 'utf8');
  // node gravado velho (ex.: versão do nvm trocada) → atualizar regrava
  const nodePath = path.join(claude, 'hooks', '.cbs-node-path');
  await fs.writeFile(nodePath, '/node/velho/bin/node\n', 'utf8');
  // hook do pacote apagado → atualizar recopia
  await fs.rm(path.join(claude, 'hooks', 'cbs-no-verify.mjs'));

  const { code, out } = cli(['atualizar', '--skip-self-update', '--skip-bmad']);
  assert.equal(code, 0, out);
  assert.match(out, /Atualização concluída/);
  assert.equal(await fs.readFile(modelsInst, 'utf8'), custom);
  assert.equal(await fs.readFile(ponytail, 'utf8'), '# meu ponytail\n');
  assert.match(out, /customização\(ões\) preservada\(s\)/);
  assert.deepEqual(hooksCbs(await lerJson(path.join(claude, 'settings.json'))), HOOKS_ESPERADOS);
  assert.equal(await fs.readFile(nodePath, 'utf8'), `${process.execPath}\n`);
  assert.match(await fs.readFile(path.join(claude, 'hooks', 'cbs-no-verify.mjs'), 'utf8'), new RegExp(MARCADOR));
  assert.doesNotMatch(out, /hooks[\\/]package\.json/, 'atualizar não fala de package.json em hooks/');
  assert.ok(!(await existe(path.join(claude, 'hooks', 'package.json'))), 'atualizar não cria ~/.claude/hooks/package.json');
});

test('instalar --sem-hooks copia os hooks mas não toca no settings.json; package.json alheio preservado, sem aviso (hooks .mjs)', async () => {
  const outroHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-semhooks-'));
  const rodar = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: outroHome, USERPROFILE: outroHome }, cwd: outroHome, input: '',
  });
  try {
    const pkg = path.join(outroHome, '.claude', 'hooks', 'package.json');
    await fs.mkdir(path.dirname(pkg), { recursive: true });
    await fs.writeFile(pkg, '{ "name": "meus-hooks" }\n', 'utf8');
    const r = rodar(['instalar', '--apenas-global', '--skip-superpowers', '--sem-hooks']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const h of HOOKS_ARQUIVOS) assert.ok(await existe(path.join(outroHome, '.claude', 'hooks', h)), `hook ${h} copiado`);
    assert.match(r.stdout, /registro no settings\.json pulado por --sem-hooks/);
    assert.ok(!(await existe(path.join(outroHome, '.claude', 'settings.json'))));
    assert.doesNotMatch(r.stdout, /hooks[\\/]package\.json|"type": "module"/);
    assert.equal(await fs.readFile(pkg, 'utf8'), '{ "name": "meus-hooks" }\n');

    const a = rodar(['atualizar', '--skip-self-update', '--skip-bmad', '--sem-hooks']);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.doesNotMatch(a.stdout, /hooks[\\/]package\.json|"type": "module"/, 'atualizar também não fala do package.json de hooks/');
    assert.match(a.stdout, /registro no settings\.json pulado por --sem-hooks/, 'atualizar diz o mesmo que o instalar');
    assert.ok(!(await existe(path.join(outroHome, '.claude', 'settings.json'))));
    assert.equal(await fs.readFile(pkg, 'utf8'), '{ "name": "meus-hooks" }\n');
  } finally {
    await fs.rm(outroHome, { recursive: true, force: true });
  }
});

// Estado deixado por uma build 0.13-dev (hooks .js + package.json type:module): entradas .js no settings.json,
// cbs-*.js com marcador e o package.json exatamente como base/hooks/package.json era.
const PKG_DEV = '{ "type": "module" }\n';
const HOOKS_LEGADO = ['cbs-comum.js', 'cbs-no-verify.js', 'cbs-format.js', 'cbs-typecheck.js', 'cbs-config-protect.js'];
async function montarLegado(home, pkgTexto) {
  const dir = path.join(home, '.claude', 'hooks');
  await fs.mkdir(dir, { recursive: true });
  const cmd = (s) => { const l = path.join(dir, 'cbs-node.sh'); const js = path.join(dir, s); return `[ ! -f "${l}" ] || [ ! -f "${js}" ] || sh "${l}" "${js}"`; };
  const grupo = (matcher, s, timeout) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(s), timeout }] });
  const settings = {
    model: 'opus',
    hooks: {
      PreToolUse: [RTK_GRUPO, grupo('Bash', 'cbs-no-verify.js', 10), grupo('Edit|Write|MultiEdit', 'cbs-config-protect.js', 10)],
      PostToolUse: [grupo('Edit|Write|MultiEdit', 'cbs-format.js', 30)],
      Stop: [grupo(null, 'cbs-typecheck.js', 90)],
    },
  };
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8');
  for (const f of HOOKS_LEGADO) await fs.writeFile(path.join(dir, f), `// velho\n\n// ${MARCADOR} v0.13.0 — edite em ~/.claude/cbs-overrides/scripts/ pra não perder no /atualizar\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'cbs-node.sh'), `#!/bin/sh\nexit 0\n\n# ${MARCADOR} v0.13.0 — arquivo do pacote; o /atualizar sobrescreve\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'cbs-meu.js'), '// meu, sem marcador\n', 'utf8');
  await fs.writeFile(path.join(dir, 'package.json'), pkgTexto, 'utf8');
  return dir;
}

test('atualizar sobre build 0.13-dev (hooks .js): troca entradas .js pelas .mjs e apaga cbs-*.js do pacote; --sem-hooks não mexe', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-legado-'));
  const rodar = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, input: '',
  });
  try {
    const dir = await montarLegado(home, PKG_DEV);
    const arq = path.join(home, '.claude', 'settings.json');
    const antes = await fs.readFile(arq, 'utf8');

    // --sem-hooks: settings.json intocado, então os .js que ele ainda referencia ficam
    const s = rodar(['atualizar', '--skip-self-update', '--skip-bmad', '--sem-hooks']);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.equal(await fs.readFile(arq, 'utf8'), antes);
    for (const f of HOOKS_LEGADO) assert.ok(await existe(path.join(dir, f)), `${f} mantido com --sem-hooks`);

    const a = rodar(['atualizar', '--skip-self-update', '--skip-bmad']);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const depois = await lerJson(arq);
    assert.deepEqual(hooksCbs(depois), HOOKS_ESPERADOS);
    assert.doesNotMatch(JSON.stringify(depois), /cbs-[a-z-]+\.js\b/, 'nenhuma entrada .js sobrou');
    assert.deepEqual(depois.hooks.PreToolUse[0], RTK_GRUPO);
    assert.equal(depois.model, 'opus');
    for (const f of HOOKS_LEGADO) assert.ok(!(await existe(path.join(dir, f))), `${f} (do pacote) apagado`);
    assert.equal(await fs.readFile(path.join(dir, 'cbs-meu.js'), 'utf8'), '// meu, sem marcador\n', 'cbs-*.js sem marcador preservado');
    for (const h of HOOKS_ARQUIVOS) assert.match(await fs.readFile(path.join(dir, h), 'utf8'), new RegExp(MARCADOR), `${h} instalado`);
    assert.equal(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), PKG_DEV, 'atualizar não mexe no package.json');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('remover sobre build 0.13-dev: tira entradas .js e cbs-*.js do pacote; package.json só sai se byte-igual ao da 0.13-dev', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-legado-rm-'));
  const rodar = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, input: '',
  });
  try {
    const outroPkg = '{"type":"module"}\n';
    const dir = await montarLegado(home, outroPkg);
    const r = rodar(['remover', '-y']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /4 entrada\(s\) CBS removida\(s\) do settings\.json/);
    assert.deepEqual(await lerJson(path.join(home, '.claude', 'settings.json')), SETTINGS_INICIAL);
    for (const f of [...HOOKS_LEGADO, 'cbs-node.sh']) assert.ok(!(await existe(path.join(dir, f))), `${f} apagado`);
    assert.ok(await existe(path.join(dir, 'cbs-meu.js')), 'cbs-*.js sem marcador preservado');
    assert.equal(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), outroPkg, 'package.json diferente do da 0.13-dev preservado');

    await fs.writeFile(path.join(dir, 'package.json'), PKG_DEV, 'utf8');
    const d = rodar(['remover', '-y']);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /hooks[\\/]package\.json/);
    assert.ok(!(await existe(path.join(dir, 'package.json'))), 'package.json da 0.13-dev apagado');
    assert.ok(await existe(path.join(dir, 'cbs-meu.js')));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('atualizar com settings.json inválido aborta antes de copiar; com --sem-hooks segue sem tocar nele', async () => {
  const arq = path.join(claude, 'settings.json');
  const valido = await fs.readFile(arq, 'utf8');
  const piloto = path.join(claude, 'commands', 'piloto.md');
  await fs.rm(piloto);
  await fs.writeFile(arq, '[1, 2]', 'utf8');
  try {
    const r = cli(['atualizar', '--skip-self-update', '--skip-bmad']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /settings\.json inválido/);
    assert.match(r.out, /--sem-hooks/);
    assert.ok(!(await existe(piloto)), 'nada copiado antes do abort');

    const s = cli(['atualizar', '--skip-self-update', '--skip-bmad', '--sem-hooks']);
    assert.equal(s.code, 0, s.out);
    assert.ok(await existe(piloto));
    assert.equal(await fs.readFile(arq, 'utf8'), '[1, 2]');
  } finally {
    await fs.writeFile(arq, valido, 'utf8');
  }
});

test('HOME com aspas: instalar/atualizar abortam antes de copiar e sugerem --sem-hooks; com --sem-hooks instalam', { skip: WIN && 'aspas não valem em caminho no Windows' }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-aspas-'));
  const home = path.join(base, 'home"q');
  await fs.mkdir(home);
  const rodar = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, input: '',
  });
  try {
    const r = rodar(['instalar', '--apenas-global', '--skip-superpowers']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /caminho inseguro/);
    assert.match(r.stderr, /--sem-hooks/);
    assert.ok(!(await existe(path.join(home, '.claude', 'skills'))), 'nada copiado');
    assert.ok(!(await existe(path.join(home, '.claude', 'hooks'))), 'nenhum hook copiado');

    const s = rodar(['instalar', '--apenas-global', '--skip-superpowers', '--sem-hooks']);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.ok(await existe(path.join(home, '.claude', 'hooks', 'cbs-node.sh')));
    assert.ok(await existe(path.join(home, '.claude', 'cbs-overrides', '.versao-instalada')));
    assert.ok(!(await existe(path.join(home, '.claude', 'settings.json'))));

    const piloto = path.join(home, '.claude', 'commands', 'piloto.md');
    await fs.rm(piloto);
    const a = rodar(['atualizar', '--skip-self-update', '--skip-bmad']);
    assert.equal(a.status, 1, a.stdout + a.stderr);
    assert.match(a.stderr, /caminho inseguro.*--sem-hooks/s);
    assert.ok(!(await existe(piloto)), 'atualizar não copiou nada antes do abort');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('node em caminho com $: sem --sem-hooks aborta antes de copiar; com --sem-hooks instala sem .cbs-node-path', { skip: WIN && 'POSIX' }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-smoke-node-'));
  const node = path.join(base, 'bin$x', 'node');
  await fs.mkdir(path.dirname(node));
  try { await fs.link(process.execPath, node); } catch { await fs.copyFile(process.execPath, node); await fs.chmod(node, 0o755); }
  const rodar = async (nome, args) => {
    const home = path.join(base, nome);
    await fs.mkdir(home, { recursive: true });
    const r = spawnSync(node, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, input: '' });
    return { ...r, claude: path.join(home, '.claude') };
  };
  try {
    const r = await rodar('h1', ['instalar', '--apenas-global', '--skip-superpowers']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /bin\$x.*--sem-hooks/s);
    assert.ok(!(await existe(path.join(r.claude, 'skills'))), 'nada copiado');

    const s = await rodar('h2', ['instalar', '--apenas-global', '--skip-superpowers', '--sem-hooks']);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.match(s.stdout, /\.cbs-node-path não gravado/);
    assert.ok(await existe(path.join(s.claude, 'hooks', 'cbs-node.sh')));
    assert.ok(!(await existe(path.join(s.claude, 'hooks', '.cbs-node-path'))));

    const a = await rodar('h2', ['atualizar', '--skip-self-update', '--skip-bmad', '--sem-hooks']);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /\.cbs-node-path não gravado/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('atualizar sem TTY e sem projetos registrados não bloqueia em prompt', () => {
  const { code, out } = cli(['atualizar', '--skip-self-update']);
  assert.equal(code, 0, out);
  assert.match(out, /Nenhum projeto BMAD registrado/);
});

test('atualizar sem TTY com projeto registrado inválido não bloqueia e limpa o registro', async () => {
  const reg = path.join(claude, 'cbs-overrides', '.projetos-bmad');
  await fs.writeFile(reg, path.join(homeTmp, 'nao-existe') + '\n', 'utf8');
  const { code, out } = cli(['atualizar', '--skip-self-update']);
  assert.equal(code, 0, out);
  assert.match(out, /1 projeto\(s\) inválido\(s\) removido\(s\)/);
  assert.equal((await fs.readFile(reg, 'utf8')).trim(), '');
});

test('status depois de instalar lista skills, personas e models.yml', () => {
  const { code, out } = cli(['status']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /\(não instalado\)/);
  assert.match(out, /Skills do pacote ativos \([1-9]\d*\)/);
  assert.match(out, /Commands do pacote ativos \([1-9]\d*\)/);
  assert.match(out, /Personas instaladas \([1-9]\d* base/);
  assert.match(out, /Agentes do pacote ativos \([1-9]\d* base, 0 override\)/);
  assert.match(out, /^\s+cbs-reviewer\.md$/m);
  assert.match(out, /^\s+cbs-build-fixer\.md$/m);
  assert.match(out, /Modelo por papel: ✓/);
  assert.match(out, /Skills de domínio detectadas:/);
  assert.match(out, /Hooks CBS ativos \(4\)/);
  assert.match(out, /Stop → cbs-typecheck\.mjs/);
  assert.match(out, /PreToolUse \[Bash\] → cbs-no-verify\.mjs$/m);
  assert.doesNotMatch(out, /launcher .* ausente|node gravado .* não existe/);
});

test('status avisa quando o node gravado sumiu e quando o launcher sumiu', async () => {
  const nodePath = path.join(claude, 'hooks', '.cbs-node-path');
  const launcher = path.join(claude, 'hooks', 'cbs-node.sh');
  const salvoNode = await fs.readFile(nodePath, 'utf8');
  const salvoLauncher = await fs.readFile(launcher, 'utf8');
  try {
    await fs.writeFile(nodePath, '/node/sumiu/bin/node\n', 'utf8');
    await fs.rm(launcher);
    const { code, out } = cli(['status']);
    assert.equal(code, 0, out);
    assert.match(out, /node gravado .*\/node\/sumiu\/bin\/node.* não existe mais/);
    assert.match(out, /launcher .*cbs-node\.sh ausente/);

    // .cbs-node-path ilegível (aqui: virou diretório) é reportado, não tratado como "sem node gravado"
    await fs.rm(nodePath);
    await fs.mkdir(nodePath);
    const d = cli(['status']);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /\.cbs-node-path.*ilegível/);
    await fs.rmdir(nodePath);

    // settings.json inválido: status é só leitura — nada de "Nada foi gravado"
    const arq = path.join(claude, 'settings.json');
    const valido = await fs.readFile(arq, 'utf8');
    await fs.writeFile(arq, '{ "hooks": ', 'utf8');
    const i = cli(['status']);
    await fs.writeFile(arq, valido, 'utf8');
    assert.equal(i.code, 0, i.out);
    assert.match(i.out, /Hooks CBS: ✗ settings\.json inválido/);
    assert.match(i.out, /corrija o JSON/i);
    assert.doesNotMatch(i.out, /Nada foi gravado/);
  } finally {
    await fs.rm(nodePath, { recursive: true, force: true });
    await fs.writeFile(nodePath, salvoNode, 'utf8');
    await fs.writeFile(launcher, salvoLauncher, 'utf8');
  }
});

test('instalar-bmad --force sem TTY e sem -y aborta sem apagar nada', async () => {
  const proj = path.join(homeTmp, 'proj-bmad');
  await fs.mkdir(path.join(proj, '_bmad', '_config'), { recursive: true });
  await fs.writeFile(path.join(proj, '_bmad', '_config', 'manifest.yaml'), 'installation:\n  version: 6.12.0\n', 'utf8');
  await fs.mkdir(path.join(proj, '.claude', 'skills', 'bmad-prd'), { recursive: true });

  const { code, out } = cli(['instalar-bmad', '--force'], { cwd: proj });
  assert.equal(code, 1, out);
  assert.match(out, /--force precisa de confirmação/);
  assert.ok(await existe(path.join(proj, '_bmad', '_config', 'manifest.yaml')));
  assert.ok(await existe(path.join(proj, '.claude', 'skills', 'bmad-prd')));
});

test('status lê a versão do BMAD do manifest de um projeto registrado', async () => {
  const proj = path.join(homeTmp, 'proj-bmad');
  const reg = path.join(claude, 'cbs-overrides', '.projetos-bmad');
  await fs.writeFile(reg, proj + '\n', 'utf8');
  const { code, out } = cli(['status'], { cwd: proj });
  assert.equal(code, 0, out);
  assert.match(out, /BMAD no diretório atual: ✓ .*\(v6\.12\.0\)/);
  assert.match(out, /Projetos BMAD registrados \(1\)/);
  assert.match(out, new RegExp(`✓ ${proj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+BMAD 6\\.12\\.0`));
});

test('remover com settings.json inválido aborta sem apagar nada e só manda corrigir o JSON', async () => {
  const arq = path.join(claude, 'settings.json');
  const valido = await fs.readFile(arq, 'utf8');
  await fs.writeFile(arq, '{ "hooks": ', 'utf8');
  try {
    const { code, out } = cli(['remover', '-y']);
    assert.equal(code, 1, out);
    assert.match(out, /settings\.json inválido.*corrija o JSON/);
    assert.doesNotMatch(out, /--sem-hooks/);
    assert.ok(await existe(path.join(claude, 'commands', 'piloto.md')));
    assert.ok(await existe(path.join(claude, 'hooks', 'cbs-node.sh')));
    assert.equal(await fs.readFile(arq, 'utf8'), '{ "hooks": ');
  } finally {
    await fs.writeFile(arq, valido, 'utf8');
  }
});

test('remover -y apaga só arquivos com marcador e preserva cbs-overrides', async () => {
  const { code, out } = cli(['remover', '-y']);
  assert.equal(code, 0, out);
  assert.match(out, /arquivo\(s\) removido\(s\)/);
  assert.ok(!(await existe(path.join(claude, 'commands', 'piloto.md'))));
  assert.ok(!(await existe(path.join(claude, 'scripts', 'gate-seguranca.js'))), 'script com marcador removido');
  assert.ok(!(await existe(path.join(claude, 'agents', 'cbs-reviewer.md'))), 'agente com marcador removido');
  assert.ok(await existe(path.join(claude, 'personas', 'ponytail.md')), 'arquivo sem marcador preservado');
  assert.ok(await existe(path.join(claude, 'cbs-overrides', 'models.yml')));
  assert.match(out, /superpowers@superpowers-marketplace/);
  assert.match(out, /bmad-method uninstall/);
  assert.deepEqual(await lerJson(path.join(claude, 'settings.json')), SETTINGS_INICIAL, 'settings.json volta ao estado anterior');
  assert.ok(!(await existe(path.join(claude, 'hooks', 'cbs-no-verify.mjs'))), 'hook com marcador removido');
  assert.ok(!(await existe(path.join(claude, 'hooks', 'cbs-node.sh'))), 'launcher removido');
  assert.ok(!(await existe(path.join(claude, 'hooks', '.cbs-node-path'))), 'node gravado removido');
  assert.deepEqual((await fs.readdir(path.join(claude, 'hooks'))).filter((f) => f.startsWith('cbs-')), [], 'nenhum cbs-* sobrou em hooks/');
  assert.match(out, /4 entrada\(s\) CBS removida\(s\) do settings\.json/);
});
