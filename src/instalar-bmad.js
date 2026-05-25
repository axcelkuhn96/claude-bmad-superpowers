// Subcomando: instalar-bmad — roda no terminal do usuário (TTY real)
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import { registrarProjetoBmad, temBmadAqui } from './bmad.js';

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
      console.log(`→ Removendo ${existente} pra instalação fresca...`);
      await fs.rm(existente, { recursive: true, force: true });
      acao = 'install';
    } else if (escolha.startsWith('u')) {
      acao = 'update';
    }
  }

  // sempre passar --action install OU update (NUNCA quick-update — pra IDE wiring funcionar)
  const bmadArgs = [
    '--yes', 'bmad-method', 'install',
    '--action', acao,
    '--tools', 'claude-code',
  ];
  // extras do usuário (filtra nossos próprios flags)
  const nossosFlags = new Set(['--force', '-f', '--update', '-u']);
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
    console.log(`\n✓ BMAD instalado em ${detectado}`);
    console.log(`✓ Projeto registrado em ~/.claude/cbs-overrides/.projetos-bmad\n`);
    console.log('Agentes BMAD típicos:');
    console.log('  @analyst   — discovery, mercado, problema');
    console.log('  @pm        — PRD, critérios de sucesso, MVP');
    console.log('  @architect — decisões técnicas, padrões');
    console.log('  @sm        — quebra em stories pequenas');
    console.log('  @dev       — implementação');
    console.log('  @qa        — testes, validação');
    console.log('\nAgora dentro do Claude Code, use:');
    console.log('  /refinar <ideia>     → vira prompt premium');
    console.log('  /executar <prompt>   → BMAD planeja, Superpowers implementa');
    console.log('  /piloto <ideia>      → fluxo completo');
  } else {
    console.log('\n⚠  Instalação rodou mas BMAD não foi detectado (procurei _bmad, .bmad-core, .bmad).');
    console.log('   Confira a saída acima.');
  }
}
