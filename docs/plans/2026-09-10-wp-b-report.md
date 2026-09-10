# WP-B — Skills e commands (release 0.12.0) — report

Data: 2026-09-10. Branch `release/0.12.0`. Sem commit (conforme instrução).

Fontes lidas na íntegra: plano da release; `base/skills/**`, `base/commands/*.md`, `base/personas/ponytail.md`, `README.md`, `src/caminhos.js`, `src/instalar.js`; auditoria (Achados, Compatibilidade, Backlog), histórico de uso (Top 10, Recomendações), pesquisa de personas §7, síntese; Superpowers 6.3.0 `subagent-driven-development/SKILL.md` + `implementer-prompt.md` + `task-reviewer-prompt.md` (cabeçalho) + `re-review-prompt.md` (cabeçalho), `writing-plans`, `brainstorming`, `finishing-a-development-branch`, `requesting-code-review/code-reviewer.md` (cabeçalho); BMAD 6.12 em `/home/axcel/IndusData/.claude/skills/` (`ls` + frontmatter de `bmad-prd`, `bmad-architecture`, `bmad-create-prd`, `bmad-create-architecture`, `bmad-create-story`, `bmad-create-epics-and-stories`, `bmad-dev-story`, `bmad-build`, `bmad-spec`, `bmad-code-review`, `bmad-review`, `bmad-agent-dev`).

## Fatos que orientaram decisões

- **Caminho instalado das personas** (`src/caminhos.js:16`, `src/instalar.js:76-80`): `~/.claude/personas/…` (base) e `~/.claude/cbs-overrides/personas/…` (override). Não é `~/.claude/skills/executor-bmad-superpowers/personas/` como o orquestrador supôs. Todos os prompts usam `~/.claude/cbs-overrides/personas/<x>` → `~/.claude/personas/<x>` (primeiro existente vence).
- **Pasta da skill é copiada recursivamente**: `copiarArvore` em `src/instalar.js:31-42` desce em subdiretórios; logo `base/skills/executor-bmad-superpowers/referencia/*.md` é instalado em `~/.claude/skills/executor-bmad-superpowers/referencia/`. `src/atualizar.js:88` usa `atualizarArvore` na mesma árvore.
- **Skills/commands são descobertos por `readdir`** (`src/status.js:24,45`, `src/remover.js:21-40`), sem lista fixa — a skill nova `revisor` é instalada/removida sem mexer em `src/`.
- **BMAD 6.12 real**: `bmad-create-prd`, `bmad-create-architecture`, `bmad-create-story` e `bmad-dev-story` são shims `lifecycle: shim` (deprecated; `bmad-create-story` diz "`bmad-build` is now the official implementation method"). Ativas: `bmad-prd`, `bmad-architecture`, `bmad-create-epics-and-stories`, `bmad-spec`, `bmad-code-review`, `bmad-review`, `bmad-agent-{dev,pm,analyst,architect,ux-designer}`. Não existe agente QA nem SM.
- **SDD 6.3.0**: um task reviewer (spec + qualidade), re-reviewer nos fix rounds (máx. 5), reviewer final da branch no modelo mais capaz; briefs/reports/ledger em `.superpowers/sdd/<plano>/`; "everything you paste into a dispatch prompt stays resident in your context — hand artifacts over as files"; implementer não dispara subagents; worktree ou consentimento explícito pra main; encerra com `finishing-a-development-branch`, cujo menu (merge/PR/manter) é o gate de integração. `writing-plans` termina perguntando "Which approach?"; `brainstorming` tem HARD-GATE de aprovação e classificação spike/bounded/architectural.
- `base/config/models.yml` já existia (WP-A) com o default do plano; referenciado por `~/.claude/cbs-overrides/models.yml`.

## Por item

### B1 — Modo autônomo
- `base/commands/piloto.md:5-9`: flags `--auto` / `auto`, `--so-refinar`, `models=` / `modelo=`; detecção sem flag por `CLAUDE_AUTONOMOUS` ou ausência de `AskUserQuestion`. Etapas 1–3 (`:15-27`) descrevem o comportamento por modo: grelha em modo auto, gate 1 = pergunta do refinador, gate 2 + integração no executor.
- `base/commands/executar.md:5-8`: mesmas flags (sem `--so-refinar`); gate do plano só em normal; integração sempre.
- `base/skills/executor-bmad-superpowers/SKILL.md:16-27` ("Modo e gates"): detecção, comportamento em auto (bounded, "Which approach?" respondido pelo executor, Fase 4 assumida com ruling no ledger), tabela de gates; `:93-97` Fase 4; `:118-124` Fase 7 com `finishing-a-development-branch` como gate de integração "vale em auto também"; anti-padrão "pular o gate de integração em --auto" (`:130`).
- `base/skills/grelhar/SKILL.md:18-20`: seção "Modo auto" (busca fatos, recomendação registrada como SUPOSIÇÃO, sem perguntar, sem "fechou?").
- `base/skills/refinador-de-prompt/SKILL.md:12-17`: modo normal (só bloqueantes, um gate) vs auto (nenhuma pergunta, SUPOSIÇÃO).
- Gates no modo normal concentrados em 2 de decisão (prompt; plano) + integração: removidos "Alinhamento prévio" e loop separado do refinador (viraram o gate 1 único), "Posso executar?" do piloto (absorvido pelo gate 1), pergunta de modelo da Fase 4 (substituída por `models.yml`).

### B2 — Modelo por papel
- `executor…/SKILL.md:29-39`: leitura de `~/.claude/cbs-overrides/models.yml`, papéis, valores, default, overrides `models=`/`modelo=`, `inherit`, e o texto do override repassado ao SDD **como override da seção Model Selection** (não como Global Constraint — achado 9 da auditoria).
- `referencia/dispatch.md` §2: tabela papel → `model` do `models.yml`.
- `revisor/SKILL.md:16`: `final_review`, `e2e`, `implementer`. `refinador…/SKILL.md:34`, `investigador…/SKILL.md:31`, `wayfinder/SKILL.md:91`: `investigar` pros subagents Explore/pesquisa.
- README `:126-146`: seção "Modelo por papel (`models.yml`)".
- `base/config/models.yml`: já criado pelo WP-A; não tocado.

### B3 — Personas por caminho e vocabulário SDD 6.3
- `referencia/dispatch.md` (novo, 4,8 KB): §1 bloco pra `## Global Constraints` do plano com caminhos por papel + resumo vinculante ≤10 linhas; §2 o que entra em cada prompt (implementer, task reviewer, re-reviewer, reviewer final, e2e) e o que é proibido colar; §3 marcação por task.
- `referencia/persona-dev.md` (novo, 1,3 KB): persona dev destilada (Amelia/`bmad-agent-dev`) em 8 linhas — o "@dev por caminho". Fica dentro da skill porque `base/personas/` (fora de `ponytail.md`) está fora do escopo do WP-B; caminho instalado: `~/.claude/skills/executor-bmad-superpowers/referencia/persona-dev.md`.
- `executor…/SKILL.md:52-53` (princípio 7), `:88-89` (Fase 3 passo 4: bloco nas Global Constraints), `:99-109` (Fase 5: papéis implementer → task reviewer → re-reviewer → reviewer final; report em `.superpowers/sdd/<plano>/task-N-report.md`; nunca conteúdo colado), anti-padrão `:127`.
- `base/personas/ponytail.md:3` (lido por caminho, todos os papéis, ordem de empilhamento) e `:12` (precedência área > linguagem > ponytail).
- `revisor/SKILL.md:17-23`: lentes e ponytail por caminho.

### B4 — Roteamento por domínio e `personas/review/`
- `referencia/roteamento.md` (novo, 4,3 KB): §1 tabela sinais → domínio (frontend, database, laravel, python, node, integracao — copiada da pesquisa §7.1), até 2 domínios (linguagem + área), ordem persona dev → ponytail → linguagem → área, precedência área > linguagem > ponytail, regras Laravel+Vite / package.json só React, sub-modo `frontend/<modo>`; §2 lentes: `seguranca` no task reviewer **sempre** que domínio backend, `cobertura-de-testes` no reviewer final; §3 TDD por tipo. Em todo lugar: "se o arquivo não existir, siga sem ele e anote".
- `executor…/SKILL.md:86-89` (Fase 3 passos 3–4), `:112-116` (Fase 6 usa as lentes).
- README `:287-330`: árvore de personas, tabela de roteamento, regras de empilhamento.

### B5 — `/investigar` read-only + "O que quebra se mudar"
- `investigador-de-ideia/SKILL.md:10-17`: hook conceitual (conferir caminho antes de Edit/Write; só `docs/`), lista de proibidos/permitidos; `:38-45` seção obrigatória "O que quebra se mudar" (dependentes, dados, comportamento, testes, reversibilidade, "não medido: como medir"); `:21` saída em `docs/analises/<data>-investigacao-<slug>.md`; `:36` perspectivas `bmad-agent-analyst`/`bmad-agent-pm` simuladas; `.bmad-core/` removido.
- `base/commands/investigar.md:11-13`: reforço read-only e saída.

### B6 — TDD por tipo de tarefa
- `refinador…/SKILL.md:48-53`: classificação `regra-de-negocio | operacional | ui` + domínios previstos; tags `<tipo_de_tarefa>` e `<dominios_previstos>` no prompt (`:81-87`).
- `referencia/roteamento.md` §3: política por tipo (TDD estrito / E2E / browser com Playwright em `/tmp/pwval`, sem `agent-browser`).
- `executor…/SKILL.md:46` (princípio 2), `:70` (Fase 1 usa as tags), `referencia/dispatch.md` §1 linha 5 do resumo vinculante.
- README `:318-326`.

### B7 — Fusão de comandos e refs BMAD
- `base/commands/refinar.md` = alias de `/piloto --so-refinar`; `refinar-auto.md` = `/piloto --auto --so-refinar` (ambos com fallback inline das Etapas 0–2).
- `base/commands/revisar.md` → skill nova `base/skills/revisor/SKILL.md` (modo standalone e modo gate); `executor…/SKILL.md:112-116` Fase 6 invoca `revisor` como gate final automático, condicional (task backend/`review: seguranca` ou TDD relaxado).
- `grelhar` e `mapear` mantidos; uso via `/piloto`/`/investigar` documentado em `grelhar/SKILL.md:12`, `wayfinder/SKILL.md:91`, `commands/grelhar.md`, `commands/mapear.md`, README `:86-89`.
- Refs BMAD: `bmad-prd`, `bmad-architecture`, `bmad-create-epics-and-stories`, `bmad-spec`, `bmad-agent-*`; `@qa`/`@sm`/`.bmad-core` removidos; `bmad-code-review` continua citado só no README (tabela); detecção por `_bmad/_config/manifest.yaml` (`executor:57`, `refinador:44`).

### B8 — Saída enxuta
- `executor…/SKILL.md:41-43`: "uma linha por fase"; linhas `→ chat:` ao fim de cada fase; entrega em `docs/analises/<data>-entrega-<slug>.md` via `referencia/entrega.md` (template novo, 1,5 KB). Cabeçalhos de 7 fases e entrega de 8 seções removidos do chat.
- `refinador…/SKILL.md:61-124`: 4 seções gravadas em `docs/prompts/`, chat de 1 linha, ajustes re-emitem só o diff no arquivo.
- `investigador…/SKILL.md:19-21`: arquivo + 1 linha.
- `revisor/SKILL.md:24`: relatório em `docs/analises/`, chat 1 linha. `grelhar/SKILL.md:114-116`: fechamento ≤10 linhas; no piloto, 1 linha.
- README `:104-106` nota "Chat enxuto".

### B9 — README
- Reescrito preservando seções inalteradas (Instalação, CLI, Customização, Desinstalar, Contribuir, Créditos): 7 skills; requisitos Superpowers ≥ 6.3 e BMAD ≥ 6.12 (`:45-46`); tabela "Como usar" com aliases e revisor como gate (`:84-98`); **Gates por modo** (`:110-122`); **models.yml** (`:126-146`); pipeline atualizado (`:150-208`); exemplo em chat enxuto; "As 7 skills"; BMAD por caminho (`:262-283`); **Personas: domínios e lentes de review** com roteamento e TDD por tipo (`:287-340`); troubleshooting com versões mínimas, auto e modelos.

## Tamanhos (bytes)

| Arquivo | Antes | Depois |
|---|---:|---:|
| `skills/executor-bmad-superpowers/SKILL.md` | 23 723 | 12 496 (meta ≤ 16 384) |
| `skills/executor-bmad-superpowers/referencia/dispatch.md` | — | 4 832 |
| `skills/executor-bmad-superpowers/referencia/roteamento.md` | — | 4 276 |
| `skills/executor-bmad-superpowers/referencia/persona-dev.md` | — | 1 302 |
| `skills/executor-bmad-superpowers/referencia/entrega.md` | — | 1 486 |
| `skills/refinador-de-prompt/SKILL.md` | 10 430 | 7 739 |
| `skills/investigador-de-ideia/SKILL.md` | 6 310 | 5 071 |
| `skills/grelhar/SKILL.md` | 6 980 | 7 979 (+ seção "Modo auto") |
| `skills/wayfinder/SKILL.md` | 9 413 | 9 769 (+ 1 parágrafo) |
| `skills/handoff/SKILL.md` | 3 552 | 3 552 (intocado) |
| `skills/revisor/SKILL.md` | — | 4 713 |
| `personas/ponytail.md` | 6 214 | 6 657 |
| `commands/piloto.md` | 2 715 | 2 897 |
| `commands/executar.md` | 1 389 | 1 927 |
| `commands/refinar.md` | 997 | 1 101 |
| `commands/refinar-auto.md` | 1 037 | 993 |
| `commands/investigar.md` | 1 053 | 1 558 |
| `commands/revisar.md` | 2 645 | 1 627 |
| `commands/grelhar.md` | 1 014 | 1 257 |
| `commands/mapear.md` | 1 099 | 1 251 |
| `commands/handoff.md` | 644 | 644 (intocado) |
| `README.md` | 24 7xx | 27 877 |

`grelhar` e `wayfinder` cresceram por acréscimo pedido pelo plano (modo auto; encaminhamento documentado); ambos bem abaixo do executor.

## Verificação

```
grep -rn -e '@qa' -e '@sm' -e '\.bmad-core' -e 'bmad-create-prd' -e 'bmad-create-architecture' \
  -e 'bmad-create-story' -e 'spec reviewer' -e 'code quality reviewer' -e '\-\-update' \
  base/skills base/commands/{piloto,executar,refinar,refinar-auto,investigar,revisar,grelhar,mapear,handoff}.md \
  base/personas/ponytail.md README.md
→ zero ocorrências
```

- Frontmatter (`---`/`name:`/`description:`/`---`) válido nos 7 `SKILL.md`.
- Todo `skill: "..."` nos 11 commands aponta pra skill existente em `base/skills/` (ou pro command `piloto`, que o Claude Code expõe como skill); `claude-mem:mem-search`/`mem-search` são externas.
- `handoff/SKILL.md` ainda cita `mem-search` (fallback válido); não estava no escopo de edição.

## Decisões onde o plano era ambíguo

1. **Stories**: o plano cita `bmad-create-story`, mas em 6.12 é shim deprecated ("use `bmad-build`"). Usei as ativas `bmad-create-epics-and-stories` (sempre) e `bmad-spec` (quando há SPEC). `bmad-build` não foi adotado como motor: o SDD continua sendo o motor (o plano não pede trocar).
2. **Persona dev por caminho**: como `base/personas/` (fora do ponytail) é do WP-C, a persona destilada foi criada dentro da skill (`referencia/persona-dev.md`). Não aponto o subagent pra `.claude/skills/bmad-agent-dev/SKILL.md` do projeto porque esse arquivo é um script de ativação (menu, `uv run`, saudação) — inadequado pra leitura por subagent.
3. **Fase 6 vs review final do SDD**: pra não triplicar review (achado 6 da auditoria), a lente `cobertura-de-testes` entra no reviewer final **do SDD** via Global Constraints, e o `/revisar` automático (Fase 6) é **condicional** (task backend/segurança ou TDD relaxado). Sem gatilho: 1 linha "pulada".
4. **Gate 1 no `/piloto`**: "Alinhamento prévio" + loop "ajustar?" + "Posso executar?" colapsaram numa única pergunta do refinador (`ok` executa / ajuste). Dúvidas bloqueantes ainda são perguntadas antes, uma por vez, só quando a grelha não as fechou.
5. **Worktree**: mantive "sem worktree" (regra existente do usuário), mas o executor cria `feat/<slug>` se estiver em main/master — é o "consentimento explícito" que o SDD 6.3 exige (achado 5 da auditoria). Não estava listado no WP-B, mas é pré-condição pro SDD 6.3 não parar.
6. **`/revisar` virou skill** (`revisor`) — o executor não conseguiria invocar um command como gate de forma limpa (achado 21 da auditoria; backlog #10). Skill nova é descoberta por `readdir`, sem mudança em `src/`.
7. **Memória**: padronizei `claude-mem:mem-search` como primeiro nome e `mem-search` como fallback (achado 11); as skills usam o resumo passado pelo command em vez de chamar de novo.
8. **Template do prompt premium** encolhido (achado 16): removidos `<execution_workflow>`, `<quality_gates>`, `<security_review>`, `<output_format>` — o executor governa isso; adicionadas `<tipo_de_tarefa>` e `<dominios_previstos>`.
9. **Entrega** vai pra `docs/analises/<data>-entrega-<slug>.md` (persistente), não pro workspace do SDD, porque o SDD apaga `.superpowers/sdd/<plano>/` quando o review final fica limpo.
10. **Detecção de modo autônomo**: como o LLM não vê TTY, os critérios são `--auto`/`auto`, `printenv CLAUDE_AUTONOMOUS` e ausência de `AskUserQuestion` na lista de ferramentas.

## Pendências / dependências de outros WPs

- WP-C: `dominios/{laravel,python,node,integracao}.md`, `review/{seguranca,cobertura-de-testes}.md`, `frontend.md` roteador + `frontend-referencia.md`. Os prompts já dizem "se o arquivo não existir, siga sem ele e anote". O sub-modo `frontend/<modo>` só se aplica se o roteador do WP-C definir modos.
- WP-A: README já descreve `status` completo, `--auto-bmad` sem TTY, `npx bmad-method uninstall` e `models.yml` copiado só se não existir — conferir que o WP-A entregou exatamente isso.
- Fechamento: CHANGELOG 0.12.0 deve citar: `--auto`/`--so-refinar`, `models.yml`, personas por caminho, skill `revisor`, `referencia/` do executor, aliases `/refinar`/`/refinar-auto`, saída em arquivo (`docs/prompts/`, `docs/analises/`), refs BMAD 6.12.
- Não testado em execução real (`/piloto --auto` num projeto): o primeiro uso deve ser observado, em especial (a) se o SDD aceita o override de Model Selection em texto, (b) se o `writing-plans` para no "Which approach?" mesmo com a instrução, (c) se `Skill piloto` com args funciona a partir de `/refinar`.
- `handoff/SKILL.md` e `commands/handoff.md` não foram alterados (nada no plano pra eles).

## Correções pós-review (`2026-09-10-wp-b-review.md`)

Também alinhado ao `models.yml` commitado pelo WP-A (`1058bd2`, `d769270`): papéis novos com `claude:`/`codex:`, agentes `cbs-*`, `effort:` separado, sem `haiku`.

| # | Sev. | O que foi feito | Onde |
|---|---|---|---|
| 1 | Alta | Instrução literal ao SDD: parar antes do Finish (não apagar workspace, não invocar `finishing-a-development-branch`). Fase 7 agora: lê o ledger → escreve entrega → commita entrega + revisão → apaga o workspace → `finishing-a-development-branch` uma vez. Anti-padrão novo. | `executor/SKILL.md` Fase 5 (parágrafo de invocação), Fase 7 passos 2–4, anti-padrões; `referencia/entrega.md` (parágrafo "Ordem na Fase 7"); README pipeline e "Gates por modo"; `commands/executar.md` lembrete |
| 2 | Alta | Seção "Menus de outras skills (qualquer modo)": o executor responde menus do BMAD/brainstorming/writing-plans, nunca repassa. Fase 3 passo 1 reescrito: `bmad-create-epics-and-stories` só com `PRD.md` + `Architecture.md`; `bmad-spec` só em modo normal (headless nunca quebra em stories); senão story mínima pelo `templates/epics-template.md` da skill, marcada `BMAD: template`; `bmad-prd` em Fast path. README: linha na tabela de gates + parágrafo. | `executor/SKILL.md` "Modo e gates" (`:24`), Fase 3 passo 1 (`:99-105`); `referencia/entrega.md` cabeçalho (`BMAD: skill \| template \| simulado`); README `:120-125` |
| 3 | Média | Fase 2: "em qualquer modo" o design vai pro plano e a aprovação é a da Fase 4 (sem gate do brainstorming nem review da spec). | `executor/SKILL.md` Fase 2 |
| 4 | Média | Escalada pro grelhar no refinador restrita a invocação sem grelha prévia (fallback inline de `refinar.md` ou chamada direta); menção no grelhar corrigida ("`/refinar` e `/refinar-auto` percorrem a Etapa 1 do `/piloto`"). | `refinador/SKILL.md` Fase 4 item 4; `grelhar/SKILL.md:12` |
| 5 | Média | Gatilho da Fase 6 estreitado: só `review: seguranca` **explícito** (auth, pagamento, tenant, dados pessoais, webhook de entrada), `ui` sem teste unitário, ou reviewer final sem lentes. A lente `seguranca` em toda task backend continua automática via Global Constraint (não precisa da marca). Em modo gate o revisor pula `cobertura-de-testes`. | `executor/SKILL.md` Fase 6; `referencia/roteamento.md` §2; `referencia/dispatch.md` §3; `revisor/SKILL.md` modo gate; `commands/executar.md`; README pipeline |
| 6 | Média | Checklist de segurança de 8 linhas como fallback explícito quando `review/seguranca.md` faltar; no revisor, ausência da lente em diff backend vira 🟡. (O WP-C já criou `review/seguranca.md` — commit `eb3d527` — então o fallback só vale pra instalações antigas.) | `referencia/roteamento.md` §2; `revisor/SKILL.md` passo 5; README troubleshooting |
| 7 | Média | Description do `/refinar-auto`: "toda dúvida, inclusive bloqueante, vira SUPOSIÇÃO destacada". | `commands/refinar-auto.md:2` |
| 8 | Baixa | Descriptions com `": "` envolvidas em aspas duplas (4 arquivos); parse com PyYAML ok em todos os 7 SKILL.md e 11 commands. | `commands/piloto.md`, `commands/executar.md`, `commands/revisar.md`, `revisor/SKILL.md` |
| 9 | Baixa | §1 do dispatch reescrito: task reviewer recebe GC por contrato; pro reviewer final o executor **passa** o bloco (com `cobertura-de-testes`). | `referencia/dispatch.md` §1 e §2 (linha "reviewer final") |
| 10 | Baixa | Em auto, escopo grande demais → `SUPOSIÇÃO: escopo cabe numa sessão`, segue e anota na entrega. | `commands/piloto.md` Etapa 1 |
| 11 | Baixa | Commit da entrega e da revisão antes do gate de integração. | `executor/SKILL.md` Fase 7 passo 3; README pipeline |
| 12 | Baixa | `/tmp/pwval` virou "venv do projeto/usuário (ex.: `/tmp/pwval`)"; `agent-browser` condicionado a "quando o ambiente não abre janela confiável". | `referencia/roteamento.md` §3, `referencia/dispatch.md` §1 linha 5, `revisor/SKILL.md`, README pré-requisitos |
| 13 | Baixa | Papel `explorer` documentado em refinador, investigador, grelhar (Fase 2) e wayfinder; README lista `/refinar` e o intake do executor. `models.yml` não editado (do WP-A). | `refinador:34`, `investigador:31`, `grelhar:12`, `wayfinder:91`, README tabela de papéis |
| 14 | Baixa | Bloco `### Ponytail` vai pro report file da task, não pra resposta ao orquestrador. | `personas/ponytail.md` seção 1 |
| 15 | Baixa | `N` na Fase 4 → branch com stories/plano fica; dito na linha de chat. | `executor/SKILL.md` Fase 4 |
| 16 | Baixa | Description do investigador: "tabela de 3–5 abordagens (inclui a mínima e a ousada)". | `investigador/SKILL.md:3` |
| 17 | Baixa | Não é defeito do WP-B; o WP-C entregou (`eb3d527`): `dominios/{laravel,python,node,integracao}.md`, `frontend.md` roteador (2,0 KB) + `frontend-referencia.md`, `review/{seguranca,cobertura-de-testes}.md`. Conferido com `ls base/personas/review base/personas/dominios`. Nada a corrigir no WP-B. | — |
| — | — | `bmad-code-review`: o report anterior dizia "citado na tabela do README" — não estava. Continua não citado (o plano diz "mantido", não "usado"); o BMAD 6.12 o define como workflow de 3 reviewers paralelos, não persona injetável, então o executor não o invoca. Registro corrigido aqui. | — |

### Agentes nomeados (pedido do orquestrador)

- Executor "Modelo por papel e agentes nomeados": `claude:` = agente em `~/.claude/agents/` (pacote instala `cbs-*`, override em `cbs-overrides/agents/`) ou modelo direto `sonnet|opus|fable|inherit` + `effort:`; `codex:` = `name` do agente em `~/.codex/agents/*.toml` (o `name` dentro do toml é `architect_sol` com underscore, embora o arquivo seja `architect-sol.toml`). Resolução argumento > arquivo > default; agente existente → `subagent_type` = nome; ausente → fallback de modelo/effort da tabela + `agente ausente: <nome>` na entrega. Sinônimos dos papéis antigos (`implementer`, `final_review`, `e2e`, `investigar`).
- Tabela completa (10 papéis × default claude / fallback modelo-effort / default codex) em `referencia/dispatch.md` §2, copiada dos frontmatters de `base/agents/cbs-*.md`; mapeamento papel SDD → papel `models.yml` na mesma seção (implementer por domínio, `refactor` na fix wave, `architect` nos fix rounds 4–5).
- Commands `piloto`/`executar`: flag `models=papel:valor` com os 10 papéis; `revisar`: `final_reviewer`/`tester`/`refactor`; README seção reescrita.
- Ressalva: o Agent tool do Claude Code não aceita effort por dispatch — effort só vale via agente nomeado; o executor registra quando cai no modelo direto.

Tamanho final do executor: 16 377 B (meta ≤ 16 384). Greps proibidos: zero ocorrências. Frontmatter YAML parseado sem erro nos 7 SKILL.md e 11 commands.

## Rodada 3 — haiku, gate de segurança, referências do WP-C, runtime Codex

| Pedido | O que foi feito | Onde |
|---|---|---|
| Zero haiku | Já purgado na rodada 2 (alinhamento ao `models.yml` do WP-A); `grep -rni haiku base/ README.md` → zero. Defaults: `explorer` = cbs-explorer (sonnet/medium), `search` = cbs-search (sonnet/low); valores válidos `sonnet \| opus \| fable \| inherit`. | executor "Modelo por papel", `referencia/dispatch.md` §2, README `models.yml`, commands `piloto`/`executar`, refinador/investigador/grelhar/wayfinder |
| Agentes `cbs-*` como default `claude:` | Tabela de papéis no SKILL.md com as duas colunas (`claude:` cbs-architect, cbs-backend, cbs-frontend, cbs-refactor, cbs-reviewer, cbs-final-reviewer, cbs-tester, cbs-explorer, cbs-search; `codex:` architect_sol … search_spark) e a frase "No Codex, ignore a coluna `claude:`". Fallback modelo/effort (do frontmatter de `base/agents/cbs-*.md`) só em `referencia/dispatch.md` §2. | executor "Modelo por papel e agentes nomeados" |
| Runtime | Seção "Runtime (Claude Code ou Codex)" no executor: detecção (ferramenta `Agent` com `subagent_type`/`model` → Claude; dispatch por nome em `~/.codex/agents/*.toml` ou `CODEX_HOME`/`CODEX_CLI_PATH` → Codex); Claude usa `claude:` (agente se existir em `~/.claude/agents`, senão modelo); Codex usa **somente** `codex:` — nunca modelo nem effort; agente ausente → sem nome, `default_subagent_model` do `config.toml`; personas/scripts em `~/.claude/personas` e `~/.claude/scripts` nos dois. Mesma regra, em 1–2 linhas, no revisor, refinador, investigador, grelhar e wayfinder; README idem; anti-padrão "passar nome de modelo no Codex". | executor `## Runtime`; `revisor` passo 4; `refinador` Fase 2 item 4; `investigador` §2; `grelhar:12`; `wayfinder:91`; README `models.yml` |
| (a) `gate-seguranca.sh` | Executor Fase 7 passo 1: com task backend, roda `~/.claude/scripts/gate-seguranca.js` via `node` (override `cbs-overrides/scripts/`) — exit 1 bloqueia (fix dispatch `refactor` + rodar de novo), "gate parcial" só avisa na entrega. Resumo vinculante (linha 6): task backend roda o gate antes de DONE. Revisor: em diff backend roda o gate; exit 1 = 🔴, parcial = aviso. Entrega e relatório do revisor ganharam a linha do gate. | executor Fase 7; `referencia/dispatch.md` §1 linha 6; `referencia/roteamento.md` §2; `referencia/entrega.md`; `revisor` passo 5 e formato; README "Gate de segurança" |
| (b) personas por caminho + `*-referencia.md` | Caminhos explícitos `~/.claude/personas/dominios/{frontend,database,laravel,python,node,integracao}.md` e `review/{seguranca,cobertura-de-testes}.md`; `node-referencia.md`, `frontend-referencia.md`, `seguranca-referencia.md` citados como "consulte por caminho quando o rulebook mandar". | `referencia/roteamento.md` §1; `referencia/dispatch.md` §1; `revisor` lente Segurança; README roteamento |
| (c) ordem de empilhamento = `base/personas/README.md` | Lido. Ordem persona dev → ponytail → linguagem → área, até 2 domínios, área > linguagem > ponytail, lentes só em reviewers, `cobertura-de-testes` "sempre que há diff de código de produção", gate na lente `seguranca`: tudo igual no executor/roteamento/dispatch. `roteamento.md` §1 passa a citar o README como fonte da ordem. | `referencia/roteamento.md` §1–§2 |

Tamanho do executor após a rodada: 16382 B (meta ≤ 16 384; cortes em princípios, anti-padrões, teammate/ultracode, detecção BMAD, tabela de gates — o conteúdo cortado continua em `referencia/` ou no README). Frontmatter YAML válido nos 7 SKILL.md e 11 commands (PyYAML).

## Rodada 4 — Runtime (CODEX_HOME) e gate em Node

- Gate: todas as chamadas agora `node ~/.claude/scripts/gate-seguranca.js` (WP-C trocou o .sh por .js); exit 1 bloqueia, "gate parcial" só avisa. Nenhuma referência a `.sh` restante em `base/skills`/README.
- Runtime: parágrafo em `referencia/dispatch.md` §2 (detecção, colunas, nomes codex, ausência → sem nome, personas/scripts em `~/.claude` em qualquer SO) + seção `## Runtime` no executor; `CODEX_HOME`/`CODEX_CLI_PATH` citados também em revisor, refinador, investigador, grelhar, wayfinder.

```
$ command grep -rn "CODEX_HOME\|gate-seguranca" base/skills base/commands
base/skills/investigador-de-ideia/SKILL.md:30:- **Código atual** via subagent `Explore` (papel `explorer` de `~/.claude/cbs-overrides/model
base/skills/wayfinder/SKILL.md:91:Chega-se aqui por `/mapear` direto, ou encaminhado pelo `/investigar` e pela grelha do `/piloto` quando o 
base/skills/grelhar/SKILL.md:12:Chega-se aqui por `/grelhar` direto, pela Etapa 1 do `/piloto` (que `/refinar` e `/refinar-auto` também per
base/skills/refinador-de-prompt/SKILL.md:40:4. **Explore subagent (obrigatório)** — papel `explorer` de `~/.claude/cbs-overrides/models.y
base/skills/executor-bmad-superpowers/SKILL.md:48:Detecte antes do primeiro dispatch. **Claude Code**: existe a ferramenta `Agent` com `suba
base/skills/executor-bmad-superpowers/SKILL.md:136:1. `superpowers:verification-before-completion`: rode testes/build e cole a saída real *
base/skills/executor-bmad-superpowers/referencia/entrega.md:33:## Gate de segurança (`node ~/.claude/scripts/gate-seguranca.js`)
base/skills/executor-bmad-superpowers/referencia/dispatch.md:26:6. Queries parametrizadas, input externo validado, segredo só por env, perm
base/skills/executor-bmad-superpowers/referencia/dispatch.md:35:**Runtime.** Claude Code = existe a ferramenta `Agent` com `subagent_type`/`
base/skills/executor-bmad-superpowers/referencia/roteamento.md:31:Nunca no implementer: dobra tokens e vira auto-review enviesado. A lente `
base/skills/revisor/SKILL.md:20:4. **Runtime e papéis**. Claude Code (ferramenta `Agent` com `subagent_type`/`model`) → coluna `claude:` 
base/skills/revisor/SKILL.md:24:   - **Segurança** — `review/seguranca.md` (tabela por stack em `review/seguranca-referencia.md`, por cam
base/skills/revisor/SKILL.md:48:- gate-seguranca.js: aprovado | parcial (ferramentas ausentes) | reprovado (exit 1) | n.a.
```
