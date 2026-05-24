#!/usr/bin/env node
// CLI entry point — claude-bmad-superpowers
import { instalar } from '../src/instalar.js';
import { atualizar } from '../src/atualizar.js';
import { remover } from '../src/remover.js';
import { status } from '../src/status.js';

const SUBCOMANDOS = {
  instalar,
  install: instalar,
  atualizar,
  update: atualizar,
  remover,
  uninstall: remover,
  remove: remover,
  status,
};

const AJUDA = `claude-bmad-superpowers — workflow BMAD + Superpowers para Claude Code

Uso:
  npx claude-bmad-superpowers <comando>

Comandos:
  instalar    Instala skills, commands e plugin Superpowers em ~/.claude/
  atualizar   Atualiza tudo, preservando customizações em cbs-overrides/
  remover     Desinstala skills/commands do pacote (preserva overrides)
  status      Mostra versão instalada, skills/commands ativos, plugins, BMAD

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
