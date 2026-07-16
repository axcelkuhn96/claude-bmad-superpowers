---
description: Fluxo completo fim-a-fim — grelha a ideia (interrogatório), refina em prompt premium, pede OK, e executa com BMAD + Superpowers.
---

**FLUXO OBRIGATÓRIO — invocações sequenciais da Skill tool:**

## Etapa 0 — Memória (PRIMEIRO de tudo)

Invoque `Skill` com `skill: "mem-search"` passando a entrada do usuário como query. Sem exceção, mesmo se parecer trivial. Se não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível" e siga.

## Etapa 1 — Grelhar (interrogatório antes de refinar)

Invoque `Skill` com `skill: "grelhar"` passando a entrada do usuário + resumo da memória. A skill interroga o usuário — **uma pergunta por vez, com resposta recomendada**, buscando fatos sozinha e pondo só as decisões pra ele — descendo a árvore de decisão até haver **entendimento compartilhado**. É aqui que as escolhas ficam afiadas antes de gastar tokens gerando o prompt.

Espere o usuário fechar a grelha (**"fechou"** / equivalente). Só então siga pra Etapa 2. Não pule esta etapa: ela se auto-escala (ideia trivial fecha em 1-2 perguntas; ideia grande destrincha vários galhos). Se a grelha revelar que o escopo é grande demais pra uma sessão, ofereça `/mapear` em vez de seguir direto.

## Etapa 2 — Refinar

Invoque `Skill` com `skill: "refinador-de-prompt"` passando a entrada do usuário + resumo da memória + as **decisões fechadas na grelha**. Aguarde a skill produzir o prompt final premium no formato dela (4 seções). Como a grelha já resolveu as decisões, o "Alinhamento prévio" da refinador vira uma **confirmação rápida** — não reabra as mesmas perguntas.

Se ainda restar dúvida bloqueante, **PERGUNTE** ao usuário e pare aqui até a resposta.

## Etapa 3 — Aguardar OK

A própria skill `refinador-de-prompt` faz o loop de iteração ("ajustar algo? ok pra fechar..."). Quando o usuário fechar com `ok` (ou equivalente), pergunte literalmente:

**"Posso executar agora? [s/N]"**

- `s` → siga pra Etapa 4
- `N` → pare (sem invocar executor)

## Etapa 4 — Executar (invoque Skill tool de novo)

Invoque a ferramenta `Skill` com `skill: "executor-bmad-superpowers"` passando o prompt final aprovado. A skill orquestra as fases — e a implementação é **delegada ao `superpowers:subagent-driven-development`** (subagents isolados por task, contexto principal limpo, branch atual sem worktree). O planejamento SEMPRE gera stories com BMAD → `superpowers:writing-plans`, e cada subagent `general-purpose` carrega a persona BMAD do seu papel (`@dev`/review/`@qa`). Haverá outro ponto de parada ("Posso implementar? [s/N]") antes de tocar código.

Entrada do usuário:

$ARGUMENTS
