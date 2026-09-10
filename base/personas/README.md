# Personas (rulebooks lidos por caminho pelos subagents)

Instalados em `~/.claude/personas/`; override por arquivo em `~/.claude/cbs-overrides/personas/<mesmo caminho>` (primeiro existente vence). O executor **nunca cola** o conteúdo no dispatch: passa o caminho e o subagent lê com `Read` antes de agir. Arquivo ausente → o subagent segue sem ele e anota no report.

## Ordem de empilhamento (implementer e reviewers)

```
persona dev (@dev BMAD, destilada na skill do executor)
  → ponytail.md                      transversal, toda task
  → linguagem: laravel | python | node      (dominios/)
  → área: frontend | database | integracao  (dominios/)
```

Até 2 domínios por task (1 linguagem + 1 área). Em conflito: regra inegociável de **área** vence a de **linguagem**; ambas vencem o corte do ponytail. Sem sinal de domínio → só persona dev + ponytail.

## Domínios (`dominios/`) — implementer **e** task reviewer

| Arquivo | Quando é injetado | Referência ao lado |
|---|---|---|
| `laravel.md` | `composer.json` com `laravel/framework`; controller, Eloquent, job, policy, Blade, Livewire | — |
| `python.md` | `pyproject.toml`/`requirements*.txt`; script, ETL, FastAPI/Django, pytest | — |
| `node.md` | `package.json` com express/fastify/nest/koa/hono, `tsconfig.json`, código de servidor | `node-referencia.md` (config/processo, TypeScript, testes) |
| `frontend.md` (roteador ≤2 KB) | tela, componente, Blade/React/Vue, CSS — escolhe **uma** skill por situação | `frontend-referencia.md` (conteúdo integral + modos, piso de craft, checklist do reviewer de UI) |
| `database.md` | migration, schema, query, índice, ORM | (apêndices A–H no próprio arquivo) |
| `integracao.md` | API externa, SDK, webhook, sync, gateway | — |

## Lentes de review (`review/`) — **só reviewers**, nunca no implementer

| Arquivo | Quem lê | Quando |
|---|---|---|
| `seguranca.md` (≤3 KB) | task reviewer; reviewer final; subagent Security do `/revisar` | **sempre** que o domínio é backend (`laravel` \| `python` \| `node` \| `integracao`) ou a task está marcada `review: seguranca` |
| `seguranca-referencia.md` | idem, por caminho | quando uma linha da tabela comum manda ler a tabela da stack (PHP / Python / Node) e pra rodar o gate |
| `cobertura-de-testes.md` | reviewer final da branch; subagent de cobertura do `/revisar` | sempre que há diff de código de produção |

Gate de linha de comando que a lente `seguranca` manda rodar: `node ~/.claude/scripts/gate-seguranca.js` (gitleaks + semgrep com baseline + audit da stack; exit 1 = task não está DONE). Override: `~/.claude/cbs-overrides/scripts/`.

## Ponytail (`ponytail.md`)

Transversal (implementer, task reviewer, re-reviewer, reviewer final): menor superfície correta e segura. Piso de segurança (validação, erro, segurança, a11y, teste) nunca é cortado.
