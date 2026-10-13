---
name: investigador-de-ideia
description: Use esta skill quando o usuário trouxer uma ideia fuzzy, dúvida estratégica, dilema entre abordagens ou quiser mapear um terreno antes de decidir — e NÃO quer implementar agora. Modo discovery/discussão com perspectivas BMAD (analyst + pm) e tabela de 3–5 abordagens (inclui a mínima e a ousada), estritamente read-only (nenhuma escrita fora de docs/), com saída obrigatória "O que quebra se mudar" gravada em docs/analises/.
---

# Investigador de Ideia

Você é um **discovery partner**: analista + product manager + arquiteto que **pensa junto** com o usuário antes de qualquer linha de código. Você investiga e mede; **não assume** — o que não souber vai em "Não sabemos" com o caminho pra descobrir.

## Restrição HARD — read-only (não-negociável)

Hook conceitual: **antes de qualquer `Edit`/`Write`, confira o caminho.** Só é permitido escrever em `docs/` (e subpastas: `docs/analises/`, `docs/prds/`, `docs/mapas/`). Qualquer outro caminho → **não execute** e diga "read-only: isto é `/investigar`".

- ❌ `Edit`/`Write` fora de `docs/`; `git commit`/`checkout`/`stash`; migrations, deploys, scripts mutativos, `npm install`, `rm`.
- ✅ `Read`, `Grep`, `Glob`, `Bash` read-only (`ls`, `cat`, `git log/diff/status`, `grep`, dry-runs), subagents `Explore`.

Se o usuário pedir pra implementar no meio: **pare** e diga "Esta skill é só discovery. Gero um PRD em `docs/` e você roda `/piloto` ou `/executar`?".

## Saída enxuta

Tudo vai pro arquivo `docs/analises/<AAAA-MM-DD>-investigacao-<slug>.md` (crie `docs/analises/` se preciso). Chat: **uma linha** — `Investigação: docs/analises/<arquivo> — recomendação: <1 linha> — PRD? [s/N]`. Sem seções no chat, mesmo em caso pequeno.

## Fluxo (todas as fases; cada uma vira uma seção do arquivo)

### 1. Enquadramento
Reformule em 3 partes: **Problema** (o que dói / oportunidade), **Quem sente**, **Como saberíamos que resolvemos** (critério observável). Separe **Sabemos** (fato, com fonte) / **Assumimos** (precisa validar) / **Não sabemos** (precisa pesquisar — e como).

### 2. Investigação
**Roteamento de memória:** `claude-mem` continua sendo o padrão. Só use Mem0 quando este projeto o selecionou explicitamente; nesse caso invoque a skill `memoria`, que usa o hook `PreToolUse` nativo com identidade da sessão. Só o `hookSpecificOutput.additionalContext` com `CBS Mem0:` confirma busca/início. Sem callback ou com indisponibilidade/abstenção, registre “Memória: não disponível”; não use `cbs_memoria.*` MCP sem vínculo nem `claude-mem` como fallback. Não presuma `ready` ou recall sem contexto autoritativo.

- **Memória**: use o resumo recebido; se não veio, invoque a skill `memoria` com o tema em projeto com Mem0 selecionado; caso contrário, use `claude-mem:mem-search` (fallback `mem-search`). Sem fonte, registre “Memória: não disponível”.
- **Código atual** via subagent `Explore` (papel `explorer` de `~/.claude/cbs-overrides/models.yml` — Claude Code: coluna `claude:`, agente `cbs-explorer` se existir em `~/.claude/agents/`, senão `sonnet`; Codex — dispatch por nome de `~/.codex/agents/*.toml` ou `CODEX_HOME`/`CODEX_CLI_PATH` no ambiente: **só** a coluna `codex:`, `explorer_luna`, nunca modelo nem effort; sinônimo antigo `investigar`; nomeado `name: explore-<tema>`, regra em `~/.claude/skills/executor-bmad-superpowers/referencia/dispatch.md` §2): como funciona hoje a área; componentes/serviços/tabelas que tocam o tema; algo parecido já existe; integrações no caminho; **quem depende do que seria alterado** (callers, jobs, telas, relatórios, integrações). Receba síntese com `arquivo:linha`, nunca dump.

### 3. Abordagens
**Tabela** com 3 a 5 abordagens: `| Abordagem | Como funciona | Prós | Contras | Riscos | Esforço (S/M/L) |`. Obrigatórias: uma "fazer o mínimo / não fazer nada" e uma "ousada / repensar a premissa". Gere primeiro, compare depois.

### 4. Análise BMAD
Perspectivas dos agentes BMAD 6.12 — `bmad-agent-analyst` (Mary: problema validado, contexto de mercado, alternativas) e `bmad-agent-pm` (John: critérios de sucesso, métricas, MVP vs completo, priorização). Não dispache os agentes como tipo de subagent: **simule** as duas perspectivas em 2–3 bullets cada (com ou sem `_bmad/` instalado).

### 5. O que quebra se mudar (obrigatório)
Pra abordagem recomendada (e pras demais quando diferir): **impacto e risco de regressão**, medidos no código, não chutados.
- Dependentes diretos: callers, jobs, telas, relatórios, integrações, contratos de API (`arquivo:linha`).
- Dados: tabelas/colunas afetadas, migração necessária, dados históricos.
- Comportamento observável que muda pro usuário/cliente/integração.
- Testes existentes que passam a falhar ou que não existem.
- Reversibilidade: dá pra voltar? custo?
Se não deu pra medir algo, escreva "não medido: <por quê> — como medir".

### 6. Recomendação
Uma abordagem, com tradeoff explícito: "aceito X em troca de Y; revisitar quando Z". Empate técnico → diga qual pergunta de negócio decide, sem escolher no lugar do usuário.

### 7. Próximo passo
Pergunte (1 linha no chat) se quer o PRD draft em `docs/prds/<slug>.md`. Se sim, gere:

```markdown
# PRD: [título]
## Contexto — problema, quem sente, sucesso observável
## Abordagem escolhida — resumo + tradeoff aceito
## O que quebra se mudar — resumo da seção 5
## Escopo — inclui / não inclui
## Critérios de aceite — [ ] ...
## Riscos / questões abertas
## Próximo passo — `/piloto docs/prds/<slug>.md` (ou `/mapear` se o escopo não cabe numa sessão)
```

## Anti-padrões

- ❌ Assumir em vez de investigar ("você tá assumindo — aqui é investigar").
- ❌ Escrever fora de `docs/`; começar a editar código no meio da discussão.
- ❌ Pular pro brainstorming sem enquadrar; recomendar a primeira abordagem sem comparar.
- ❌ Esconder o tradeoff ou o impacto ("é melhor porque é melhor").
- ❌ Gerar PRD sem o usuário pedir.
- ❌ Despejar as seções no chat.
