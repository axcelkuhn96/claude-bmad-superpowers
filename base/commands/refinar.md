---
description: Transforma uma ideia crua em prompt premium contextualizado pelo projeto, gravado em docs/prompts/. Alias de `/piloto --so-refinar` — grelha as decisões e pergunta só dúvidas bloqueantes antes do prompt final; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto`, na ordem, sem pular:

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`. Claude Code usa `Bash` com o gatilho exato indicado pela skill. Codex executa esse mesmo comando via `exec_command` com a raiz do projeto como diretório de trabalho; por `functions.exec`, use `const r=await tools.exec_command({cmd:'cbs memoria hook search <base64url>', workdir:'<raiz-do-projeto>', login:false});text(r.output);`. Considere a operação confirmada somente quando o contexto nativo retornado trouxer o prefixo `CBS Mem0:`. Sem esse contexto, ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall com base em `typed_trigger_only` ou outro retorno da CLI.

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` (entrada + resumo da memória) — uma pergunta por vez, só decisões; espere "fechou".
3. `Skill` `refinador-de-prompt` (entrada + memória + decisões da grelha, modo normal) — grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e pergunta `ok` / ajuste. Pare após o `ok`; **não** invoque o executor.

Não responda nem rode Bash/Read/Grep antes do passo 1.

Entrada do usuário:

$ARGUMENTS
