---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto, gravado em docs/prompts/. Alias de `/piloto --so-refinar` — grelha as decisões e pergunta só dúvidas bloqueantes antes do prompt final; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto`, na ordem, sem pular:

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`, que usa o hook `PreToolUse` nativo com identidade da sessão. Só o `hookSpecificOutput.additionalContext` com `CBS Mem0:` confirma busca/início. Sem callback ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall sem contexto autoritativo.

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` (entrada + resumo da memória) — uma pergunta por vez, só decisões; espere "fechou".
3. `Skill` `refinador-de-prompt` (entrada + memória + decisões da grelha, modo normal) — grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e pergunta `ok` / ajuste. Pare após o `ok`; **não** invoque o executor.

Não responda nem rode Bash/Read/Grep antes do passo 1.

Entrada do usuário:

$ARGUMENTS
