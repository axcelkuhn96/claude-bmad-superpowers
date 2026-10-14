# claude-bmad-superpowers

> Workflow PT-BR para [Claude Code](https://claude.com/claude-code): **refina sua ideia com a memória do projeto e entrega pra uma execução de qualidade** — TDD real, subagents isolados, um task reviewer por task e review final da branch.

Um pacote de **8 skills** e **13 comandos** em português que amarram cinco camadas, cada uma no seu nível:

| Camada | Quem faz | Papel |
|---|---|---|
| **Front-end PT-BR** (o diferencial) | skills deste pacote | Grelha e refina sua ideia com memória, faz discovery sem tocar código, roteia personas por domínio, controla gates e modelo por papel |
| **Motor de execução** | [Superpowers ≥ 6.3](https://github.com/obra/superpowers) | brainstorming → plano → subagent-driven-development (implementer → task reviewer → re-reviewer → reviewer final) → finishing-a-development-branch |
| **Disciplina de processo** (sempre) | [BMAD-METHOD ≥ 6.12](https://github.com/bmad-code-org/BMAD-METHOD) | Gera as stories no planejamento (`bmad-create-epics-and-stories`, `bmad-prd`, `bmad-architecture`) e empresta a persona dev (Amelia) a cada implementer |
| **Expertise por domínio** (quando aplicável) | rulebooks em `personas/dominios/` + lentes em `personas/review/` | Em cima da persona dev, empilha regras de linguagem (`laravel`, `python`, `node`) e de área (`frontend`, `database`, `integracao`); reviewers ganham lentes de `seguranca` e `cobertura-de-testes` |
| **Anti-over-engineering** (sempre, transversal) | rulebook `personas/ponytail.md` | Lido por **todo** subagent: escada de decisão (reusar > stdlib > nativo > dep > 1 linha > só então build) pra escrever o **mínimo** — sem cortar validação, erro, segurança ou teste |

Em vez de competir, cada peça fica no que faz bem: **você refina em português, e a execução roda sempre com o Superpowers como motor + o BMAD como disciplina dentro dele**. Personas e rulebooks chegam aos subagents **por caminho de arquivo**, nunca colados no prompt — o contexto principal só orquestra.

---

## Índice

- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Como usar](#como-usar-escolhe-pelo-grau-de-maturidade-da-ideia)
- [Gates por modo](#gates-por-modo)
- [Modelo por papel (models.yml)](#modelo-por-papel-modelsyml)
- [Como o pipeline funciona](#como-o-pipeline-funciona)
- [Exemplo de fluxo real](#exemplo-de-fluxo-real)
- [As 8 skills](#as-8-skills)
- [Memória (claude-mem)](#memória-claude-mem)
- [Memória opcional (Mem0)](#memória-opcional-mem0)
- [BMAD + Superpowers: sempre juntos](#bmad--superpowers-sempre-juntos)
- [Personas: domínios e lentes de review](#personas-domínios-e-lentes-de-review)
- [Ponytail](#ponytail-menos-código-mesma-segurança)
- [Hooks globais](#hooks-globais)
- [CLI de referência](#cli-de-referência)
- [Customização que sobrevive a updates](#customização-que-sobrevive-a-updates)
- [Desinstalar](#desinstalar)
- [Troubleshooting](#troubleshooting)

---

## Pré-requisitos

- **Node 18+** (`node --version`)
- **Claude Code** instalado e logado (`claude --version`)
- **Git**
- **Superpowers ≥ 6.3** (plugin; o instalador mostra o comando) — o executor descreve o contrato do `subagent-driven-development` 6.3 (task reviewer único, briefs/reports em `.superpowers/sdd/<plano>/`, `finishing-a-development-branch`)
- **BMAD ≥ 6.12** por projeto (`_bmad/`, skills `bmad-*` em `.claude/skills/`) — o pacote usa `bmad-prd`, `bmad-architecture`, `bmad-create-epics-and-stories`, `bmad-spec`, `bmad-agent-*`
- Opcional, recomendado: **[claude-mem](https://github.com/thedotmack/claude-mem)** — se presente, as skills consultam sua memória de sessões anteriores antes de planejar.
- Opcional, pra validação de UI: Playwright num venv do projeto ou do usuário (ex.: `/tmp/pwval`) — as personas de frontend exigem screenshot antes de DONE.

---

## Instalação

Um comando instala tudo (cross-platform — Linux, macOS, Windows, WSL):

```bash
npx claude-bmad-superpowers instalar
```

Isso faz, em ordem:

1. **Skills + comandos + personas** → copia as 8 skills, 13 comandos e as personas (`ponytail.md`, `dominios/*.md`, `review/*.md`) pra `~/.claude/skills/`, `~/.claude/commands/` e `~/.claude/personas/`; copia `models.yml` pra `~/.claude/cbs-overrides/models.yml` **só se não existir**.
2. **Superpowers** → detecta o plugin; se não estiver instalado, mostra o comando exato pra rodar **dentro do Claude Code** (instalação de plugin não funciona via CLI fora do app).
3. **BMAD** → instala no diretório atual se você estiver dentro de um projeto (interativo, em PT-BR). Pra pular: `--apenas-global`.

> Atalho: depois de instalar, os binários `claude-bmad-superpowers` e `cbs` ficam disponíveis. Use `cbs` pra digitar menos.

**Flags do `instalar`:**

| Flag | Efeito |
|---|---|
| `--apenas-global` / `--skip-bmad` | Não instala BMAD no diretório atual (só skills/comandos/Superpowers) |
| `--skip-superpowers` | Não tenta instalar o plugin Superpowers |
| `--sem-hooks` | Copia os hooks CBS (`~/.claude/hooks/cbs-*.mjs`) mas não os registra no `settings.json` (não persiste: o próximo `atualizar` sem a flag registra) |

Verifique a qualquer momento:

```bash
cbs status
```

---

## Como usar (escolhe pelo grau de maturidade da ideia)

| Você tem... | Use | O que acontece |
|---|---|---|
| Ideia fuzzy, dúvida estratégica | `/investigar <tema>` | Pensa junto, mapeia o código, brainstorm, **"o que quebra se mudar"**, recomenda. Grava em `docs/analises/`. **Estritamente read-only.** |
| Trabalho grande demais pra 1 sessão | `/mapear <ideia>` | Cartografa um mapa de decisões em `docs/mapas/`, resolve ticket por ticket (wayfinder). O `/investigar` e a grelha do `/piloto` encaminham pra cá. **Não toca em código.** |
| Quer stress-testar um plano/decisão | `/grelhar <tema>` | Interrogatório, uma pergunta por vez **no seletor do CLI**, até entendimento compartilhado. Roda por dentro do `/piloto`. **Não implementa.** |
| Ideia clara mas crua | `/refinar <ideia>` | Alias de `/piloto --so-refinar`: grelha + prompt premium em `docs/prompts/`, sem executar |
| Ideia crua, sem querer perguntas | `/refinar-auto <ideia>` | Alias de `/piloto --auto --so-refinar`: assume tudo e marca `SUPOSIÇÃO` |
| Prompt/spec em mãos | `/executar [--auto] <prompt>` | Stories BMAD → plano → subagents + TDD por tipo → revisão final → entrega em `docs/analises/` |
| Atalho fim-a-fim | `/piloto [--auto] <ideia>` | grelhar + refinar (gate 1) + executar (gate 2 + integração) numa conversa só |
| Quer revisar o que foi feito | `/revisar [escopo]` | Code review + cobertura + segurança (lentes `personas/review/`), relatório em `docs/analises/`; só corrige com seu OK. É também o gate final automático do `/executar` e `/piloto`. |
| Vai trocar de sessão/agente | `/handoff [foco]` | Compacta a conversa num documento de continuação (referencia artefatos, redige segredos, sugere próximas skills). |
| Quer auditar a config de agentes | `/blindar` | AgentShield estático em ~/.claude, ~/.codex e no projeto; relatório em `docs/analises/` (read-only). O relatório traz achados da sua config global: não commite em repo público |

Comandos de manutenção:

| Comando | Pra que |
|---|---|
| `/instalar-bmad` | Instala o BMAD no projeto atual (delega pra `cbs instalar-bmad`, interativo) |
| `/atualizar` | Atualiza o pacote + Superpowers + BMAD dos projetos registrados |

> **BMAD roda sempre** em `/executar` e `/piloto`: o planejamento gera as stories com BMAD antes do plano do Superpowers, e cada implementer lê a persona dev. Não há flag pra desligar.

> **Chat enxuto.** Todas as skills respondem com **1 linha por fase**; o conteúdo vai pra arquivo (`docs/prompts/`, `docs/analises/`, plano, `.superpowers/sdd/`). "Terminou?" se responde com a linha da fase atual.

---

## Gates por modo

| Gate | `/piloto` | `/piloto --auto` | `/executar` | `/executar --auto` |
|---|---|---|---|---|
| Grelha (decisões, uma por vez) | interativa | recomendação registrada como `SUPOSIÇÃO` | — | — |
| **Gate 1** — prompt refinado (`ok` / ajuste) | sim | não | — (o prompt já vem pronto) | — |
| **Gate 2** — plano aprovado ("Posso implementar?") | sim | não | sim | não |
| Perguntas entre tasks ("continuar?", "qual modelo?") | nunca | nunca | nunca | nunca |
| Menus do BMAD (`bmad-prd` Fast path, "wait for user"), do `brainstorming` e o "Which approach?" do `writing-plans` | o executor responde | o executor responde | o executor responde | o executor responde |
| **Gate de integração** — antes de `git push` / merge / deploy (`finishing-a-development-branch`) | sim | **sim** | sim | **sim** |

O modo auto também é detectado sem flag: `CLAUDE_AUTONOMOUS` definida no ambiente, ou sessão sem `AskUserQuestion` (`claude -p`, subagente, cron, teammate). `auto` como primeira palavra do argumento equivale a `--auto`. Em auto, toda suposição vai marcada no plano e na entrega.

Dúvidas **bloqueantes** (regra de negócio sem default sensato) ainda são perguntadas no modo normal, uma por vez, antes do gate 1; em auto viram `SUPOSIÇÃO` destacada.

Stories em auto: sem `PRD.md` + `Architecture.md` o executor não roda `bmad-create-epics-and-stories` (que exige os dois e para em menus) — gera a story mínima pelo template do BMAD e marca `BMAD: template`. O SDD para antes do Finish dele: entrega, commit dos relatórios e o menu de integração são do executor, uma vez só.

---

## Modelo por papel e agentes nomeados (`models.yml`)

O instalador copia `base/config/models.yml` pra `~/.claude/cbs-overrides/models.yml` (só se não existir; o `/atualizar` nunca sobrescreve) e os 10 agentes `cbs-*` pra `~/.claude/agents/` (override em `~/.claude/cbs-overrides/agents/`). `/executar`, `/piloto`, `/revisar`, `/refinar`, `/investigar`, `/grelhar` e `/mapear` leem o arquivo. Cada papel tem `claude:` (nome de um agente em `~/.claude/agents/` **ou** modelo direto `sonnet | opus | fable | inherit`, com `effort:` opcional `low | medium | high | xhigh | max`) e `codex:` (o `name` de um agente em `~/.codex/agents/*.toml`). O runtime escolhe a coluna.

| Papel | Usado em | Default `claude` (modelo/effort do agente) | Default `codex` |
|---|---|---|---|
| `orchestrator` | contexto principal (a sessão) | `fable`, effort `max` | — |
| `architect` | design/plano delegado, BLOCKED de arquitetura, fix rounds 4–5 | `cbs-architect` (fable/xhigh) | `architect_sol` |
| `implementer_backend` | implementer de task sem domínio `frontend` | `cbs-backend` (opus/high) | `backend_terra` |
| `implementer_frontend` | implementer de task `frontend` | `cbs-frontend` (sonnet/high) | `frontend_terra` |
| `refactor` | refatoração, fix wave do review final, correções do `/revisar` | `cbs-refactor` (opus/high) | `refactor_terra` |
| `build_fixer` | task BLOCKED por build/typecheck, ou Stop (`cbs-typecheck`) continuando a falhar | `cbs-build-fixer` (sonnet/high) | `backend_terra` |
| `reviewer` | task reviewer / re-reviewer (read-only) | `cbs-reviewer` (opus/xhigh) | `reviewer_sol` |
| `final_reviewer` | review final da branch e `revisor` (read-only) | `cbs-final-reviewer` (opus/xhigh) | `final_reviewer_sol` |
| `tester` | validação E2E / browser | `cbs-tester` (sonnet/medium) | `tester_luna` |
| `explorer` | subagents Explore de `/refinar`, `/investigar`, `/grelhar`, `/mapear` e do intake do executor | `cbs-explorer` (sonnet/medium) | `explorer_luna` |
| `search` | buscas pontuais (memória, grep amplo) | `cbs-search` (sonnet/low) | `search_spark` |

Regras: argumento > arquivo > default. **Claude Code** (ferramenta `Agent`): coluna `claude:` — se o valor é nome de agente e o arquivo existe, o dispatch vai **por nome** (`subagent_type`) e o agente carrega modelo, effort e ferramentas; se não existe, cai no modelo/effort do frontmatter (tabela acima) e a entrega anota `agente ausente`. **Codex** (`~/.codex/agents/*.toml`, `CODEX_HOME`): **só** a coluna `codex:` — nome do agente, nunca modelo nem effort; agente ausente → dispatch sem nome e o `default_subagent_model` do `config.toml` decide. Personas e scripts ficam em `~/.claude/personas/` e `~/.claude/scripts/` nos dois runtimes e em qualquer SO (o instalador resolve o home). Nomes antigos (`implementer`, `final_review`, `e2e`, `investigar`) continuam aceitos como sinônimos.

```
/executar models=implementer_backend:sonnet,reviewer:opus <prompt>   # parcial (agente ou modelo)
/piloto modelo=opus <ideia>                                          # todos os papéis, modelo direto
```

O executor repassa isso ao `subagent-driven-development` como override da seção *Model Selection* (implementer por domínio, `architect` nos fix rounds 4–5, `final_reviewer` no review final).

---

## Como o pipeline funciona

```
/investigar  →  discovery (read-only, só escreve em docs/)
                mem-search → enquadra → Explore subagent → abordagens →
                análise BMAD (analyst/pm) → O QUE QUEBRA SE MUDAR →
                recomendação → docs/analises/<data>-investigacao-<slug>.md → opcional PRD

/mapear      →  discovery de escopo grande (sem código)
                mem-search → nomeia destino (grelhar) → mapa de decisões em
                docs/mapas/ → tickets (pesquisa/protótipo/grelhar/tarefa) 1 a 1

/grelhar     →  interrogatório (não implementa)
                mem-search → 1 pergunta por vez NO SELETOR DO CLI
                  (2-4 opções c/ tradeoff + "(Recomendado)" na primeira) →
                busca fatos sozinho, pergunta só decisões → entendimento compartilhado
                (--auto: recomendação registrada como SUPOSIÇÃO, sem perguntar)

/piloto      →  grelhar → refinar → executar (fim-a-fim)
                mem-search → grelha → refinador grava docs/prompts/<slug>.md
                  (tipo_de_tarefa: regra-de-negocio|operacional|ui; dominios_previstos)
                → 🛑 gate 1: `ok` → executor
                (--so-refinar para aqui = /refinar; --auto pula os gates de decisão)

/executar    →  prompt → código entregue
                mem-search → executor (orquestrador, NÃO implementa inline)
                  → branch feat/<slug> se estava em main (sem worktree)
                  → BMAD gera stories (bmad-create-epics-and-stories / bmad-prd)
                  → superpowers:writing-plans (stories → plano)
                  → classifica cada task: (domínio: laravel+database; tipo: ...; review: seguranca)
                  → Global Constraints do plano recebem os CAMINHOS dos rulebooks
                  → 🛑 gate 2: "Posso implementar? [s/N]"  (pulado em --auto)
                  → superpowers:subagent-driven-development (models.yml)
                       · implementer (agente do models.yml, name impl-t<N>)
                         lê por caminho: persona-dev → ponytail → linguagem → área
                       · task reviewer (spec + qualidade) lê ponytail + domínio
                         + review/seguranca.md quando backend
                       · re-reviewer nos fix rounds; reviewer final lê
                         review/cobertura-de-testes.md
                       (o SDD para ANTES do Finish dele — sem apagar workspace,
                        sem finishing-a-development-branch)
                  → revisor (gate final automático: só review: seguranca explícito ou ui sem teste)
                  → verification-before-completion → docs/analises/<data>-entrega-<slug>.md
                  → commit dos relatórios → apaga o workspace do plano
                  → 🛑 gate de integração: finishing-a-development-branch (uma vez, sempre)

/revisar     →  code review + cobertura + segurança (subagents nomeados rev-*,
                agente reviewer/final_reviewer do models.yml,
                lentes por caminho) → docs/analises/<data>-revisao-<slug>.md →
                "Corrigir? [s/N]"

/handoff     →  compacta a conversa num doc de continuação (docs/handoffs/
                ou temp do SO) → referencia artefatos, redige segredos
```

**Por que isso protege seu contexto:** na execução, o contexto principal só **orquestra** — cada task vira um subagent isolado que implementa e é revisado. O grosso do trabalho (grep, leitura, edição, testes) acontece nos subagents, e os rulebooks são lidos **lá**, por caminho, não colados no seu chat.

---

## Exemplo de fluxo real

```text
você: /investigar vale a pena adicionar régua de cobrança pós-vencimento?

claude: Investigação: docs/analises/2026-09-10-investigacao-regua.md — recomendação: job diário
        + templates por faixa (quebra: relatório X e webhook Y) — PRD? [s/N]

você: s

claude: PRD: docs/prds/regua-pos-vencimento.md

você: /piloto --auto docs/prds/regua-pos-vencimento.md

claude: modo: auto
        Grelha fechada: 4 decisões (SUPOSIÇÃO)
        Prompt: docs/prompts/2026-09-10-regua.md — tipo regra-de-negocio+ui, domínios laravel+database; frontend
        Fase 1 — intake ok — branch feat/regua, models sonnet/opus/opus
        Fase 3 — 2 stories, 5 tasks — docs/superpowers/plans/2026-09-10-regua.md
        Fase 5 — task 1/5 ok — commits a1b2c3d..d4e5f6a
        ...
        Fase 6 — revisão: 2 achados (🔴 0) — docs/analises/2026-09-10-revisao-regua.md
        Fase 7 — entrega: testes 41/41 — docs/analises/2026-09-10-entrega-regua.md — aguardando opção de integração
        1. Merge em main  2. Push + PR  3. Manter a branch
```

---

## As 8 skills

- **`refinador-de-prompt`** — transforma ideia crua em prompt premium (tags XML) gravado em `docs/prompts/`. Usa a memória e um subagent Explore, classifica o **tipo de tarefa** (`regra-de-negocio` | `operacional` | `ui` — define a política de teste do executor) e os **domínios previstos**, pergunta só dúvidas **bloqueantes** (uma por vez), e fecha com um único gate (`ok` / ajuste). Etapa interna do `/piloto`; `/refinar` e `/refinar-auto` são aliases.

- **`investigador-de-ideia`** — modo discovery/discussão, **estritamente read-only** (só escreve em `docs/`; confere o caminho antes de qualquer Edit/Write). Enquadramento → investigação (Explore) → 3-5 abordagens → análise BMAD (analyst/pm) → **"O que quebra se mudar"** (dependentes, dados, testes, reversibilidade — medidos no código) → recomendação → opcional PRD. Saída em `docs/analises/`.

- **`executor-bmad-superpowers`** — orquestrador que **não implementa inline**. Modo `--auto`, `models.yml`, branch `feat/<slug>` se estava em main. Stories BMAD → `writing-plans` → roteamento por domínio e tipo por task → `subagent-driven-development` com personas **por caminho** → `revisor` como gate final condicional → `verification-before-completion` → entrega em `docs/analises/` → `finishing-a-development-branch`. Tabelas e templates em `referencia/` (roteamento, dispatch, persona-dev, entrega).

- **`revisor`** — code review + cobertura de testes + segurança em subagents read-only nomeados (`rev-<escopo>`; `general-purpose` ou o agente `reviewer`/`final_reviewer` do `models.yml`), cada um lendo por caminho o ponytail, os domínios detectados no diff e as lentes `review/seguranca.md` (só com superfície) e `review/cobertura-de-testes.md`; E2E com Playwright quando há UI sem teste. Relatório em `docs/analises/`. Modo standalone (`/revisar`, pergunta antes de corrigir) e modo gate (chamada pelo executor; 🔴 → um fix dispatch + uma re-review).

- **`grelhar`** — interrogatório implacável, **uma pergunta por vez no seletor interativo do CLI**, 2-4 opções com tradeoff e `(Recomendado)` na primeira. Busca **fatos** sozinha e pergunta só **decisões**. Roda na Etapa 1 do `/piloto`; em modo auto registra a recomendação como `SUPOSIÇÃO`. Adaptada de [mattpocock/skills](https://github.com/mattpocock/skills).

- **`wayfinder`** — pra trabalho grande demais pra uma sessão só. Cartografa um **mapa de decisões** em `docs/mapas/` e resolve **tickets** um a um, com "névoa de guerra" e fronteira. O `/investigar` e a grelha do `/piloto` encaminham pra cá. Planeja **decisões, não deliverables**. Adaptada de [mattpocock/skills](https://github.com/mattpocock/skills).

- **`handoff`** — compacta a conversa num **documento de continuação** pra outro agente/sessão. **Referencia** artefatos, **redige** segredos, sugere próximas skills. Adaptada de [mattpocock/skills](https://github.com/mattpocock/skills).

- **`memoria`** — inicia sob demanda a memória Mem0 nos projetos ativados, consulta o contexto e guarda pedidos explícitos no Qdrant. Veja [memória opcional](#memória-opcional-mem0).

---

## Memória (claude-mem)

Se você tem o **claude-mem** instalado, os comandos invocam `claude-mem:mem-search` (fallback `mem-search`) **como primeira ação** — antes de planejar qualquer coisa — e passam o resumo às skills. Isso traz pro contexto decisões anteriores, padrões já estabelecidos e bugs já resolvidos no mesmo domínio.

Sem claude-mem, as skills marcam "Memória: não disponível" e seguem normalmente.

---

## Memória opcional (Mem0)

O **claude-mem continua sendo o padrão**. O CBS também contém uma opção Mem0 por projeto, com seleção e confiança locais explícitas para sessões novas de Claude Code ou Codex. Cada sessão usa um provedor de memória; uma sessão Mem0 não consulta o claude-mem. A importação opcional do histórico claude-mem é manual e fica numa coleção separada, sem alimentar o recall automático.

Na curadoria por conversa, o extrator avalia cada lote de cinco trocas completas — uma fala humana e a resposta final visível da LLM — e pode selecionar zero ou várias decisões, regras, correções ou soluções duráveis. Referências verificáveis acompanham cada seleção; resumos brutos não são obrigatórios nem publicados, e respostas da LLM nunca são tratadas como fala humana, revisão humana ou fato verificado. `PreCompact` e `SessionEnd` fazem flush do lote restante com menos de cinco trocas. O `Interrupt` do Codex persiste progresso e solicita flush assíncrono. Após encerramento abrupto, lotes parciais persistidos são recuperados no próximo hook depois de 30 minutos de inatividade; uma fala humana sem resposta final permanece pendente. O teto de 100 chamadas e os contadores persistem ao reiniciar ou retomar a sessão.

Para configurar o cronograma pelo CLI, mantendo a adesão Mem0 e as identidades locais já configuradas:

```sh
cbs memoria extractor-schedule --mode conversation --turns 5 --max-calls 100
```

Em um projeto já configurado e ativado para Mem0, abra `claude` ou `codex` normalmente. A ativação registra o MCP `cbs_memoria` no perfil da CLI escolhida; `search`, `get`, `status` e `remember` aparecem no catálogo da **nova sessão**. Peça em linguagem natural para consultar a memória: `search` busca, `get` lê um resultado completo e `status` verifica a disponibilidade. Quando pedir expressamente “guarde isto na memória”, `remember` envia o conteúdo para gravação, sujeito ao proprietário, escritor, consentimento e projeto confiável já configurados. Não é necessário `cbs memoria launch`. O Claude Code usa `CLAUDE_CONFIG_DIR` quando definido; o Codex usa `CODEX_HOME` quando definido. Abra uma nova sessão após a ativação, atualização do CBS ou troca do provedor.

Execute a ativação na raiz Git para cada CLI que usará a memória. Ela registra Claude Code com escopo local por projeto e perfil; no Codex, registra um único servidor global por perfil, que usa a raiz da sessão atual. Para perfis adicionais, execute novamente com `CLAUDE_CONFIG_DIR` ou `CODEX_HOME` apropriado. Uma entrada `cbs_memoria` divergente bloqueia o registro sem sobrescrevê-la; a CLI informa a ação necessária. Os comandos `mcp get` ajudam a diagnosticar o registro:

```sh
cd /raiz/git
cbs memoria activate --cli claude --project /raiz/git
cbs memoria activate --cli codex --project /raiz/git
CLAUDE_CONFIG_DIR=/caminho/do/perfil cbs memoria activate --cli claude --project /raiz/git
CODEX_HOME=/caminho/do/perfil cbs memoria activate --cli codex --project /raiz/git
claude mcp get cbs_memoria
codex mcp get cbs_memoria --json
CLAUDE_CONFIG_DIR=/caminho/do/perfil claude mcp get cbs_memoria
CODEX_HOME=/caminho/do/perfil codex mcp get cbs_memoria --json
```

Os hooks nativos capturam a conversa e, quando a publicação automática é habilitada, enviam candidatos validados ao Qdrant pelo escritor local. Um pedido direto a `remember` usa o mesmo escritor autorizado e não espera o lote de cinco trocas nem chama Haiku. Aceita `text` e, opcionalmente, `type` (`rule`, `fact`, `decision`, `preference`), `scope` (`project` ou `personal`) e `condition`; condições e negações precisam permanecer no texto. Retorna `stored` somente após confirmação remota do Qdrant, ou `duplicate` com o ID existente quando o fato idêntico já foi gravado. Ausência de autorização ou falha retorna um estado tipado sem declarar sucesso. O pedido fica marcado como conteúdo fornecido pelo agente ao MCP, não como fala literal do usuário nem revisão humana. `status` distingue a configuração de escrita manual (`manualWriteConfigured`) da automática (`automaticWriteConfigured`); nenhum desses campos confirma que um pedido específico foi gravado.

O recall automático dos hooks e das skills usa apenas a **curadoria**; o MCP também atende a consultas explícitas, cuja busca padrão pode incluir histórico bruto importado do Claude-mem, identificado como legado não verificado. Use `source: "curated"` para limitar a consulta à curadoria ou `source: "legacy"` para consultar apenas o histórico antigo. Nenhum resultado legado entra no recall automático nem é promovido a memória revisada. Não há serviço no startup do PC: o worker local de busca inicia sob demanda e encerra após cinco minutos sem uso. O MCP de gravação vinculado ao `cbs memoria launch` permanece distinto.

Sem o MCP registrado no catálogo da sessão, uma pergunta genérica pode não consultar a memória; os hooks automáticos continuam independentes. Captura, extração por CLI, SDK Mem0 e embeddings E5 rodam no computador de quem desenvolve pela rota CPU; GPU não é requisito e ainda não foi validada. O servidor executa Qdrant autenticado e persistente. O instalador `base/memoria/deploy/install-qdrant.sh` configura o serviço privado; um gateway HTTPS público pode ser usado mediante escolha explícita por projeto.

Na configuração `.cbs/memoria.json`, o destino privado continua sendo o padrão. Para acesso direto pela Internet, defina `qdrant.allow_public: true`, `qdrant.address` com o IPv4 público fixo **real** do servidor e `qdrant.url` com o domínio HTTPS correspondente (por exemplo, `https://memoria.example.com:48677/`). O CBS exige certificado válido pela CA normal, nome TLS correspondente, conexão ao endereço fixado e ausência de redirecionamentos. Mudanças no modo público, endereço, URL ou coleção exigem nova ativação local antes de ler a chave ou acessar a rede. O IPv4 de exemplo da faixa `203.0.113.0/24` é reservado para documentação e será rejeitado pela validação.

A chave pode ser fornecida pela variável `CBS_MEMORIA_QDRANT_KEY` ou, em Linux, pelo arquivo `~/.config/cbs/memoria/qdrant-api-key`: diretórios `.config`, `cbs` e `memoria` pertencentes ao usuário e com permissão `0700`, arquivo pertencente ao usuário e com `0600`. A variável, quando definida, tem precedência. Guarde o segredo fora do Git. `cbs memoria activate --cli claude|codex --project /raiz/git` mostra projeto, destino e coleção para confirmação no terminal. Configuração nativa versionada exige a opção explícita `--allow-tracked-native`; o CBS preserva alterações locais e no índice do Git ao ativar ou reverter.

A extração oferece Sonnet e Haiku como opções explícitas. Na rota Haiku com modo de conversa, o modelo seleciona informações duráveis do lote e gera candidatos com referências às falas humanas e às respostas finais do assistente. O limite padrão é de 100 chamadas pagas por sessão e cinco candidatos por lote; cada `UserPromptSubmit` apenas captura, sem chamar o modelo. Configurações antigas podem manter seu limite até usar `extractor-schedule`. Sem publicação automática, o proprietário revisa no terminal antes do envio ao SDK com `infer=False`. Os resumos devem preservar negações e condições; as referências conservam o trecho original.

`cbs memoria help` lista as ações. `cbs memoria check --project /raiz/git` e `cbs memoria status --project /raiz/git --cli claude|codex` mostram o estado local. A publicação automática começa desligada por projeto. Para habilitá-la, o proprietário registra seus perfis (`owner-register`), seleciona Haiku (`extractor-select`), designa o dispositivo escritor (`writer-bootstrap`) e usa `auto-publish-enable` com o projeto, perfil e proprietário. Esses comandos exigem confirmação local e verificam a confiança do destino e a autoridade do escritor. Abra uma **nova sessão** da CLI para carregar o MCP e os hooks após a ativação. Uma sessão anterior com proprietário ou extrator vazios pode retomar a captura no próximo hook nativo válido, se o consentimento ainda estiver ativo. `auto-publish-disable` revoga a adesão.

Com a adesão ativa, os lotes completos ou o flush de encerramento acionam Haiku; o cliente aceita somente candidatos duráveis com referências verificáveis à conversa, rejeita segredos e conteúdo inadequado, verifica novamente o consentimento antes da gravação, gera embeddings locais e envia ao Qdrant. A validação automática fica identificada como tal e nunca conta como revisão humana. Fatos idênticos entre novos lotes são deduplicados; paráfrases equivalentes e memórias antigas sem chave de deduplicação podem gerar cópias. Falhas transitórias retomam a partir do checkpoint persistido sem nova extração; a retentativa sob demanda é limitada e a fila volta a ser examinada na sessão seguinte. A gravação automática continua independente de chamadas a `remember`.

No primeiro hook autorizado para uma sessão, o CBS marca o fim da transcrição já existente e começa a considerar somente mensagens posteriores. A mensagem que acionou esse primeiro hook também pode ficar antes do corte; envie a próxima mensagem para iniciar a captura nova. Os contadores de chamadas Haiku não são reiniciados: elevar o limite com `extractor-schedule` preserva as chamadas já consumidas.

Para importar o histórico gerado anteriormente pelo claude-mem, veja [o tutorial de importação e busca manual](docs/memoria/importar-claude-mem.md). A coleção histórica separada guarda registros brutos com origem identificada; não são memórias revisadas nem entram automaticamente no contexto das skills. A importação e a busca usam embeddings locais, sem reescrita por LLM. O importador usa checkpoint vinculado ao snapshot, destino e modelo, IDs estáveis por linha e trecho, e reconcilia pontos remotos na retomada. O recibo de reconciliação confirma a cobertura da importação; ele não comprova a qualidade do conteúdo legado.

Uma avaliação contextual pequena usou uma instrução humana real e uma nova tarefa em sessões nativas de Claude Code e Codex. Nos dois CLIs, a memória lembrou a restrição que os controles omitiram; os controles também permaneceram seguros. As quatro respostas não executaram ferramentas. A auditoria Astra validou esse benefício mínimo, limitado ao caso avaliado.

Um ensaio local isolado completou o ciclo automático em ambas as CLIs: hooks capturaram a fonte, o checkpoint acionou Haiku, a revisão no terminal gravou pelo SDK e uma sessão nova recuperou a memória. Outro ensaio validou correção de memória, indisponibilidade do Qdrant, interrupção de worker próprio e repetição do mesmo checkpoint; a recuperação retornou somente a versão ativa, sem perda ou duplicação no ensaio. A revisão desses ensaios foi automatizada para QA e não substitui o aceite humano do proprietário. O transporte HTTPS público do Qdrant também passou por teste remoto limitado de TLS, autenticação e operações SDK; essa prova não cobre o pipeline completo de memórias no servidor remoto.

**Experimental em Linux:** a rota de ativação em sessões normais de Claude Code e Codex passou a prova nativa limitada; os estados locais de confiança e propriedade continuam obrigatórios. Windows segue sem prova de release (`windows_release_unproved`) e será validado por outro responsável. Isso não representa aceite de qualidade geral: julgamento do proprietário, RF-19 completo e pipeline de memórias no Qdrant remoto permanecem pendentes. A operação entre duas máquinas foi adiada pelo proprietário para depois da implantação.

---

## BMAD + Superpowers: sempre juntos

BMAD e Superpowers **rodam sempre em conjunto**, em camadas — não são alternativas e não há flag pra desligar:

1. **Discovery** (`/investigar`) — perspectivas dos agentes `bmad-agent-analyst` (Mary) e `bmad-agent-pm` (John), simuladas em bullets.
2. **Execução** (`/executar`, `/piloto`) — BMAD gera as stories antes do plano, e a persona dev é lida por cada implementer do Superpowers.

### Como BMAD entra sem virar uma persona solta

Os agentes BMAD (`bmad-agent-dev`, `bmad-agent-pm`, …) **nunca são dispachados como tipo de subagent** — isso traria uma persona com agenda própria pra dentro da execução. **Todo subagent é `general-purpose` ou o agente do `models.yml` (`cbs-*`), sempre com `name`** (`<papel>-<escopo>`, ex.: `impl-t3`, `rev-t3` — o endereço pra `@nome`), e a disciplina chega por **caminho de arquivo**:

| Subagent (`general-purpose` ou agente do `models.yml`) | Lê por caminho |
|---|---|
| Implementer | `skills/executor-bmad-superpowers/referencia/persona-dev.md` (Amelia destilada: story como contrato, `[x]` por task, File List, Dev Agent Record, Ready for Review) → `ponytail.md` → domínios |
| Task reviewer / re-reviewer | `ponytail.md` → domínios → `review/seguranca.md` (quando backend) |
| Reviewer final | idem + `review/cobertura-de-testes.md` |
| Security | lente `review/seguranca.md` (o BMAD não tem agente de security) |

Skills BMAD 6.12 usadas no planejamento: `bmad-create-epics-and-stories` (stories, sempre), `bmad-spec` (quando há SPEC), `bmad-prd` (decisão de produto), `bmad-architecture` (arquitetura nova). O BMAD é **requisito** — sem ele instalado, o executor para e oferece `/instalar-bmad`.

Pra instalar no projeto:

```bash
cd meu-projeto
cbs instalar-bmad        # PT-BR, registra o projeto pro /atualizar
```

---

## Personas: domínios e lentes de review

**Onde mora:** `~/.claude/personas/` (base) e `~/.claude/cbs-overrides/personas/` (override do usuário — sobrescreve o base por arquivo; o `/atualizar` nunca toca). Os subagents leem **por caminho**; se um arquivo não existir, seguem sem ele e anotam no report.

```
~/.claude/personas/
├── ponytail.md                       transversal — todo subagent
├── dominios/
│   ├── frontend.md  (+ frontend-referencia.md, React e React Native)   área
│   ├── database.md                                área
│   ├── integracao.md                              área
│   ├── laravel.md                                 linguagem
│   ├── python.md                                  linguagem
│   └── node.md                                    linguagem
└── review/                           só reviewers
    ├── seguranca.md                  sempre que o domínio é backend
    └── cobertura-de-testes.md        reviewer final
```

### Roteamento (Fase 3 do executor)

Cada task do plano recebe a marcação `(domínio: <linguagem>+<área>; tipo: <tipo>; review: seguranca)` pela tabela sinais → domínio (`skills/executor-bmad-superpowers/referencia/roteamento.md`):

| Domínio | Sinais (resumo) |
|---|---|
| `frontend` | `*.blade.php`, `src/components/`, `*.tsx/.vue/.svelte`, `*.css`, `app/Livewire/**`, `react-native`/`expo` no `package.json`; tela, componente, layout, dashboard |
| `database` | `migrations/`, `prisma/`, `alembic/`, `*.sql`, models; tabela, índice, migration, query |
| `laravel` | `composer.json` com `laravel/framework` + `app/**`, `routes/**`; controller, job, policy, Eloquent |
| `python` | `pyproject.toml` / `requirements*.txt` + `*.py`; script, ETL, FastAPI/Django, pytest |
| `node` | `package.json` com `express`/`fastify`/`@nestjs/core`/`koa`/`hono` + servidor em `src/**`; endpoint, middleware, JWT, fila |
| `integracao` | `*Client*`, `*Webhook*`, `integrations/`, `config/services.php`, `*_API_KEY`; API externa, webhook, sync, OAuth |

Regras: **até 2 domínios por task** (uma linguagem + uma área; 3 = quebrar a task). **Ordem de leitura**: persona dev → ponytail → linguagem → área. **Precedência**: regra inegociável de área vence a de linguagem; ambas vencem o corte do ponytail. Sem sinal → só persona dev + ponytail. Lentes de review nunca entram no implementer. As tabelas completas ficam ao lado (`node-referencia.md`, `frontend-referencia.md`, `review/seguranca-referencia.md`) e são consultadas por caminho quando o rulebook manda.

`laravel.md`, `python.md`, `node.md` (com seção "Testes") e as seções React/React Native de `frontend-referencia.md` trazem regras duras adaptadas do ECC (MIT), cada uma com uma seção **"Build quebrado"** — lida pelo `cbs-build-fixer` quando uma task fica BLOCKED por build/typecheck.

**Gate de segurança**: a lente `seguranca` manda rodar `node ~/.claude/scripts/gate-seguranca.js` (gitleaks + semgrep com baseline + audit da stack + AgentShield; override em `~/.claude/cbs-overrides/scripts/`) antes de DONE em task backend; o executor roda de novo na Fase 7 antes do push e o `/revisar` em diff backend. Exit 1 bloqueia. **gitleaks ausente ou com erro reprova o gate** (mudança de comportamento — instale o binário); `.gitleaks.toml` ausente no HEAD não reprova, o gate usa as regras default do gitleaks. Achados históricos do gitleaks já revisados ficam fora do gate: lista opcional por projeto em `~/.claude/cbs-overrides/gate-achados-revisados.json`. Quando o diff (ou o working tree) toca config de agente — `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json` ou `hooks.json` em qualquer profundidade, ou `hooks/` só na raiz do repo (um `src/hooks/` de React não dispara) —, o gate roda o **AgentShield** em modo estático (nunca `--opus`); achado alto ou crítico reprova, sem supressão (corrija a config ou aceite o REPROVADO conscientemente); ausente ou com erro vira gate parcial. Demais ferramentas ausentes viram "gate parcial" no report, nunca aprovação silenciosa.

### TDD por tipo de tarefa

O refinador classifica a tarefa e o executor aplica:

| `tipo` | Política |
|---|---|
| `regra-de-negocio` | TDD estrito: RED → GREEN com evidência no report |
| `operacional` (script, ETL, relatório, job) | validação E2E contra dado real/fixture no lugar do RED-GREEN |
| `ui` | validação no browser com Playwright (screenshots golden path + 2 estados + mobile); teste unitário só pra lógica extraída |

### Customizar pro seu projeto

Quer endurecer regras (bloquear shadcn novo, exigir ícones lucide, exigir o design system X)? Crie o mesmo caminho relativo em `cbs-overrides`:

```bash
mkdir -p ~/.claude/cbs-overrides/personas/dominios
cp ~/.claude/personas/dominios/frontend.md ~/.claude/cbs-overrides/personas/dominios/frontend.md
# edita, adiciona suas regras — sobrevive ao /atualizar
```

Mesma mecânica pra `review/<lente>.md` e `ponytail.md`.

---

## Ponytail: menos código, mesma segurança

Enquanto os rulebooks de domínio são **por-task**, o **ponytail é transversal** — lido por **todo** subagent implementer e reviewer, em qualquer task. Ele importa a filosofia [ponytail](https://github.com/DietrichGebert/ponytail) ("lazy senior developer") pra dentro da execução: entender o problema por completo e **depois** escrever o mínimo que resolve.

**A escada de decisão** (antes de criar qualquer código novo, pare no primeiro "sim"):

1. Isso precisa existir?
2. Já está no codebase (dá pra reusar)?
3. A stdlib/linguagem resolve?
4. É feature nativa da plataforma/framework?
5. Uma dependência **já instalada** resolve?
6. Dá em uma linha?
7. Só então — construa o mínimo.

**Piso de segurança (inegociável):** ponytail corta *código desnecessário*, jamais qualidade. Validação de input, tratamento de erro, segurança, acessibilidade e testes **nunca** entram no corte.

**Níveis:** `lite` · `full` (padrão) · `ultra` · `off` (desliga o corte, mas o piso de segurança continua). Peça outro nível explicitamente se quiser.

**Onde mora:** `~/.claude/personas/ponytail.md` (base); override em `~/.claude/cbs-overrides/personas/ponytail.md`.

### Orquestração: teammate e ultracode

O motor da execução é sempre o `superpowers:subagent-driven-development`. Escalonamentos (sem trocar o motor): **teammate** — subagent persistente e endereçável (`SendMessage`), bom pra um consultor/reviewer que acompanha várias tasks; **ultracode** (Workflow) — fan-out multi-agente determinístico com verificação, pra N tasks independentes (requer opt-in explícito). Gates, personas por caminho e `models.yml` valem em qualquer caminho.

---

## Hooks globais

4 hooks em `~/.claude/hooks/cbs-*.mjs` (ESM pela extensão, sem dependências, sem `npx`), Claude Code **e** Codex, ligados por padrão via merge idempotente no `settings.json` (backup automático; hooks e chaves de outras ferramentas nunca são tocados). Não há `package.json` em `~/.claude/hooks`: hooks `.js` CommonJS seus ali continuam funcionando.

| Hook | Evento / matcher | O que faz |
|---|---|---|
| `cbs-format.mjs` | PostToolUse `Edit\|Write\|MultiEdit` | Formata só o arquivo editado com pint, `ruff format`, biome ou prettier **do projeto** (binário + config locais); em silêncio quando não há ferramenta |
| `cbs-no-verify.mjs` | PreToolUse `Bash` | Bloqueia `--no-verify`, `-n`/`--no-verify` em commit/am, `-c core.hooksPath=…` em commit/push/merge/rebase/am/cherry-pick; fail-closed (texto ambíguo bloqueia); não bloqueia os casos comuns de string, echo, `grep`/`gh` ou mensagem de commit |
| `cbs-config-protect.mjs` | PreToolUse `Edit\|Write\|MultiEdit` | Bloqueia qualquer mudança em config existente de lint/format/typecheck (ESLint, Prettier, Biome, Pint, PHPStan, PHP-CS-Fixer, Ruff, mypy, Stylelint, `[tool.ruff]`/`[tool.mypy]` do `pyproject.toml`); análise que falha ou passa de 3 s bloqueia; criar config nova é permitido |
| `cbs-typecheck.mjs` | Stop | Roda tsc/phpstan/mypy\|pyright só nas stacks tocadas na sessão; bloqueia o fim do turno **uma vez** com o resumo dos erros; teto de 60 s; nunca escreve buildinfo/cache no repo do usuário |

Env: `CBS_HOOKS=off` desliga todos; `CBS_HOOKS_DESLIGADOS=format,typecheck,no-verify,config` desliga os escolhidos; `CBS_PERMITIR_CONFIG=1` é o escape pontual do `cbs-config-protect`. Rodam via um launcher POSIX (`~/.claude/hooks/cbs-node.sh`) que acha um `node` válido mesmo depois de troca de versão no nvm/fnm/volta; launcher ou script ausente nunca bloqueia a sessão (o hook vira no-op). `format` e `typecheck` só rodam binário que outro usuário local não consegue plantar (dono = você ou root; diretórios não graváveis por outros).

`cbs instalar --sem-hooks` / `cbs atualizar --sem-hooks` copia os arquivos mas não registra os hooks no `settings.json`. **Não é persistente**: o próximo `cbs atualizar` (ou `/atualizar`) sem a flag registra de novo — pra manter desligado, exporte `CBS_HOOKS=off`. `cbs status` lista os hooks CBS ativos; `cbs remover` tira só as entradas CBS do `settings.json`. `atualizar` e `remover` também limpam o legado das builds de desenvolvimento 0.13-dev: entradas `cbs-*.js` no `settings.json`, os `cbs-*.js` com marcador e o `~/.claude/hooks/package.json` só quando é byte a byte o da dev (`{ "type": "module" }`).

**Codex:** os mesmos 4 hooks chegam pelo plugin (`codex-hooks.json`: no-verify em `Bash`, config-protect em `Bash|apply_patch`, format em `apply_patch`, typecheck no Stop) e exigem o CBS instalado em `~/.claude`. Precisam estar marcados como confiáveis no Codex; sem isso ficam inertes, sem aviso.

**Windows:** exige Git Bash (`sh`) — os hooks não têm caminho nativo `.cmd`/PowerShell. Latência medida < 100 ms no caminho vazio (sem match).

### Limitações conhecidas

- **Codex, `apply_patch` rodado pelo shell** (chega ao hook como `Bash`): só o `cbs-config-protect` cobre essa rota — o Codex não dispara PostToolUse ali, então format e typecheck não veem essas edições. Como o Codex não informa o diretório, config protegida ou `pyproject.toml` em caminho **relativo** é bloqueada pelo nome, mesmo sem afrouxar nada (escape `CBS_PERMITIR_CONFIG=1`, ou use a ferramenta `apply_patch`). Patch fora do texto do comando (`apply_patch < arquivo.patch`) não é inspecionável e passa. O hook roda com `$SHELL -c`: validado com sh, bash e zsh; fish e nushell não verificados.
- **Diretório não confiável = no-op silencioso** de format e typecheck: root num container sobre bind mount de outro dono, WSL em `/mnt/c` (777) e diretórios 777 (ex.: `storage/` do Laravel). No Windows os dois também ficam em silêncio (shims `.cmd` não são resolvidos).
- **Falsos positivos** (fail-closed de propósito):
  - `cbs-no-verify`: `git commit -- --no-verify` e `git log --grep "--no-verify"` (o marcador aparece na mesma invocação git), `git -c core.hooksPath=… log`, `xargs -n1 git commit` — escape `CBS_HOOKS_DESLIGADOS=no-verify`. Passam sem bloqueio: flags fora da invocação git (`pgrep -f "git commit"`, `find -name`, `echo -ne`, `nice -n`), `-n` fora de commit/am (`cherry-pick -n`) e heredoc cujo corpo cita `--no-verify` (corpo é dado). Fora do alcance: `git pull --no-verify`, `--config-env`/`GIT_CONFIG_*`/`git config core.hooksPath`, `HUSKY=0`, alias (`git ci -n`).
  - `cbs-config-protect`: comentário ou espaço mudado dentro de `[tool.ruff]`/`[tool.mypy]`; comando Bash que só cita um cabeçalho de patch com nome protegido (heredoc gravando um `.patch`, mensagem de commit); patch que o hook não consegue aplicar igual ao Codex — escape `CBS_PERMITIR_CONFIG=1`.
- **`cbs-typecheck`**: phpstan e mypy recebem os arquivos tocados na linha de comando, o que sobrepõe `paths` do `phpstan.neon` e `files` do mypy; `CLAUDE_PROJECT_DIR` velho ou inexistente → nada é checado; `tsc` içado na raiz de um monorepo → sem checagem.
- Pré-existente (desde a 0.12): `~/.claude/scripts/package.json` (`{ "type": "module" }`) faz `.js` CommonJS seus em `~/.claude/scripts/` falharem no load; o `atualizar` o preserva e o `remover` não o apaga.

## CLI de referência

```bash
cbs instalar         # tudo: skills + comandos + personas + models.yml + Superpowers + BMAD (no cwd)
cbs instalar-bmad    # só BMAD no diretório atual (interativo, PT-BR) + registra
cbs atualizar        # self-update + skills/comandos/personas + Superpowers + BMAD dos projetos
cbs remover          # desinstala skills/comandos (preserva cbs-overrides/)
cbs status           # versões (pacote, Superpowers, BMAD por projeto), skills/comandos, personas
```

**Flags do `atualizar`:**

| Flag | Efeito |
|---|---|
| `--skip-self-update` | Não tenta atualizar o próprio pacote (git pull / npx @latest) |
| `--skip-bmad` | Não mexe no BMAD dos projetos registrados |
| `--auto-bmad` / `-y` | Atualiza BMAD em todos os projetos sem perguntar (padrão quando não há TTY) |
| `--sem-hooks` | Não registra os hooks CBS no `settings.json` nesta execução (o próximo `atualizar` sem a flag registra de novo) |

O `atualizar` detecta como o pacote foi instalado (clone git ou npm) e se atualiza sozinho; depois reescreve só a camada base, **preservando suas customizações** (veja abaixo).

---

## Customização que sobrevive a updates

Modelo de **camadas**: o pacote escreve arquivos com um marcador no rodapé; o `atualizar` só sobrescreve esses. Suas edições ficam separadas e nunca são tocadas.

```
~/.claude/
├── skills/refinador-de-prompt/SKILL.md   ← base (atualizado pelo `atualizar`)
├── commands/refinar.md                    ← base (atualizado pelo `atualizar`)
├── personas/dominios/laravel.md           ← base
└── cbs-overrides/                         ← SEU, nunca tocado pelo update
    ├── models.yml                         ← modelo por papel
    ├── skills/<nome>/SKILL.md             ← sua versão custom
    ├── commands/<nome>.md                 ← sua versão custom
    └── personas/{ponytail.md,dominios/*.md,review/*.md}
```

Quer alterar um comando ou persona sem perder no update? Crie a versão custom em `~/.claude/cbs-overrides/`.

---

## Desinstalar

```bash
cbs remover          # remove skills/comandos/hooks do pacote e as entradas CBS do settings.json; preserva cbs-overrides/
```

Não desinstala o Superpowers nem o BMAD — a saída mostra os comandos pra isso (`/plugin uninstall superpowers@superpowers-marketplace`, `npx bmad-method uninstall`).

---

## Troubleshooting

| Sintoma | Solução |
|---|---|
| `comando claude não encontrado` | Claude Code não está no PATH. A CLI imprime as instruções pra instalar o Superpowers manualmente dentro do app. |
| Superpowers não instalou | Dentro do Claude Code: `/plugin marketplace add obra/superpowers-marketplace` e `/plugin install superpowers@superpowers-marketplace` |
| Executor descreve reviewers que não existem | Superpowers < 6.3. Atualize o plugin: o executor segue o contrato 6.3 (task reviewer único, briefs em `.superpowers/sdd/`). |
| `bmad-prd` / `bmad-create-epics-and-stories` não existem | BMAD < 6.12. Rode `cbs atualizar --auto-bmad` ou `cbs instalar-bmad --force`. |
| `/piloto` fica esperando resposta num script/cron | Use `--auto` ou exporte `CLAUDE_AUTONOMOUS=1`; sem `AskUserQuestion` o modo auto também é detectado. |
| Subagents rodando no modelo errado | Edite `~/.claude/cbs-overrides/models.yml` ou passe `models=...` / `modelo=...` no comando. Agente nomeado que não existe em `~/.claude/agents` cai no modelo default (a entrega anota `agente ausente`). |
| Lente `review/seguranca.md` ausente | Instalação anterior ao 0.12.0: rode `cbs atualizar`. Enquanto isso o reviewer usa o checklist de fallback de `referencia/roteamento.md` e marca 🟡. |
| Quero reinstalar do zero | `cbs remover && cbs instalar` (suas customizações em `cbs-overrides/` sobrevivem) |

Mais detalhes em [INSTALL.md](INSTALL.md).

---

## Contribuir

Issues e PRs bem-vindos. Foco: conteúdo das skills e personas, novas integrações, exemplos.

## Licença

MIT — veja [LICENSE](LICENSE).

## Créditos

- [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) — BMad Code
- [Superpowers](https://github.com/obra/superpowers) — Jesse Vincent (obra)
- [Claude Code](https://claude.com/claude-code) — Anthropic
- [ECC](https://github.com/affaan-m/ECC) — Affaan Mustafa (MIT): hooks, regras de persona e casos de teste portados do commit `e482e57`
