---
description: "Revisa tudo que foi feito (mudanças da branch / working tree ou escopo dado) — code review + cobertura de testes + segurança em subagents general-purpose, com ponytail, domínios e lentes personas/review/ lidos por caminho. Read-only por padrão — grava o relatório em docs/analises/ e só corrige com seu OK. É também o gate final automático de /executar e /piloto."
---

**ORDEM OBRIGATÓRIA:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "claude-mem:mem-search"` (fallback `mem-search`) passando o tema das mudanças como query. Se nenhuma existir, registre "Memória: não disponível".
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "revisor"` em modo **standalone**, passando o escopo (argumentos, ou vazio = mudanças da branch atual) + resumo da memória.

A skill determina o escopo sem editar nada, escreve o diff num arquivo e despacha subagents `general-purpose` read-only (code review com ponytail + domínios; cobertura com `review/cobertura-de-testes.md`; segurança com `review/seguranca.md` só quando há superfície; E2E com Playwright quando há UI sem teste) — todos recebendo **caminhos**, nunca conteúdo colado. Papéis: `final_reviewer` / `tester` / `refactor` de `~/.claude/cbs-overrides/models.yml` (agente nomeado ou modelo). O contexto principal só orquestra.

Relatório em `docs/analises/<data>-revisao-<slug>.md`; chat com 1 linha. **Nada é corrigido sem OK**: a skill termina perguntando "Corrigir os 🔴/🟡 agora? [s/N]" e, com `s`, delega a um implementer `general-purpose` na branch atual, sem worktree, seguido de re-review.

Escopo (opcional — vazio = revisar mudanças da branch atual):

$ARGUMENTS
