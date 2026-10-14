---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto, gravado em docs/prompts/. Alias de `/piloto --so-refinar` — grelha as decisões e pergunta só dúvidas bloqueantes antes do prompt final; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto`, na ordem, sem pular:

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` (entrada + resumo da memória) — uma pergunta por vez, só decisões; espere "fechou".
3. `Skill` `refinador-de-prompt` (entrada + memória + decisões da grelha, modo normal) — grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e pergunta `ok` / ajuste. Pare após o `ok`; **não** invoque o executor.

Não responda nem rode Bash/Read/Grep antes do passo 1.

Entrada do usuário:

$ARGUMENTS
