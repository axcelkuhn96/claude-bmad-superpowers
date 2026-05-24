---
description: Atualiza o pacote claude-bmad-superpowers, o plugin Superpowers e oferece atualizar BMAD nos projetos registrados. Preserva customizações em ~/.claude/cbs-overrides/.
---

Você vai atualizar o pacote claude-bmad-superpowers e suas dependências.

## Passos

1. Rode:
   ```bash
   npx claude-bmad-superpowers atualizar
   ```

2. Acompanhe a saída. Ela vai:
   - Recopiar as skills/commands do `base/` (sobrescrevendo só arquivos com marcador `claude-bmad-superpowers:base`)
   - Preservar customizações em `~/.claude/cbs-overrides/`
   - Tentar atualizar o plugin Superpowers via `claude /plugin update`
   - Listar projetos com BMAD registrados

3. Para cada projeto BMAD listado, pergunte ao usuário se quer atualizar BMAD nele agora:
   ```bash
   cd <projeto> && npx bmad-method install --update
   ```

4. Mostre ao usuário a versão nova vs antiga (a saída da CLI já mostra isso).

5. Sugira rodar `npx claude-bmad-superpowers status` pra confirmar tudo certo.

## Se algo der errado

- Erro no `npx claude-bmad-superpowers`: peça `node --version` (precisa 18+).
- Erro no `claude /plugin update`: oriente o usuário a rodar manualmente dentro do Claude Code.
- Erro no `npx bmad-method install --update`: pode pular esse projeto e seguir.
