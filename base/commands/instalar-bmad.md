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
   - Rodar `npx bmad-method install --tools claude-code` no diretório atual (com prompts interativos)
   - Após sucesso, registrar o projeto em `~/.claude/cbs-overrides/.projetos-bmad`
   - Listar os agentes BMAD disponíveis

3. Acompanhe a saída. Se o BMAD perguntar coisas (módulos, idioma, etc.), oriente o usuário a responder.

4. Após terminar, confirme:
   - `.bmad-core/` (ou `.bmad/`) existe no diretório
   - Linha do diretório está em `~/.claude/cbs-overrides/.projetos-bmad`

5. Diga ao usuário que agora ele pode usar `/refinar`, `/executar` ou `/piloto` e essas skills vão invocar os agentes BMAD automaticamente.

## Se algo der errado

- `npx bmad-method install` falhar:
  - Confira `node --version` (precisa 18+)
  - Confira se tem `git` instalado
  - Reportar em https://github.com/bmad-code-org/BMAD-METHOD/issues

- `npx claude-bmad-superpowers` não encontrado:
  - O pacote pode não estar publicado ainda — rode pelo clone local: `node /caminho/do/clone/bin/cli.js instalar-bmad`
