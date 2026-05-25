---
description: Executa um prompt refinado (ou PRD) — BMAD planeja, e a implementação é DELEGADA ao superpowers:subagent-driven-development (subagents isolados por task, contexto principal limpo).
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando o tema/intent extraído do prompt como query. Sem exceção. Se `mem-search` não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível".
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "executor-bmad-superpowers"`, passando o prompt + resumo curto da memória (ou "nada relevante").

**Lembrete:** o executor é um ORQUESTRADOR — ele NÃO implementa inline. A implementação (Fase 5) é delegada ao `superpowers:subagent-driven-development`, que despacha implementer + 2 reviewers por task. Trabalhar na branch atual, sem worktree. Há um ponto de parada ("Posso implementar? [s/N]") antes da execução.

**BMAD + Superpowers sempre juntos:** o planejamento (Fase 3) SEMPRE gera as stories com BMAD e converte em plano via `superpowers:writing-plans`. Na execução, cada subagent `general-purpose` carrega a persona BMAD correspondente (`@dev` no implementer, review/`@qa` nos reviewers). Não há flag pra desligar — Superpowers é o motor, BMAD é a disciplina injetada nele.

Prompt/spec:

$ARGUMENTS
