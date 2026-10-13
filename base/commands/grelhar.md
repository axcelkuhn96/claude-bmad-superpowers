---
description: Interrogatório implacável (grilling) sobre um plano, decisão ou ideia — uma pergunta por vez no seletor do CLI, com opções sugeridas e recomendação marcada, até haver entendimento compartilhado. Não implementa. Roda por dentro do /piloto (Etapa 1); use direto quando quiser só stress-testar uma decisão.
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`. Claude Code usa `Bash` com o gatilho exato indicado pela skill. Codex executa esse mesmo comando via `exec_command` com a raiz do projeto como diretório de trabalho; por `functions.exec`, use `const r=await tools.exec_command({cmd:'cbs memoria hook search <base64url>', workdir:'<raiz-do-projeto>', login:false});text(r.output);`. Considere a operação confirmada somente quando o contexto nativo retornado trouxer o prefixo `CBS Mem0:`. Sem esse contexto, ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall com base em `typed_trigger_only` ou outro retorno da CLI.

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com a entrada; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "grelhar"`, passando a entrada do usuário + resumo curto do que a memória retornou.

A skill conduz o interrogatório: **uma pergunta por vez no seletor interativo do CLI** (`AskUserQuestion`), cada uma com 2-4 opções pra debate e a recomendação marcada `(Recomendado)`. Busca os fatos sozinha e pergunta só as decisões. Sem `AskUserQuestion` na sessão (ou com `--auto`), entra em modo auto: registra a recomendação como `SUPOSIÇÃO` em cada decisão, sem perguntar. Ela **não** implementa nem gera o prompt final — ao fechar ("fechou"), sugere `/piloto` (ou `/refinar`), `/executar` ou `/mapear`.

Entrada do usuário:

$ARGUMENTS
