---
description: Executa um prompt refinado (ou PRD) usando BMAD pra planejar e Superpowers pra implementar com TDD, subagents e security review.
---

Invoque a skill `executor-bmad-superpowers` com o prompt/spec abaixo.

Execute as **7 fases obrigatórias**: intake → brainstorming técnico → plano BMAD (PM/Architect/SM com artefatos em `docs/`) → confirmação → implementação TDD → QA + security review (subagents) → entrega no formato definido.

**Lembrete:** TDD não é opcional quando há lógica testável. Subagents (`Explore`, `code-reviewer`, `security-auditor`) são default pra proteger contexto.

Prompt/spec:

$ARGUMENTS
