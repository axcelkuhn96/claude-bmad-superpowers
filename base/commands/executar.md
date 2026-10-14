---
description: "Executa um prompt refinado (ou PRD/caminho de docs/prompts/) — BMAD gera as stories, e a implementação é DELEGADA ao superpowers:subagent-driven-development (subagents isolados por task, personas por caminho, contexto principal limpo). Gate do plano + gate de integração. Flags — --auto, models=papel:valor / modelo=x."
---

**Flags** — primeiras palavras de `$ARGUMENTS`; remova-as antes de passar o prompt e registre o modo em 1 linha:

- `--auto` (ou `auto`) → modo autônomo: sem gate do plano; o "Which approach?" do `writing-plans` é respondido pelo executor; **único gate** = integração (menu antes de `git push` / merge / deploy). Vale também, sem flag, com `CLAUDE_AUTONOMOUS` definida ou sem `AskUserQuestion` na sessão.
- `models=implementer_backend:opus,reviewer:fable` ou `modelo=opus` → override de `~/.claude/cbs-overrides/models.yml` (papéis: `orchestrator`, `architect`, `implementer_backend`, `implementer_frontend`, `refactor`, `reviewer`, `final_reviewer`, `tester`, `explorer`, `search`; valor = nome de agente em `~/.claude/agents` (ex.: `cbs-backend`) / `~/.codex/agents` ou modelo `sonnet|opus|fable|inherit`); repasse literal.

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema/intent; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "executor-bmad-superpowers"`, passando o prompt (ou o caminho do arquivo) + resumo curto da memória + modo + models.

**Lembrete:** o executor é um ORQUESTRADOR — não implementa inline. Fase 5 delegada ao `superpowers:subagent-driven-development` (implementer → task reviewer → re-reviewer → reviewer final, `general-purpose` ou o agente do `models.yml`, com `name` — `impl-t<N>`, `rev-t<N>`, `rerev-t<N>-r<R>`, `rev-final` — pra você falar com eles por `@nome`); persona dev, ponytail, domínios e lentes de review chegam aos subagents **por caminho**. Branch atual (`feat/<slug>` se estava em main), sem worktree. Gates: plano (Fase 4, modo normal) e integração (fim, sempre). Revisão final automática (`revisor`) só quando alguma task marcou `review: seguranca` explícito ou é `ui` sem teste unitário. O executor responde sozinho os menus do BMAD e do brainstorming, e manda o SDD parar antes do Finish dele (entrega, commit dos relatórios e `finishing-a-development-branch` são do executor, uma vez só). Chat: 1 linha por fase; entrega em `docs/analises/`.

Prompt/spec:

$ARGUMENTS
