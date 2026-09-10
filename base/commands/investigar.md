---
description: Modo discovery/discussão. Pensa junto com o usuário sobre uma ideia fuzzy, dilema ou dúvida estratégica. Estritamente read-only (nenhuma escrita fora de docs/), saída em docs/analises/ com seção obrigatória "O que quebra se mudar". PROIBIDO tocar em código-fonte.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "claude-mem:mem-search"` (fallback `mem-search`) passando o tema do usuário como query. Mesmo se parecer trivial. Se nenhuma existir, registre "Memória: não disponível" e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "investigador-de-ideia"`, passando o tema + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**READ-ONLY (regra dura):** antes de qualquer `Edit`/`Write`, confira o caminho — só `docs/` é permitido (`docs/analises/`, `docs/prds/`, `docs/mapas/`). Nada de commit, migration, deploy, install. Você **investiga e mede** — não assume; o que não souber vai em "Não sabemos" com o caminho pra descobrir. Se o usuário pedir pra implementar no meio, pare e ofereça gerar o PRD pra ele rodar `/piloto` ou `/executar`.

**Saída:** `docs/analises/<data>-investigacao-<slug>.md` com Enquadramento, Investigação, Abordagens, Análise BMAD, **O que quebra se mudar**, Recomendação e Próximo passo. No chat: 1 linha (caminho + recomendação + "PRD? [s/N]"). Escopo grande demais pra uma sessão → sugira `/mapear`.

Tema:

$ARGUMENTS
