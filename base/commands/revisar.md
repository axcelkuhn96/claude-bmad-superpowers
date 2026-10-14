---
description: "Revisa tudo que foi feito (mudanças da branch / working tree ou escopo dado) — code review + cobertura de testes + segurança em subagents general-purpose, com ponytail, domínios e lentes personas/review/ lidos por caminho. Read-only por padrão — grava o relatório em docs/analises/ e só corrige com seu OK. É também o gate final automático de /executar e /piloto."
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema das mudanças; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "revisor"` em modo **standalone**, passando o escopo (argumentos, ou vazio = mudanças da branch atual) + resumo da memória.

A skill determina o escopo sem editar nada, escreve o diff num arquivo e despacha subagents `general-purpose` read-only e nomeados (`name: <papel>-<escopo>`, ex.: `rev-seguranca`) (code review com ponytail + domínios; cobertura com `review/cobertura-de-testes.md`; segurança com `review/seguranca.md` só quando há superfície; E2E com Playwright quando há UI sem teste) — todos recebendo **caminhos**, nunca conteúdo colado. Papéis: `final_reviewer` / `tester` / `refactor` de `~/.claude/cbs-overrides/models.yml` (agente nomeado ou modelo). O contexto principal só orquestra.

Relatório em `docs/analises/<data>-revisao-<slug>.md`; chat com 1 linha. **Nada é corrigido sem OK**: a skill termina perguntando "Corrigir os 🔴/🟡 agora? [s/N]" e, com `s`, delega a um implementer `general-purpose` na branch atual, sem worktree, seguido de re-review.

Escopo (opcional — vazio = revisar mudanças da branch atual):

$ARGUMENTS
