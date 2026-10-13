---
description: Modo discovery/discussão. Pensa junto com o usuário sobre uma ideia fuzzy, dilema ou dúvida estratégica. Estritamente read-only (nenhuma escrita fora de docs/), saída em docs/analises/ com seção obrigatória "O que quebra se mudar". PROIBIDO tocar em código-fonte.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`, que usa o hook `PreToolUse` nativo com identidade da sessão. Só o `hookSpecificOutput.additionalContext` com `CBS Mem0:` confirma busca/início. Sem callback ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall sem contexto autoritativo.

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "investigador-de-ideia"`, passando o tema + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**READ-ONLY (regra dura):** antes de qualquer `Edit`/`Write`, confira o caminho — só `docs/` é permitido (`docs/analises/`, `docs/prds/`, `docs/mapas/`). Nada de commit, migration, deploy, install. Você **investiga e mede** — não assume; o que não souber vai em "Não sabemos" com o caminho pra descobrir. Se o usuário pedir pra implementar no meio, pare e ofereça gerar o PRD pra ele rodar `/piloto` ou `/executar`.

**Saída:** `docs/analises/<data>-investigacao-<slug>.md` com Enquadramento, Investigação, Abordagens, Análise BMAD, **O que quebra se mudar**, Recomendação e Próximo passo. No chat: 1 linha (caminho + recomendação + "PRD? [s/N]"). Escopo grande demais pra uma sessão → sugira `/mapear`.

Tema:

$ARGUMENTS
