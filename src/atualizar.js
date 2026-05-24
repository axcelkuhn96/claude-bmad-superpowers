// Subcomando: atualizar
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RAIZ_BASE, DIR_SKILLS, DIR_COMMANDS, ARQ_VERSAO_INSTALADA,
  MARCADOR, lerVersaoPacote, lerVersaoInstalada, existe, garantirDir,
} from './caminhos.js';
import { tentarAtualizarSuperpowers } from './superpowers.js';
import { listarProjetosBmad } from './bmad.js';

async function arquivoTemMarcador(p) {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return buf.includes(MARCADOR);
  } catch {
    return false;
  }
}

function limparMarcadorAntigo(conteudo) {
  const regex = new RegExp(`\\n*<!--\\s*${MARCADOR}[^>]*-->\\n*`, 'g');
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
  const rodape = destino.endsWith('.md')
    ? `\n\n<!-- ${MARCADOR} v${versao} — edite em ~/.claude/cbs-overrides/ pra não perder no /atualizar -->\n`
    : '';
  await garantirDir(path.dirname(destino));
  await fs.writeFile(destino, limpo + rodape, 'utf8');
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

export async function atualizar(_args = []) {
  console.log('🔄 claude-bmad-superpowers — atualizando...\n');

  const versaoNova = await lerVersaoPacote();
  const versaoAtual = await lerVersaoInstalada();
  console.log(`Versão instalada: ${versaoAtual || '(não detectada)'}`);
  console.log(`Versão do pacote: ${versaoNova}\n`);

  const resultado = { atualizado: [], preservado: [] };

  if (await existe(path.join(RAIZ_BASE, 'skills'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'skills'), DIR_SKILLS, versaoNova, resultado);
  }
  if (await existe(path.join(RAIZ_BASE, 'commands'))) {
    await atualizarArvore(path.join(RAIZ_BASE, 'commands'), DIR_COMMANDS, versaoNova, resultado);
  }

  await fs.writeFile(ARQ_VERSAO_INSTALADA, versaoNova + '\n', 'utf8');

  console.log(`✓ ${resultado.atualizado.length} arquivo(s) do base atualizado(s).`);
  if (resultado.preservado.length > 0) {
    console.log(`✓ ${resultado.preservado.length} customização(ões) preservada(s):`);
    for (const p of resultado.preservado) console.log(`    ${p}`);
  }
  console.log();

  // plugin Superpowers
  await tentarAtualizarSuperpowers();

  // BMAD em projetos registrados
  const projetos = await listarProjetosBmad();
  if (projetos.length > 0) {
    console.log('\n📦 Projetos com BMAD registrados:');
    for (const p of projetos) console.log(`    ${p}`);
    console.log('\nPra atualizar BMAD em cada um:');
    console.log('    cd <projeto> && npx bmad-method install --update\n');
  }

  console.log('✓ Atualização concluída.');
}
