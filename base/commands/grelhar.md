---
description: Interrogatório implacável (grilling) sobre um plano, decisão ou ideia — uma pergunta por vez no seletor do CLI, com opções sugeridas e recomendação marcada, até haver entendimento compartilhado. Não implementa.
---

**ORDEM OBRIGATÓRIA:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando a entrada do usuário como query. Se não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível" e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "grelhar"`, passando a entrada do usuário + resumo curto do que a memória retornou.

A skill conduz o interrogatório: **uma pergunta por vez no seletor interativo do CLI** (`AskUserQuestion`), cada uma com 2-4 opções pra debate e a recomendação marcada `(Recomendado)`. Busca os fatos sozinha e pergunta só as decisões. Ela **não** implementa nem gera o prompt final — ao fechar ("fechou"), ela sugere `/refinar`, `/executar` ou `/mapear`.

Entrada do usuário:

$ARGUMENTS
