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
  assert.match(modelsBase, /^implementer:\s*sonnet/m);
  assert.match(modelsBase, /^reviewer:\s*opus/m);
  assert.match(modelsBase, /^final_review:\s*opus/m);
  assert.match(modelsBase, /^e2e:\s*sonnet/m);
  assert.match(modelsBase, /^investigar:\s*inherit/m);
});

test('instalar de novo não sobrescreve models.yml customizado', async () => {
  const modelsInst = path.join(claude, 'cbs-overrides', 'models.yml');
  const custom = 'implementer: opus\nreviewer: opus\n';
  await fs.writeFile(modelsInst, custom, 'utf8');

  const { code, out } = cli(['instalar', '--apenas-global', '--skip-superpowers']);
  assert.equal(code, 0, out);
  assert.match(out, /models\.yml já existe — preservado/);
  assert.equal(await fs.readFile(modelsInst, 'utf8'), custom);
});

test('atualizar --skip-self-update --skip-bmad preserva models.yml e override sem marcador', async () => {
  const modelsInst = path.join(claude, 'cbs-overrides', 'models.yml');
  const custom = await fs.readFile(modelsInst, 'utf8');
  // persona editada pelo usuário (sem marcador) não pode ser sobrescrita
  const ponytail = path.join(claude, 'personas', 'ponytail.md');
  await fs.writeFile(ponytail, '# meu ponytail\n', 'utf8');

  const { code, out } = cli(['atualizar', '--skip-self-update', '--skip-bmad']);
  assert.equal(code, 0, out);
  assert.match(out, /Atualização concluída/);
  assert.equal(await fs.readFile(modelsInst, 'utf8'), custom);
  assert.equal(await fs.readFile(ponytail, 'utf8'), '# meu ponytail\n');
  assert.match(out, /customização\(ões\) preservada\(s\)/);
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
  assert.match(out, /Modelo por papel: ✓/);
  assert.match(out, /Skills de domínio detectadas:/);
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

test('remover -y apaga só arquivos com marcador e preserva cbs-overrides', async () => {
  const { code, out } = cli(['remover', '-y']);
  assert.equal(code, 0, out);
  assert.match(out, /arquivo\(s\) removido\(s\)/);
  assert.ok(!(await existe(path.join(claude, 'commands', 'piloto.md'))));
  assert.ok(await existe(path.join(claude, 'personas', 'ponytail.md')), 'arquivo sem marcador preservado');
  assert.ok(await existe(path.join(claude, 'cbs-overrides', 'models.yml')));
  assert.match(out, /superpowers@superpowers-marketplace/);
  assert.match(out, /bmad-method uninstall/);
});
