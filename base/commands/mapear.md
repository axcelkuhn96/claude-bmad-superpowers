---
description: Cartografa um trabalho grande demais pra uma sessão só como um mapa de decisões em docs/mapas/, resolvendo tickets um a um (wayfinder). Evolução do /investigar pra escopos grandes — o /investigar e a grelha do /piloto encaminham pra cá quando o escopo não cabe numa sessão. Não toca código de aplicação.
---

**ORDEM OBRIGATÓRIA:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "claude-mem:mem-search"` (fallback `mem-search`) passando a entrada como query. Se nenhuma existir, registre "Memória: não disponível" e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "wayfinder"`, passando a entrada + resumo da memória.

A skill decide o modo:
- **Ideia solta** → **cartografar**: nomeia o destino (via `grelhar`), mapeia a fronteira em largura, cria o mapa em `docs/mapas/<slug>.md` com os tickets de decisão, dispara pesquisas (modelo `investigar` do `models.yml`; subagents nomeados `explore-<ticket>`), e para.
- **Caminho de um mapa existente** → **percorrer**: pega o próximo ticket da fronteira, resolve uma decisão, registra e gradua a névoa.

É discovery: **proibido editar código de aplicação** (só `docs/`). Ao fim, sugere `/piloto` (ou `/refinar`) ou `/executar`.

Entrada do usuário (ideia solta ou caminho do mapa):

$ARGUMENTS
