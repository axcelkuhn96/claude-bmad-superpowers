# Instalação

## Pré-requisitos

- **Node 18+**: `node --version`
- **Claude Code instalado e logado**: `claude --version`
- (Opcional) **Git**: necessário se for usar `npx bmad-method install` em projetos

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
2. Copia as 3 skills pra `~/.claude/skills/`.
3. Copia os 8 commands pra `~/.claude/commands/`.
4. Marca cada arquivo com um rodapé `<!-- claude-bmad-superpowers:base vX.Y.Z -->` (usado pelo update pra saber o que pode sobrescrever).
5. **Detecta** o plugin **Superpowers** (lendo `~/.claude/plugins/installed_plugins.json`); se não estiver instalado, mostra o comando exato pra rodar dentro do Claude Code (plugins não instalam via CLI fora do app).
6. Grava a versão instalada no registro de `~/.claude/cbs-overrides/`.

## Verificar instalação

```bash
npx claude-bmad-superpowers status
```

Deve listar:
- Versão instalada vs disponível
- Skills ativos em `~/.claude/skills/`
- Commands ativos em `~/.claude/commands/`
- Se Superpowers está como plugin
- Se BMAD está instalado no projeto atual

## Por projeto que vai usar BMAD

BMAD é per-project (escreve em `_bmad/`, `docs/`, etc.) e é **requisito** do `/executar` — sem ele, o executor para e pede pra instalar:

```bash
cd meu-projeto
claude
> /instalar-bmad
```

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

`remover` preserva `~/.claude/cbs-overrides/` — suas customizações sobrevivem.
