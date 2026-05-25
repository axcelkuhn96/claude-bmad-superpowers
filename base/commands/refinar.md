---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto. Pergunta dúvidas bloqueantes antes de gerar o prompt final.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando a entrada do usuário como query. Mesmo se a ideia parecer trivial — você não decide se vale; rode sempre. Se a skill `mem-search` não existir, tente `claude-mem:mem-search`. Se nenhuma existir, registre "Memória: não disponível" e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "refinador-de-prompt"`, passando a entrada + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**Importante:** Se houver dúvidas bloqueantes, a skill vai PERGUNTAR antes de gerar o prompt. Mesmo se a ideia for ruim (ex.: recriar algo que existe), emita o formato completo — não termine cedo.

Entrada do usuário:

$ARGUMENTS
