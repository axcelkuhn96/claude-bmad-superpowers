---
description: Fluxo completo fim-a-fim — refina a ideia em prompt premium, mostra pro usuário, pede OK, e depois executa com BMAD + Superpowers.
---

Execute o fluxo completo em duas etapas:

## Etapa 1 — Refinar

Invoque a skill `refinador-de-prompt` com a entrada do usuário.

Siga o fluxo completo, incluindo Explore subagent obrigatório e detecção BMAD.

Se houver dúvidas bloqueantes, **PERGUNTE** e pare aqui até o usuário responder.

Apresente o **prompt final premium** no formato da skill.

## Etapa 2 — Aguardar OK

Pergunte ao usuário: **"Posso executar este prompt? [s/N/editar]"**

- `s` → siga pra etapa 3
- `N` → pare
- `editar` → ajuste com base no feedback e volte a perguntar

## Etapa 3 — Executar

Invoque a skill `executor-bmad-superpowers` passando o prompt final aprovado.

Execute as 7 fases obrigatórias até a entrega.

Entrada do usuário:

$ARGUMENTS
