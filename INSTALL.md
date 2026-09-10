# Instalação

## Pré-requisitos

- **Node 18+**: `node --version`
- **Claude Code instalado e logado**: `claude --version`
- (Opcional) **Git**: necessário se for usar `npx bmad-method install` em projetos
- Versões testadas: **Superpowers ≥ 6.3**, **BMAD-METHOD ≥ 6.12**

## Instalação rápida

```bash
npx claude-bmad-superpowers instalar
```

Ou instalando globalmente (atalho `cbs`):

```bash
npm install -g claude-bmad-superpowers
cbs instalar
```

## O que o `instalar` faz

1. Detecta o diretório `~/.claude/` (cria se faltar).
2. Copia as skills de `base/skills/` pra `~/.claude/skills/` (executor-bmad-superpowers, refinador-de-prompt, investigador-de-ideia, grelhar, wayfinder, handoff).
3. Copia os commands de `base/commands/` pra `~/.claude/commands/` (`/piloto`, `/executar`, `/refinar`, `/refinar-auto`, `/investigar`, `/revisar`, `/grelhar`, `/mapear`, `/handoff`, `/instalar-bmad`, `/atualizar`).
4. Copia a árvore inteira de `base/personas/` pra `~/.claude/personas/`: `ponytail.md`, rulebooks de domínio em `dominios/` e lentes de review em `review/` — o executor passa o **caminho** desses arquivos aos subagents quando a task pertence ao domínio.
5. Copia os agentes de `base/agents/` pra `~/.claude/agents/` (`cbs-architect`, `cbs-reviewer`, `cbs-final-reviewer`, `cbs-backend`, `cbs-frontend`, `cbs-refactor`, `cbs-tester`, `cbs-explorer`, `cbs-search`) — subagentes do Claude Code com modelo, effort e tools fixados no frontmatter; os de review/exploração são read-only. Pra customizar um, copie pra `~/.claude/cbs-overrides/agents/`.
6. Copia `base/config/models.yml` (agente/modelo por papel, com dois runtimes: `claude:` aponta pra um agente `cbs-*` ou um modelo direto; `codex:` aponta pra um agente em `~/.codex/agents/`) pra `~/.claude/cbs-overrides/models.yml` **só se ainda não existir** — esse arquivo é seu, nem `instalar` nem `atualizar` sobrescrevem. Precedência: argumento do comando > `cbs-overrides/models.yml` > default do pacote.
7. Marca cada `.md` copiado com um rodapé `<!-- claude-bmad-superpowers:base vX.Y.Z -->` (usado pelo update pra saber o que pode sobrescrever).
8. **Detecta** o plugin **Superpowers** (lendo `~/.claude/plugins/installed_plugins.json`); se não estiver instalado, mostra o comando exato pra rodar dentro do Claude Code (plugins não instalam via CLI fora do app).
9. Grava a versão instalada em `~/.claude/cbs-overrides/.versao-instalada`.
10. Sem `--apenas-global`, instala BMAD no diretório atual (ver abaixo).

Flags: `--apenas-global` / `--skip-bmad` (não instala BMAD no cwd), `--skip-superpowers`.

## Verificar instalação

```bash
npx claude-bmad-superpowers status
```

Deve listar:
- Versão instalada vs disponível
- Skills e commands do pacote ativos em `~/.claude/`
- Personas instaladas (base e overrides, incluindo `review/`), agentes `cbs-*` ativos em `~/.claude/agents/` e se `cbs-overrides/models.yml` existe
- Versão do plugin Superpowers (lida de `installed_plugins.json`)
- Skills de domínio detectadas (frontend-design, ui-ux-pro-max, taste-skill, dba)
- BMAD no diretório atual e a versão do BMAD em cada projeto registrado (lida de `_bmad/_config/manifest.yaml`)

## Por projeto que vai usar BMAD

BMAD é per-project (escreve em `_bmad/`, `_bmad-output/` e `.claude/skills/bmad-*`) e é **requisito** do `/executar` — sem ele, o executor para e pede pra instalar:

```bash
cd meu-projeto
claude
> /instalar-bmad
```

A CLI roda `npx bmad-method install --directory <dir> --action install --tools claude-code --modules bmm,core --communication-language pt-BR --document-output-language pt-BR --yes` e registra o projeto em `~/.claude/cbs-overrides/.projetos-bmad`. Se BMAD já existir: `--update` atualiza (`--action update`); `--force` reinstala do zero (`bmad-method uninstall` + remoção de `.claude/skills/bmad-*`, com confirmação; `-y` confirma).

## Atualizar

```bash
npx claude-bmad-superpowers atualizar
```

Recopia o `base/` (só arquivos com o marcador), preserva `cbs-overrides/` e pergunta em quais projetos registrados atualizar o BMAD. **Sem TTY** (ex.: rodando pela ferramenta Bash do Claude Code) a CLI não consegue perguntar e se comporta como `--auto-bmad`; use `--skip-bmad` pra não tocar nos projetos ou `--projetos /a,/b` pra escolher. É isso que o `/atualizar` faz: primeiro `--skip-bmad`, depois pergunta a você e roda `--auto-bmad`/`--projetos`.

## Troubleshooting

### "comando claude não encontrado"

O Claude Code precisa estar no PATH. A CLI tenta `which claude` (Unix) / `where claude` (Windows). Se não achar, ela imprime instruções pra rodar o `/plugin install` manualmente dentro do Claude Code.

### "Superpowers não instalou"

Dentro do Claude Code:

```text
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

### "Permission denied" no Linux/Mac

Confere permissões de `~/.claude/`:

```bash
ls -la ~/.claude/
```

### Quero reinstalar do zero

```bash
npx claude-bmad-superpowers remover
npx claude-bmad-superpowers instalar
```

`remover` preserva `~/.claude/cbs-overrides/` — suas customizações (inclusive `models.yml`) sobrevivem.

### Rodar os testes do pacote

```bash
npm test
```

`test/smoke.js` roda a CLI num `HOME` temporário (help, status, instalar, atualizar, remover) sem tocar no seu `~/.claude`.
