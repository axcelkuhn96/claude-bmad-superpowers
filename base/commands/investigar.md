---
description: Modo discovery/discussão. Pensa junto com o usuário sobre uma ideia fuzzy, dilema ou dúvida estratégica. PROIBIDO tocar em código-fonte.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando o tema do usuário como query. Mesmo se a tarefa parecer trivial — você não decide se vale; rode sempre. Se a skill `mem-search` não existir no ambiente, tente `claude-mem:mem-search`. Se nenhuma existir, registre "Memória: não disponível neste ambiente" e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "investigador-de-ideia"`, passando o tema + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**LEMBRETE CRÍTICO:** A skill **proíbe** edição de código-fonte. Você só pode escrever em `docs/`, `notas/`, `discovery/`. Se o usuário pedir pra implementar no meio, pare e ofereça gerar PRD pra ele rodar `/piloto` ou `/executar`.

Tema:

$ARGUMENTS
