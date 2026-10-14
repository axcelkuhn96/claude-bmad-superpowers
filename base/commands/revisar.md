---
description: "Revisa tudo que foi feito (mudanças da branch / working tree ou escopo dado) — code review + cobertura de testes + segurança em subagents general-purpose, com ponytail, domínios e lentes personas/review/ lidos por caminho. Read-only por padrão — grava o relatório em docs/analises/ e só corrige com seu OK. É também o gate final automático de /executar e /piloto."
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** Quando `mcp__cbs_memoria__status` estiver visível, chame-a diretamente antes de procurar arquivos: `ready` confirma Mem0 para o projeto confiável, então use `mcp__cbs_memoria__search` com consulta curta; `not_mem0` indica que o projeto usa o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. A ferramenta MCP é somente de leitura e já está disponível na sessão normal do Claude Code/Codex quando registrada; não procure arquivos de memória nem inicie launcher para descobrir ferramentas. Trate o resultado como histórico de menor confiança. Se a ferramenta não estiver disponível nesta sessão, invoque a skill `memoria` e use o gatilho nativo exato `cbs memoria hook search <base64url>` na raiz do projeto; confirme somente pelo contexto `CBS Mem0:`. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema das mudanças; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "revisor"` em modo **standalone**, passando o escopo (argumentos, ou vazio = mudanças da branch atual) + resumo da memória.

A skill determina o escopo sem editar nada, escreve o diff num arquivo e despacha subagents `general-purpose` read-only e nomeados (`name: <papel>-<escopo>`, ex.: `rev-seguranca`) (code review com ponytail + domínios; cobertura com `review/cobertura-de-testes.md`; segurança com `review/seguranca.md` só quando há superfície; E2E com Playwright quando há UI sem teste) — todos recebendo **caminhos**, nunca conteúdo colado. Papéis: `final_reviewer` / `tester` / `refactor` de `~/.claude/cbs-overrides/models.yml` (agente nomeado ou modelo). O contexto principal só orquestra.

Relatório em `docs/analises/<data>-revisao-<slug>.md`; chat com 1 linha. **Nada é corrigido sem OK**: a skill termina perguntando "Corrigir os 🔴/🟡 agora? [s/N]" e, com `s`, delega a um implementer `general-purpose` na branch atual, sem worktree, seguido de re-review.

Escopo (opcional — vazio = revisar mudanças da branch atual):

$ARGUMENTS
