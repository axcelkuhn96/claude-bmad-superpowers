// Subcomando: instalar
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RAIZ_BASE, DIR_SKILLS, DIR_COMMANDS, DIR_PERSONAS, DIR_SCRIPTS, DIR_AGENTS, DIR_HOOKS, DIR_OVERRIDES,
  ARQ_VERSAO_INSTALADA, ARQ_SETTINGS, MARCADOR, RAIZ_CLAUDE,
  garantirDir, lerVersaoPacote, existe,
} from './caminhos.js';
import { lerSettings, aplicarHooks, gravarCaminhoNode } from './hooks-settings.js';
import { tentarInstalarSuperpowers } from './superpowers.js';
import { instalarBmad } from './instalar-bmad.js';
import { temBmadAqui } from './bmad.js';

function rodapeParaArquivo(p, versao) {
  if (p.endsWith('.md')) return `\n\n<!-- ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/ pra não perder no /atualizar -->\n`;
  if (p.endsWith('.js')) return `\n\n// ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/scripts/ pra não perder no /atualizar\n`;
  if (p.endsWith('.sh')) return `\n\n# ${MARCADOR} v${versao} — arquivo do pacote; o /atualizar sobrescreve\n`;
  return '';
}

function limparMarcadorAntigo(conteudo) {
  // remove qualquer rodapé/cabeçalho antigo com o marcador (forma .md `<!-- -->` ou .js `// ...`)
  const regex = new RegExp(`\\n*(<!--\\s*${MARCADOR}[^>]*-->|(?:#|//)\\s*${MARCADOR}[^\\n]*)\\n*`, 'g');
  return conteudo.replace(regex, '');
}

async function copiarComMarcador(origem, destino, versao) {
  const conteudo = await fs.readFile(origem, 'utf8');
  const limpo = limparMarcadorAntigo(conteudo).trimEnd();
  await garantirDir(path.dirname(destino));
  await fs.writeFile(destino, limpo + rodapeParaArquivo(destino, versao), 'utf8');
  if (destino.endsWith('.js')) await fs.chmod(destino, 0o755);
}

// models.yml (modelo por papel) é do usuário: copia o default SÓ se não existir
export async function garantirModelsOverride() {
  const origem = path.join(RAIZ_BASE, 'config', 'models.yml');
  const destino = path.join(DIR_OVERRIDES, 'models.yml');
  if (!(await existe(origem))) return { acao: 'sem-default', destino };
  if (await existe(destino)) return { acao: 'preservado', destino };
  await garantirDir(DIR_OVERRIDES);
  await fs.copyFile(origem, destino);
  return { acao: 'criado', destino };
}

// hooks: arquivos com marcador (cbs-*.js, launcher cbs-node.sh); package.json ({"type":"module"}) SÓ se não existir (SP-2).
// `copiar` troca a política de cópia (o atualizar preserva arquivo sem marcador).
export async function copiarHooks(origem, destino, versao, copiar = copiarComMarcador) {
  const pkgDestino = path.join(destino, 'package.json');
  const pkgExistia = await existe(pkgDestino);
  for (const ent of await fs.readdir(origem, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (ent.name === 'package.json') {
      if (!pkgExistia) { await garantirDir(destino); await fs.copyFile(path.join(origem, ent.name), pkgDestino); }
      else if (!/"type"\s*:\s*"module"/.test(await fs.readFile(pkgDestino, 'utf8'))) {
        console.log(`⚠  ${pkgDestino} existe sem "type": "module" — os hooks CBS (ESM) não vão carregar; ajuste manualmente.`);
      }
      continue;
    }
    await copiar(path.join(origem, ent.name), path.join(destino, ent.name), versao);
  }
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
  const semHooks = args.includes('--sem-hooks');
  // settings.json inválido aborta ANTES de copiar qualquer coisa (SP-6)
  if (!semHooks) await lerSettings(ARQ_SETTINGS, 'corrija o JSON ou rode com --sem-hooks');

  await garantirDir(RAIZ_CLAUDE);
  await garantirDir(DIR_SKILLS);
  await garantirDir(DIR_COMMANDS);
  await garantirDir(DIR_PERSONAS);
  await garantirDir(DIR_OVERRIDES);
  await garantirDir(path.join(DIR_OVERRIDES, 'skills'));
  await garantirDir(path.join(DIR_OVERRIDES, 'commands'));
  await garantirDir(path.join(DIR_OVERRIDES, 'personas'));
  await garantirDir(path.join(DIR_OVERRIDES, 'scripts'));
  await garantirDir(path.join(DIR_OVERRIDES, 'agents'));

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

  // copia scripts (ex.: gate-seguranca.js, rodado pelos reviewers de segurança)
  const origemScripts = path.join(RAIZ_BASE, 'scripts');
  if (await existe(origemScripts)) {
    console.log('→ Copiando scripts...');
    await copiarArvore(origemScripts, DIR_SCRIPTS, versao);
  }

  // copia agentes (subagentes cbs-* referenciados por papel em models.yml)
  const origemAgents = path.join(RAIZ_BASE, 'agents');
  if (await existe(origemAgents)) {
    console.log('→ Copiando agentes cbs-*...');
    await copiarArvore(origemAgents, DIR_AGENTS, versao);
  }

  // hooks globais (cbs-*.js + launcher) + node do instalador pro launcher + merge idempotente no settings.json
  const origemHooks = path.join(RAIZ_BASE, 'hooks');
  if (await existe(origemHooks)) {
    console.log('→ Copiando hooks cbs-*...');
    await copiarHooks(origemHooks, DIR_HOOKS, versao);
    await gravarCaminhoNode(DIR_HOOKS);
    if (semHooks) {
      console.log('(registro no settings.json pulado por --sem-hooks)');
    } else {
      const r = await aplicarHooks(ARQ_SETTINGS, DIR_HOOKS);
      console.log(r.mudou
        ? `→ settings.json: hooks CBS registrados${r.backup ? ` (backup em ${r.backup})` : ''}`
        : '✓ settings.json: hooks CBS já registrados.');
    }
  }

  // models.yml default → cbs-overrides/ (nunca sobrescreve)
  const models = await garantirModelsOverride();
  if (models.acao === 'criado') console.log('→ Criando cbs-overrides/models.yml (modelo por papel, default do pacote)...');
  else if (models.acao === 'preservado') console.log('✓ cbs-overrides/models.yml já existe — preservado.');

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
├── commands/<nome>.md       ← substitui o base
├── personas/<caminho>.md    ← substitui personas/ (ponytail, dominios/, review/)
├── scripts/<nome>.js        ← substitui scripts/ (gate-seguranca.js)
├── agents/cbs-<papel>.md    ← substitui um agente cbs-* (modelo, effort, tools, prompt)
└── models.yml               ← agente/modelo por papel (claude: e codex:)
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
      console.log('BMAD é per-project (escreve em _bmad/, _bmad-output/ e .claude/skills/bmad-*)');
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
  /mapear <ideia>        → escopo grande vira mapa de decisões (wayfinder)
  /grelhar <tema>        → interrogatório até entendimento compartilhado
  /refinar <ideia>       → ideia vira prompt premium
  /executar <prompt>     → BMAD planeja, Superpowers implementa
  /piloto <ideia>        → fluxo completo (grelha + refina + executa)
  /handoff [foco]        → doc de continuação pra outra sessão

Verificar:    npx claude-bmad-superpowers status
Atualizar:    npx claude-bmad-superpowers atualizar
Mais BMAD:    cd <outro-projeto> && npx claude-bmad-superpowers instalar-bmad
`);
}
