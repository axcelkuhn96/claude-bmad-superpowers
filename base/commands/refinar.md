---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto, gravado em docs/prompts/. Alias de `/piloto --so-refinar` — grelha as decisões e pergunta só dúvidas bloqueantes antes do prompt final; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto`, na ordem, sem pular:

**Roteamento de memória:** Na sessão Mem0 iniciada pelo launcher CBS (ou em checkout com `.cbs/memoria.json` `provider: mem0` sem vínculo), use somente `cbs_memoria.search` do MCP. Se a ferramenta estiver indisponível ou responder `unbound`/`unavailable`/`abstain`, registre "Memória: não disponível" e continue sem chamar `claude-mem:mem-search` nem `mem-search`. As instruções de busca Claude abaixo valem somente para sessão `claude-mem` congelada.

1. `Skill` `claude-mem:mem-search` (fallback `mem-search`) com a entrada como query — sem exceção; sem skill, "Memória: não disponível".
2. `Skill` `grelhar` (entrada + resumo da memória) — uma pergunta por vez, só decisões; espere "fechou".
3. `Skill` `refinador-de-prompt` (entrada + memória + decisões da grelha, modo normal) — grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e pergunta `ok` / ajuste. Pare após o `ok`; **não** invoque o executor.

Não responda nem rode Bash/Read/Grep antes do passo 1.

Entrada do usuário:

$ARGUMENTS
