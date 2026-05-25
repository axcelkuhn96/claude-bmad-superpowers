#!/usr/bin/env node
// CLI entry point — claude-bmad-superpowers
import { instalar } from '../src/instalar.js';
import { atualizar } from '../src/atualizar.js';
import { remover } from '../src/remover.js';
import { status } from '../src/status.js';
import { instalarBmad } from '../src/instalar-bmad.js';

const SUBCOMANDOS = {
  instalar,
  install: instalar,
  atualizar,
  update: atualizar,
  remover,
  uninstall: remover,
  remove: remover,
  status,
  'instalar-bmad': instalarBmad,
  'install-bmad': instalarBmad,
};

const AJUDA = `claude-bmad-superpowers — workflow BMAD + Superpowers para Claude Code

Uso:
  npx claude-bmad-superpowers <comando>

Comandos:
  instalar         Instala TUDO: skills + commands (global) + Superpowers (plugin) + BMAD (no cwd)
  instalar-bmad    Instala apenas BMAD-METHOD no diretório atual e registra o projeto
  atualizar        Self-update + skills/commands + Superpowers + BMAD nos projetos registrados
  remover          Desinstala skills/commands do pacote (preserva overrides)
  status           Mostra versão instalada, skills/commands ativos, plugins, BMAD

Flags do instalar:
  --apenas-global       Não instala BMAD no cwd (skills/commands/Superpowers somente)
  --skip-bmad           Idem
  --skip-superpowers    Não tenta instalar o plugin Superpowers

Flags do atualizar:
  --skip-self-update    Não tenta atualizar o próprio pacote (git pull ou npx @latest)
  --skip-bmad           Não pergunta sobre atualizar BMAD nos projetos
  --auto-bmad, -y       Atualiza BMAD em todos os projetos sem perguntar

Aliases: install/update/uninstall/remove também funcionam.
Atalho:  cbs <comando>  (se instalado globalmente)
`;

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(AJUDA);
    process.exit(0);
  }
  const fn = SUBCOMANDOS[sub];
  if (!fn) {
    console.error(`Comando desconhecido: ${sub}\n`);
    console.log(AJUDA);
    process.exit(1);
  }
  try {
    await fn(process.argv.slice(3));
  } catch (err) {
    console.error(`\n✗ Erro: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
