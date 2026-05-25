# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

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
