---
description: "Executa um prompt refinado (ou PRD/caminho de docs/prompts/) — BMAD gera as stories, e a implementação é DELEGADA ao superpowers:subagent-driven-development (subagents isolados por task, personas por caminho, contexto principal limpo). Gate do plano + gate de integração. Flags — --auto, models=papel:valor / modelo=x."
---

**Flags** — primeiras palavras de `$ARGUMENTS`; remova-as antes de passar o prompt e registre o modo em 1 linha:

- `--auto` (ou `auto`) → modo autônomo: sem gate do plano; o "Which approach?" do `writing-plans` é respondido pelo executor; **único gate** = integração (menu antes de `git push` / merge / deploy). Vale também, sem flag, com `CLAUDE_AUTONOMOUS` definida ou sem `AskUserQuestion` na sessão.
- `models=implementer_backend:opus,reviewer:fable` ou `modelo=opus` → override de `~/.claude/cbs-overrides/models.yml` (papéis: `orchestrator`, `architect`, `implementer_backend`, `implementer_frontend`, `refactor`, `reviewer`, `final_reviewer`, `tester`, `explorer`, `search`; valor = nome de agente em `~/.claude/agents` (ex.: `cbs-backend`) / `~/.codex/agents` ou modelo `sonnet|opus|fable|inherit`); repasse literal.

**ORDEM OBRIGATÓRIA:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "claude-mem:mem-search"` (fallback `mem-search`) passando o tema/intent extraído do prompt como query. Se nenhuma existir, registre "Memória: não disponível".
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "executor-bmad-superpowers"`, passando o prompt (ou o caminho do arquivo) + resumo curto da memória + modo + models.

**Lembrete:** o executor é um ORQUESTRADOR — não implementa inline. Fase 5 delegada ao `superpowers:subagent-driven-development` (implementer → task reviewer → re-reviewer → reviewer final, todos `general-purpose` e nomeados — `impl-t<N>`, `rev-t<N>`, `rerev-t<N>-r<R>`, `rev-final` — pra você falar com eles por `@nome`); persona dev, ponytail, domínios e lentes de review chegam aos subagents **por caminho**. Branch atual (`feat/<slug>` se estava em main), sem worktree. Gates: plano (Fase 4, modo normal) e integração (fim, sempre). Revisão final automática (`revisor`) só quando alguma task marcou `review: seguranca` explícito ou é `ui` sem teste unitário. O executor responde sozinho os menus do BMAD e do brainstorming, e manda o SDD parar antes do Finish dele (entrega, commit dos relatórios e `finishing-a-development-branch` são do executor, uma vez só). Chat: 1 linha por fase; entrega em `docs/analises/`.

Prompt/spec:

$ARGUMENTS
