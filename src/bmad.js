// Detecção e registro de projetos com BMAD
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARQ_PROJETOS_BMAD, existe, garantirDir } from './caminhos.js';

const CANDIDATOS_BMAD = ['.bmad-core', '.bmad', 'bmad-core'];

export async function temBmadAqui(dir) {
  for (const c of CANDIDATOS_BMAD) {
    const p = path.join(dir, c);
    if (await existe(p)) return p;
  }
  return null;
}

export async function listarProjetosBmad() {
  if (!(await existe(ARQ_PROJETOS_BMAD))) return [];
  const txt = await fs.readFile(ARQ_PROJETOS_BMAD, 'utf8');
  return txt.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function registrarProjetoBmad(dir) {
  await garantirDir(path.dirname(ARQ_PROJETOS_BMAD));
  const atuais = await listarProjetosBmad();
  if (atuais.includes(dir)) return;
  atuais.push(dir);
  await fs.writeFile(ARQ_PROJETOS_BMAD, atuais.join('\n') + '\n', 'utf8');
}
