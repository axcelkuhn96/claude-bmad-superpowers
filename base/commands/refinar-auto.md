---
description: Mesma skill do /refinar, mas assume tudo que não for crítico (sem perguntar). Marca as suposições explicitamente.
---

Invoque a skill `refinador-de-prompt` com a entrada do usuário abaixo, em **modo auto**:

- Não pergunte dúvidas não-bloqueantes — assuma valor razoável e marque como `SUPOSIÇÃO`.
- Pergunte apenas se a dúvida for **realmente** bloqueante (ex.: regra de negócio crítica sem default sensato).
- Liste todas as suposições em destaque no diagnóstico final.

Entrada do usuário:

$ARGUMENTS
