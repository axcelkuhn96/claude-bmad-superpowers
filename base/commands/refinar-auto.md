---
description: Mesma coisa do /refinar, mas sem perguntar nada — toda dúvida, inclusive bloqueante, vira SUPOSIÇÃO destacada no prompt. Alias de `/piloto --auto --so-refinar`; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --auto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--auto --so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto` em modo auto:

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` em **modo auto** — sem perguntas; cada decisão recebe a recomendação registrada como `SUPOSIÇÃO`.
3. `Skill` `refinador-de-prompt` em **modo auto** — não pergunta, assume valor razoável e marca `SUPOSIÇÃO` em destaque; grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e encerra sem gate. **Não** invoque o executor.

Entrada do usuário:

$ARGUMENTS
