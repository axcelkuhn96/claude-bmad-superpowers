---
description: Cartografa um trabalho grande demais pra uma sessão só como um mapa de decisões em docs/mapas/, resolvendo tickets um a um (wayfinder). Evolução do /investigar pra escopos grandes — o /investigar e a grelha do /piloto encaminham pra cá quando o escopo não cabe numa sessão. Não toca código de aplicação.
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** No bootstrap automático, chame `mcp__cbs_memoria__status` diretamente quando visível: `ready` confirma Mem0 para o projeto confiável; então use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"` (e `get` com ID/fonte se precisar do conteúdo completo). `not_mem0` indica o padrão Claude-mem; outros resultados `unavailable` não autorizam fallback. Trate o resultado como histórico de menor confiança. Se o MCP não estiver no catálogo desta sessão, registre “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não procure arquivos, skills ou configuração via Bash/`exec_command`, `ls`, `cat` ou `grep` para descobrir o MCP; não use launcher ou `cbs memoria hook search` como fallback de consulta. Esse hook da CLI só cabe quando o usuário pedir sua execução explicitamente; hooks automáticos seguem independentes. Em Mem0 indisponível/abstenção, registre “Memória: não disponível”, sem inventar recall ou recorrer ao Claude-mem. Quando o projeto não selecionou Mem0, use `claude-mem:mem-search` (fallback `mem-search`).

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com a entrada; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "wayfinder"`, passando a entrada + resumo da memória.

A skill decide o modo:
- **Ideia solta** → **cartografar**: nomeia o destino (via `grelhar`), mapeia a fronteira em largura, cria o mapa em `docs/mapas/<slug>.md` com os tickets de decisão, dispara pesquisas (modelo `investigar` do `models.yml`; subagents nomeados `explore-<ticket>`), e para.
- **Caminho de um mapa existente** → **percorrer**: pega o próximo ticket da fronteira, resolve uma decisão, registra e gradua a névoa.

É discovery: **proibido editar código de aplicação** (só `docs/`). Ao fim, sugere `/piloto` (ou `/refinar`) ou `/executar`.

Entrada do usuário (ideia solta ou caminho do mapa):

$ARGUMENTS
