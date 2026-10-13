---
description: "Revisa tudo que foi feito (mudanças da branch / working tree ou escopo dado) — code review + cobertura de testes + segurança em subagents general-purpose, com ponytail, domínios e lentes personas/review/ lidos por caminho. Read-only por padrão — grava o relatório em docs/analises/ e só corrige com seu OK. É também o gate final automático de /executar e /piloto."
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`, que usa o hook `PreToolUse` nativo com identidade da sessão. Só o `hookSpecificOutput.additionalContext` com `CBS Mem0:` confirma busca/início. Sem callback ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall sem contexto autoritativo.

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com o tema das mudanças; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
2. **SÓ DEPOIS**: invoque `Skill` com `skill: "revisor"` em modo **standalone**, passando o escopo (argumentos, ou vazio = mudanças da branch atual) + resumo da memória.

A skill determina o escopo sem editar nada, escreve o diff num arquivo e despacha subagents `general-purpose` read-only e nomeados (`name: <papel>-<escopo>`, ex.: `rev-seguranca`) (code review com ponytail + domínios; cobertura com `review/cobertura-de-testes.md`; segurança com `review/seguranca.md` só quando há superfície; E2E com Playwright quando há UI sem teste) — todos recebendo **caminhos**, nunca conteúdo colado. Papéis: `final_reviewer` / `tester` / `refactor` de `~/.claude/cbs-overrides/models.yml` (agente nomeado ou modelo). O contexto principal só orquestra.

Relatório em `docs/analises/<data>-revisao-<slug>.md`; chat com 1 linha. **Nada é corrigido sem OK**: a skill termina perguntando "Corrigir os 🔴/🟡 agora? [s/N]" e, com `s`, delega a um implementer `general-purpose` na branch atual, sem worktree, seguido de re-review.

Escopo (opcional — vazio = revisar mudanças da branch atual):

$ARGUMENTS
