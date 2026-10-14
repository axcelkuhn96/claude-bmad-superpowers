---
description: Interrogatório implacável (grilling) sobre um plano, decisão ou ideia — uma pergunta por vez no seletor do CLI, com opções sugeridas e recomendação marcada, até haver entendimento compartilhado. Não implementa. Roda por dentro do /piloto (Etapa 1); use direto quando quiser só stress-testar uma decisão.
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com a entrada; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "grelhar"`, passando a entrada do usuário + resumo curto do que a memória retornou.

A skill conduz o interrogatório: **uma pergunta por vez no seletor interativo do CLI** (`AskUserQuestion`), cada uma com 2-4 opções pra debate e a recomendação marcada `(Recomendado)`. Busca os fatos sozinha e pergunta só as decisões. Sem `AskUserQuestion` na sessão (ou com `--auto`), entra em modo auto: registra a recomendação como `SUPOSIÇÃO` em cada decisão, sem perguntar. Ela **não** implementa nem gera o prompt final — ao fechar ("fechou"), sugere `/piloto` (ou `/refinar`), `/executar` ou `/mapear`.

Entrada do usuário:

$ARGUMENTS
