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
3. Copia os 7 commands pra `~/.claude/commands/`.
4. Marca cada arquivo com header `<!-- claude-bmad-superpowers:base vX.Y.Z -->` (usado pelo update).
5. Tenta instalar o plugin **Superpowers** via `claude /plugin install` (instrui você se não conseguir).
6. Grava versão instalada em `~/.claude/cbs-overrides/.versao-instalada`.

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

BMAD é per-project (escreve em `.bmad-core/`, `docs/prd.md`, etc.):

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
/plugin install superpowers@obra
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
