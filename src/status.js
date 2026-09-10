// Subcomando: status
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DIR_SKILLS, DIR_COMMANDS, DIR_PERSONAS, DIR_OVERRIDES, MARCADOR,
  lerVersaoPacote, lerVersaoInstalada, existe, RAIZ_CLAUDE,
} from './caminhos.js';
import { temBinarioClaude, plugInstalado, versoesPlugin } from './superpowers.js';
import { temBmadAqui, versaoBmadEm, listarProjetosBmad } from './bmad.js';

// skills de domínio que o roteador de personas (executor) sabe usar se estiverem presentes
const SKILLS_DOMINIO = [
  { nome: 'frontend-design', tipo: 'plugin', uso: 'frontend greenfield' },
  { nome: 'ui-ux-pro-max', tipo: 'plugin', uso: 'reviewer de UI (a11y, touch)' },
  { nome: 'design-taste-frontend', tipo: 'skill', uso: 'frontend greenfield (taste-skill)' },
  { nome: 'redesign-existing-projects', tipo: 'skill', uso: 'frontend em projeto existente (taste-skill)' },
  { nome: 'dba', tipo: 'skill', uso: 'database' },
];

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

// lista *.md relativos a `dir` (ex.: ponytail.md, dominios/frontend.md, review/seguranca.md)
async function listarMd(dir) {
  if (!(await existe(dir))) return [];
  const out = [];
  async function rec(d) {
    const ents = await fs.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(path.relative(dir, p));
    }
  }
  await rec(dir);
  return out.sort();
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

  // personas: base (~/.claude/personas) + overrides (~/.claude/cbs-overrides/personas)
  const personasBase = await listarMd(DIR_PERSONAS);
  const personasOverride = await listarMd(path.join(DIR_OVERRIDES, 'personas'));
  console.log(`Personas instaladas (${personasBase.length} base, ${personasOverride.length} override):`);
  for (const p of personasBase) {
    const sobrescrita = personasOverride.includes(p) ? '  (sobrescrita em cbs-overrides/)' : '';
    console.log(`  ${p}${sobrescrita}`);
  }
  for (const p of personasOverride) {
    if (!personasBase.includes(p)) console.log(`  ${p}  (só em cbs-overrides/)`);
  }
  const review = personasBase.filter((p) => p.startsWith('review' + path.sep));
  if (review.length === 0) console.log('  ⚠  nenhuma persona em personas/review/ (seguranca, cobertura-de-testes)');
  const modelsYml = path.join(DIR_OVERRIDES, 'models.yml');
  console.log(`Modelo por papel: ${(await existe(modelsYml)) ? '✓ ' + modelsYml : '✗ cbs-overrides/models.yml ausente (rode instalar/atualizar)'}`);
  console.log();

  // Claude Code + Superpowers (a detecção lê installed_plugins.json; não depende do binário)
  const claudeOk = await temBinarioClaude();
  console.log(`Claude Code CLI: ${claudeOk ? '✓ encontrado' : '✗ não encontrado no PATH'}`);
  const sp = await versoesPlugin('superpowers');
  if (sp.length === 0) {
    console.log(`Plugin Superpowers: ${(await plugInstalado('superpowers')) ? '✓ instalado (versão não lida)' : '✗ não detectado'}`);
  } else {
    const usuario = sp.find((e) => e.scope === 'user') || sp[0];
    console.log(`Plugin Superpowers: ✓ ${usuario.version} (${usuario.chave}, escopo ${usuario.scope})`);
    const outras = sp.filter((e) => e !== usuario && e.version !== usuario.version);
    for (const o of outras) console.log(`  também: ${o.version} (${o.chave}, escopo ${o.scope}${o.projectPath ? ' em ' + o.projectPath : ''})`);
  }
  console.log();

  // skills de domínio (usadas pelo roteador de personas quando presentes)
  console.log('Skills de domínio detectadas:');
  for (const sd of SKILLS_DOMINIO) {
    const tem = sd.tipo === 'plugin'
      ? await plugInstalado(sd.nome)
      : await existe(path.join(DIR_SKILLS, sd.nome, 'SKILL.md'));
    console.log(`  ${tem ? '✓' : '✗'} ${sd.nome} (${sd.tipo}) — ${sd.uso}`);
  }
  console.log();

  // BMAD: diretório atual + projetos registrados (versão lida de _bmad/_config/manifest.yaml)
  const cwd = process.cwd();
  const bmadAqui = await temBmadAqui(cwd);
  if (bmadAqui) {
    const v = await versaoBmadEm(cwd);
    console.log(`BMAD no diretório atual: ✓ ${bmadAqui}${v ? ' (v' + v + ')' : ''}`);
  } else {
    console.log('BMAD no diretório atual: ✗ não detectado (rode /instalar-bmad dentro do projeto)');
  }
  const projetos = await listarProjetosBmad();
  console.log(`Projetos BMAD registrados (${projetos.length}):`);
  for (const p of projetos) {
    if (!(await existe(p))) { console.log(`  ✗ ${p}  (diretório não existe mais)`); continue; }
    if (!(await temBmadAqui(p))) { console.log(`  ✗ ${p}  (_bmad/ não encontrado)`); continue; }
    const v = await versaoBmadEm(p);
    console.log(`  ✓ ${p}  BMAD ${v || '(versão não lida)'}`);
  }
  console.log();
}
