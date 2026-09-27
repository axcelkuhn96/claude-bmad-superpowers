// Subcomando: atualizar
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  RAIZ_BASE, DIR_SKILLS, DIR_COMMANDS, DIR_PERSONAS, DIR_SCRIPTS, DIR_AGENTS, DIR_HOOKS, ARQ_VERSAO_INSTALADA,
  ARQ_SETTINGS, MARCADOR, lerVersaoPacote, lerVersaoInstalada, existe, garantirDir,
} from './caminhos.js';
import { tentarAtualizarSuperpowers } from './superpowers.js';
import { listarProjetosBmad, atualizarBmadEmProjeto, limparProjetosInvalidos } from './bmad.js';
import { tentarSelfUpdate } from './auto-update.js';
import { garantirModelsOverride, instalarHooks } from './instalar.js';
import { prevalidarHooks } from './hooks-settings.js';

async function arquivoTemMarcador(p) {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return buf.includes(MARCADOR);
  } catch {
    return false;
  }
}

function limparMarcadorAntigo(conteudo) {
  const regex = new RegExp(`\\n*(<!--\\s*${MARCADOR}[^>]*-->|(?:#|//)\\s*${MARCADOR}[^\\n]*)\\n*`, 'g');
  return conteudo.replace(regex, '');
}

async function copiarSeBase(origem, destino, versao) {
  if (await existe(destino)) {
    if (!(await arquivoTemMarcador(destino))) {
      return { acao: 'preservado', destino };
    }
  }
  const conteudo = await fs.readFile(origem, 'utf8');
  const limpo = limparMarcadorAntigo(conteudo).trimEnd();
  let rodape = '';
  if (destino.endsWith('.md')) rodape = `\n\n<!-- ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/ pra não perder no /atualizar -->\n`;
  else if (/\.m?js$/.test(destino)) rodape = `\n\n// ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/scripts/ pra não perder no /atualizar\n`;
  else if (destino.endsWith('.sh')) rodape = `\n\n# ${MARCADOR} v${versao} — arquivo do pacote; o /atualizar sobrescreve\n`;
  await garantirDir(path.dirname(destino));
  await fs.writeFile(destino, limpo + rodape, 'utf8');
  if (/\.m?js$/.test(destino)) await fs.chmod(destino, 0o755);
  return { acao: 'atualizado', destino };
}

async function atualizarArvore(origemBase, destinoBase, versao, resultado) {
  const entradas = await fs.readdir(origemBase, { withFileTypes: true });
  for (const ent of entradas) {
    const origem = path.join(origemBase, ent.name);
    const destino = path.join(destinoBase, ent.name);
    if (ent.isDirectory()) {
      await atualizarArvore(origem, destino, versao, resultado);
    } else if (ent.isFile()) {
      const r = await copiarSeBase(origem, destino, versao);
      resultado[r.acao].push(r.destino);
    }
  }
}

// --projetos /a,/b  ou  --projetos=/a,/b  → lista de caminhos absolutos normalizados
function lerFlagProjetos(args) {
  let valor = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projetos') valor = args[i + 1] || '';
    else if (args[i].startsWith('--projetos=')) valor = args[i].slice('--projetos='.length);
  }
  if (valor === null) return null;
  return valor.split(',').map((p) => p.trim()).filter(Boolean).map((p) => path.resolve(p));
}

async function perguntar(pergunta) {
  const rl = readline.createInterface({ input, output });
  const resp = await rl.question(pergunta);
  rl.close();
  return resp.trim().toLowerCase();
}

export async function atualizar(args = []) {
  console.log('🔄 claude-bmad-superpowers — atualizando...\n');

  const versaoAtual = await lerVersaoPacote();
  const versaoInstalada = await lerVersaoInstalada();
  console.log(`Versão instalada em ~/.claude: ${versaoInstalada || '(não detectada)'}`);
  console.log(`Versão do clone/pacote atual: ${versaoAtual}\n`);

  const semHooks = args.includes('--sem-hooks');
  // settings.json inválido ou caminho inseguro aborta ANTES de copiar qualquer coisa (SP-6)
  if (!semHooks) await prevalidarHooks(ARQ_SETTINGS, DIR_HOOKS);

  // ETAPA 0 — Self-update (a menos que --skip-self-update)
  if (!args.includes('--skip-self-update')) {
    console.log('━━━ Etapa 1/4: self-update do pacote ━━━');
    await tentarSelfUpdate(versaoAtual, args);
  } else {
    console.log('(self-update pulado por flag)\n');
  }

  // re-leitura: tentarSelfUpdate pode ter atualizado VERSAO via git pull
  const versaoNova = await lerVersaoPacote();

  // ETAPA 1 — Recopiar base
  console.log('━━━ Etapa 2/4: skills e commands ━━━');
  const resultado = { atualizado: [], preservado: [] };
  if (await existe(path.join(RAIZ_BASE, 'skills'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'skills'), DIR_SKILLS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'commands'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'commands'), DIR_COMMANDS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'personas'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'personas'), DIR_PERSONAS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'scripts'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'scripts'), DIR_SCRIPTS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'agents'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'agents'), DIR_AGENTS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'hooks'))) {
    const r = await instalarHooks(versaoNova, semHooks, async (origem, destino, versao) => {
      const c = await copiarSeBase(origem, destino, versao);
      resultado[c.acao].push(c.destino);
    });
    if (r.mudou) resultado.atualizado.push(ARQ_SETTINGS);
  }
  const models = await garantirModelsOverride();
  if (models.acao === 'criado') resultado.atualizado.push(models.destino);
  else if (models.acao === 'preservado') resultado.preservado.push(models.destino);
  await fs.writeFile(ARQ_VERSAO_INSTALADA, versaoNova + '\n', 'utf8');
  console.log(`✓ ${resultado.atualizado.length} arquivo(s) do base atualizado(s) (v${versaoNova}).`);
  if (resultado.preservado.length > 0) {
    console.log(`✓ ${resultado.preservado.length} customização(ões) preservada(s):`);
    for (const p of resultado.preservado) console.log(`    ${p}`);
  }
  console.log();

  // ETAPA 2 — Superpowers plugin
  console.log('━━━ Etapa 3/4: plugin Superpowers ━━━');
  await tentarAtualizarSuperpowers();
  console.log();

  // ETAPA 3 — BMAD em projetos registrados
  if (!args.includes('--skip-bmad')) {
    console.log('━━━ Etapa 4/4: BMAD nos projetos registrados ━━━');
    const { validos, removidos } = await limparProjetosInvalidos();
    if (removidos.length > 0) {
      console.log(`(${removidos.length} projeto(s) inválido(s) removido(s) do registro)`);
    }
    if (validos.length === 0) {
      console.log('Nenhum projeto BMAD registrado. Rode /instalar-bmad num projeto pra cadastrar.\n');
    } else {
      console.log(`Projetos BMAD registrados (${validos.length}):`);
      for (const p of validos) console.log(`  - ${p}`);

      // --projetos a,b,c restringe a lista (usado pelo /atualizar depois de perguntar ao usuário)
      const filtro = lerFlagProjetos(args);
      const candidatos = filtro ? validos.filter((p) => filtro.includes(p)) : validos;
      if (filtro) {
        const desconhecidos = filtro.filter((p) => !validos.includes(p));
        for (const p of desconhecidos) console.log(`⚠  ${p}: não está no registro. Ignorado.`);
      }

      const auto = args.includes('--auto-bmad') || args.includes('-y') || Boolean(filtro);
      let modo = auto ? 'todos' : null;
      if (!modo && !process.stdin.isTTY) {
        // sem terminal (ex.: rodando via ferramenta Bash do Claude Code) não dá pra perguntar:
        // comporta como --auto-bmad. Pra não tocar nos projetos, use --skip-bmad.
        console.log('\n(sem TTY: atualizando BMAD em todos os projetos registrados, como --auto-bmad; use --skip-bmad ou --projetos pra restringir)');
        modo = 'todos';
      }
      if (!modo) {
        modo = await perguntar('\nAtualizar BMAD em [t]odos / [s]elecionar / [n]ão? [n] ');
        if (!modo) modo = 'n';
      }

      let alvos = [];
      if (modo.startsWith('t')) alvos = candidatos;
      else if (modo.startsWith('s')) {
        for (const p of validos) {
          const r = await perguntar(`  Atualizar em ${p}? [s/N] `);
          if (r.startsWith('s')) alvos.push(p);
        }
      }

      let ok = 0, falha = 0;
      for (const p of alvos) {
        const r = await atualizarBmadEmProjeto(p);
        r ? ok++ : falha++;
      }
      if (alvos.length > 0) {
        console.log(`✓ BMAD atualizado em ${ok}/${alvos.length} projeto(s)${falha ? ` (${falha} falha[s])` : ''}.\n`);
      }
    }
  } else {
    console.log('(update do BMAD pulado por --skip-bmad)\n');
  }

  console.log('✓ Atualização concluída.');
}
