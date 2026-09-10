---
description: Atualiza o pacote claude-bmad-superpowers, o plugin Superpowers e oferece atualizar BMAD nos projetos registrados. Preserva customizações em ~/.claude/cbs-overrides/.
---

Você vai atualizar o pacote claude-bmad-superpowers e suas dependências.

A CLI roda pela ferramenta Bash, **sem TTY**: ela não consegue perguntar nada. Por isso a pergunta sobre BMAD é sua (via `AskUserQuestion`), e a CLI recebe a decisão por flag.

## Passos

1. Atualize pacote, skills/commands/personas e Superpowers, **sem tocar nos projetos BMAD**:
   ```bash
   npx claude-bmad-superpowers atualizar --skip-bmad
   ```
   A saída mostra: versão antiga vs nova, arquivos do `base/` recopiados (só os com marcador `claude-bmad-superpowers:base`), customizações preservadas em `~/.claude/cbs-overrides/` (inclusive `models.yml`) e a instrução pra atualizar o Superpowers dentro do Claude Code.

2. Liste os projetos BMAD registrados e a versão em cada um:
   ```bash
   npx claude-bmad-superpowers status
   ```
   (seção "Projetos BMAD registrados").

3. Pergunte ao usuário (`AskUserQuestion`; se não estiver disponível, texto corrido) se quer atualizar BMAD em **todos**, em **alguns** (quais) ou em **nenhum**. Default: nenhum.

4. Rode conforme a resposta (a CLI chama `npx bmad-method install --action update --directory <projeto> --tools claude-code --yes` em cada alvo):
   - todos:
     ```bash
     npx claude-bmad-superpowers atualizar --skip-self-update --auto-bmad
     ```
   - alguns:
     ```bash
     npx claude-bmad-superpowers atualizar --skip-self-update --projetos /caminho/a,/caminho/b
     ```
   - nenhum: nada a rodar.

5. Mostre ao usuário a versão nova vs antiga (a saída da CLI já mostra isso) e sugira rodar `npx claude-bmad-superpowers status` pra confirmar.

## Se algo der errado

- Erro no `npx claude-bmad-superpowers`: peça `node --version` (precisa 18+).
- Superpowers: a CLI não atualiza plugin; oriente o usuário a rodar `/plugin update superpowers@superpowers-marketplace` dentro do Claude Code.
- Falha em um projeto BMAD: a CLI reporta e segue pros outros; o usuário pode rodar `cd <projeto> && npx claude-bmad-superpowers instalar-bmad --update` depois.
- Nunca rode `npx claude-bmad-superpowers atualizar` sem `--skip-bmad` nem `--auto-bmad`/`--projetos` antes de perguntar: sem TTY a CLI assume `--auto-bmad` e atualiza todos os projetos.
