---
description: Instala BMAD-METHOD no projeto atual (per-project) via npx, detecta a stack e registra o projeto pro /atualizar conhecer.
---

Você vai instalar o BMAD-METHOD no diretório atual do usuário.

## Passos

1. Confirme que o usuário está no diretório certo do projeto (mostre `pwd`).

2. Pergunte se confirma instalar BMAD ali. Se sim:

3. Rode:
   ```bash
   npx bmad-method install
   ```
   Acompanhe a saída e responda às perguntas do instalador BMAD se aparecerem (stack, etc.) consultando o usuário.

4. Após instalar, verifique se `.bmad-core/` (ou `.bmad/`) foi criado.

5. Registre o projeto no índice global pra o `/atualizar` saber dele depois:
   ```bash
   mkdir -p ~/.claude/cbs-overrides
   echo "$(pwd)" >> ~/.claude/cbs-overrides/.projetos-bmad
   ```
   (Mas só se ainda não estiver registrado — confira antes.)

6. Mostre os agentes BMAD disponíveis (geralmente: `@analyst`, `@pm`, `@architect`, `@sm`, `@dev`, `@qa`).

7. Diga ao usuário que agora ele pode usar `/refinar`, `/executar` ou `/piloto` e essas skills vão invocar os agentes BMAD automaticamente.

## Se algo der errado

Se `npx bmad-method install` falhar:
- Confira `node --version` (precisa 18+)
- Confira se tem `git` instalado (BMAD usa)
- Mostre o erro ao usuário e sugira reportar em https://github.com/bmadcode/BMAD-METHOD/issues
