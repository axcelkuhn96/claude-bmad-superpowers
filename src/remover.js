// Subcomando: remover
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  DIR_SKILLS, DIR_COMMANDS, DIR_PERSONAS, DIR_SCRIPTS, DIR_AGENTS, DIR_HOOKS, DIR_OVERRIDES, ARQ_VERSAO_INSTALADA,
  ARQ_SETTINGS, MARCADOR, existe,
} from './caminhos.js';
import { lerSettings, retirarHooks, listarHooksCbs } from './hooks-settings.js';

async function arquivoTemMarcador(p) {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return buf.includes(MARCADOR);
  } catch {
    return false;
  }
}

// ~/.claude/hooks/package.json byte a byte como as builds 0.13-dev o gravavam (base/hooks/package.json até virar .mjs).
// Qualquer outro conteúdo é do usuário e fica.
const PKG_HOOKS_DEV = Buffer.from('{ "type": "module" }\n');
async function ehPkgHooksDev(p) {
  try {
    return (await fs.lstat(p)).isFile() && (await fs.readFile(p)).equals(PKG_HOOKS_DEV);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function coletarRemoviveis(dir, lista) {
  if (!(await existe(dir))) return;
  const entradas = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entradas) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await coletarRemoviveis(p, lista);
    } else if (ent.isFile() && (await arquivoTemMarcador(p))) {
      lista.push(p);
    }
  }
}

async function removerDirsVazios(dir) {
  if (!(await existe(dir))) return;
  const entradas = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entradas) {
    if (ent.isDirectory()) {
      const sub = path.join(dir, ent.name);
      await removerDirsVazios(sub);
      try {
        const restantes = await fs.readdir(sub);
        if (restantes.length === 0) await fs.rmdir(sub);
      } catch {}
    }
  }
}

export async function remover(args = []) {
  console.log('🗑  claude-bmad-superpowers — remover\n');
  console.log('Vai remover apenas arquivos com marcador do pacote.');
  console.log(`Customizações em ${DIR_OVERRIDES} serão preservadas.\n`);

  const { dados: settings } = await lerSettings(ARQ_SETTINGS); // inválido → aborta sem tocar em nada (SP-6)
  const entradasCbs = listarHooksCbs(settings).length;

  const alvos = [];
  await coletarRemoviveis(DIR_SKILLS, alvos);
  await coletarRemoviveis(DIR_COMMANDS, alvos);
  await coletarRemoviveis(DIR_PERSONAS, alvos);
  await coletarRemoviveis(DIR_SCRIPTS, alvos);
  await coletarRemoviveis(DIR_AGENTS, alvos);
  await coletarRemoviveis(DIR_HOOKS, alvos);
  // node gravado pro launcher (sem marcador: é só um caminho)
  const nodeGravado = path.join(DIR_HOOKS, '.cbs-node-path');
  if (await existe(nodeGravado)) alvos.push(nodeGravado);
  const pkgHooks = path.join(DIR_HOOKS, 'package.json');
  if (await ehPkgHooksDev(pkgHooks)) alvos.push(pkgHooks);

  if (alvos.length === 0 && entradasCbs === 0) {
    console.log('Nada pra remover.');
    return;
  }

  console.log(`Arquivos a remover (${alvos.length}):`);
  for (const a of alvos) console.log(`  - ${a}`);
  if (entradasCbs) console.log(`  - ${entradasCbs} entrada(s) CBS em ${ARQ_SETTINGS}`);
  console.log();

  if (!args.includes('--sim') && !args.includes('-y')) {
    const rl = readline.createInterface({ input, output });
    const resp = await rl.question('Confirmar remoção? [s/N] ');
    rl.close();
    if (!resp.toLowerCase().startsWith('s')) {
      console.log('Cancelado.');
      return;
    }
  }

  // entradas do settings.json saem ANTES do launcher/.cbs-node-path (H3): nunca há hook registrado apontando pro vazio
  const rs = await retirarHooks(ARQ_SETTINGS);
  if (rs.removidos) console.log(`✓ ${rs.removidos} entrada(s) CBS removida(s) do settings.json (backup em ${rs.backup}).`);
  for (const a of alvos) await fs.rm(a, { force: true });
  await removerDirsVazios(DIR_SKILLS);
  await removerDirsVazios(DIR_COMMANDS);
  await removerDirsVazios(DIR_PERSONAS);
  await removerDirsVazios(DIR_SCRIPTS);
  await removerDirsVazios(DIR_AGENTS);
  await removerDirsVazios(DIR_HOOKS);
  try { await fs.rm(ARQ_VERSAO_INSTALADA, { force: true }); } catch {}

  console.log(`✓ ${alvos.length} arquivo(s) removido(s).`);
  console.log('\nPra remover o plugin Superpowers (dentro do Claude Code):');
  console.log('    /plugin uninstall superpowers@superpowers-marketplace\n');
  console.log('Pra remover BMAD de um projeto (apaga _bmad/ e .claude/skills/bmad-*, preserva _bmad-output/):');
  console.log('    npx bmad-method uninstall --directory <projeto> -y\n');
}
