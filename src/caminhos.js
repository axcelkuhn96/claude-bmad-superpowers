// Resolução cross-platform de caminhos
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RAIZ_PACOTE = path.resolve(__dirname, '..');
export const RAIZ_BASE = path.join(RAIZ_PACOTE, 'base');
export const ARQ_VERSAO = path.join(RAIZ_BASE, 'VERSAO');

export const HOME = os.homedir();
export const RAIZ_CLAUDE = path.join(HOME, '.claude');
export const DIR_SKILLS = path.join(RAIZ_CLAUDE, 'skills');
export const DIR_COMMANDS = path.join(RAIZ_CLAUDE, 'commands');
export const DIR_OVERRIDES = path.join(RAIZ_CLAUDE, 'cbs-overrides');
export const ARQ_VERSAO_INSTALADA = path.join(DIR_OVERRIDES, '.versao-instalada');
export const ARQ_PROJETOS_BMAD = path.join(DIR_OVERRIDES, '.projetos-bmad');

export const MARCADOR = 'claude-bmad-superpowers:base';

export async function lerVersaoPacote() {
  try {
    const v = await fs.readFile(ARQ_VERSAO, 'utf8');
    return v.trim();
  } catch {
    return '0.0.0';
  }
}

export async function lerVersaoInstalada() {
  try {
    const v = await fs.readFile(ARQ_VERSAO_INSTALADA, 'utf8');
    return v.trim();
  } catch {
    return null;
  }
}

export async function garantirDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function existe(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
