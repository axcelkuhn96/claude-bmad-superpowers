# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.3.0] - 2026-05-24

### Mudança de arquitetura
- **Executor agora DELEGA ao Superpowers real em vez de reimplementar.** Diagnóstico (sessões `bcf5870f`/`609f0c5d`/`89756461`): o executor descrevia brainstorming/TDD/subagent na própria SKILL.md e o modelo fazia tudo inline no contexto principal — os subagents quase não disparavam e o contexto poluía. Pesquisa na fonte primária (Superpowers v5.1.0) mostrou que `subagent-driven-development` mantém o contexto principal só como orquestrador e despacha implementer + 2 reviewers por task.
- **Fase 3 (Planejamento):** BMAD gera spec/stories → `superpowers:writing-plans` converte em plano executável com tasks discretas.
- **Fase 5 (Execução):** agora **delega a `superpowers:subagent-driven-development`** — implementer subagent isolado por task + spec reviewer + code quality reviewer. O contexto principal só orquestra. Fallback pra TDD manual se Superpowers ausente.
- **Sem worktree:** instrução explícita pra trabalhar na branch atual (não invocar `using-git-worktrees`), conforme preferência do usuário.
- Removida a prosa que reimplementava RED-GREEN e regras de subagent inline (agora vêm das skills reais).
- `executar.md` e `piloto.md` ajustados pra refletir a delegação.

## [0.2.10] - 2026-05-24

### Alterado
- **Removida a seção "Versão curta para colar"** do `refinador-de-prompt`. O prompt premium completo já é o entregável; a versão curta era redundante. Agora são 4 seções (Diagnóstico, Contexto usado, Dúvidas, Prompt final premium) em vez de 5.

## [0.2.9] - 2026-05-24

### Corrigido
- **Executor agora invoca as skills Superpowers/BMAD formais**, não só aplica o método. Análise da sessão `bcf5870f` mostrou TDD real mas sem invocar `superpowers:test-driven-development`, e plano sem invocar agentes/skills BMAD. Mudanças:
  - Fase 2 → invoca `superpowers:brainstorming`
  - Fase 3 → invoca skills BMAD reais (`bmad-create-prd`, `bmad-create-architecture`, `bmad-create-story`, ou agentes `bmad-agent-*`), escalando pelo tamanho da tarefa
  - Fase 5 → invoca `superpowers:test-driven-development` (+ `systematic-debugging` se travar)
  - Fase 6 → invoca `superpowers:requesting-code-review`
  - Fase 7 → invoca `superpowers:verification-before-completion` antes de declarar pronto
- **Fase 4 virou PONTO DE PARADA HARD**: executor agora termina a mensagem com "Posso implementar? [s/N]" e espera resposta antes de tocar em código. Antes emitia o cabeçalho mas seguia direto codando.

## [0.2.8] - 2026-05-24

### Corrigido
- **`mem-search` agora é obrigatório em primeiro lugar**, sem julgamento. Análise da sessão `5954fb4b` mostrou 0/3 invocações de claude-mem mesmo com a v0.2.5 mandando. Reforço em duas camadas:
  - **Nos 5 slash commands**: ordem numerada explícita — "1. PRIMEIRO invoque Skill mem-search. 2. SÓ DEPOIS invoque a skill principal."
  - **No topo das 3 SKILL.md**: novo bloco "⚠️ PRIMEIRA AÇÃO — SEMPRE consultar memória persistente" antes do bloco de formato obrigatório.
- Espera-se agora que `mem-search` apareça como primeira tool call em cada slash command.

## [0.2.7] - 2026-05-24

### Adicionado
- **Fase 5 — Alinhamento prévio** no `refinador-de-prompt`: ANTES de gerar o prompt premium, skill agora emite um resumo curto (`## Alinhamento` com "Entendi" + "Decisões que precisam de OK seu" + "Tradeoffs") e **PARA**, esperando o usuário confirmar. Usuário decide tudo ANTES do prompt — não vê suposições enterradas só depois.
- Loop de iteração que era Fase 6 virou Fase 7. Pra ajustar antes do prompt, basta dizer o que mudar na fase de alinhamento. Pra ajustar depois, mesma coisa via loop final.
- `/refinar-auto` continua pulando a Fase 5 (assume tudo e vai direto — esse é o propósito do auto).

## [0.2.6] - 2026-05-24

### Adicionado
- **Loop de iteração no `/refinar`** (Fase 6 do `refinador-de-prompt`): depois de emitir o prompt, skill SEMPRE pergunta "Quer ajustar algo? `ok` pra fechar ou diga o que mudar". Permite co-decidir sem rodar `/refinar` do zero várias vezes. Aceita `ok`/`pode`/`tá bom`/`fechado` como sinal de fim. Qualquer outro texto = ajuste → re-emite formato completo.
- `/piloto` ajustado pra esperar o `ok` do loop do refinador antes de perguntar "executar agora?".

## [0.2.5] - 2026-05-24

### Adicionado
- **Integração explícita com claude-mem** nas 3 skills. Antes era genérico ("se houver memória, consulte"); agora é imperativo com nomes específicos: `mem-search`, `claude-mem:mem-search`, `claude-mem:smart-explore`, `claude-mem:knowledge-agent`, MCP tools `*memory_search*` etc. Se nenhuma aparecer disponível, marca "Memória: nada encontrado" e segue. Antes o LLM ignorava o claude-mem mesmo instalado.

## [0.2.4] - 2026-05-24

### Corrigido
- **Slash commands agora FORÇAM invocação da Skill tool**. Texto antigo "Invoque a skill X" era ambíguo — o LLM lia como "trabalhe nessa pegada" e improvisava sem chamar o Skill tool. Novo texto: "AÇÃO OBRIGATÓRIA AGORA: invoque a ferramenta `Skill` com `skill: \"<nome>\"` antes de qualquer outra coisa". Validado em análise de JSONL: sessões antigas tinham 0 Skill tool calls; agora deve ter ≥1 por slash command.

## [0.2.3] - 2026-05-24

### Corrigido
- **Skills agora seguem formato rígido sempre**, independente do tamanho da tarefa. Adicionada seção `## ⚠️ FORMATO OBRIGATÓRIO` no topo de cada SKILL.md:
  - `refinador-de-prompt`: sempre emite Diagnóstico/Contexto/Dúvidas/Prompt final/Versão curta — mesmo se recomendar "não faça"
  - `investigador-de-ideia`: sempre as 6 fases com cabeçalho explícito
  - `executor-bmad-superpowers`: sempre as 7 fases com cabeçalho + 8 seções fixas na entrega
- Antes, em casos pequenos, as skills adaptavam pra resposta livre — útil mas não auditável. Agora estrutura é fixa, conteúdo se adapta.

## [0.2.2] - 2026-05-24

### Corrigido
- **BMAD install agora 100% não-interativo no caminho feliz**: passa `--modules bmm,core` explicitamente, fixando os módulos oficiais. Isso pula a tela de seleção de módulos E a pergunta sobre custom/community modules (que aparecia mesmo com `--yes`).

## [0.2.1] - 2026-05-24

### Corrigido
- **Detecção do Superpowers** agora lê `~/.claude/plugins/installed_plugins.json` em vez de tentar `claude /plugin list` (que não funciona fora do app). Detecta de verdade.
- **Instalação do Superpowers** não tenta mais via CLI (não funciona pra plugins). Mostra instruções claras: `/plugin marketplace add obra/superpowers-marketplace` + `/plugin install superpowers@superpowers-marketplace`.
- **BMAD install nunca mais cai em Quick Update**: passa `--action install` (ou `update`, dependendo do que o usuário escolher) explicitamente. Antes o BMAD entrava em `quick-update` quando detectava instalação prévia, ignorando `--tools claude-code` (resultando em "No IDE selected").
- **`instalar-bmad` agora pergunta** quando BMAD já existe: reinstalar do zero / update / pular. Flags `--force` e `--update` pra modo não-interativo.

## [0.2.0] - 2026-05-24

### Adicionado
- **`instalar` agora instala TUDO de uma vez**: skills/commands (global) + plugin Superpowers + BMAD no diretório atual. Um único comando (`npx claude-bmad-superpowers instalar`) cobre todo o setup. Flags: `--apenas-global` / `--skip-bmad` / `--skip-superpowers`.
- **Novo subcomando `instalar-bmad`** na CLI: `npx claude-bmad-superpowers instalar-bmad` roda o instalador interativo do BMAD no terminal do usuário (TTY real) e registra o projeto automaticamente. O slash command `/instalar-bmad` foi atualizado pra delegar nele via `!` prefix.
- **Self-update do pacote** no `atualizar`: detecta modo de instalação (git clone vs npm) e faz `git pull --ff-only` ou re-exec via `npx claude-bmad-superpowers@latest`.
- **Update real do BMAD nos projetos registrados**: itera `~/.claude/cbs-overrides/.projetos-bmad` e roda `npx bmad-method install --action update --tools claude-code` em cada um (com modos `todos`, `selecionar` ou flag `--auto-bmad`).
- Flags novas no `atualizar`: `--skip-self-update`, `--skip-bmad`, `--auto-bmad` / `-y`.
- Limpeza automática de projetos inválidos (diretórios removidos) do registro.

### Alterado
- `atualizar` agora roda em 4 etapas explícitas (self-update → base → Superpowers → BMAD), com cabeçalhos visíveis na saída.

## [0.1.0] - 2026-05-24

### Adicionado
- CLI Node cross-platform (`claude-bmad-superpowers` / `cbs`) com subcomandos `instalar`, `atualizar`, `remover`, `status`.
- 3 skills: `refinador-de-prompt`, `investigador-de-ideia`, `executor-bmad-superpowers`.
- 7 commands: `/refinar`, `/refinar-auto`, `/investigar`, `/executar`, `/piloto`, `/instalar-bmad`, `/atualizar`.
- Modelo de camadas (base read-only + overrides) para preservar customizações no update.
- Instalação automática do plugin Superpowers via marketplace do Claude Code.
- Detecção e instalação per-project do BMAD-METHOD.
