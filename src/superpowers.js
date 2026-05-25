// Detecção e instalação do plugin Superpowers
// IMPORTANTE: usamos execFile (não exec/shell) pra evitar injeção. Args vão como array.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RAIZ_CLAUDE } from './caminhos.js';

const rodar = promisify(execFile);
const ARQ_PLUGINS = path.join(RAIZ_CLAUDE, 'plugins', 'installed_plugins.json');

export async function temBinarioClaude() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await rodar(cmd, ['claude']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detecta se Superpowers está instalado lendo o registry de plugins do Claude Code.
 * Estrutura: ~/.claude/plugins/installed_plugins.json — { plugins: { "nome@marketplace": [...] } }
 */
export async function plugInstalado(nome) {
  try {
    const buf = await fs.readFile(ARQ_PLUGINS, 'utf8');
    const json = JSON.parse(buf);
    const chaves = Object.keys(json.plugins || {});
    return chaves.some((k) => k.toLowerCase().includes(nome.toLowerCase()));
  } catch {
    return false;
  }
}

const INSTRUCOES_SUPERPOWERS = `
   Pra instalar o Superpowers, dentro do Claude Code rode:

     /plugin marketplace add obra/superpowers-marketplace
     /plugin install superpowers@superpowers-marketplace

   (a instalação via CLI fora do Claude Code não funciona pra plugins)
`;

export async function tentarInstalarSuperpowers() {
  if (await plugInstalado('superpowers')) {
    console.log('✓ Plugin Superpowers já está instalado.\n');
    return;
  }
  console.log('⚠  Plugin Superpowers não detectado em ~/.claude/plugins/.');
  console.log(INSTRUCOES_SUPERPOWERS);
}

export async function tentarAtualizarSuperpowers() {
  if (!(await plugInstalado('superpowers'))) {
    console.log('⚠  Plugin Superpowers não instalado.');
    console.log(INSTRUCOES_SUPERPOWERS);
    return;
  }
  console.log('→ Pra atualizar o Superpowers, dentro do Claude Code rode:');
  console.log('     /plugin update superpowers@superpowers-marketplace\n');
}
