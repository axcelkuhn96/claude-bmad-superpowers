# claude-bmad-superpowers

> Workflow PT-BR para [Claude Code](https://claude.com/claude-code): **refina sua ideia com a memória do projeto e entrega pra uma execução de qualidade** — TDD real, subagents isolados, um task reviewer por task e review final da branch.

Um pacote de **8 skills** e **13 comandos** em português que amarram cinco camadas, cada uma no seu nível:

| Camada | Quem faz | Papel |
|---|---|---|
| **Front-end PT-BR** (o diferencial) | skills deste pacote | Grelha e refina sua ideia com memória, faz discovery sem tocar código, roteia personas por domínio, controla gates e modelo por papel |
| **Motor de execução** | [Superpowers ≥ 7.0](https://github.com/obra/superpowers) | brainstorming → plano → subagent-driven-development (implementer → task reviewer → re-reviewer → reviewer final) → finishing-a-development-branch |
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
- **Superpowers ≥ 7.0** (plugin; o instalador mostra o comando) — o executor usa o contrato do `subagent-driven-development` 7.0 (task reviewer único, ledger/briefs/reports em `.superpowers/sdd/<plano>/`, `finishing-a-development-branch`)
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
| Dúvida, suspeita de problema ou ideia a investigar | `/investigar <tema>` | Busca evidência no ambiente pertinente, distingue fato de hipótese e pode concluir que não há defeito. Read-only; relatório em `docs/analises/` só quando útil ou solicitado. |
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
| Brainstorming 7.0 de ideia ainda não refinada | — (gate 1 refina) | — | aprova descrição antes do plano | decisões registradas |
| Menus operacionais do BMAD | o executor responde | o executor responde | o executor responde | o executor responde |
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
/investigar  →  investigação read-only
                memória pertinente → evidência no ambiente adequado →
                confirmado / hipótese / não verificado → limites da conclusão →
                pergunta se quer sugestão de correção, quando cabível

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
você: /investigar a cobrança pós-vencimento está falhando em produção?

claude: Não encontrei falha nos eventos consultados em produção entre 9h e 10h;
        o caso do cliente citado ainda não foi verificado. Quer que eu investigue esse caso?

você: sim, e sugira uma correção se confirmar a falha

claude: Falha confirmada no caso citado: [evidência]. A causa provável é [hipótese];
        sugiro [correção], sujeita à verificação [pendente].

você: /refinar essa correção

claude: Prompt: docs/prompts/2026-09-10-regua.md

```

---

## As 8 skills

- **`refinador-de-prompt`** — transforma ideia crua em prompt premium (tags XML) gravado em `docs/prompts/`. Usa a memória e um subagent Explore, classifica o **tipo de tarefa** (`regra-de-negocio` | `operacional` | `ui` — define a política de teste do executor) e os **domínios previstos**, pergunta só dúvidas **bloqueantes** (uma por vez), e fecha com um único gate (`ok` / ajuste). Etapa interna do `/piloto`; `/refinar` e `/refinar-auto` são aliases.

- **`investigador-de-ideia`** — investiga dúvidas, suspeitas e ideias com evidência do ambiente pertinente. Classifica confirmado, hipótese e não verificado, inclusive quando não encontra defeito. Read-only para código, dados e produção; relatório em `docs/analises/` só quando útil ou solicitado.

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

A memória fica no Qdrant central, que pode atender diferentes projetos e usuários. Memórias de escopo `project` são compartilhadas no respectivo projeto; as de escopo `personal` são filtradas pelo proprietário configurado. Cada projeto mantém sua coleção e seu contexto nas consultas.

Na curadoria por conversa, o extrator avalia cada lote de cinco trocas completas — uma fala humana e a resposta final visível da LLM — e pode selecionar zero ou várias decisões, regras, correções ou soluções duráveis. Referências verificáveis acompanham cada seleção; resumos brutos não são obrigatórios nem publicados, e respostas da LLM nunca são tratadas como fala humana, revisão humana ou fato verificado. `PreCompact` e `SessionEnd` fazem flush do lote restante com menos de cinco trocas. O `Interrupt` do Codex persiste progresso e solicita flush assíncrono. Após encerramento abrupto, lotes parciais persistidos são recuperados no próximo hook depois de 30 minutos de inatividade; uma fala humana sem resposta final permanece pendente. Na publicação automática por conversa, o teto padrão é de 100 chamadas por sessão/dia UTC; o consumo da janela e o total histórico persistem ao reiniciar ou retomar a sessão.

Para configurar o cronograma pelo CLI, mantendo a adesão Mem0 e as identidades locais já configuradas:

```sh
cbs memoria extractor-schedule --mode conversation --turns 5 --max-calls 100
```

Em um projeto já configurado e ativado para Mem0, abra `claude` ou `codex` normalmente. A ativação registra o MCP `cbs_memoria` no perfil da CLI escolhida; `search`, `get`, `status` e `remember` aparecem no catálogo da **nova sessão**. Peça em linguagem natural para consultar a memória: `search` busca, `get` lê um resultado completo e `status` verifica a disponibilidade. Quando pedir expressamente “guarde isto na memória”, `remember` envia o conteúdo para gravação, sujeito ao proprietário, escritor, consentimento e projeto confiável já configurados. Com esses requisitos válidos, a escrita manual fica disponível nos projetos Mem0 conhecidos mesmo se o executável de extração tiver sido removido por uma atualização do Claude Code. Não é necessário `cbs memoria launch`, reconfigurar o extrator ou reiniciar a CLI por causa dessa remoção. O Claude Code usa `CLAUDE_CONFIG_DIR` quando definido; o Codex usa `CODEX_HOME` quando definido. Abra uma nova sessão após a ativação do MCP ou troca do provedor.

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

Os hooks nativos capturam a conversa e, quando a publicação automática é habilitada, enviam candidatos validados ao Qdrant pelo escritor local. Um pedido direto a `remember` usa o mesmo escritor autorizado e o consentimento de publicação automática válido; não espera o lote de cinco trocas nem chama Haiku. Aceita `text` e, opcionalmente, `type` (`rule`, `fact`, `decision`, `preference`), `scope` (`project` ou `personal`) e `condition`; condições e negações precisam permanecer no texto. Retorna `stored` somente após confirmação remota do Qdrant, ou `duplicate` com o ID existente quando o fato idêntico já foi gravado. Ausência de autorização ou falha retorna um estado tipado sem declarar sucesso. O pedido fica marcado como conteúdo fornecido pelo agente ao MCP, não como fala literal do usuário nem revisão humana. Chamadas simultâneas ao serviço local aguardam em uma fila limitada, respeitando o prazo da própria operação. Se a confirmação falhar após a gravação, repetir o mesmo pedido permite reconciliar a identidade existente. `status` distingue a configuração de escrita manual (`manualWriteConfigured`) da automática (`automaticWriteConfigured`); nenhum desses campos confirma que um pedido específico foi gravado.

O recall automático dos hooks e das skills usa apenas a **curadoria**; o MCP também atende a consultas explícitas, cuja busca padrão pode incluir histórico bruto importado do Claude-mem, identificado como legado não verificado. Use `source: "curated"` para limitar a consulta à curadoria ou `source: "legacy"` para consultar apenas o histórico antigo. Nenhum resultado legado entra no recall automático nem é promovido a memória revisada. Não há serviço no startup do PC: no Linux, MCP e hooks compartilham o mesmo broker e encoder local, iniciados sob demanda e encerrados após cinco minutos sem uso. O MCP de gravação vinculado ao `cbs memoria launch` permanece distinto.

Sem o MCP registrado no catálogo da sessão, uma pergunta genérica pode não consultar a memória; os hooks automáticos continuam independentes. Captura, extração por CLI, SDK Mem0 e embeddings E5 rodam no computador de quem desenvolve. O instalador seleciona CUDA no Linux com NVIDIA detectada, DirectML no Windows compatível ou CPU; falhas de instalação ou inicialização da GPU retornam à CPU. `CBS_MEMORIA_EMBEDDING_DEVICE=auto|cpu|cuda|directml` controla a preferência, e `runtime-selection.json` no estado local registra a variante instalada e o motivo de eventual fallback. A rota Windows ainda não tem validação física de release. O servidor executa Qdrant autenticado e persistente. O instalador `base/memoria/deploy/install-qdrant.sh` configura o serviço privado; um gateway HTTPS público pode ser usado mediante escolha explícita por projeto.

Na configuração `.cbs/memoria.json`, o destino privado continua sendo o padrão. Para acesso direto pela Internet, defina `qdrant.allow_public: true`, `qdrant.address` com o IPv4 público fixo **real** do servidor e `qdrant.url` com o domínio HTTPS correspondente (por exemplo, `https://memoria.example.com:48677/`). O CBS exige certificado válido pela CA normal, nome TLS correspondente, conexão ao endereço fixado e ausência de redirecionamentos. Mudanças no modo público, endereço, URL ou coleção exigem nova ativação local antes de ler a chave ou acessar a rede. O IPv4 de exemplo da faixa `203.0.113.0/24` é reservado para documentação e será rejeitado pela validação.

A chave pode ser fornecida pela variável `CBS_MEMORIA_QDRANT_KEY` ou, em Linux, pelo arquivo `~/.config/cbs/memoria/qdrant-api-key`: diretórios `.config`, `cbs` e `memoria` pertencentes ao usuário e com permissão `0700`, arquivo pertencente ao usuário e com `0600`. A variável, quando definida, tem precedência. Guarde o segredo fora do Git. `cbs memoria activate --cli claude|codex --project /raiz/git` mostra projeto, destino e coleção para confirmação no terminal. Configuração nativa versionada exige a opção explícita `--allow-tracked-native`; o CBS preserva alterações locais e no índice do Git ao ativar ou reverter.

A extração oferece Sonnet e Haiku como opções explícitas. Na rota Haiku com modo de conversa, o modelo seleciona informações duráveis do lote e gera candidatos com referências às falas humanas e às respostas finais do assistente. O limite padrão é de 100 chamadas pagas por sessão e cinco candidatos por lote; cada `UserPromptSubmit` apenas captura, sem chamar o modelo. Configurações antigas podem manter seu limite até usar `extractor-schedule`. Sem publicação automática, o proprietário revisa no terminal antes do envio ao SDK com `infer=False`. Os resumos devem preservar negações e condições; as referências conservam o trecho original.

`cbs memoria help` lista as ações. `cbs memoria check --project /raiz/git` e `cbs memoria status --project /raiz/git --cli claude|codex` mostram o estado local. A publicação automática começa desligada por projeto. Para habilitá-la, o proprietário registra seus perfis (`owner-register`), seleciona Haiku (`extractor-select`), designa o dispositivo escritor (`writer-bootstrap`) e usa `auto-publish-enable` com o projeto, perfil e proprietário. Esses comandos exigem confirmação local e verificam a confiança do destino e a autoridade do escritor. Abra uma **nova sessão** da CLI para carregar o MCP e os hooks após a ativação. Uma sessão anterior com proprietário ou extrator vazios pode retomar a captura no próximo hook nativo válido, se o consentimento ainda estiver ativo. `auto-publish-disable` revoga a adesão.

Com a adesão ativa, os lotes completos ou o flush de encerramento acionam Haiku; se uma atualização oficial do Claude Code removeu o executável selecionado, a extração pode resolver a versão atual na mesma instalação e perfil, inclusive para lotes de sessões já iniciadas. O cliente aceita somente candidatos duráveis com referências verificáveis à conversa, rejeita segredos e conteúdo inadequado, verifica novamente o consentimento antes da gravação, gera embeddings locais e envia ao Qdrant. A validação automática fica identificada como tal e nunca conta como revisão humana. Fatos idênticos entre novos lotes são deduplicados; paráfrases equivalentes e memórias antigas sem chave de deduplicação podem gerar cópias. Falhas transitórias retomam a partir do checkpoint persistido sem nova extração; a retentativa sob demanda é limitada e a fila volta a ser examinada na sessão seguinte. A gravação automática continua independente de chamadas a `remember`.

No primeiro hook autorizado para uma sessão, o CBS marca o fim da transcrição já existente e começa a considerar somente mensagens posteriores. A mensagem que acionou esse primeiro hook também pode ficar antes do corte; envie a próxima mensagem para iniciar a captura nova. Na publicação automática por conversa, `--max-calls` limita as chamadas por sessão e dia UTC. O contador histórico nunca é reiniciado; o consumo diário é persistido e renovado na mudança de dia UTC. Ao atingir o limite, a fila é adiada e reavaliada no próximo gatilho elegível (checkpoint completo, início de sessão, compactação ou encerramento), sem novo serviço no startup do PC. Consumo legado sem data comprovada é carregado para o dia da migração; elevar o limite com `extractor-schedule` preserva esse consumo. Erros de formato ou de prova da fonte ficam retidos para diagnóstico, sem retentativas pagas automáticas. Extração fora desse modo mantém o limite acumulado da sessão.

No Linux, o serviço local protege a exclusividade do encoder durante toda a vida do worker e pode reconciliar as novas guardas após uma queda. Uma guarda legada ou malformada permanece bloqueada até diagnóstico seguro; o protocolo Windows não foi alterado por essa correção.

Para importar o histórico gerado anteriormente pelo claude-mem, veja [o tutorial de importação e busca manual](docs/memoria/importar-claude-mem.md). A coleção histórica separada guarda registros brutos com origem identificada; não são memórias revisadas nem entram automaticamente no contexto das skills. A importação e a busca usam embeddings locais, sem reescrita por LLM. O importador usa checkpoint vinculado ao snapshot, destino e modelo, IDs estáveis por linha e trecho, e reconcilia pontos remotos na retomada. O recibo de reconciliação confirma a cobertura da importação; ele não comprova a qualidade do conteúdo legado.

Uma avaliação contextual pequena usou uma instrução humana real e uma nova tarefa em sessões nativas de Claude Code e Codex. Nos dois CLIs, a memória lembrou a restrição que os controles omitiram; os controles também permaneceram seguros. As quatro respostas não executaram ferramentas. A auditoria Astra validou esse benefício mínimo, limitado ao caso avaliado.

### Avaliação offline da curadoria

O corpus versionado em `base/memoria/evals/curation-v1.json` contém onze casos de conversa, memória anterior e decisão esperada (`keep`, `omit` ou `correct`), incluindo três casos `holdout` e controles de preferência pessoal e de atribuição a terceiros. Para avaliar saídas já capturadas de um extrator, crie um JSON com o mesmo `case_id` e a saída candidata. Exemplo mínimo de abstenção:

```json
{"version":1,"results":[{"case_id":"mizu-transient-cbs-status","output":{"no_facts":true,"candidates":[]}}]}
```

```sh
cbs memoria avaliar --outputs /caminho/resultados.json --split dev
cbs memoria avaliar --corpus /caminho/corpus.json --outputs /caminho/resultados.json --split holdout
```

O relatório JSON mede cobertura e checagens determinísticas de contrato, referências à conversa, segredo, estado temporário e duplicata exata. Tentativas, tokens, latência e custo só são computados quando informados no arquivo de saídas. Para métricas semânticas de falso salvamento, omissão, correção, escopo e tipo, cada candidato precisa de adjudicação declarada `fixture` ou `human` com justificativa; o CBS não verifica quem a declarou. Sem ela, `semantic.status` é `unmeasured`. O comando é offline e não chama Haiku, embedding, broker ou Qdrant. Esse ensaio avalia **candidatos fornecidos**, não memória realmente gravada; o corpus publicado não prova independência estatística nem qualidade geral do modelo.

### Em desenvolvimento: qualidade e continuidade da memória (Unreleased)

Esta seção descreve o conjunto em desenvolvimento nesta branch, ainda não publicado. Usuários da versão 0.15.10 continuam com o comportamento da versão instalada; a aceitação e a publicação dependem dos gates de avaliação. Em um projeto Mem0 já ativado, com destino Qdrant e confiança local válidos:

- **Busca por identificadores exatos:** um administrador pode criar o índice textual nativo do Qdrant no campo `data` da coleção existente com `cbs memoria indexar-texto --project /raiz/git`. A operação acessa o Qdrant e fica fora da rota de recall do hook. A busca preserva a ordem dos resultados vetoriais elegíveis; só acrescenta ao fim resultados lexicais distintos com correspondência literal de identificadores técnicos ASCII, até 20 resultados. O recall automático continua limitado a 500 bytes. Não há BM25, índice sparse, serviço novo, reextração de lotes antigos ou mudança do E5, do fingerprint e da dimensão 384; o fallback GPU/CPU existente continua igual. Termos comuns e nomes sem identificador verificável podem não ser resgatados nem aparecer primeiro.
- **Contexto causal opcional:** a mesma chamada de extração Haiku pode anexar ao candidato até quatro resumos de 256 bytes, nas categorias `problem`, `reason`, `attempt` e `pending`, ligados às referências da fonte e marcados `generated_unverified`. O recall só mostra esse contexto quando cabe no orçamento e preserva a atribuição; ele não vira prova humana, fato independente ou instrução. Não há chamada adicional ao modelo por prompt, mas a saída de extração pode consumir tokens adicionais. As políticas seladas v4, a deduplicação e os ACKs anteriores continuam aplicáveis.
- **Avaliação reproduzível:** `cbs memoria avaliar --corpus /caminho/corpus-v2.json --retrieval /caminho/candidatos-congelados.json --split dev --adjudication /caminho/rotulos-privados.json --identities /caminho/identidades-privadas.json --observations /caminho/observacoes-privadas.json` compara rankings vetorial e combinado em replay offline. Corpus real congelado e fixture sintética são avaliados separadamente; rótulos, identidades e observações independentes ficam em arquivos privados vinculados por hashes. O replay compara candidatos já coletados, não executa uma transação pareada ao vivo no Qdrant nem confirma a verdade atual de cada fato. Métricas sem dados permanecem `unmeasured`.
- **Exportação Markdown privada:** `cbs memoria exportar --project /raiz/git --output /diretorio/privado` cria um snapshot derivado OKF v0.2 em `versions/<UUID>/`, com `index.md`, um Markdown por memória elegível, `history.json` e manifesto. O JSON devolvido traz `bundleDir`; use esse caminho em `cbs memoria historico --project /raiz/git --id <UUID> --snapshot <bundleDir>`. O ponteiro `current.json` só troca depois de uma paginação completa (até 64 itens e 4 MiB por página, 10.000 itens no total); uma falha mantém o bundle anterior. O escopo é o projeto e, quando a identidade nativa do proprietário é inequívoca, também o owner. Dois perfis nativos vinculados ao mesmo owner mantêm o escopo pessoal; se a identidade faltar ou apontar owners diferentes, o resultado pode ser `project_only`. `--profile` não escolhe a memória pessoal de outra pessoa. Inclui memórias elegíveis ativas, substituídas e expiradas com os vínculos disponíveis; não exporta pendências, legado bruto, metadados brutos alheios ou trechos de origem. O histórico valida primeiro o snapshot local e só então tenta conferir atualidade remota: sem acesso remoto, `freshness_unverified`; com divergência, `stale`. Vínculos ausentes continuam indicados como incompletos. Arquivos derivados são privados e podem exigir retenção ou limpeza manual; não são commitados, enviados ao Git ou reimportados como autoridade automaticamente. O Qdrant continua sendo a fonte da curadoria.
- **Continuidade curta entre sessões:** após captura nativa validada, Claude Code ou Codex pode receber no `SessionStart` seguinte do mesmo projeto, owner, raiz, worktree e branch um resumo de até 300 bytes com link para um Markdown privado. O documento usa os oito títulos do `/handoff`, sem executar essa skill interativa nem chamar outra LLM. O estado por sessão expira após sete dias e usa diretório `0700` e arquivos `0600`; só excertos curtos de objetivo/status aceitos por filtros estritos entram, rotulados como histórico não confiável; texto incerto deixa apenas referências operacionais. Um commit descendente na mesma branch é aceito; troca de branch, rebase, identidade incerta, outra sessão ativa ou empate provocam abstenção. A seleção usa a sessão encerrada mais recente ou uma inativa há pelo menos cinco minutos. `SessionEnd` e, no Codex, `Interrupt` ajudam quando o evento nativo chega; o último checkpoint válido permite fallback após interrupção sem evento, sem garantia de que Ctrl-C dispare um hook. Um evento terminal remove o cache de excertos, mas o Markdown já entregue permanece privado até expirar; a limpeza de arquivos expirados é oportunista no próximo início de sessão. Um caminho privado longo demais para o orçamento causa abstenção. A leitura não apaga o estado: o recibo vem após a saída ao host, de modo que uma queda anterior pode repetir a entrega. Instrução humana e `/handoff` manual têm prioridade e este último continua disponível para o documento completo por pedido explícito.

Para voltar ao comportamento anterior após uma futura publicação, use a versão anterior do pacote: ela volta à busca vetorial sem reindexar a coleção e ignora o contexto gerado sem alterar os fatos. O `/handoff` manual continua disponível; se a entrega automática precisar cessar isoladamente, ainda não há um switch público específico documentado. Remova somente snapshots derivados que você exportou, caso não queira retê-los; mantenha IDs, ACKs, filas e cursors da curadoria. Esta branch ainda não comprova ganho geral de qualidade: a avaliação medida resgatou **2** identificadores exatos contra o mínimo de **3**, o benefício de contexto real segue não medido, e o p95 estrito de componente anterior excedeu 1 s. Smoke nativo completo da entrega automática nas duas CLIs e prova física de Windows ainda são gates separados.

### Inventário incremental de skills

```sh
cbs skills inventario --json
cbs skills inventario --save-snapshot ~/.local/state/cbs/skills-inventory/snapshot.json
cbs skills inventario --changed --json
cbs skills inventario --root /caminho/skills --snapshot ~/.local/state/cbs/skills-inventory/snapshot.json --changed
```

O inventário lê `SKILL.md` das raízes globais Claude, Codex e `.agents`, das skills do projeto atual e dos caches de plugins. `CLAUDE_CONFIG_DIR` e `CODEX_HOME` selecionam os perfis correspondentes. Uma raiz explícita com `--root` substitui o conjunto padrão. A primeira execução tem baseline `unknown`. Após salvar um snapshot privado, hashes observados distinguem `changed` e `unchanged`; `added` e `deleted` exigem o mesmo escopo e varreduras completas. Raízes ausentes, mudanças de escopo ou limites de leitura deixam ausências como `unobserved`, sem presumir exclusão. `--changed` inclui alterações identificadas e itens `unknown`, que ainda não podem ser classificados como novos. Caches grandes podem atingir o limite; use `--root` para comparar uma raiz menor por completo. Referências locais ausentes e nomes iguais com conteúdo divergente são sinais para revisão manual. Um arquivo presente no cache não comprova plugin habilitado ou carregado na sessão; o relatório marca essa fonte `runtime_unverified`. Uso não é medido, e hash igual não prova compatibilidade semântica. O inventário não executa nem atualiza skills.

Para site público novo ou redesign, o [rulebook frontend](base/personas/dominios/frontend-referencia.md) acrescenta ao brief/report existente a finalidade e a afirmação de cada seção, sua fonte de prova e a origem/licença ou prompt do asset. A captura Playwright confirma se o asset realmente apareceu. Esse critério foi adaptado do [Taste skill observado](https://github.com/Leonxlnx/taste-skill/blob/f624f37a8c650b9cc550253104925efe4c8de246/skills/taste-skill/SKILL.md); a avaliação e o inventário foram inspirados nos [conceitos de eval do ECC](https://github.com/affaan-m/ECC/blob/b92f181b3b748d1abbc2afd94af6aa7d8c8fca29/skills/eval-harness/SKILL.md) e de [stocktake do ECC](https://github.com/affaan-m/ECC/blob/b92f181b3b748d1abbc2afd94af6aa7d8c8fca29/skills/skill-stocktake/SKILL.md).

Um ensaio local isolado completou o ciclo automático em ambas as CLIs: hooks capturaram a fonte, o checkpoint acionou Haiku, a revisão no terminal gravou pelo SDK e uma sessão nova recuperou a memória. Outro ensaio validou correção de memória, indisponibilidade do Qdrant, interrupção de worker próprio e repetição do mesmo checkpoint; a recuperação retornou somente a versão ativa, sem perda ou duplicação no ensaio. A revisão desses ensaios foi automatizada para QA e não substitui o aceite humano do proprietário. O transporte HTTPS público do Qdrant também passou por teste remoto limitado de TLS, autenticação e operações SDK; essa prova não cobre o pipeline completo de memórias no servidor remoto.

**Experimental em Linux:** a rota de ativação em sessões normais de Claude Code e Codex passou a prova nativa limitada; os estados locais de confiança e propriedade continuam obrigatórios. Windows segue sem prova de release (`windows_release_unproved`) e será validado por outro responsável. Isso não representa aceite de qualidade geral: julgamento do proprietário, RF-19 completo e pipeline de memórias no Qdrant remoto permanecem pendentes. A operação entre duas máquinas foi adiada pelo proprietário para depois da implantação.

---

## BMAD + Superpowers: sempre juntos

Na execução, BMAD e Superpowers **rodam em conjunto**, em camadas — não são alternativas e não há flag pra desligar:

1. **Investigação** (`/investigar`) — apura fatos e limites antes de recomendar ou propor mudança.
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

Enquanto os rulebooks de domínio são **por-task**, o **ponytail é transversal** — lido por **todo** subagent implementer e reviewer, em qualquer task. O CBS mantém uma adaptação da filosofia [Ponytail 5.2.0 de Dietrich Gebert](https://github.com/DietrichGebert/ponytail/tree/v5.2.0) ([licença MIT](https://github.com/DietrichGebert/ponytail/blob/v5.2.0/LICENSE)): entender o problema por completo e **depois** escrever o mínimo que resolve. O plugin Ponytail e seus hooks não são instalados pelo CBS. Os benchmarks do projeto original não medem esta adaptação.

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
cbs memoria avaliar --outputs resultados.json  # avaliação offline de candidatos de memória
cbs skills inventario --changed --json          # skills alteradas desde o snapshot privado
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
| Executor descreve reviewers que não existem | Superpowers < 7.0. Atualize o plugin: o executor segue o contrato 7.0 (task reviewer único, briefs em `.superpowers/sdd/`). |
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
- [Mem0](https://github.com/mem0ai/mem0) — Mem0 (Apache 2.0): SDK utilizado no armazenamento e na recuperação da memória persistente com Qdrant.
- [Akita/ai-memory](https://github.com/akitaonrails/ai-memory) — inspiração para ideias de busca, contexto e memória inspecionável; sem código copiado.
- [OpenKnowledgeFormat](https://github.com/GoogleCloudPlatform/knowledge-catalog) — especificação de referência para os snapshots Markdown derivados OKF v0.2.
