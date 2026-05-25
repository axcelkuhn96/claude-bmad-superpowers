# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

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
