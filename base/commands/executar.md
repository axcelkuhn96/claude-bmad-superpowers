---
description: Executa um prompt refinado (ou PRD) usando BMAD pra planejar e Superpowers pra implementar com TDD, subagents e security review.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando o tema/intent extraído do prompt como query. Sem exceção. Se `mem-search` não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível".
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "executor-bmad-superpowers"`, passando o prompt + resumo curto da memória (ou "nada relevante").

**Lembrete:** TDD não é opcional quando há lógica testável. Subagents (`Explore`, `code-reviewer`, `security-auditor`) são default pra proteger contexto.

Prompt/spec:

$ARGUMENTS
