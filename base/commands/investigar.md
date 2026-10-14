---
description: Modo discovery/discussão. Pensa junto com o usuário sobre uma ideia fuzzy, dilema ou dúvida estratégica. Estritamente read-only (nenhuma escrita fora de docs/), saída em docs/analises/ com seção obrigatória "O que quebra se mudar". PROIBIDO tocar em código-fonte.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "investigador-de-ideia"`, passando o tema + um resumo curto do que a memória retornou (ou "nada relevante encontrado").

Não responda nem rode Bash/Read/Grep antes desses 2 passos.

**READ-ONLY (regra dura):** antes de qualquer `Edit`/`Write`, confira o caminho — só `docs/` é permitido (`docs/analises/`, `docs/prds/`, `docs/mapas/`). Nada de commit, migration, deploy, install. Você **investiga e mede** — não assume; o que não souber vai em "Não sabemos" com o caminho pra descobrir. Se o usuário pedir pra implementar no meio, pare e ofereça gerar o PRD pra ele rodar `/piloto` ou `/executar`.

**Saída:** `docs/analises/<data>-investigacao-<slug>.md` com Enquadramento, Investigação, Abordagens, Análise BMAD, **O que quebra se mudar**, Recomendação e Próximo passo. No chat: 1 linha (caminho + recomendação + "PRD? [s/N]"). Escopo grande demais pra uma sessão → sugira `/mapear`.

Tema:

$ARGUMENTS
