---
description: Interrogatório implacável (grilling) sobre um plano, decisão ou ideia — uma pergunta por vez no seletor do CLI, com opções sugeridas e recomendação marcada, até haver entendimento compartilhado. Não implementa. Roda por dentro do /piloto (Etapa 1); use direto quando quiser só stress-testar uma decisão.
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com a entrada; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "grelhar"`, passando a entrada do usuário + resumo curto do que a memória retornou.

A skill conduz o interrogatório: **uma pergunta por vez no seletor interativo do CLI** (`AskUserQuestion`), cada uma com 2-4 opções pra debate e a recomendação marcada `(Recomendado)`. Busca os fatos sozinha e pergunta só as decisões. Sem `AskUserQuestion` na sessão (ou com `--auto`), entra em modo auto: registra a recomendação como `SUPOSIÇÃO` em cada decisão, sem perguntar. Ela **não** implementa nem gera o prompt final — ao fechar ("fechou"), sugere `/piloto` (ou `/refinar`), `/executar` ou `/mapear`.

Entrada do usuário:

$ARGUMENTS
