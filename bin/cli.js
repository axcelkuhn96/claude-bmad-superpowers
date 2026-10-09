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
  status           Versões (pacote, Superpowers, BMAD por projeto), skills/commands/personas, models.yml
  memoria          Operações Mem0 locais (cbs memoria help)

Flags do instalar:
  --apenas-global       Não instala BMAD no cwd (skills/commands/Superpowers somente)
  --skip-bmad           Idem
  --skip-superpowers    Não tenta instalar o plugin Superpowers
  --sem-hooks           Não registra os hooks CBS no ~/.claude/settings.json (os arquivos são copiados)

Flags do instalar-bmad:
  --update, -u          Atualiza a instalação existente (bmad-method install --action update)
  --force, -f           Reinstala do zero: bmad-method uninstall + remove .claude/skills/bmad-* (pede confirmação)
  -y, --sim             Confirma o --force sem perguntar

Flags do atualizar:
  --skip-self-update    Não tenta atualizar o próprio pacote (git pull ou npx @latest)
  --skip-bmad           Não atualiza BMAD nos projetos registrados
  --auto-bmad, -y       Atualiza BMAD em todos os projetos sem perguntar
  --projetos a,b        Atualiza BMAD só nesses projetos (caminhos separados por vírgula)
  (sem TTY, ex. via ferramenta Bash do Claude Code: comporta como --auto-bmad)
  --sem-hooks           Não registra os hooks CBS no ~/.claude/settings.json (os arquivos são copiados)

Hooks CBS (env):
  CBS_HOOKS=off                                        desliga todos
  CBS_HOOKS_DESLIGADOS=format,typecheck,no-verify,config   desliga os escolhidos
  CBS_PERMITIR_CONFIG=1                                libera edição de config de lint/format

Aliases: install/update/uninstall/remove também funcionam.
Atalho:  cbs <comando>  (se instalado globalmente)
`;

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(AJUDA);
    process.exit(0);
  }
  if (sub === 'memoria') {
    try {
      const { main: memoria } = await import('../base/memoria/cli.mjs');
      process.exitCode = await memoria(process.argv.slice(3));
    } catch (err) {
      console.error(`CBS Mem0: ${err.message}`);
      process.exitCode = 1;
    }
    return;
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
