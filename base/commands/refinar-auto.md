---
description: Mesma coisa do /refinar, mas sem perguntar nada — toda dúvida, inclusive bloqueante, vira SUPOSIÇÃO destacada no prompt. Alias de `/piloto --auto --so-refinar`; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --auto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--auto --so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto` em modo auto:

**Roteamento de memória:** Na sessão Mem0 iniciada pelo launcher CBS (ou em checkout com `.cbs/memoria.json` `provider: mem0` sem vínculo), use somente `cbs_memoria.search` do MCP. Se a ferramenta estiver indisponível ou responder `unbound`/`unavailable`/`abstain`, registre "Memória: não disponível" e continue sem chamar `claude-mem:mem-search` nem `mem-search`. As instruções de busca Claude abaixo valem somente para sessão `claude-mem` congelada.

1. `Skill` `claude-mem:mem-search` (fallback `mem-search`) com a entrada como query; sem skill, "Memória: não disponível".
2. `Skill` `grelhar` em **modo auto** — sem perguntas; cada decisão recebe a recomendação registrada como `SUPOSIÇÃO`.
3. `Skill` `refinador-de-prompt` em **modo auto** — não pergunta, assume valor razoável e marca `SUPOSIÇÃO` em destaque; grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e encerra sem gate. **Não** invoque o executor.

Entrada do usuário:

$ARGUMENTS
