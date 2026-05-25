// Detecção, registro e atualização de projetos com BMAD
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ARQ_PROJETOS_BMAD, existe, garantirDir } from './caminhos.js';

const CANDIDATOS_BMAD = ['_bmad', '.bmad-core', '.bmad', 'bmad-core'];

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

function rodarHerdandoTerminal(comando, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(comando, args, { stdio: 'inherit', ...opts });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
    child.on('error', reject);
  });
}

export async function atualizarBmadEmProjeto(dir) {
  if (!(await existe(dir))) {
    console.log(`⚠  ${dir}: diretório não existe mais. Pulando.`);
    return false;
  }
  if (!(await temBmadAqui(dir))) {
    console.log(`⚠  ${dir}: BMAD não detectado. Pulando.`);
    return false;
  }
  console.log(`\n→ Atualizando BMAD em ${dir}...`);
  try {
    await rodarHerdandoTerminal(
      'npx',
      ['--yes', 'bmad-method', 'install', '--action', 'update', '--directory', dir, '--tools', 'claude-code', '--yes'],
      { cwd: dir }
    );
    console.log(`✓ BMAD atualizado em ${dir}\n`);
    return true;
  } catch (e) {
    console.log(`⚠  Falha em ${dir}: ${e.message}\n`);
    return false;
  }
}

export async function limparProjetosInvalidos() {
  const lista = await listarProjetosBmad();
  const validos = [];
  const removidos = [];
  for (const p of lista) {
    if (await existe(p)) validos.push(p);
    else removidos.push(p);
  }
  if (removidos.length > 0) {
    await fs.writeFile(ARQ_PROJETOS_BMAD, validos.join('\n') + (validos.length ? '\n' : ''), 'utf8');
  }
  return { validos, removidos };
}
