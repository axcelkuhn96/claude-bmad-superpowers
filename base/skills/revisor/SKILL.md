---
name: revisor
description: "Use esta skill pra revisar mudanças (branch, working tree ou escopo dado) com code review + cobertura de testes + segurança em subagents general-purpose, lendo as lentes personas/review/ e o ponytail POR CAMINHO. Read-only por padrão — grava o relatório em docs/analises/ e só corrige com OK. Chamada por /revisar e, em modo gate, pelo executor (/executar, /piloto) como revisão final automática."
---

# Revisor

Você **orquestra** a revisão; quem lê diff e código são os subagents. Dois modos:

- **standalone** (`/revisar [escopo]`): revisa, grava o relatório e **pergunta** antes de corrigir.
- **gate** (invocada pelo executor, Fase 6): revisa a branch da execução; **pula** a lente `cobertura-de-testes` (o reviewer final do SDD já a leu) e roda só o que o gatilho pediu (segurança explícita e/ou E2E de `ui`); 🔴 → **um** fix dispatch + **uma** re-review, sem perguntar; 🟡 vão pra entrega. Nunca corrija no contexto principal.

Chat enxuto: 1 linha por etapa; o detalhe vai pro relatório.

## Fluxo

**Roteamento de memória:** Na sessão Mem0 iniciada pelo launcher CBS (ou em checkout com `.cbs/memoria.json` `provider: mem0` sem vínculo), use somente `cbs_memoria.search` do MCP. Se a ferramenta estiver indisponível ou responder `unbound`/`unavailable`/`abstain`, registre "Memória: não disponível" e continue sem chamar `claude-mem:mem-search` nem `mem-search`. As instruções de busca Claude abaixo valem somente para sessão `claude-mem` congelada.

1. **Memória**: use o resumo recebido; se não veio, `claude-mem:mem-search` (fallback `mem-search`) com o tema das mudanças.
2. **Escopo (sem editar nada)**: argumentos → escopo. Senão: `git status` + `git diff` (não commitado) e, em branch de feature, `git diff <base>...HEAD`. Escreva o diff num arquivo — `.superpowers/revisao/<data>-<slug>/diff.txt` (garanta que `.superpowers/` está ignorado; senão adicione a `.git/info/exclude`) — e passe **o caminho** aos subagents, nunca o conteúdo.
3. **Domínios**: detecte no diff com a tabela de `~/.claude/skills/executor-bmad-superpowers/referencia/roteamento.md` §1 (até 2 por área tocada).
4. **Runtime e papéis**. Claude Code (ferramenta `Agent` com `subagent_type`/`model`) → coluna `claude:` de `~/.claude/cbs-overrides/models.yml` (agente `cbs-*` se existir em `~/.claude/agents/`, senão o modelo). Codex (dispatch por nome em `~/.codex/agents/*.toml`, ou `CODEX_HOME`/`CODEX_CLI_PATH` no ambiente) → **somente** a coluna `codex:` (nome do agente), nunca modelo nem effort; agente ausente → dispatch sem nome. Personas e scripts ficam em `~/.claude/personas/` e `~/.claude/scripts/` nos dois runtimes. Papéis: `final_reviewer` pros reviewers (default agente `cbs-final-reviewer`, opus/xhigh), `tester` pra validação no browser (`cbs-tester`, sonnet/medium), `refactor` pro fix (`cbs-refactor`, opus/high). Agente existente em `~/.claude/agents/` → `subagent_type` = nome; senão `model:` do fallback entre parênteses. Todo dispatch é nomeado (`name: <papel>-<escopo>`: `rev-codigo`, `rev-cobertura`, `rev-seguranca`, `e2e-revisao`, `fix-revisao`, `rerev-revisao`) — regra em `~/.claude/skills/executor-bmad-superpowers/referencia/dispatch.md` §2.
5. **Subagents** — `subagent_type: "general-purpose"` ou o agente nomeado do papel (nunca `code-reviewer`, `qa-expert`, `security-auditor`, `voltagent-*`, `bmad-agent-*`), read-only, independentes (dispare em paralelo). Cada prompt leva: caminho do diff, escopo em 1 linha, story/critérios de aceite se existirem, e os **caminhos** das lentes (override `~/.claude/cbs-overrides/personas/...` → base `~/.claude/personas/...`; lente ausente → usar o fallback de `executor-bmad-superpowers/referencia/roteamento.md` §2 e, em diff backend, registrar `lente seguranca ausente` como 🟡 no relatório):
   - **Code review** — `ponytail.md` (usar o checklist de over-engineering, seção 4, sem afrouxar o piso de segurança) + `dominios/<dominio>.md` detectados. Confere contra story, critérios de aceite, padrões do projeto e escopo. Pode usar o template de `superpowers:requesting-code-review`.
   - **Cobertura de testes** — `review/cobertura-de-testes.md`. Cobertura comportamental, casos de borda, falhas previsíveis (timeout, dado inválido, concorrência), rastreabilidade story ↔ código ↔ teste.
   - **Segurança** — `review/seguranca.md` (tabela por stack em `review/seguranca-referencia.md`, por caminho). **Só** se o diff toca backend (laravel | python | node | integracao), auth, input externo, webhook, pagamento, tenant ou dados pessoais; senão registre "sem superfície de segurança". Em diff backend, rode também `node ~/.claude/scripts/gate-seguranca.js` (override `~/.claude/cbs-overrides/scripts/`): exit 1 = 🔴 bloqueante; "APROVADO COM RESSALVAS" (ferramenta ausente) = aviso no relatório.
   - **E2E** (papel `tester`) — só quando há mudança `ui` / `operacional` sem teste unitário: Playwright no venv do projeto/usuário (ex.: `/tmp/pwval`; sem `agent-browser` quando o ambiente não abre janela confiável), screenshots em `.superpowers/revisao/<data>-<slug>/visual/`.
   Subagent devolve só veredito, contagem por severidade e caminho do próprio report.
6. **Relatório** em `docs/analises/<data>-revisao-<slug>.md` (formato abaixo). Chat: `Revisão: N achados (🔴 x, 🟡 y) — docs/analises/<arquivo>`.
7. **Correção**:
   - standalone → pergunte **"Corrigir os 🔴/🟡 agora? [s/N]"**. `s` → um implementer no papel `refactor` (caminhos de `persona-dev.md` + `ponytail.md`) com a lista completa de achados, na branch atual, sem worktree; depois uma re-review escopada.
   - gate → 🔴 entram no fix dispatch obrigatoriamente (um só, com todos os achados); 🟡 ficam registrados pra entrega.

## Formato do relatório (arquivo)

```markdown
# Revisão: <slug>
Data · branch · escopo (arquivos / commits / áreas) · modo (standalone | gate) · models

## Achados por severidade
- 🔴 Bloqueante: <arquivo:linha> — ...
- 🟡 Atenção: ...
- 🟢 OK: ...

## Cobertura de testes
- o que está testado / lacunas (saída da lente cobertura-de-testes)

## Segurança
- itens da lente seguranca + achados, ou "sem superfície de segurança"
- gate-seguranca.js: aprovado | parcial (ferramentas ausentes) | reprovado (exit 1) | n.a.

## E2E / visual
- caminho dos screenshots ou "não aplicável"

## Veredito
- Pronto pra merge? O que falta.
```

## Anti-padrões

- ❌ Ler diff/código no contexto principal.
- ❌ Colar lente/ponytail no prompt (caminho, sempre).
- ❌ Corrigir sem OK no modo standalone; corrigir inline em qualquer modo.
- ❌ Rodar a lente de segurança em diff sem superfície (custo à toa) — mas nunca pulá-la quando há backend.
