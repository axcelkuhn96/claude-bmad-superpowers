# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.11.0] - 2026-07-16

### Mudou — grelhar agora pergunta no seletor interativo do CLI
- **Toda pergunta da `grelhar` vai pela ferramenta `AskUserQuestion`** (seletor interativo), nunca mais como texto corrido. Cada pergunta traz **2 a 4 opções concretas** pra alimentar o debate, com a **recomendação como primeira opção** marcada `(Recomendado)` — e o **tradeoff de cada opção** na descrição (o que ganha × o que custa). O usuário sempre tem "Other" automático pra responder livre.
- **Uma pergunta por chamada, ainda.** A ferramenta aceita até 4 por vez, mas a skill manda **uma** — mandar várias atordoa e impede resolver as dependências da árvore de decisão em ordem.
- **Novas regras de montagem:** `header` curto (máx. 12 chars) pra área da decisão; **proibido opção-espantalho** (toda alternativa precisa ser defensável por alguém sensato); usar `preview` quando a decisão for comparar algo concreto (dois formatos de código, shapes de dado, layouts), que renderiza lado a lado; se o usuário escolher "Other" e abrir premissa nova, **reordenar a árvore** antes de seguir.
- **Fallback preservado:** fora do Claude Code (sem `AskUserQuestion`), a skill cai pro formato texto — uma pergunta por vez, recomendação explícita e alternativas numeradas com tradeoff.
- **Anti-padrões novos:** perguntar em texto corrido tendo o seletor; várias perguntas numa chamada; opção espantalho; pergunta sem tradeoff na descrição.
- **README** e descrição da skill/comando atualizados pra refletir o seletor.

## [0.10.0] - 2026-07-16

### Adicionado — 3 skills adaptadas de mattpocock/skills (agora 6 skills, 11 comandos)
- **`grelhar` (skill) + `/grelhar` (comando)** — interrogatório implacável (grilling): **uma pergunta por vez com resposta recomendada**, descendo a árvore de decisão até entendimento compartilhado. Distingue **fato** (busca sozinha via Explore/Read/Grep) de **decisão** (pergunta ao usuário). Não implementa nem gera prompt — ao fechar, sugere `/refinar`, `/executar` ou `/mapear`.
- **`wayfinder` (skill) + `/mapear` (comando)** — pra trabalho grande demais pra uma sessão só e ainda nebuloso. Cartografa um **mapa de decisões** em `docs/mapas/<slug>.md` (adaptado do issue tracker do original pra markdown local) e resolve **tickets** (pesquisa/protótipo/grelhar/tarefa) um a um, com "névoa de guerra", fronteira, HITL×AFK e "uma decisão por sessão". Evolução do `/investigar`; planeja **decisões, não deliverables**; proíbe editar código de aplicação.
- **`handoff` (skill) + `/handoff` (comando)** — compacta a conversa num **documento de continuação** pra outro agente/sessão retomar sem reler o histórico. **Referencia** artefatos (specs/planos/commits/diffs) por caminho em vez de duplicar, **redige** segredos (API keys, senhas, PII) e inclui seção "Skills sugeridas". Salva em `docs/handoffs/` (se houver `docs/`) ou no diretório temporário do SO.

### Mudou — grelhar entra no pipeline do `/piloto`
- **`/piloto` agora é `grelhar` → `refinar` → OK → `executar`.** Nova **Etapa 1 (Grelhar)** roda o interrogatório antes de refinar, pra afiar as decisões antes de gastar tokens gerando o prompt. A grelha se auto-escala (ideia trivial fecha em 1-2 perguntas; grande destrincha vários galhos) e, se o escopo for grande demais, oferece `/mapear`. A **Etapa 2 (Refinar)** recebe as decisões fechadas e o "Alinhamento" da refinador vira **confirmação rápida** — sem reabrir as mesmas perguntas. Etapas renumeradas (executar virou Etapa 4).
- **`refinador-de-prompt`:** nota na Fase 4 (Gap analysis) pra **escalar pro `grelhar`** quando as dúvidas bloqueantes forem muitas e interdependentes (árvore, não lista) — vale pro `/refinar` standalone.
- **README:** contagem "6 skills e 11 comandos"; tabela "Como usar" com `/mapear`, `/grelhar`, `/handoff`; diagrama do pipeline com os 3 novos fluxos e o `/piloto` incluindo grelhar; seção "As 6 skills" com os 3 novos verbetes.

### Distribuição
- Zero mudança de CLI — o `instalar`/`atualizar` já copia `base/skills/` e `base/commands/` recursivamente, então as 3 skills e os 3 comandos são distribuídos e cobertos pelo fluxo de override automaticamente. Mensagens de ajuda do instalador atualizadas.

## [0.9.0] - 2026-07-02

### Adicionado — Gate de modelo na execução
- **Novo gate na Fase 4 do executor:** junto do "Posso implementar? [s/N]", o executor pergunta em qual modelo rodar os subagents de execução — **atual** ou **sonnet** (duas opções só).
  - **atual** (padrão): sem override — a skill `superpowers:subagent-driven-development` segue o tiering próprio dela (mecânico → barato, julgamento → padrão, review final → mais capaz) a partir do modelo da sessão.
  - **sonnet**: o executor injeta uma restrição global e a skill dispara **todos** os implementer/reviewer subagents em `model: sonnet` (bom pra padronizar/economizar em feature grande ou mecânica).
- **Base do mecanismo:** a `subagent-driven-development` (v6.1.0) lê as restrições globais antes de disparar e especifica o modelo explicitamente em cada subagent — então o gate é enforçável por-subagent, não só no nível de sessão. Modo `--auto` assume `s` + modelo **atual**.

### Mudou
- **Fase 5 do executor:** novo passo 6.1 que repassa a escolha do gate como restrição global pro Superpowers (e ao fallback manual). **README:** diagrama do pipeline cita o gate de modelo + nova subseção "Gate de modelo (atual ou sonnet)".

## [0.8.0] - 2026-07-02

### Adicionado — Rulebook transversal ponytail (anti-over-engineering)
- **Novo rulebook `base/personas/ponytail.md`.** Diferente dos rulebooks de domínio (frontend/database, que são **por-task**), o ponytail é **transversal** — injetado no prompt de **todo** subagent implementer/reviewer, em qualquer task. Importa a filosofia [ponytail](https://github.com/DietrichGebert/ponytail) ("lazy senior developer"): entender o problema por completo e **depois** subir uma escada de decisão de 7 degraus (existe? já no codebase? stdlib? nativo? dep instalada? 1 linha? só então build) pra escrever o mínimo.
- **Piso de segurança inegociável:** ponytail corta código desnecessário, **jamais** validação, tratamento de erro, segurança, acessibilidade ou teste. Inclui níveis (`lite`/`full`/`ultra`/`off`, padrão `full`) e checklist de over-engineering pro reviewer.
- **Nova seção "Orquestração: teammate vs ultracode"** no executor e no README: guia conceitual de quando escalar a orquestração pra **teammate** (subagent persistente e endereçável via `SendMessage`) ou **ultracode** (Workflow multi-agente determinístico), sem trocar o motor `subagent-driven-development`.

### Mudou
- **Executor:** novo princípio não-negociável ("Menor superfície (ponytail)"). **Fase 5** injeta o `ponytail.md` completo (incondicional) em todo implementer, empilhado `@dev` → ponytail → domínio; caminho com precedência de override (`cbs-overrides` → base), igual aos domínios. **Fase 6** injeta o ponytail no code review pra sinalizar over-engineering sem afrouxar o piso de segurança.
- **README:** nova camada "Anti-over-engineering (sempre, transversal)" na tabela; seção "Ponytail: menos código, mesma segurança"; ponytail citado no diagrama do pipeline.
- **Distribuição:** zero mudança de CLI — o `instalar`/`atualizar` já copia `base/personas/` recursivamente, então o `ponytail.md` é distribuído e coberto pelo fluxo de override automaticamente.

## [0.7.0] - 2026-06-08

### Adicionado — Rulebook de domínio database
- **Novo rulebook `base/personas/dominios/database.md`.** Segundo domínio com expertise própria (depois do frontend), empilhado em cima do `@dev` BMAD. Diferente do frontend, **não há skill oficial** a invocar — a expertise (DBA sênior + SQL pro) está destilada no próprio rulebook, self-contained.
- **Cobre** (task de feature, não DBA-ops): detecção de schema/ORM/migration antes de qualquer DDL; modo dual (seguir padrão existente × greenfield); regras inegociáveis (migration reversível, queries parametrizadas, índice em FK, sem N+1, sem `SELECT *`, dinheiro em `numeric`, transação atômica, filtro de tenant); loop de validação (up/down + EXPLAIN + isolamento de tenant).
- **Apêndices de profundidade (estilo enciclopédico):** especificidades por RDBMS (PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, SQLite); NoSQL (MongoDB, Redis); PK uuid×autoincremento (incl. uuidv7/ULID); leitura de plano de execução (EXPLAIN); migrations zero-downtime (expand→migrate→contract); padrões de query avançados (CTEs, window functions, keyset pagination); data warehousing (star schema, SCD); guia por ORM (Prisma, TypeORM, SQLAlchemy/Alembic, Django, ActiveRecord, GORM).

### Mudou
- **Fase 3 do executor** agora classifica tasks também como **database** (sinais: `migrations/`, `prisma/schema.prisma`, `db/migrate/`, `alembic/`, `.sql`, models/repositories; menção a tabela/coluna/query/índice/migração/schema).
- **Fase 5 do executor** carrega `database.md` e injeta o conteúdo completo no prompt do implementer **e** do code quality reviewer (QA de banco: índices, plano de execução, rollback, isolamento de tenant). Como não há skill oficial, a instrução é seguir o rulebook destilado literalmente.
- **README** atualizado: seção "Database (implementado nesta versão)" e heading dos rulebooks agora lista frontend + database.

## [0.6.0] - 2026-06-02

### Adicionado — Rulebook de domínio frontend
- **Nova camada `personas/dominios/` no pacote.** Em cima do `@dev` BMAD (que já é injetado em todo subagent `general-purpose` desde a v0.4.3), o executor agora empilha um **rulebook específico de domínio** quando a task pertence ao domínio. Mesmo padrão persona-as-instructions — o `subagent_type` continua SEMPRE `general-purpose`. Nesta versão, **só frontend** está implementado; tasks de outros domínios seguem só com `@dev` puro (comportamento herdado).
- **Fase 3 agora classifica cada task como frontend ou não.** A marcação alimenta a Fase 5.
- **Fase 5 carrega o rulebook do domínio** de `~/.claude/cbs-overrides/personas/dominios/<dominio>.md` (se existir) ou `~/.claude/personas/dominios/<dominio>.md` e cola o conteúdo completo no prompt do implementer subagent.

### Frontend rulebook (`base/personas/dominios/frontend.md`)
- **Skill oficial `frontend-design`** (plugin `claude-plugins-official`) é obrigatória — instruída explicitamente no prompt do implementer ANTES de codar UI. Sem ela, a saída cai em "AI slop".
- **Modo dual — não impõe estética sempre.** Passo 1: detectar o design system existente do projeto (Tailwind config / theme / componentes / Storybook / motion / tema). Passo 2A: **se existe padrão**, segui-lo rigorosamente (reusa primitivos, mantém tipografia, motion, escala de espaçamento; `frontend-design` entra como checklist técnico de estados/hierarquia/qualidade, NÃO como licença pra "redesenhar bold"). Passo 2B: **só quando não há padrão**, comita a uma direção estética distinta via `frontend-design` e estabelece tokens já em config.
- **Anti-IA-genérico vale nos dois modos**: sem lorem ipsum, sem emoji como ícone, estados completos obrigatórios (loading/empty/error/foco/disabled), acessibilidade AA, hierarquia tipográfica deliberada, copy alinhada ao i18n do projeto.
- **Padronização de CSS / nomenclatura — DRY de estilo**: token > literal (hex hardcoded só com justificativa); 3+ repetições de classes → extrair (cn/cva/utility/componente); naming consistente (kebab-case CSS modules, BEM se o projeto é BEM, data-attributes Radix-style); um conceito = um nome (não introduzir sinônimos); não duplicar tokens em arquivos diferentes; animação e breakpoints têm nome também. Varredura final do diff antes de fechar a story.
- **Loop de validação visual obrigatório**: dev server up + golden path + 2 estados + dark mode + teclado + mobile breakpoint, anotados no Dev Agent Record. Se ambiente headless, declarar explicitamente "não validado visualmente".

### Mudou
- **CLI**: `instalar`, `atualizar` e `remover` agora tratam `base/personas/` (copia pra `~/.claude/personas/`, preserva customizações em `~/.claude/cbs-overrides/personas/`, remove apenas arquivos com marcador).
- **`caminhos.js`**: novo constant `DIR_PERSONAS` (`~/.claude/personas/`).
- **README** atualizado com seção sobre rulebooks de domínio e como sobrescrever.

## [0.5.1] - 2026-05-25

### Corrigido (consistência de docs)
- **INSTALL.md** atualizado: 7 → **8 commands**; marcador descrito como rodapé (não header); passo do Superpowers agora diz "detecta e mostra o comando" (não "instala via CLI"); `.bmad-core/` → `_bmad/` e BMAD marcado como requisito do `/executar`.
- **Comando do Superpowers padronizado** em todos os docs: `/plugin marketplace add obra/superpowers-marketplace` + `/plugin install superpowers@superpowers-marketplace` (antes o INSTALL.md tinha `superpowers@obra`, que não bate com o nome real do marketplace).
- **README**: passo 2 da instalação não promete mais "instala" o plugin — diz "detecta e mostra o comando exato" (plugins não instalam via CLI fora do app).
- **Descrição do pacote (package.json) e do repo GitHub** atualizadas: removido "BMAD opcional"; agora "Superpowers (motor) + BMAD (disciplina) integrados".

## [0.5.0] - 2026-05-25

### Mudança de arquitetura — BMAD + Superpowers SEMPRE juntos
- **Revertido o opt-in da v0.4.0.** Decisão do usuário: BMAD e Superpowers passam a rodar **sempre em conjunto, em camadas**, sem flag pra desligar. Superpowers é o **motor** (subagents isolados por task, TDD, 2 reviewers, contexto limpo); BMAD é a **disciplina** (gera as stories no planejamento e suas personas `@dev`/`@qa`/review são injetadas em cada subagent `general-purpose`). Nenhum dos dois roda "puro".
- **Fase 3 sempre BMAD primeiro:** `bmad-create-prd` (se houver produto/arquitetura) + `bmad-create-story`/`epics-and-stories` → `superpowers:writing-plans` converte em plano. Mesmo caso pequeno gera ao menos 1 story (rastreabilidade story↔código↔teste).
- **Detecção inicial:** BMAD vira requisito — sem BMAD, o executor para e oferece `/instalar-bmad`; só simula as personas se o usuário recusar.
- **Removido `--bmad`** como opt-in dos comandos `executar.md`/`piloto.md` e da skill (agora é o comportamento padrão).
- README repositionado: BMAD deixa de ser "opcional" e passa a "sempre em conjunto com Superpowers".

### Adicionado
- **Novo comando `/revisar`** (8º comando): revisa tudo que foi feito (mudanças da branch / working tree) com code review + QA + security, delegando a subagents `general-purpose` com as personas BMAD injetadas (`bmad-code-review`, `@qa`/TEA). Read-only por padrão — emite relatório com achados por severidade e veredito de merge, e só corrige (via `subagent-driven-development`) com OK do usuário.

## [0.4.3] - 2026-05-25

### Adicionado
- **Personas BMAD estendidas a TODOS os subagents `general-purpose`** (antes só o implementer). No caminho `--bmad`, cada subagent continua sendo `general-purpose` (regra rígida mantida — nunca dispachar `@dev`/`@qa`/`bmad-agent-*`/`code-reviewer`/`qa-expert` como tipo de agente), mas o prompt injeta as convenções do agente BMAD correspondente ao papel:
  - **Implementer** → Dev agent (`@dev`)
  - **Spec reviewer** → review do BMAD (conferir contra critérios de aceite e tasks da story)
  - **Code quality reviewer** + **QA da Fase 6** → QA/Test agent (`@qa`/TEA: test design, testes baseados em risco, rastreabilidade)
  - **Code review da Fase 6** → review do BMAD (`bmad-code-review`)
  - **Security** → sem equivalente no BMAD; segue `general-purpose` + checklist.
- Fase 6 ganhou regra de subagent explícita (igual à Fase 5): tudo roda em `general-purpose`, nunca em agente de domínio/plugin.

## [0.4.2] - 2026-05-25

### Adicionado
- **Disciplina do Dev agent do BMAD (`@dev`) dentro do implementer `general-purpose`** — só no caminho `--bmad` (quando há story files BMAD). O `subagent_type` continua `general-purpose` (a regra rígida da v0.4.1 é mantida — nunca dispachar `@dev`/`bmad-agent-dev` como tipo de agente), mas o prompt de cada implementer passa a injetar as convenções do `@dev`: implementar tasks/subtasks da story em ordem com checkboxes, TDD por task, atualizar File List + Dev Agent Record, validar critérios de aceite e marcar status → Ready for Review. Junta o isolamento + TDD + 2 reviewers do `general-purpose` com a disciplina de story do BMAD. Fora do `--bmad`, o implementer segue só o plano do `writing-plans`.

## [0.4.1] - 2026-05-25

### Corrigido
- **Implementer subagent agora é fixado em `general-purpose`.** Sessão real mostrou o executor delegando a `superpowers:subagent-driven-development`, que chutou um nome de agente especialista (`backend-developer`) — inexistente — e caiu no vizinho mais próximo da lista de plugins instalados (`voltagent-core-dev:backend-developer`). Esses agentes de domínio/plugin trazem system prompt e agenda próprios, toolset limitado e fogem do plano/TDD entregue, quebrando a garantia de qualidade. Fase 5 da `executor-bmad-superpowers` agora tem regra rígida: implementer SEMPRE `general-purpose`, nunca `voltagent-*`/`*-pro`/`*-specialist`/`*-expert`; se um nome de especialista não existir, usar `general-purpose` em vez de buscar o match mais parecido.

## [0.4.0] - 2026-05-24

### Reposicionamento (decisão de arquitetura)
- **Superpowers vira a espinha dorsal da execução; BMAD vira opt-in.** Validado por sessão real (`f992fd4b`): a delegação ao `subagent-driven-development` funciona (implementer subagent assume a implementação, contexto principal limpo). Conclusão: empilhar refinador + BMAD-story + writing-plans era cerimônia redundante pra feature única.
- **Fase 3 do executor**: default agora é só `superpowers:writing-plans` (o prompt refinado já é spec). BMAD (`bmad-create-prd`/`create-story`) só entra opt-in — feature grande/multi-story ou flag `--bmad`.
- **BMAD reposicionado** pra camada de discovery/planejamento de produto (`/investigar`, features grandes), fora do caminho de execução de feature única.
- README reescrito deixando claro: front-end PT-BR (refinar+memória) é o diferencial, Superpowers é o motor de qualidade, BMAD é planejamento de produto opcional.
- `executar.md`/`piloto.md`: documentam `--bmad` como opt-in.

## [0.3.0] - 2026-05-24

### Mudança de arquitetura
- **Executor agora DELEGA ao Superpowers real em vez de reimplementar.** Diagnóstico (sessões `bcf5870f`/`609f0c5d`/`89756461`): o executor descrevia brainstorming/TDD/subagent na própria SKILL.md e o modelo fazia tudo inline no contexto principal — os subagents quase não disparavam e o contexto poluía. Pesquisa na fonte primária (Superpowers v5.1.0) mostrou que `subagent-driven-development` mantém o contexto principal só como orquestrador e despacha implementer + 2 reviewers por task.
- **Fase 3 (Planejamento):** BMAD gera spec/stories → `superpowers:writing-plans` converte em plano executável com tasks discretas.
- **Fase 5 (Execução):** agora **delega a `superpowers:subagent-driven-development`** — implementer subagent isolado por task + spec reviewer + code quality reviewer. O contexto principal só orquestra. Fallback pra TDD manual se Superpowers ausente.
- **Sem worktree:** instrução explícita pra trabalhar na branch atual (não invocar `using-git-worktrees`), conforme preferência do usuário.
- Removida a prosa que reimplementava RED-GREEN e regras de subagent inline (agora vêm das skills reais).
- `executar.md` e `piloto.md` ajustados pra refletir a delegação.

## [0.2.10] - 2026-05-24

### Alterado
- **Removida a seção "Versão curta para colar"** do `refinador-de-prompt`. O prompt premium completo já é o entregável; a versão curta era redundante. Agora são 4 seções (Diagnóstico, Contexto usado, Dúvidas, Prompt final premium) em vez de 5.

## [0.2.9] - 2026-05-24

### Corrigido
- **Executor agora invoca as skills Superpowers/BMAD formais**, não só aplica o método. Análise da sessão `bcf5870f` mostrou TDD real mas sem invocar `superpowers:test-driven-development`, e plano sem invocar agentes/skills BMAD. Mudanças:
  - Fase 2 → invoca `superpowers:brainstorming`
  - Fase 3 → invoca skills BMAD reais (`bmad-create-prd`, `bmad-create-architecture`, `bmad-create-story`, ou agentes `bmad-agent-*`), escalando pelo tamanho da tarefa
  - Fase 5 → invoca `superpowers:test-driven-development` (+ `systematic-debugging` se travar)
  - Fase 6 → invoca `superpowers:requesting-code-review`
  - Fase 7 → invoca `superpowers:verification-before-completion` antes de declarar pronto
- **Fase 4 virou PONTO DE PARADA HARD**: executor agora termina a mensagem com "Posso implementar? [s/N]" e espera resposta antes de tocar em código. Antes emitia o cabeçalho mas seguia direto codando.

## [0.2.8] - 2026-05-24

### Corrigido
- **`mem-search` agora é obrigatório em primeiro lugar**, sem julgamento. Análise da sessão `5954fb4b` mostrou 0/3 invocações de claude-mem mesmo com a v0.2.5 mandando. Reforço em duas camadas:
  - **Nos 5 slash commands**: ordem numerada explícita — "1. PRIMEIRO invoque Skill mem-search. 2. SÓ DEPOIS invoque a skill principal."
  - **No topo das 3 SKILL.md**: novo bloco "⚠️ PRIMEIRA AÇÃO — SEMPRE consultar memória persistente" antes do bloco de formato obrigatório.
- Espera-se agora que `mem-search` apareça como primeira tool call em cada slash command.

## [0.2.7] - 2026-05-24

### Adicionado
- **Fase 5 — Alinhamento prévio** no `refinador-de-prompt`: ANTES de gerar o prompt premium, skill agora emite um resumo curto (`## Alinhamento` com "Entendi" + "Decisões que precisam de OK seu" + "Tradeoffs") e **PARA**, esperando o usuário confirmar. Usuário decide tudo ANTES do prompt — não vê suposições enterradas só depois.
- Loop de iteração que era Fase 6 virou Fase 7. Pra ajustar antes do prompt, basta dizer o que mudar na fase de alinhamento. Pra ajustar depois, mesma coisa via loop final.
- `/refinar-auto` continua pulando a Fase 5 (assume tudo e vai direto — esse é o propósito do auto).

## [0.2.6] - 2026-05-24

### Adicionado
- **Loop de iteração no `/refinar`** (Fase 6 do `refinador-de-prompt`): depois de emitir o prompt, skill SEMPRE pergunta "Quer ajustar algo? `ok` pra fechar ou diga o que mudar". Permite co-decidir sem rodar `/refinar` do zero várias vezes. Aceita `ok`/`pode`/`tá bom`/`fechado` como sinal de fim. Qualquer outro texto = ajuste → re-emite formato completo.
- `/piloto` ajustado pra esperar o `ok` do loop do refinador antes de perguntar "executar agora?".

## [0.2.5] - 2026-05-24

### Adicionado
- **Integração explícita com claude-mem** nas 3 skills. Antes era genérico ("se houver memória, consulte"); agora é imperativo com nomes específicos: `mem-search`, `claude-mem:mem-search`, `claude-mem:smart-explore`, `claude-mem:knowledge-agent`, MCP tools `*memory_search*` etc. Se nenhuma aparecer disponível, marca "Memória: nada encontrado" e segue. Antes o LLM ignorava o claude-mem mesmo instalado.

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
