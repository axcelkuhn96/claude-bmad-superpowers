// Subcomando: remover
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  DIR_SKILLS, DIR_COMMANDS, DIR_OVERRIDES, ARQ_VERSAO_INSTALADA, MARCADOR, existe,
} from './caminhos.js';

async function arquivoTemMarcador(p) {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return buf.includes(MARCADOR);
  } catch {
    return false;
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

  const alvos = [];
  await coletarRemoviveis(DIR_SKILLS, alvos);
  await coletarRemoviveis(DIR_COMMANDS, alvos);

  if (alvos.length === 0) {
    console.log('Nada pra remover.');
    return;
  }

  console.log(`Arquivos a remover (${alvos.length}):`);
  for (const a of alvos) console.log(`  - ${a}`);
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

  for (const a of alvos) await fs.rm(a, { force: true });
  await removerDirsVazios(DIR_SKILLS);
  await removerDirsVazios(DIR_COMMANDS);
  try { await fs.rm(ARQ_VERSAO_INSTALADA, { force: true }); } catch {}

  console.log(`✓ ${alvos.length} arquivo(s) removido(s).`);
  console.log('\nPra remover o plugin Superpowers (dentro do Claude Code):');
  console.log('    /plugin uninstall superpowers@obra\n');
  console.log('Pra remover BMAD de um projeto:');
  console.log('    rm -rf <projeto>/.bmad-core <projeto>/docs/prd.md  # ou similar\n');
}
