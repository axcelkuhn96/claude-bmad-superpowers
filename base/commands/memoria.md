---
description: Busca memória do projeto ou inicia sob demanda o serviço local de um projeto que já selecionou Mem0.
---

Para buscar a pedido do usuário, chame diretamente `mcp__cbs_memoria__search` com o tema, sem Bash/`exec_command` para localizar skill, configuração ou MCP. Leia resultados completos com `mcp__cbs_memoria__get`; use `mcp__cbs_memoria__status` para pedido de disponibilidade sem tema. Se o MCP não estiver no catálogo desta sessão, informe “Memória: não disponível nesta sessão; registre o MCP CBS Memória e abra uma nova sessão”. Não substitua a consulta natural por `cbs memoria hook search` ou Claude-mem em projeto Mem0. A skill `memoria` documenta a CLI quando o usuário pedir **explicitamente** executá-la e a ação `start` sob demanda; só confirme o hook pelo contexto nativo `CBS Mem0:`.

Argumentos:

$ARGUMENTS
