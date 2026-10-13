---
description: Cartografa um trabalho grande demais pra uma sessão só como um mapa de decisões em docs/mapas/, resolvendo tickets um a um (wayfinder). Evolução do /investigar pra escopos grandes — o /investigar e a grelha do /piloto encaminham pra cá quando o escopo não cabe numa sessão. Não toca código de aplicação.
---

**ORDEM OBRIGATÓRIA:**

**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`. Claude Code usa `Bash` com o gatilho exato indicado pela skill. Codex executa esse mesmo comando via `exec_command` com a raiz do projeto como diretório de trabalho; por `functions.exec`, use `const r=await tools.exec_command({cmd:'cbs memoria hook search <base64url>', workdir:'<raiz-do-projeto>', login:false});text(r.output);`. Considere a operação confirmada somente quando o contexto nativo retornado trouxer o prefixo `CBS Mem0:`. Sem esse contexto, ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall com base em `typed_trigger_only` ou outro retorno da CLI.

1. **PRIMEIRO**: obtenha a memória: em projeto com Mem0 explicitamente selecionado, invoque a skill `memoria` com a entrada; caso contrário, invoque `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível” e siga.
2. **DEPOIS**: invoque `Skill` com `skill: "wayfinder"`, passando a entrada + resumo da memória.

A skill decide o modo:
- **Ideia solta** → **cartografar**: nomeia o destino (via `grelhar`), mapeia a fronteira em largura, cria o mapa em `docs/mapas/<slug>.md` com os tickets de decisão, dispara pesquisas (modelo `investigar` do `models.yml`; subagents nomeados `explore-<ticket>`), e para.
- **Caminho de um mapa existente** → **percorrer**: pega o próximo ticket da fronteira, resolve uma decisão, registra e gradua a névoa.

É discovery: **proibido editar código de aplicação** (só `docs/`). Ao fim, sugere `/piloto` (ou `/refinar`) ou `/executar`.

Entrada do usuário (ideia solta ou caminho do mapa):

$ARGUMENTS
