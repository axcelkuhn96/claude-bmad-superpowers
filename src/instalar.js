// Subcomando: instalar
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RAIZ_BASE, DIR_SKILLS, DIR_COMMANDS, DIR_PERSONAS, DIR_OVERRIDES,
  ARQ_VERSAO_INSTALADA, MARCADOR, RAIZ_CLAUDE,
  garantirDir, lerVersaoPacote, existe,
} from './caminhos.js';
import { tentarInstalarSuperpowers } from './superpowers.js';
import { instalarBmad } from './instalar-bmad.js';
import { temBmadAqui } from './bmad.js';

function rodapeParaArquivo(p, versao) {
  if (!p.endsWith('.md')) return '';
  return `\n\n<!-- ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/ pra não perder no /atualizar -->\n`;
}

function limparMarcadorAntigo(conteudo) {
  // remove qualquer rodapé/cabeçalho antigo com o marcador
  const regex = new RegExp(`\\n*<!--\\s*${MARCADOR}[^>]*-->\\n*`, 'g');
  return conteudo.replace(regex, '');
}

async function copiarComMarcador(origem, destino, versao) {
  const conteudo = await fs.readFile(origem, 'utf8');
  const limpo = limparMarcadorAntigo(conteudo).trimEnd();
  await garantirDir(path.dirname(destino));
  await fs.writeFile(destino, limpo + rodapeParaArquivo(destino, versao), 'utf8');
}

async function copiarArvore(origemBase, destinoBase, versao) {
  const entradas = await fs.readdir(origemBase, { withFileTypes: true });
  for (const ent of entradas) {
    const origem = path.join(origemBase, ent.name);
    const destino = path.join(destinoBase, ent.name);
    if (ent.isDirectory()) {
      await copiarArvore(origem, destino, versao);
    } else if (ent.isFile()) {
      await copiarComMarcador(origem, destino, versao);
    }
  }
}

export async function instalar(args = []) {
  console.log('🚀 claude-bmad-superpowers — instalando...\n');

  const versao = await lerVersaoPacote();
  console.log(`Versão do pacote: ${versao}`);
  const pularBmad = args.includes('--apenas-global') || args.includes('--skip-bmad');
  const pularSuperpowers = args.includes('--skip-superpowers');

  await garantirDir(RAIZ_CLAUDE);
  await garantirDir(DIR_SKILLS);
  await garantirDir(DIR_COMMANDS);
  await garantirDir(DIR_PERSONAS);
  await garantirDir(DIR_OVERRIDES);
  await garantirDir(path.join(DIR_OVERRIDES, 'skills'));
  await garantirDir(path.join(DIR_OVERRIDES, 'commands'));
  await garantirDir(path.join(DIR_OVERRIDES, 'personas'));

  // copia skills
  const origemSkills = path.join(RAIZ_BASE, 'skills');
  if (await existe(origemSkills)) {
    console.log('→ Copiando skills...');
    await copiarArvore(origemSkills, DIR_SKILLS, versao);
  }

  // copia commands
  const origemCmds = path.join(RAIZ_BASE, 'commands');
  if (await existe(origemCmds)) {
    console.log('→ Copiando commands...');
    await copiarArvore(origemCmds, DIR_COMMANDS, versao);
  }

  // copia personas (rulebooks de domínio injetados nos subagents)
  const origemPersonas = path.join(RAIZ_BASE, 'personas');
  if (await existe(origemPersonas)) {
    console.log('→ Copiando personas de domínio...');
    await copiarArvore(origemPersonas, DIR_PERSONAS, versao);
  }

  // registra versão
  await fs.writeFile(ARQ_VERSAO_INSTALADA, versao + '\n', 'utf8');

  // copia README de overrides (apenas na primeira vez)
  const readmeOverrides = path.join(DIR_OVERRIDES, 'README.md');
  if (!(await existe(readmeOverrides))) {
    const conteudo = `# cbs-overrides

Este diretório é **seu**. O \`npx claude-bmad-superpowers atualizar\` nunca toca nele.

Use pra customizar skills/commands do pacote sem perder no update:

\`\`\`
~/.claude/cbs-overrides/
├── skills/<nome>/SKILL.md   ← substitui ou complementa o base
└── commands/<nome>.md       ← substitui o base
\`\`\`

Convenção: se você criar um arquivo aqui com o mesmo caminho relativo de um arquivo do base, ele tem prioridade.
`;
    await fs.writeFile(readmeOverrides, conteudo, 'utf8');
  }

  console.log('━━━ Etapa 1/3: skills e commands ━━━ ✓\n');

  // ━━━ Etapa 2: plugin Superpowers ━━━
  if (!pularSuperpowers) {
    console.log('━━━ Etapa 2/3: plugin Superpowers ━━━');
    await tentarInstalarSuperpowers();
  } else {
    console.log('(Superpowers pulado por --skip-superpowers)\n');
  }

  // ━━━ Etapa 3: BMAD no diretório atual ━━━
  if (!pularBmad) {
    const cwd = process.cwd();
    const jaTem = await temBmadAqui(cwd);
    console.log(`━━━ Etapa 3/3: BMAD em ${cwd} ━━━`);
    if (jaTem) {
      console.log(`✓ BMAD já instalado em ${cwd} (${jaTem}).`);
      console.log('  Pra atualizar: npx claude-bmad-superpowers atualizar --auto-bmad\n');
    } else {
      console.log('BMAD é per-project (escreve em .bmad-core/, docs/, etc.)');
      console.log('O instalador é interativo — responda as perguntas conforme aparecerem.\n');
      try {
        await instalarBmad([]);
      } catch (e) {
        console.log(`⚠  Erro ao instalar BMAD: ${e.message}`);
        console.log('   Você pode rodar depois:  npx claude-bmad-superpowers instalar-bmad\n');
      }
    }
  } else {
    console.log('(BMAD pulado por --apenas-global / --skip-bmad)');
    console.log('Pra instalar BMAD num projeto depois:  cd <projeto> && npx claude-bmad-superpowers instalar-bmad\n');
  }

  // mensagem final
  console.log(`
✓ Instalação concluída.

Use no dia a dia:
  /investigar <tema>     → discovery sem código
  /refinar <ideia>       → ideia vira prompt premium
  /executar <prompt>     → BMAD planeja, Superpowers implementa
  /piloto <ideia>        → fluxo completo (refina + executa)

Verificar:    npx claude-bmad-superpowers status
Atualizar:    npx claude-bmad-superpowers atualizar
Mais BMAD:    cd <outro-projeto> && npx claude-bmad-superpowers instalar-bmad
`);
}
