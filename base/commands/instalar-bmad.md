---
description: Instala BMAD-METHOD no projeto atual e registra para o /atualizar conhecer. Como BMAD é interativo, delega a CLI npx que roda no terminal do usuário.
---

O BMAD-METHOD tem um instalador **interativo** (perguntas em TTY) que o Claude Code não navega bem direto. Por isso, a forma certa é rodar via CLI do pacote — o `!` faz o comando rodar no terminal do usuário com TTY real, e a saída volta pra mim.

## Passos

1. Confirme o diretório com o usuário (mostre `pwd`).

2. Se for o diretório certo, peça para o usuário rodar (ou rode você via `!`):

   ```
   ! npx claude-bmad-superpowers instalar-bmad
   ```

   Esse comando vai:
   - Rodar `npx bmad-method install --directory <dir> --action install --tools claude-code --modules bmm,core --communication-language pt-BR --document-output-language pt-BR --yes` no diretório atual (agentes e documentos em português)
   - Após sucesso, registrar o projeto em `~/.claude/cbs-overrides/.projetos-bmad`
   - Listar os agentes BMAD disponíveis

   Se BMAD já existir no diretório, a CLI pergunta `[r]einstalar / [u]pdate / [p]ular`. Flags equivalentes:
   - `--update` (`-u`): `bmad-method install --action update`
   - `--force` (`-f`): reinstala do zero — roda `bmad-method uninstall` (apaga `_bmad/` e `.claude/skills/bmad-*`, preserva `_bmad-output/`) e pede confirmação; `-y` confirma sem perguntar

3. Acompanhe a saída. Se o BMAD perguntar algo que a flag `--yes` não cobriu, oriente o usuário a responder.

4. Após terminar, confirme:
   - `_bmad/` existe no diretório (versão em `_bmad/_config/manifest.yaml`)
   - `.claude/skills/bmad-*` foram criadas (skills `bmad-agent-dev`, `bmad-prd`, `bmad-create-epics-and-stories`, etc.)
   - Linha do diretório está em `~/.claude/cbs-overrides/.projetos-bmad`
   - `npx claude-bmad-superpowers status` lista o projeto com a versão do BMAD

5. Diga ao usuário que agora ele pode usar `/refinar`, `/executar` ou `/piloto` e essas skills vão invocar os agentes BMAD automaticamente.

## Se algo der errado

- `npx bmad-method install` falhar:
  - Confira `node --version` (precisa 18+)
  - Confira se tem `git` instalado
  - Reportar em https://github.com/bmad-code-org/BMAD-METHOD/issues

- `npx claude-bmad-superpowers` não encontrado:
  - O pacote pode não estar publicado ainda — rode pelo clone local: `node /caminho/do/clone/bin/cli.js instalar-bmad`
