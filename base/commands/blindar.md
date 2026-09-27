---
description: "Auditoria read-only da configuração de agentes com o AgentShield (modo estático): ~/.claude, ~/.codex e o projeto atual. Grava docs/analises/<AAAA-MM-DD>-blindar.md com os achados por severidade. Não corrige nada."
---

**Somente leitura.** Não edite, não apague e não "corrija" nada em `~/.claude`, `~/.codex` ou no projeto. A única escrita permitida é o relatório em `docs/analises/`.

1. Verifique o binário: `command -v agentshield` (Windows: `where agentshield`). Ausente → responda só: "AgentShield não instalado. Instale com `npm i -g ecc-agentshield` e rode `/blindar` de novo." e pare.
2. Para cada alvo que existir — `~/.claude`, `~/.codex`, diretório atual — rode em modo **estático**, exatamente `agentshield scan --format json --path <alvo>` e nenhuma outra flag (NUNCA `--fix`, que altera arquivos; nem `--opus`, `--deep` ou `--injection`, que chamam a API; nem `--sandbox`, que executa os hooks) (o alvo vai sempre depois de `--path`; sem ele o agentshield escolhe o diretório sozinho), com a saída JSON num arquivo temporário (`mktemp`). Exit 0 ou 2 = varredura concluída (2 só indica achado crítico); outro exit ou JSON ilegível → registre o alvo como "erro" no relatório e siga para o próximo. Não cole a saída bruta no chat.
3. Leia os JSON (`findings[]` com `severity`, `id`, `file`, `title`; totais em `summary`) e escreva `docs/analises/<AAAA-MM-DD>-blindar.md` (crie `docs/analises/` se preciso):
   - cabeçalho: data, versão do agentshield (`agentshield --version`) e alvos escaneados;
   - por alvo, tabela `Severidade | Regra | Arquivo | Resumo`, ordenada crítica → alta → média → baixa (achados `info`, se houver, no fim);
   - contagem por severidade;
   - "O que fazer": 1 linha por achado crítico ou alto.
   Se um achado citar valor sensível (token, chave, senha), mostre só `***`.
   O AgentShield não tem mecanismo de supressão: para cada achado a saída é corrigir a configuração ou aceitá-lo conscientemente (registre no relatório que foi aceito e por quê). Nunca sugira flag, comentário ou arquivo de "ignorar".
4. Apague os temporários. No chat, 1 linha: `blindar: <n> crítico, <n> alto, <n> médio, <n> baixo — docs/analises/<arquivo>`.

Escopo extra (opcional):

$ARGUMENTS
