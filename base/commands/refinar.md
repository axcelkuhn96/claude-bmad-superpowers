---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto, gravado em docs/prompts/. Alias de `/piloto --so-refinar` — grelha as decisões e pergunta só dúvidas bloqueantes antes do prompt final; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto`, na ordem, sem pular:

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` (entrada + resumo da memória) — uma pergunta por vez, só decisões; espere "fechou".
3. `Skill` `refinador-de-prompt` (entrada + memória + decisões da grelha, modo normal) — grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e pergunta `ok` / ajuste. Pare após o `ok`; **não** invoque o executor.

Não responda nem rode Bash/Read/Grep antes do passo 1.

Entrada do usuário:

$ARGUMENTS
