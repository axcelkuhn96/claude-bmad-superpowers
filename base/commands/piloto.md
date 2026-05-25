---
description: Fluxo completo fim-a-fim — refina a ideia em prompt premium, mostra pro usuário, pede OK, e depois executa com BMAD + Superpowers.
---

**FLUXO OBRIGATÓRIO em duas invocações de Skill tool:**

## Etapa 1 — Refinar (invoque Skill tool AGORA)

Invoque a ferramenta `Skill` com `skill: "refinador-de-prompt"` passando a entrada do usuário abaixo. Aguarde a skill produzir o prompt final premium no formato dela (5 seções).

Se a skill emitir dúvidas bloqueantes, **PERGUNTE** ao usuário e pare aqui até a resposta.

## Etapa 2 — Aguardar OK

A própria skill `refinador-de-prompt` faz o loop de iteração ("ajustar algo? ok pra fechar..."). Quando o usuário fechar com `ok` (ou equivalente), pergunte literalmente:

**"Posso executar agora? [s/N]"**

- `s` → siga pra Etapa 3
- `N` → pare (sem invocar executor)

## Etapa 3 — Executar (invoque Skill tool de novo)

Invoque a ferramenta `Skill` com `skill: "executor-bmad-superpowers"` passando o prompt final aprovado. A skill vai executar as 7 fases obrigatórias.

Entrada do usuário:

$ARGUMENTS
