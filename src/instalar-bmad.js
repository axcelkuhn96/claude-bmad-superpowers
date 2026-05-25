// Subcomando: instalar-bmad — roda no terminal do usuário (TTY real)
import { spawn } from 'node:child_process';
import process from 'node:process';
import { registrarProjetoBmad, temBmadAqui } from './bmad.js';

function rodarHerdandoTerminal(comando, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(comando, args, { stdio: 'inherit', ...opts });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}

export async function instalarBmad(args = []) {
  const dir = process.cwd();
  console.log(`📦 claude-bmad-superpowers — instalando BMAD em:\n   ${dir}\n`);

  if (await temBmadAqui(dir)) {
    console.log(`⚠  BMAD já parece estar instalado em ${dir}.`);
    console.log('   Pra atualizar, use:  npx claude-bmad-superpowers atualizar --auto-bmad');
    console.log('   Ou rode manualmente:  npx bmad-method install --action update --tools claude-code\n');
    if (!args.includes('--force')) {
      console.log('Use --force pra rodar a instalação mesmo assim.');
      await registrarProjetoBmad(dir);
      console.log(`✓ Projeto registrado no índice global (~/.claude/cbs-overrides/.projetos-bmad).`);
      return;
    }
  }

  const bmadArgs = ['--yes', 'bmad-method', 'install', '--tools', 'claude-code'];
  // permite passar extras (--communication-language Portuguese, etc.)
  for (const a of args) if (a !== '--force') bmadArgs.push(a);

  console.log(`→ Rodando: npx ${bmadArgs.join(' ')}\n`);
  try {
    await rodarHerdandoTerminal('npx', bmadArgs, { cwd: dir });
  } catch (e) {
    console.error(`\n✗ Instalação do BMAD falhou: ${e.message}`);
    console.error('  Verifique se você tem Node 18+ e git instalados.');
    process.exit(1);
  }

  // pós-instalação
  if (await temBmadAqui(dir)) {
    await registrarProjetoBmad(dir);
    console.log(`\n✓ BMAD instalado e projeto registrado no índice global.`);
    console.log(`   (~/.claude/cbs-overrides/.projetos-bmad)\n`);
    console.log('Agentes BMAD típicos disponíveis:');
    console.log('  @analyst   — discovery, mercado, problema');
    console.log('  @pm        — PRD, critérios de sucesso, MVP');
    console.log('  @architect — decisões técnicas, padrões');
    console.log('  @sm        — quebra em stories pequenas');
    console.log('  @dev       — implementação');
    console.log('  @qa        — testes, validação');
    console.log('\nAgora, dentro do Claude Code, use:');
    console.log('  /refinar <ideia>     → vira prompt premium');
    console.log('  /executar <prompt>   → BMAD planeja, Superpowers implementa');
    console.log('  /piloto <ideia>      → fluxo completo');
  } else {
    console.log('\n⚠  Instalação rodou mas .bmad-core/ não foi detectado.');
    console.log('   Verifique a saída acima.');
  }
}
