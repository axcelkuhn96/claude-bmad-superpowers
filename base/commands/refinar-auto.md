---
description: Mesma coisa do /refinar, mas sem perguntar nada — toda dúvida, inclusive bloqueante, vira SUPOSIÇÃO destacada no prompt. Alias de `/piloto --auto --so-refinar`; não executa.
---

Este comando é um **alias fino**: equivale a `/piloto --auto --so-refinar <entrada>`.

Invoque `Skill` com `skill: "piloto"` passando `--auto --so-refinar` + a entrada do usuário. Se não for possível encadear o comando, execute você mesmo as Etapas 0–2 do `/piloto` em modo auto:

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`. Claude Code usa `Bash` com o gatilho exato indicado pela skill. Codex executa esse mesmo comando via `exec_command` com a raiz do projeto como diretório de trabalho; por `functions.exec`, use `const r=await tools.exec_command({cmd:'cbs memoria hook search <base64url>', workdir:'<raiz-do-projeto>', login:false});text(r.output);`. Considere a operação confirmada somente quando o contexto nativo retornado trouxer o prefixo `CBS Mem0:`. Sem esse contexto, ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall com base em `typed_trigger_only` ou outro retorno da CLI.

1. Em projeto com Mem0 selecionado, invoque a skill `memoria` com a entrada; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. `Skill` `grelhar` em **modo auto** — sem perguntas; cada decisão recebe a recomendação registrada como `SUPOSIÇÃO`.
3. `Skill` `refinador-de-prompt` em **modo auto** — não pergunta, assume valor razoável e marca `SUPOSIÇÃO` em destaque; grava `docs/prompts/<data>-<slug>.md`, responde 1 linha e encerra sem gate. **Não** invoque o executor.

Entrada do usuário:

$ARGUMENTS
