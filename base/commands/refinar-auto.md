---
description: Mesma skill do /refinar, mas assume tudo que não for crítico (sem perguntar). Marca as suposições explicitamente.
---

**AÇÃO OBRIGATÓRIA AGORA:** invoque a ferramenta `Skill` com `skill: "refinador-de-prompt"` antes de qualquer outra coisa. Passe a entrada do usuário abaixo + a instrução de modo auto.

**Modo auto** (passar no contexto pra skill):
- Não pergunte dúvidas não-bloqueantes — assuma valor razoável e marque como `SUPOSIÇÃO`.
- Pergunte apenas se a dúvida for **realmente** bloqueante (ex.: regra de negócio crítica sem default sensato).
- Liste todas as suposições em destaque no diagnóstico final.

Entrada do usuário:

$ARGUMENTS
