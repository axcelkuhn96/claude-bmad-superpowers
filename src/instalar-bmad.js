// Subcomando: instalar-bmad — roda no terminal do usuário (TTY real)
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import { registrarProjetoBmad, temBmadAqui } from './bmad.js';

// idioma dos agentes e dos documentos gerados pelo BMAD (default do BMAD é English)
const IDIOMA_BMAD = 'pt-BR';

function rodarHerdandoTerminal(comando, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(comando, args, { stdio: 'inherit', ...opts });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}

async function perguntar(pergunta) {
  const rl = readline.createInterface({ input, output });
  const resp = await rl.question(pergunta);
  rl.close();
  return resp.trim().toLowerCase();
}

// skills do BMAD instaladas no projeto (.claude/skills/bmad-*)
async function listarSkillsBmad(dir) {
  const dirSkills = path.join(dir, '.claude', 'skills');
  try {
    const ents = await fs.readdir(dirSkills, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && e.name.startsWith('bmad-')).map((e) => path.join(dirSkills, e.name));
  } catch {
    return [];
  }
}

// --force: desinstala via `bmad-method uninstall` (apaga _bmad/ e .claude/skills/bmad-*, preserva _bmad-output/)
// e varre o que sobrar em .claude/skills/bmad-*. Pede confirmação, a menos que -y/--sim.
async function desinstalarBmad(dir, existente, args) {
  const skills = await listarSkillsBmad(dir);
  console.log('→ Reinstalação do zero vai apagar:');
  console.log(`     ${existente}`);
  console.log(`     ${skills.length} skill(s) bmad-* em ${path.join(dir, '.claude', 'skills')}`);
  console.log('   (_bmad-output/ e suas outras skills são preservados)');

  if (!args.includes('-y') && !args.includes('--sim')) {
    if (!process.stdin.isTTY) {
      throw new Error('--force precisa de confirmação; sem TTY, passe -y pra confirmar.');
    }
    const r = await perguntar('   Confirmar? [s/N] ');
    if (!r.startsWith('s')) {
      console.log('Cancelado. Nada foi apagado.');
      return false;
    }
  }

  try {
    await rodarHerdandoTerminal('npx', ['--yes', 'bmad-method', 'uninstall', '--directory', dir, '--yes'], { cwd: dir });
  } catch (e) {
    console.log(`⚠  bmad-method uninstall falhou (${e.message}); removendo manualmente.`);
  }
  // o que sobrou (uninstall antigo, ou instalação parcial)
  if (await temBmadAqui(dir)) await fs.rm(existente, { recursive: true, force: true });
  for (const s of await listarSkillsBmad(dir)) await fs.rm(s, { recursive: true, force: true });
  console.log('✓ Instalação anterior removida.\n');
  return true;
}

export async function instalarBmad(args = []) {
  const dir = process.cwd();
  console.log(`📦 claude-bmad-superpowers — instalando BMAD em:\n   ${dir}\n`);

  const existente = await temBmadAqui(dir);
  let acao = 'install';

  if (existente) {
    console.log(`⚠  BMAD já existe em ${existente}.`);

    let escolha;
    if (args.includes('--force') || args.includes('-f')) {
      escolha = 'r'; // reinstalar do zero
    } else if (args.includes('--update') || args.includes('-u')) {
      escolha = 'u';
    } else if (!process.stdin.isTTY) {
      escolha = 'p'; // sem terminal não dá pra perguntar
    } else {
      escolha = await perguntar('   [r]einstalar do zero / [u]pdate / [p]ular? [p] ');
      if (!escolha) escolha = 'p';
    }

    if (escolha.startsWith('p')) {
      console.log('Mantendo instalação existente. Apenas registrando o projeto.\n');
      await registrarProjetoBmad(dir);
      return;
    }
    if (escolha.startsWith('r')) {
      if (!(await desinstalarBmad(dir, existente, args))) return;
      acao = 'install';
    } else if (escolha.startsWith('u')) {
      acao = 'update';
    }
  }

  // máximo não-interativo (flags conferidas em `npx bmad-method@6.12 install --help`):
  // --directory <dir> (sem ele o BMAD pergunta o diretório mesmo com --yes e trava sem TTY)
  // --action install/update (NUNCA quick-update — pra IDE wiring funcionar)
  // --tools claude-code (escreve skills bmad-* em .claude/skills do projeto)
  // --modules bmm,core (fixa lista — pula tela de seleção)
  // --communication-language / --document-output-language (default do BMAD é English)
  // --yes (aceita defaults onde houver)
  // sem --custom-source (sinaliza ao BMAD pra não perguntar sobre custom modules)
  const bmadArgs = [
    '--yes', 'bmad-method', 'install',
    '--directory', dir,
    '--action', acao,
    '--tools', 'claude-code',
    '--modules', 'bmm,core',
    '--communication-language', IDIOMA_BMAD,
    '--document-output-language', IDIOMA_BMAD,
    '--yes',
  ];
  // extras do usuário (filtra nossos próprios flags)
  const nossosFlags = new Set(['--force', '-f', '--update', '-u', '-y', '--sim']);
  for (const a of args) if (!nossosFlags.has(a)) bmadArgs.push(a);

  console.log(`→ Rodando: npx ${bmadArgs.join(' ')}\n`);
  try {
    await rodarHerdandoTerminal('npx', bmadArgs, { cwd: dir });
  } catch (e) {
    console.error(`\n✗ Instalação do BMAD falhou: ${e.message}`);
    console.error('  Verifique se você tem Node 18+ e git instalados.');
    process.exit(1);
  }

  // pós-instalação
  const detectado = await temBmadAqui(dir);
  if (detectado) {
    await registrarProjetoBmad(dir);
    const skills = await listarSkillsBmad(dir);
    console.log(`\n✓ BMAD instalado em ${detectado} (${skills.length} skills bmad-* em .claude/skills/)`);
    console.log(`✓ Projeto registrado em ~/.claude/cbs-overrides/.projetos-bmad\n`);
    console.log('Agentes BMAD (skills bmad-agent-*):');
    console.log('  @analyst      — discovery, mercado, problema');
    console.log('  @pm           — PRD, critérios de sucesso, MVP');
    console.log('  @architect    — decisões técnicas, padrões');
    console.log('  @ux-designer  — UX, fluxos, telas');
    console.log('  @dev          — implementação (persona injetada nos subagents do /executar)');
    console.log('  (QA e stories são workflows: bmad-review, bmad-create-epics-and-stories)');
    console.log('\nAgora dentro do Claude Code, use:');
    console.log('  /refinar <ideia>     → vira prompt premium');
    console.log('  /executar <prompt>   → BMAD planeja, Superpowers implementa');
    console.log('  /piloto <ideia>      → fluxo completo');
  } else {
    // o instalador do BMAD sai com 0 mesmo quando um prompt é cancelado (ex.: sem TTY)
    console.log('\n⚠  Instalação rodou mas BMAD não foi detectado (procurei _bmad/).');
    console.log('   Confira a saída acima.');
    process.exitCode = 1;
  }
}
