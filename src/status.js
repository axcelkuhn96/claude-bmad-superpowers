// Subcomando: status
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DIR_SKILLS, DIR_COMMANDS, DIR_OVERRIDES, MARCADOR,
  lerVersaoPacote, lerVersaoInstalada, existe, RAIZ_CLAUDE,
} from './caminhos.js';
import { temBinarioClaude, plugInstalado } from './superpowers.js';
import { temBmadAqui } from './bmad.js';

async function listarComMarcador(dir) {
  if (!(await existe(dir))) return [];
  const out = [];
  async function rec(d) {
    const ents = await fs.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) {
        try {
          const txt = await fs.readFile(p, 'utf8');
          if (txt.includes(MARCADOR)) out.push(p);
        } catch {}
      }
    }
  }
  await rec(dir);
  return out;
}

export async function status(_args = []) {
  console.log('📋 claude-bmad-superpowers — status\n');

  const vPacote = await lerVersaoPacote();
  const vInst = await lerVersaoInstalada();

  console.log(`Versão do pacote (este npx): ${vPacote}`);
  console.log(`Versão instalada em ~/.claude: ${vInst || '(não instalado)'}`);
  if (vInst && vInst !== vPacote) {
    console.log(`  → update disponível: rode  npx claude-bmad-superpowers atualizar`);
  }
  console.log();

  console.log(`~/.claude: ${RAIZ_CLAUDE}`);
  console.log(`Overrides: ${DIR_OVERRIDES}\n`);

  const skills = await listarComMarcador(DIR_SKILLS);
  console.log(`Skills do pacote ativos (${skills.length}):`);
  for (const s of skills) console.log(`  ${s}`);
  console.log();

  const cmds = await listarComMarcador(DIR_COMMANDS);
  console.log(`Commands do pacote ativos (${cmds.length}):`);
  for (const c of cmds) console.log(`  ${c}`);
  console.log();

  const claudeOk = await temBinarioClaude();
  console.log(`Claude Code CLI: ${claudeOk ? '✓ encontrado' : '✗ não encontrado no PATH'}`);

  if (claudeOk) {
    const sp = await plugInstalado('superpowers');
    console.log(`Plugin Superpowers: ${sp ? '✓ instalado' : '✗ não detectado'}`);
  }

  const bmadAqui = await temBmadAqui(process.cwd());
  console.log(`BMAD no diretório atual: ${bmadAqui ? '✓ ' + bmadAqui : '✗ não detectado (rode /instalar-bmad dentro do projeto)'}`);
  console.log();
}
