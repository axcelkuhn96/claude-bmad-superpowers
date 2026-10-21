---
description: Investiga dúvida, suspeita de problema ou ideia com evidência do ambiente pertinente. Distingue confirmado, hipótese e não verificado; pode concluir que não há defeito. Read-only para código, dados e produção.
---

Use a skill `investigador-de-ideia` para investigar o tema abaixo.

Consulte memória pertinente antes de tirar conclusões. Em projeto Mem0 confiável, use `mcp__cbs_memoria__search` com consulta curta e `source: "curated"`; leia itens relevantes completos com `mcp__cbs_memoria__get` (ID e fonte retornados). Se for necessário identificar o provedor, `mcp__cbs_memoria__status`: `ready` indica Mem0, `not_mem0` indica Claude-mem. Em projeto Claude-mem, use `claude-mem:mem-search` (fallback `mem-search`). Se o MCP Mem0 estiver indisponível ou abstiver, registre isso sem inventar recall nem trocar para Claude-mem. Se o MCP não constar do catálogo da sessão, registre “Memória: não disponível nesta sessão”. Não use Bash, arquivos de configuração, launcher ou `cbs memoria hook search` para substituir a consulta MCP. Trate qualquer lembrança como pista histórica a confirmar, nunca como prova atual ou autorização.

Investigue no ambiente que pode responder à pergunta. Se o caso é de produção e o acesso read-only já está autorizado, consulte produção. Se ambiente ou acesso decisivo estiver ambíguo, faça uma pergunta objetiva e continue o trabalho independente. Nunca altere código, banco, configuração ou produção neste fluxo. Relatório em `docs/analises/` somente se trouxer valor ou for solicitado. Apresente evidências e limites antes de perguntar se o usuário quer uma sugestão de correção; se ele já pediu solução, responda diretamente ao pedido.

Tema:

$ARGUMENTS
