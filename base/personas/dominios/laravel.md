# Domínio: Laravel / PHP

Rulebook lido por caminho pelo subagent `general-purpose` quando a task toca código PHP de um projeto Laravel. **Stacka em cima do `@dev` BMAD e do ponytail**, não substitui — o subagent é Dev + Laravel, não só Laravel. Se a task também é de banco, empilha `database.md`; se chama API externa, `integracao.md`; se é Blade/Livewire, `frontend.md` (ordem: @dev → ponytail → laravel → área). Regra inegociável de área vence a daqui.

> Destilado do Laravel Boost (`laravel-best-practices`, `testing-best-practices`, MIT) e do `php-reviewer` do ECC (MIT). Reescrito em pt-BR; o subagent tem o codebase na frente — este arquivo dá o critério, não o código.

## Gatilhos (Fase 3 do executor)
- Arquivos: `composer.json` com `laravel/framework`; `app/`, `routes/`, `database/migrations/`, `resources/views/*.blade.php`, `tests/Feature/`, `app/Livewire/`, `app/Filament/`.
- Story menciona: controller, model, Eloquent, migration, job, queue, policy, Form Request, Blade, Livewire, Inertia, Filament, artisan, Pest/PHPUnit.
- Task **só** de Blade/CSS → `laravel + frontend`. Task **só** de migration/query → `laravel + database`.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)
1. **Detecte as convenções do projeto ANTES de aplicar qualquer regra.** O Laravel aceita várias formas válidas; a certa é a que o codebase já usa.
2. **Se o projeto tem Laravel Boost** (`laravel/boost` no `composer.json`, MCP `laravel-boost` em `.mcp.json`, skills em `.claude/skills/laravel-*`): use `search-docs` pra API sensível a versão e `database-schema`/`application-info` em vez de ler migrations na mão. Não duplique regras que o Boost já injeta — este rulebook vira checklist.
3. **Sem Boost:** confira a versão instalada (`composer show laravel/framework`) antes de usar API nova; na dúvida, leia `vendor/laravel/framework`.
4. **Nunca introduza um segundo padrão** pra algo que o projeto já resolve de um jeito (validação inline vs Form Request, Service vs Action, Repository vs Eloquent direto). Desvie só por defeito de correção/segurança — e diga que desviou.

## Detecção (reporte antes de codar)
```
### Convenções Laravel detectadas
- Versão: Laravel 11.x · PHP 8.3 · Pest 3 (ou PHPUnit)
- Boost: instalado / não
- Estrutura: Actions em app/Actions? Services? DTOs? Enums nativos?
- Validação: Form Request / inline / ambos (qual predomina)
- Autorização: Policies / Gates / middleware / pacote (spatie/permission)
- Front: Blade puro / Livewire N / Inertia+X / Filament / API-only
- Filas: driver, Horizon?, jobs em app/Jobs
- Testes: Feature-first? factories? RefreshDatabase? paralelismo?
- Tooling: pint.json, phpstan.neon (nível), rector, larastan
Modo: seguir padrão existente | estabelecer padrão (greenfield)
```

## Regras inegociáveis (valem sempre)

**Segurança (bloqueante em review)**
- `$fillable` explícito em model populado por request. `$guarded = []` + dado de request = bug. `create($request->all())` = bug; use `$request->validated()` / `safe()->only([...])`.
- Autorização em toda ação protegida: `Gate::authorize`/Policy ou `authorize()` no Form Request. Autenticado ≠ autorizado. Validação ≠ autorização.
- Query só por Eloquent/builder/bindings. `whereRaw`/`orderByRaw`/`DB::select` com string interpolada de input = bug. Binding protege valor, não identificador (coluna/tabela) — allowlist pra esses.
- Blade `{{ }}` sempre; `{!! !!}` só com conteúdo sanitizado pro contexto exato.
- `@csrf` em todo form que muda estado; rota fora do CSRF (webhook) tem que ter outra verificação (assinatura).
- Rate limit em login, recuperação de senha, verificação, endpoints caros.
- Upload: `mimes`/`image`/`max`, nome gerado pelo Storage, fora de path executável.
- Segredo só via `config()` lendo `env()` no arquivo de config — nunca `env()` no código de app (quebra `config:cache`).
- `composer audit` no loop de validação.

**Eloquent / performance**
- Sem N+1: `with()`/`load()`/`$with` onde há loop ou serialização; em review, rodar a rota com `DB::enableQueryLog()` ou `preventLazyLoading` em teste.
- Relação com tipo de retorno concreto (`HasMany`, `BelongsTo`). Scopes locais pra filtro repetido.
- Operação multi-passo em `DB::transaction()`. Sem query em Blade.
- Coleção grande: `lazy()`/`chunkById()`/`cursor()`; nunca `->get()` pra iterar milhares.

**Migrations (além do `database.md`)**
- Gere com `make:migration`. Migration aplicada em ambiente compartilhado é imutável — nova migration forward.
- Coluna obrigatória/única em tabela populada = passos separados (nullable → deploy que aceita os dois → backfill em chunks por command/job → constraint).
- `down()` honesto: se não reverte dado, documente e marque irreversível.

**Filas**
- `$timeout` menor que `retry_after` da conexão. Backoff em falha transitória. `ShouldBeUnique` quando dispatch pode duplicar. `failed()` quando falha terminal precisa de efeito. Job idempotente por design.

**HTTP client** → ver `dominios/integracao.md` (timeouts, retry só idempotente, `throw()`, `Http::fake`).

**Estilo / tipos**
- `declare(strict_types=1)` onde o projeto usa; tipos em parâmetro/retorno de método público; `readonly` em promoted property nunca reatribuída; `final` quando não é pra herdar (siga o que o projeto faz).
- `dd()`/`dump()`/`var_dump()` commitado = bloqueante. `catch (\Exception $e) {}` vazio = bloqueante.
- Lógica de negócio fora do controller (Action/Service **do jeito que o projeto já faz**).

## Testes (regras do Boost, resumidas)
- Feature test primeiro; unit só pra lógica sem framework. Não teste o framework — teste o que o projeto configura (cast, relação com constraint, regra de validação).
- Toda rota: autenticação, autorização, **tenant cruzado retorna 404 (não 403, que confirma existência)**, validação com mensagem visível.
- Matriz completa de permissão no teste de Policy, não no de controller.
- Escrita: assert resposta + estado no banco + efeito colateral (fake com 1 assertion).
- `setUp()`/`beforeEach()` só configuração. Tempo, aleatoriedade, HTTP externo controlados (`Carbon::setTestNow`, `Http::fake`, `preventStrayRequests`).
- Use as ferramentas de teste que o projeto já tem; não adicione plugin/browser sem pedido.

## Loop obrigatório de validação (antes de Ready for Review)
```
vendor/bin/pint --test              # ou o formatter do projeto
vendor/bin/phpstan analyse          # no nível do phpstan.neon do projeto
php artisan test --filter=<escopo>  # depois a suíte relevante inteira
composer audit
php artisan migrate --pretend       # se houve migration
```
Cole a saída resumida no Dev Agent Record. Ambiente sem PHP/banco → declare explicitamente o que não rodou.

## Saída esperada (além do @dev)
- Bloco "Convenções Laravel detectadas".
- Lista de regras do projeto que você **seguiu em vez** da regra deste rulebook (com o motivo "padrão existente").
- Queries novas e como evitou N+1. Migrations e plano de rollback.
- Saída do loop de validação.

## Anti-padrões fatais
- ❌ Introduzir Repository/Service/DTO "porque é boa prática" num projeto que usa Eloquent direto (ponytail + Boost).
- ❌ `env()` fora de config. ❌ `$request->all()` em `create`/`update`. ❌ `{!! $input !!}`.
- ❌ Adicionar Pest/Dusk/pacote novo sem pedido. ❌ Alterar migration já aplicada.
- ❌ Chutar API de versão nova sem conferir (`search-docs` ou vendor).
