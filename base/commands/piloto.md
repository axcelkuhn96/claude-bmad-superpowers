---
description: Fluxo completo fim-a-fim — refina a ideia em prompt premium, mostra pro usuário, pede OK, e depois executa com BMAD + Superpowers.
---

**FLUXO OBRIGATÓRIO — invocações sequenciais da Skill tool:**

## Etapa 0 — Memória (PRIMEIRO de tudo)

Invoque `Skill` com `skill: "mem-search"` passando a entrada do usuário como query. Sem exceção, mesmo se parecer trivial. Se não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível" e siga.

## Etapa 1 — Refinar

Invoque `Skill` com `skill: "refinador-de-prompt"` passando a entrada do usuário + resumo da memória. Aguarde a skill produzir o prompt final premium no formato dela (4 seções, após alinhamento prévio). O refino aqui substitui o brainstorming do Superpowers.

Se a skill emitir dúvidas bloqueantes, **PERGUNTE** ao usuário e pare aqui até a resposta.

## Etapa 2 — Aguardar OK

A própria skill `refinador-de-prompt` faz o loop de iteração ("ajustar algo? ok pra fechar..."). Quando o usuário fechar com `ok` (ou equivalente), pergunte literalmente:

**"Posso executar agora? [s/N]"**

- `s` → siga pra Etapa 3
- `N` → pare (sem invocar executor)

## Etapa 3 — Executar (invoque Skill tool de novo)

Invoque a ferramenta `Skill` com `skill: "executor-bmad-superpowers"` passando o prompt final aprovado. A skill orquestra as fases — e a implementação é **delegada ao `superpowers:subagent-driven-development`** (subagents isolados por task, contexto principal limpo, branch atual sem worktree). O planejamento SEMPRE gera stories com BMAD → `superpowers:writing-plans`, e cada subagent `general-purpose` carrega a persona BMAD do seu papel (`@dev`/review/`@qa`). Haverá outro ponto de parada ("Posso implementar? [s/N]") antes de tocar código.

Entrada do usuário:

$ARGUMENTS
