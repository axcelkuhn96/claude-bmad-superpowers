# Referência — dispatch por caminho (executor, Fases 3 e 5)

Contrato do SDD 6.3: tudo que você cola num prompt de subagent fica residente no seu contexto pelo resto da sessão. Por isso persona, ponytail, rulebooks e lentes entram como **caminho de arquivo** + um **resumo vinculante ≤10 linhas**. O subagent lê os arquivos com `Read` antes de agir — no contexto dele, não no seu.

Caminhos instalados (primeiro existente vence): override do usuário `~/.claude/cbs-overrides/personas/...` → base `~/.claude/personas/...`. A persona dev destilada vive nesta skill: `~/.claude/skills/executor-bmad-superpowers/referencia/persona-dev.md`.

## 1. Bloco a acrescentar em `## Global Constraints` do plano

O task reviewer recebe as Global Constraints por contrato do SDD, e o implementer as recebe no dispatch. Pro **reviewer final** não é automático: o SDD passa `[PLAN_OR_REQUIREMENTS]` + linhas do ledger — **passe** você este bloco (com a lente `cobertura-de-testes`) no dispatch dele. A marcação por task (§3) fica no texto da task, que o `task-brief` extrai.

```markdown
### Rulebooks CBS (ler ANTES de agir; primeiro caminho existente vence; ausente → seguir sem ele e anotar `rulebook ausente: <caminho>` no report)
- Persona dev (todo implementer): `~/.claude/skills/executor-bmad-superpowers/referencia/persona-dev.md`
- Transversal (implementer e reviewers): `~/.claude/cbs-overrides/personas/ponytail.md` → `~/.claude/personas/ponytail.md`
- Domínio (conforme a marcação da task): `~/.claude/cbs-overrides/personas/dominios/<dominio>.md` → `~/.claude/personas/dominios/<dominio>.md` (`frontend | database | laravel | python | node | integracao`). Tabelas completas ao lado — `node-referencia.md`, `frontend-referencia.md` — consulte por caminho quando o rulebook mandar.
- Lentes de review (só reviewers): `~/.claude/cbs-overrides/personas/review/<lente>.md` → `~/.claude/personas/review/<lente>.md`
  - `seguranca`: task reviewer de toda task com domínio backend (laravel | python | node | integracao) ou marcada `review: seguranca`; tabela por stack em `seguranca-referencia.md`, por caminho
  - `cobertura-de-testes`: reviewer final da branch

### Resumo vinculante (≤10 linhas)
1. Menor superfície: reusar > stdlib > nativo do framework > dependência já instalada > 1 linha inline > só então build mínimo.
2. Nunca cortar validação de input, tratamento de erro, segurança, acessibilidade ou teste.
3. Ordem de leitura: persona dev → ponytail → linguagem (laravel | python | node) → área (frontend | database | integracao).
4. Regra inegociável de área vence a de linguagem; ambas vencem o corte ponytail.
5. TDD: `regra-de-negocio` = RED→GREEN com evidência no report; `operacional` / `ui` = validação E2E/browser aceita (Playwright no venv do projeto/usuário, ex.: `/tmp/pwval`; sem `agent-browser` quando o ambiente não abre janela confiável), saída/screenshots no report.
6. Queries parametrizadas, input externo validado, segredo só por env, permissão por tenant; task backend roda `node ~/.claude/scripts/gate-seguranca.js` antes de DONE (exit 1 = não está DONE; "gate parcial" = avisar no report).
7. Branch `<nome>`; sem worktree; um commit por task.
8. Subagent não dispara subagents; devolve só status, commits, 1 linha de teste, preocupações; o resto no report file.
```

Preencha `<nome>` da branch e apague linhas que não se aplicam ao projeto (ex.: tenant). Não passe de 10 linhas.

## 2. O que entra no prompt de cada papel

**Runtime.** Claude Code = existe a ferramenta `Agent` com `subagent_type`/`model` → coluna `claude:` do `models.yml` (agente `cbs-*` se existir em `~/.claude/agents/`, senão o modelo do fallback). Codex = dispatch por nome de agente de `~/.codex/agents/*.toml` ou `CODEX_HOME`/`CODEX_CLI_PATH` no ambiente → **somente** a coluna `codex:` (`name` do toml: architect_sol, reviewer_sol, final_reviewer_sol, backend_terra, frontend_terra, refactor_terra, tester_luna, explorer_luna, search_spark), nunca modelo nem effort; agente inexistente → despacha sem nome (`default_subagent_model` do `config.toml`). Personas e scripts: `~/.claude/personas/` e `~/.claude/scripts/` nos dois runtimes e em qualquer SO (o instalador resolve o home).

`subagent_type` é `general-purpose` **ou** o nome do agente do `models.yml` quando ele existe em `~/.claude/agents/` (Codex: `~/.codex/agents/`); `model:` só quando o papel resolve pra modelo cru.

**Nome (todo dispatch).** Todo dispatch nomeia o subagente (`name`), curto, kebab-case, único na sessão, no padrão `<papel>-<escopo>` (ex.: `impl-t3`, `rev-t3`, `fix-t3-r2`, `explore-auth`, `rev-final`); o nome é o endereço para `@nome`/`SendMessage`. Nome já usado na sessão → sufixo `-2`, `-3` (`rev-t3-2`). `name` é o nome da **instância**: independe de `subagent_type` e do agente do `models.yml` (`subagent_type: cbs-reviewer` + `name: rev-t3`). Codex: use o nome do agente em `~/.codex/agents` quando existir; o nome da instância segue o mesmo padrão quando o runtime aceitar — o "despacha sem nome" do Codex acima quer dizer **sem agente**, não sem `name`. Por quê: o usuário fala com os agentes pelo `@nome` — subagente sem nome não tem endereço. Nomes dos papéis da tabela abaixo: implementer `impl-t<N>` (fix round `fix-t<N>-r<R>`), task reviewer `rev-t<N>`, re-reviewer `rerev-t<N>-r<R>`, reviewer final `rev-final`, fix wave `fix-final`, build fixer `build-t<N>`, tester `e2e-t<N>`, explorer / search `explore-<tema>` / `search-<tema>`.

Defaults do `models.yml` (agente `claude` instalado pelo pacote em `~/.claude/agents/`, com o modelo/effort do frontmatter dele — usado como fallback se o agente faltar — e agente `codex`). **No Codex use só a coluna `codex`** — nunca modelo nem effort; agente ausente → dispatch sem nome (`default_subagent_model` do `config.toml`):

| Papel | Default `claude` | Fallback modelo/effort | Default `codex` |
|---|---|---|---|
| `orchestrator` | fable (effort max) — a sessão | — | — |
| `architect` | cbs-architect | fable/xhigh | architect_sol |
| `implementer_backend` | cbs-backend | opus/high | backend_terra |
| `implementer_frontend` | cbs-frontend | sonnet/high | frontend_terra |
| `refactor` | cbs-refactor | opus/high | refactor_terra |
| `build_fixer` | cbs-build-fixer | sonnet/high | backend_terra |
| `reviewer` | cbs-reviewer | opus/xhigh | reviewer_sol |
| `final_reviewer` | cbs-final-reviewer | opus/xhigh | final_reviewer_sol |
| `tester` | cbs-tester | sonnet/medium | tester_luna |
| `explorer` | cbs-explorer | sonnet/medium | explorer_luna |
| `search` | cbs-search | sonnet/low | search_spark |

| Papel SDD | Papel `models.yml` | Conteúdo do prompt |
|---|---|---|
| implementer | `implementer_backend`; `implementer_frontend` se domínio `frontend`; `refactor` se task de refatoração; `architect` nos fix rounds 4–5 | 1 linha de contexto; caminho do brief ("leia primeiro — são seus requisitos"); interfaces de tasks anteriores; caminho do report; Global Constraints (§1). Domínio `frontend`: "antes de codar, leia o roteador `frontend.md` e invoque a skill que ele indicar". |
| task reviewer | `reviewer` (read-only) | caminhos do brief, do report e do review-package; Global Constraints (§1) — a lente `seguranca` já está nelas quando aplicável |
| re-reviewer | `reviewer` (read-only) | findings abertos, brief, report, diff do fix |
| reviewer final | `final_reviewer` (read-only) | review-package da branch; linhas `minor (deferred)` e `parked` do ledger; Global Constraints (§1) com a lente `cobertura-de-testes` (+ `seguranca` se alguma task foi backend) — **passadas por você** |
| fix wave do review final | `refactor` | lista completa de findings, review-package, report path |
| build fixer (task BLOCKED por build/compile/typecheck, ou hook de Stop que continua falhando depois de 1 fix round) | `build_fixer` | saída real do comando que falha; caminho do brief e do report; persona da linguagem **por caminho** (seção "Build quebrado"); "menor mudança, sem refatorar" |
| tester (Fase 6 / revisor, tasks `ui` / `operacional`) | `tester` | roteiro de validação; Playwright no venv do projeto/usuário; salvar screenshots em `.superpowers/sdd/<plano>/task-N-visual/`; devolver só o caminho e o veredito |
| explorer / search (intake) | `explorer` / `search` | pergunta fechada; devolver síntese com `arquivo:linha`, nunca dump |

Proibido em qualquer prompt: conteúdo de `ponytail.md`, `dominios/*.md`, `review/*.md` ou `persona-dev.md`; histórico de tasks anteriores ("estado após as Tasks 1–3"); o plano inteiro.

## 3. Marcação por task (no texto da task do plano)

```
### Task 3: Endpoint de baixa de título (domínio: laravel+database; tipo: regra-de-negocio; review: seguranca)
```

- `domínio:` 0 a 2 valores, `linguagem+area`. Sem sinal → omita (a task segue só com persona dev + ponytail).
- `tipo:` `regra-de-negocio` | `operacional` | `ui` — vem de `<tipo_de_tarefa>` do prompt refinado; sem ele, classifique pela tabela de `roteamento.md` §3.
- `review: seguranca` **só explícito**: quando a task toca auth, pagamento, tenant, dados pessoais ou webhook de entrada. (A lente `seguranca` no task reviewer de toda task backend é automática pela Global Constraint — não precisa da marca; a marca é o que dispara a Fase 6.)
- `refatoração` no título ou `tipo:` quando a task só reorganiza código sem mudar comportamento → papel `refactor`.
