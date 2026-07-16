---
description: Compacta a conversa atual num documento de handoff pra outro agente/sessão continuar sem reler o histórico. Referencia artefatos (não duplica), redige segredos, sugere próximas skills.
---

Invoque `Skill` com `skill: "handoff"`. Se o usuário passou argumentos, trate-os como **descrição do foco da próxima sessão** e ajuste o documento pra isso.

A skill salva o handoff em `docs/handoffs/` (se houver `docs/`) ou no diretório temporário do SO, referenciando specs/planos/commits por caminho, redigindo qualquer segredo, e incluindo uma seção "Skills sugeridas".

Foco da próxima sessão (opcional):

$ARGUMENTS
