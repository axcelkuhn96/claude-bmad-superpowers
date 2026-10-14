---
description: "Fluxo completo fim-a-fim — grelha a ideia, refina em prompt premium (gate 1), planeja (gate 2) e executa com BMAD + Superpowers; gate de integração antes de push/merge/deploy. Flags — --auto (sem gates de decisão), --so-refinar (para no prompt), models=papel:valor / modelo=x (agente nomeado ou modelo por papel)."
---

**Flags** — primeiras palavras de `$ARGUMENTS`; remova-as antes de passar a entrada às skills e registre o modo em 1 linha (`modo: auto|normal`):

- `--auto` (ou `auto`) → **modo autônomo**: sem grelha interativa (cada decisão vira recomendação registrada como `SUPOSIÇÃO`), sem gate 1 nem gate 2. **Único gate** = integração (menu antes de `git push` / merge / deploy). O mesmo modo vale, sem flag, se `printenv CLAUDE_AUTONOMOUS` estiver definida ou se `AskUserQuestion` não existir na sessão.
- `--so-refinar` → executa as Etapas 0–2 e para (é o que `/refinar` e `/refinar-auto` chamam).
- `models=implementer_backend:opus,reviewer:fable` ou `modelo=opus` → override de `~/.claude/cbs-overrides/models.yml` (papéis: `orchestrator`, `architect`, `implementer_backend`, `implementer_frontend`, `refactor`, `reviewer`, `final_reviewer`, `tester`, `explorer`, `search`; valor = nome de agente em `~/.claude/agents` (ex.: `cbs-backend`) / `~/.codex/agents` ou modelo `sonnet|opus|fable|inherit`); repasse literal ao executor.

Chat enxuto: 1 linha por etapa. O detalhe vai pros arquivos (`docs/prompts/`, plano, `.superpowers/sdd/`, `docs/analises/`).

## Etapa 0 — Memória (primeiro de tudo)

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

Invoque a skill `memoria` com a entrada se o projeto selecionou Mem0; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.

## Etapa 1 — Grelhar

Invoque `Skill` com `skill: "grelhar"` passando a entrada + resumo da memória + o modo. Normal: uma pergunta por vez no `AskUserQuestion`, só decisões (fatos ela busca sozinha); espere **"fechou"**. Auto: modo auto da skill (sem perguntas, recomendação registrada por decisão). Se a grelha revelar escopo grande demais pra uma sessão: normal → ofereça `/mapear` e pare; auto → registre `SUPOSIÇÃO: escopo cabe numa sessão`, siga, e anote na entrega que `/mapear` era o indicado.

## Etapa 2 — Refinar (gate 1)

Invoque `Skill` com `skill: "refinador-de-prompt"` passando a entrada + resumo da memória + **decisões fechadas na grelha** + o modo. Ela grava `docs/prompts/<data>-<slug>.md` (com `tipo_de_tarefa` e `dominios_previstos`) e responde 1 linha. Não reabra decisões da grelha.

- Normal: a pergunta dela (**`ok` executa / diga o que mudar**) é o **gate 1**. `ok` → Etapa 3.
- Auto: sem pergunta → Etapa 3.
- `--so-refinar`: pare aqui (após o `ok`, no modo normal).

## Etapa 3 — Executar

Invoque `Skill` com `skill: "executor-bmad-superpowers"` passando o caminho do prompt + modo + models. O executor tem o **gate 2** (aprovação do plano, só no modo normal) e o **gate de integração** (`finishing-a-development-branch`, em qualquer modo). Não há outro ponto de parada: implementação delegada ao `superpowers:subagent-driven-development` na branch atual (`feat/<slug>` se estava em main), personas por caminho, subagents nomeados (`name: <papel>-<escopo>`, endereçáveis por `@nome`), revisão final automática (`revisor`) quando houver gatilho.

Entrada do usuário:

$ARGUMENTS
