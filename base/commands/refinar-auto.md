---
description: Mesma skill do /refinar, mas assume tudo que não for crítico (sem perguntar). Marca as suposições explicitamente.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando a entrada do usuário como query. Sem exceção. Se `mem-search` não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível".
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "refinador-de-prompt"`, passando a entrada + resumo da memória + a instrução de modo auto abaixo.

**Modo auto** (passar no contexto pra skill):
- **PULA a Fase 5 (Alinhamento prévio)** — não pare pra confirmar, vá direto pro prompt.
- Não pergunte dúvidas não-bloqueantes — assuma valor razoável e marque como `SUPOSIÇÃO`.
- Pergunte apenas se a dúvida for **realmente** bloqueante (ex.: regra de negócio crítica sem default sensato).
- Liste todas as suposições em destaque no diagnóstico final.

Entrada do usuário:

$ARGUMENTS
