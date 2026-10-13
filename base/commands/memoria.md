---
description: Busca memória do projeto via hook CBS ou inicia sob demanda o serviço local de um projeto que já selecionou Mem0.
---

Para buscar, passe o tema ao invocar a skill `memoria`; para iniciar, peça a ação `start`. Ela só usa Mem0 quando o projeto selecionou explicitamente esse provider e só confirma a operação quando o contexto nativo devolvido pelo hook trouxer `CBS Mem0:`. Claude Code usa `Bash`; Codex executa o gatilho exato via `exec_command` na raiz do projeto, conforme a skill `memoria`. Sem contexto autoritativo, informe “Memória: não disponível”. Não faça fallback para MCP sem vínculo nem para `claude-mem` em projeto Mem0.

Argumentos:

$ARGUMENTS
