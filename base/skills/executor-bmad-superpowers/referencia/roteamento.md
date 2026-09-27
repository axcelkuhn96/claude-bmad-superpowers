# Referência — roteamento por domínio, lentes de review e TDD por tipo (executor, Fase 3)

## 1. Sinais → domínio

Rulebooks em `~/.claude/personas/dominios/{frontend,database,laravel,python,node,integracao}.md` (override em `~/.claude/cbs-overrides/personas/dominios/`); lentes em `~/.claude/personas/review/{seguranca,cobertura-de-testes}.md`. Ao lado, as tabelas completas — `dominios/node-referencia.md`, `dominios/frontend-referencia.md`, `review/seguranca-referencia.md` — que o subagent consulta **por caminho** quando o rulebook mandar. Ordem e precedência batem com `~/.claude/personas/README.md`. Se um arquivo não existir na instalação, siga sem ele e anote no plano.

| Domínio | Sinais de arquivo | Sinais de story |
|---|---|---|
| `frontend` | `resources/views/**/*.blade.php`, `src/components/`, `src/app/`, `pages/`, `*.tsx` / `*.vue` / `*.svelte`, `*.css`, `tailwind.config.*`, `app/Livewire/**`, `app/Filament/**` (parte de view), `package.json` com `react-native`/`expo`, `app.json` com `expo`, `metro.config.*` | tela, componente, UI/UX, layout, responsivo, landing, dark mode, filtro, dashboard |
| `database` | `database/migrations/`, `prisma/`, `alembic/`, `db/migrate/`, `*.sql`, models / entities / repositories, `app/Models/` quando muda schema ou query | tabela, coluna, índice, migration, query lenta, relatório, relação, banco, schema |
| `laravel` | `composer.json` com `laravel/framework` + qualquer `app/**`, `routes/**`, `tests/**` | controller, job, policy, Form Request, Eloquent, artisan, Livewire, Inertia |
| `python` | `pyproject.toml` / `requirements*.txt` + `*.py` | script, ETL, FastAPI / Django, pandas, cron, pytest |
| `node` | `package.json` com `express` / `fastify` / `@nestjs/core` / `koa` / `hono` (sem Laravel na raiz), `tsconfig.json`, `src/**/*.{ts,js}` de servidor (`server.*`, `app.*`, `routes/`, `middlewares/`, `workers/`), `vitest.config.*` / `jest.config.*` | endpoint, rota, middleware, API REST, JWT / sessão, job / fila, CLI Node, TypeScript |
| `integracao` | `*Client*`, `*Webhook*`, `integrations/`, `providers/`, `config/services.php`, `.env.example` com `*_API_KEY` | API externa, SDK, webhook, sync, gateway, OAuth, "importar de X" |

Regras:
- **Até 2 domínios por task**: uma **linguagem** (`laravel` | `python` | `node`) + uma **área** (`frontend` | `database` | `integracao`). Três = task grande demais → quebre no plano (cada parte com o seu domínio).
- **Ordem no prompt**: persona dev → ponytail → linguagem → área. **Precedência em conflito**: regra inegociável de área vence a de linguagem; ambas vencem o corte do ponytail.
- Repo Laravel + Vite/React: `laravel` é a linguagem e `frontend` a área; `node` só entra com servidor Node próprio (worker, BFF).
- `package.json` só com React/Vue, ou com `react-native`/`expo` (React Native), e sem servidor Node → `frontend`, não `node`.
- Sem sinal → só persona dev + ponytail (comportamento herdado).
- `frontend`: se o roteador `frontend.md` definir modo de superfície (operar | persuadir | ler | experienciar), anote `frontend/<modo>`; registre no contexto se existem `DESIGN.md`, `PRODUCT.md` ou `design-system/*/MASTER.md` — são entrada, nunca regenerados.

## 2. Lentes de review (`personas/review/`) — só reviewers

| Lente | Quem lê | Quando |
|---|---|---|
| `seguranca` | task reviewer | **sempre** que o domínio for backend (`laravel` \| `python` \| `node` \| `integracao`). A marca `review: seguranca` na task é **só explícita** (auth, pagamento, tenant, dados pessoais, webhook de entrada) e é o gatilho da Fase 6 |
| `cobertura-de-testes` | reviewer final da branch | sempre que há diff de código de produção (o `revisor` em modo gate não repete) |

Nunca no implementer: dobra tokens e vira auto-review enviesado. A lente `seguranca` manda rodar `node ~/.claude/scripts/gate-seguranca.js` (gitleaks + semgrep + audit da stack; override em `~/.claude/cbs-overrides/scripts/`): exit 1 = task não está DONE; "APROVADO COM RESSALVAS" / gate parcial (ferramenta ausente) = aviso no report, nunca aprovação silenciosa; JSON completos em `.superpowers/sdd/`. O executor roda o mesmo gate na Fase 7 antes do push.

**Fallback enquanto `review/seguranca.md` não existir** (o reviewer usa este checklist e anota `lente ausente`; em diff backend a ausência da lente é 🟡 no relatório, não nota de rodapé):
1. Auth / autorização: rota nova tem middleware? permissão checada no servidor?
2. Validação de input externo: tipo, tamanho, formato, charset; rejeitar, não sanitizar em silêncio.
3. Exposição de dados: response com campos a mais? log vazando PII/token?
4. Injection: SQL/NoSQL parametrizado; nada de string concatenada em query ou shell.
5. XSS: escape na renderização; HTML de usuário só com allowlist.
6. Tenant / permissão por empresa em toda leitura e escrita.
7. Idempotência: jobs, webhooks e retries não duplicam efeito (dedupe por id de evento).
8. Secrets: nada hard-coded; `.env.example` atualizado; assinatura de webhook verificada.

## 3. TDD por tipo de task

O tipo vem de `<tipo_de_tarefa>` do prompt refinado; sem ele, classifique aqui. Task mista → prevalece o tipo mais estrito, ou quebre a task.

| `tipo` | Sinais | Política de teste |
|---|---|---|
| `regra-de-negocio` | cálculo, validação, regra fiscal / financeira, máquina de estado, permissão, parser, conciliação | **TDD estrito**: RED → GREEN → refactor, com comando e saída do RED e do GREEN no report |
| `operacional` | script, ETL / sync, relatório, comando, migração de dados, job, infra, comparação de planilhas | **validação E2E** no lugar do RED-GREEN: rodar contra dado real ou fixture, saída no report; teste de regressão só quando barato |
| `ui` | tela, componente, layout, filtro, dashboard, modal, CRUD visual | **validação no browser** (Playwright no venv do projeto/usuário, ex.: `/tmp/pwval`; sem `agent-browser` quando o ambiente não abre janela confiável): screenshots do golden path + 2 estados + 1 breakpoint mobile em `.superpowers/sdd/<plano>/task-N-visual/`; teste unitário só pra lógica extraída da view |
