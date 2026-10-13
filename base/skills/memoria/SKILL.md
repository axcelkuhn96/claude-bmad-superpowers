---
name: memoria
description: Busca memória Mem0 autenticada pelo hook CBS quando o projeto a selecionou explicitamente, ou inicia o serviço local sob demanda.
---

# Memória CBS

Use esta skill apenas quando o usuário pedir memória, quando um fluxo CBS exigir busca, ou para iniciar o serviço de um projeto que já selecionou explicitamente `provider: mem0`. A seleção do provedor é por projeto; a memória pessoal Claude continua sendo o padrão.

## Buscar

A primeira busca autenticada inicia o broker local sob demanda quando necessário; não peça ao usuário para abrir uma sessão por launcher.

1. Prepare uma consulta curta em UTF-8. Se precisar gerar a codificação, use um comando local que imprima Base64 URL-safe sem `=` no final; não inclua esse gerador junto com o gatilho.
2. Use a ferramenta `Bash` com o comando exatamente `cbs memoria hook search <consulta-base64url>`. O diretório de trabalho deve ser a raiz do projeto atual. Não acrescente flags, redirecionamentos, encadeamentos ou outros comandos.
3. Considere a busca executada somente se o retorno do hook incluir `hookSpecificOutput.additionalContext` com o prefixo `CBS Mem0:`. Esse contexto é a única fonte autoritativa do resultado.
4. Se o contexto não vier, ou trouxer indisponibilidade/abstenção, informe “Memória: não disponível” e siga sem inventar recall. Não use `cbs_memoria.*`, MCP sem vínculo nem `claude-mem` como fallback quando Mem0 está selecionado.

## Iniciar

Quando o projeto já selecionou explicitamente Mem0 e a sessão precisar iniciar o serviço local, use `Bash` com o comando exatamente `cbs memoria hook start`, na raiz do projeto. Só considere o início confirmado se o contexto de retorno do hook trouxer `CBS Mem0:`. A saída da CLI `typed_trigger_only`, por si só, não confirma execução. Em ausência ou indisponibilidade do contexto, informe “Memória: não disponível”.

Não inicie serviço por atividade comum da CLI. Não selecione ou promova provider, não configure owner e não transfira memória entre projetos. Nunca trate contexto ausente, ferramenta sem vínculo ou callback não confiável como `ready` ou `recall`.
