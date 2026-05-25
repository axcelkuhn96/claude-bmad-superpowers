---
description: Executa um prompt refinado (ou PRD) usando BMAD pra planejar e Superpowers pra implementar com TDD, subagents e security review.
---

**AÇÃO OBRIGATÓRIA AGORA:** invoque a ferramenta `Skill` com `skill: "executor-bmad-superpowers"` antes de qualquer outra coisa. Não responda nem rode outras tools antes da invocação. A skill define o fluxo das 7 fases obrigatórias.

Passe o prompt/spec abaixo como contexto pra skill.

**Lembrete:** TDD não é opcional quando há lógica testável. Subagents (`Explore`, `code-reviewer`, `security-auditor`) são default pra proteger contexto.

Prompt/spec:

$ARGUMENTS
