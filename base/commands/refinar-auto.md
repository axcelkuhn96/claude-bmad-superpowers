---
description: Mesma coisa do /refinar, mas sem perguntar nada — toda dúvida, inclusive bloqueante, vira SUPOSIÇÃO destacada no prompt. Alias de `/piloto --auto --so-refinar`; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --auto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--auto --so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto` em modo auto:

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`, que usa o hook `PreToolUse` nativo com identidade da sessão. Só o `hookSpecificOutput.additionalContext` com `CBS Mem0:` confirma busca/início. Sem callback ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall sem contexto autoritativo.

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` em **modo auto** — sem perguntas; cada decisão recebe a recomendação registrada como `SUPOSIÇÃO`.
3. `Skill` `refinador-de-prompt` em **modo auto** — não pergunta, assume valor razoável e marca `SUPOSIÇÃO` em destaque; grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e encerra sem gate. **Não** invoque o executor.

Entrada do usuário:

$ARGUMENTS
