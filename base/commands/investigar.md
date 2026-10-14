---
description: Modo discovery/discussão. Pensa junto com o usuário sobre uma ideia fuzzy, dilema ou dúvida estratégica. Estritamente read-only (nenhuma escrita fora de docs/), saída em docs/analises/ com seção obrigatória "O que quebra se mudar". PROIBIDO tocar em código-fonte.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "investigador-de-ideia"`, passando o tema + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**READ-ONLY (regra dura):** antes de qualquer `Edit`/`Write`, confira o caminho — só `docs/` é permitido (`docs/analises/`, `docs/prds/`, `docs/mapas/`). Nada de commit, migration, deploy, install. Você **investiga e mede** — não assume; o que não souber vai em "Não sabemos" com o caminho pra descobrir. Se o usuário pedir pra implementar no meio, pare e ofereça gerar o PRD pra ele rodar `/piloto` ou `/executar`.

**Saída:** `docs/analises/<data>-investigacao-<slug>.md` com Enquadramento, Investigação, Abordagens, Análise BMAD, **O que quebra se mudar**, Recomendação e Próximo passo. No chat: 1 linha (caminho + recomendação + "PRD? [s/N]"). Escopo grande demais pra uma sessão → sugira `/mapear`.

Tema:

$ARGUMENTS
