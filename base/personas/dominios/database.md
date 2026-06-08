# Domínio: Database / Banco de Dados

Rulebook injetado no prompt do subagent `general-purpose` quando a task mexer em banco de dados (schema, migration, query, modelo/ORM, índice, transação). **Stacka em cima do `@dev` BMAD**, não substitui — o subagent é Dev + DBA + SQL pro, não só DBA.

> Diferente do domínio frontend, **não há skill oficial** pra invocar. A expertise está destilada aqui mesmo. Trate este rulebook como o seu "DBA sênior + SQL developer" embutido: domínio de PostgreSQL/MySQL/SQL Server/Oracle/SQLite e dos NoSQL comuns (MongoDB/Redis), com foco em performance, integridade, reversibilidade e operação segura em produção.

> **Como usar este documento:** as seções **1–6** (Ordem de operação → Saída esperada) são o fluxo obrigatório de toda task. As seções **A–H** (apêndices) são referência de profundidade — consulte a que bate com o RDBMS/ORM/cenário da task. Não precisa aplicar tudo; precisa aplicar o que é relevante e nunca violar as "Regras inegociáveis".

---

## ⚠️ 1. ORDEM DE OPERAÇÃO (não inverta)

1. **DETECTE as convenções de banco do projeto ANTES de escrever qualquer DDL/query.**
2. **Se existir um padrão** (ORM, ferramenta de migration, naming, estratégia de índice) → siga rigorosamente. Este rulebook vira checklist de qualidade técnica (índices, transações, plano de execução), **não** licença pra "trocar de ORM" ou "renomear tudo".
3. **Se NÃO existir padrão** (greenfield) → estabeleça um deliberadamente (ferramenta de migration, convenção de nomes, tipos) e documente enquanto implementa.
4. **As regras inegociáveis (seção 4)** valem nos dois modos, sempre.

## 2. Detecção do schema/banco existente

Antes de escrever qualquer linha de SQL/migration/modelo, procure por:

- **RDBMS / driver**: `package.json`/`requirements.txt`/`go.mod`/`pom.xml`/`Gemfile` → qual banco e qual client (pg, mysql2, psycopg, sqlx, etc.). Connection string em `.env`/`config` → Postgres? MySQL? SQLite? SQL Server? Oracle? Mongo?
- **ORM / query builder**: Prisma (`schema.prisma`), TypeORM/Sequelize/Drizzle, Knex, SQLAlchemy/Alembic, Django ORM, ActiveRecord, GORM, Ecto, jOOQ/Hibernate. **Ou SQL puro** (arquivos `.sql`, repositório de queries).
- **Ferramenta de migration**: `migrations/`, `prisma/migrations/`, `db/migrate/`, `alembic/`, Flyway (`db/migration/V*`), Liquibase, `golang-migrate`, `goose`. Como roda (up/down)? Tem rollback?
- **Convenção de nomes**: tabelas no singular ou plural? snake_case ou camelCase? PK é `id`/`uuid`/`<tabela>_id`? FK como `<tabela>_id`? timestamps `created_at`/`updated_at` ou `createdAt`?
- **Tipos e padrões**: usa `uuid` ou `serial`/`bigint` autoincremento? `timestamptz` ou `timestamp`? enums no banco ou em código? soft-delete (`deleted_at`)? multi-tenant (coluna `tenant_id`/`company_id` em tudo)?
- **Índices e constraints existentes**: como FKs são indexadas? unique compostos? índices parciais? Olhe migrations antigas pra ver o estilo.
- **Seeds / fixtures**: `seeds/`, `factories/`, dados de teste — pra não reinventar.

Reporte na sua resposta inicial (antes de codar) um bloco curto:

```
### Schema/DB detectado
- RDBMS: PostgreSQL 15 (driver: pg via Prisma)
- ORM/migration: Prisma — migrations em prisma/migrations, rollback via prisma migrate
- Naming: tabelas snake_case plural, PK uuid `id`, FK `<tabela>_id`, timestamps created_at/updated_at (timestamptz)
- Multi-tenant: coluna company_id em todas as tabelas de negócio
- Soft-delete: deleted_at (nullable) nas tabelas X, Y

Modo de operação: **seguir padrão existente**
```

ou:

```
### Schema/DB detectado
Greenfield. Sem ORM, sem migrations, sem schema. Banco: [definir/confirmar].

Modo de operação: **estabelecer padrão** (escolher ferramenta de migration + convenção)
```

## 3. Modo de operação

### 3A — "seguir padrão existente"

Quando o projeto JÁ tem banco/ORM:

- **Use a ferramenta de migration do projeto.** NUNCA edite schema manualmente no banco nem altere uma migration já aplicada/commitada — crie uma nova migration forward.
- **Match a convenção de nomes ao pé da letra.** Se é snake_case plural, sua tabela nova é snake_case plural. PK/FK/timestamps no mesmo formato. Inconsistência de naming é dívida permanente.
- **Reuse os tipos do projeto.** Se o padrão é `uuid` pra PK, não crie `serial`. Se usa `timestamptz`, não introduza `timestamp` naive. Se enums vivem em código, não crie enum no banco (e vice-versa).
- **Respeite multi-tenancy.** Se toda tabela tem `tenant_id`/`company_id`, a sua também tem — e TODA query filtra por ele. Vazamento entre tenants é incidente de segurança.
- **Respeite soft-delete.** Se o projeto usa `deleted_at`, suas queries de leitura filtram `deleted_at IS NULL` e você não dá `DELETE` físico sem motivo.
- **Modelo novo segue a estrutura de arquivo do projeto** (mesma pasta de models/entities, mesmo padrão de relação, mesmo estilo de repository).

### 3B — "estabelecer padrão" (greenfield)

Quando não há banco/ORM:

- Escolha **uma** ferramenta de migration e comprometa-se com ela (reversível, versionada, em arquivo). Não rode DDL solto.
- Defina a convenção de nomes **explicitamente** e documente em `docs/db.md` ou comentário no schema (naming, PK strategy, timestamps, soft-delete sim/não, multi-tenant sim/não). A próxima migration vai se ancorar nisso.
- Escolha tipos com intenção: `uuid` vs `bigint` (tradeoff documentado — ver Apêndice C), `timestamptz` pra tempo, `numeric` pra dinheiro (NUNCA `float`), `text` vs `varchar(n)` conforme o banco.
- Crie a primeira migration já com as constraints certas (PK, FK com índice, NOT NULL, unique onde faz sentido) — não deixe pra "depois".

## 4. Regras inegociáveis — valem SEMPRE (nos dois modos)

**Migrations / mudança de schema**
- ❌ **Nunca** editar uma migration já commitada/aplicada. Mudança = nova migration forward.
- ✅ Toda migration tem **caminho de volta** (down reversível, ou plano explícito de rollback se for irreversível — ex.: drop de coluna com dados).
- ✅ Migration **destrutiva** (drop column/table, mudança de tipo com perda) é sinalizada no relatório com risco e, quando possível, feita em fases (expand → migrate data → contract — ver Apêndice E).
- ✅ Migration de schema e migration de dados (backfill) separadas quando o volume é grande — backfill em lote, não um `UPDATE` gigante que trava a tabela.
- ✅ Em tabela grande, evite lock longo: adicionar coluna NOT NULL com default em Postgres antigo, criar índice sem `CONCURRENTLY`, mudança de tipo que reescreve a tabela, etc. Pense no impacto em produção.

**Integridade**
- ✅ Toda FK tem constraint de FK real no banco (não só "convenção") **e índice na coluna FK** (FK sem índice = scan em cascata e em joins).
- ✅ `NOT NULL` onde o dado é obrigatório. `UNIQUE` onde a regra de negócio exige unicidade (inclusive compostos).
- ✅ `CHECK`/enum pra domínios fechados. Dinheiro em `numeric`/`decimal`, nunca float.
- ✅ Constraint de integridade no banco > validação só na aplicação (a app não é a única porta de entrada).
- ✅ Decida o comportamento de `ON DELETE`/`ON UPDATE` de cada FK conscientemente (CASCADE, RESTRICT, SET NULL) — default silencioso causa surpresa.

**Queries — performance e segurança**
- ❌ **String concatenada com input em query = proibido.** SEMPRE query parametrizada / prepared statement / binding do ORM. (SQL injection.)
- ❌ **N+1**: loop disparando uma query por item. Use join, `IN`, ou eager-load do ORM. Se você escreveu um loop com query dentro, pare e reescreva set-based.
- ❌ `SELECT *` em código de produção — selecione as colunas necessárias (evita over-fetch e quebra silenciosa ao mudar schema).
- ✅ Toda query nova de leitura relevante: pense no índice que ela usa. Sem índice adequado em coluna de filtro/join/order = full scan. Adicione o índice na mesma migration.
- ✅ Paginação por keyset/cursor quando a tabela cresce (não `OFFSET` alto em tabela grande).
- ✅ `EXISTS` em vez de `COUNT(*) > 0`; filtre cedo; trate `NULL` explicitamente (três valores: NULL não é igual a nada).

**Transações e concorrência**
- ✅ Operação multi-passo que precisa ser atômica roda em **uma transação**. Não deixe estado meio-gravado.
- ✅ Escolha do isolation level consciente quando há concorrência real (default na maioria é Read Committed). Documente se precisar de Serializable/Repeatable Read.
- ✅ Previna deadlock: acesse recursos em ordem consistente; mantenha transações curtas; não faça I/O externo (HTTP) dentro de transação aberta.
- ✅ Concorrência em update: escolha entre lock pessimista (`SELECT ... FOR UPDATE`) e otimista (coluna de versão) conscientemente.
- ✅ Idempotência em jobs/webhooks/retries que escrevem (unique key, upsert, ou guarda de "já processado").

**Segurança de dados**
- ✅ Filtro por tenant/empresa em TODA query quando o schema é multi-tenant. Considere Row-Level Security no Postgres pra reforçar no banco.
- ✅ Sem secret/credencial hardcoded — connection string via env. `.env.example` atualizado se mudar config.
- ✅ Nada de PII em log de query/erro. Mascare ou omita.
- ✅ Princípio do menor privilégio se a task tocar grants/roles. Encryption at rest / column-level pra dado sensível quando exigido.

## 5. Loop obrigatório de validação

Antes de marcar a story como **Ready for Review**:

1. **Rodar a migration up** num banco limpo/dev — tem que aplicar sem erro.
2. **Rodar o down** (ou o rollback) — tem que reverter sem deixar lixo. Se irreversível, declarar isso explicitamente.
3. **Testes** que cobrem o comportamento da query/modelo (com dados representativos, não só 1 linha feliz). Inclua o caso de borda (vazio, NULL, duplicado, violação de constraint).
4. **`EXPLAIN` / plano de execução** nas queries novas que importam — confirmar uso de índice, sem seq scan inesperado em tabela grande. (Apêndice D pra ler plano.)
5. Se multi-tenant: teste explícito de que um tenant **não** enxerga dado de outro.

Se o ambiente não permitir rodar o banco, **deixe explícito** no relatório: "Não validei contra banco real — ambiente sem DB. Recomendo aplicar migration up/down e rodar EXPLAIN nas queries X, Y antes do merge." Nunca alegue "validei" se não rodou.

## 6. Saída esperada do subagent

Além do que o `@dev` BMAD pede (File List, Dev Agent Record, status Ready for Review):

- Bloco "### Schema/DB detectado" no início (da seção 2).
- **Migrations criadas** (nome do arquivo + o que fazem) e se têm down/rollback.
- **Mudanças de schema** resumidas (tabelas/colunas/constraints/índices adicionados ou alterados).
- **Índices adicionados** e por qual query/filtro cada um existe.
- **Queries relevantes** e o plano de execução observado (ou nota de que não foi possível rodar EXPLAIN).
- **Riscos de produção** (lock, migration destrutiva, backfill pesado) e mitigação.
- **Validação**: o que foi rodado (up/down, testes, EXPLAIN, teste de isolamento de tenant). Ou nota explícita.
- **Tradeoffs aceitos** (ex.: "usei uuid v4 apesar de fragmentação de índice porque o resto do schema é uuid").

---

# Apêndices de profundidade (consulte conforme a task)

## Apêndice A — Especificidades por RDBMS (gotchas)

### PostgreSQL
- **Índice sem travar produção:** `CREATE INDEX CONCURRENTLY` (não pode rodar dentro de transação; muitas ferramentas de migration exigem flag pra isso). Sem `CONCURRENTLY`, o `CREATE INDEX` segura lock de escrita na tabela.
- **`ALTER TABLE` e lock:** adicionar coluna `NULL` sem default é instantâneo (PG 11+ também com default constante). Adicionar `NOT NULL` força validação — em tabela grande, faça em fases (add nullable → backfill → set not null com `NOT VALID` + `VALIDATE CONSTRAINT`).
- **Mudança de tipo** (`ALTER COLUMN ... TYPE`) costuma reescrever a tabela inteira (lock pesado). Avalie coluna nova + backfill + swap.
- **Tipos fortes:** `timestamptz` (sempre, nunca `timestamp` naive), `jsonb` (indexável via GIN, não `json`), `text` (sem penalidade vs `varchar`), `numeric` pra dinheiro, `uuid` nativo, arrays, `enum` nativo (cuidado: adicionar valor a enum é fácil, remover não), tipos de range, `citext` pra case-insensitive.
- **VACUUM/autovacuum:** updates/deletes geram bloat; tabela muito atualizada precisa de autovacuum agressivo. Não é problema da migration, mas mencione se criar tabela hot.
- **Índices especiais:** parcial (`WHERE deleted_at IS NULL`), de expressão (`lower(email)`), GIN/GiST (jsonb, full-text, geoespacial via PostGIS), BRIN (tabelas enormes append-only).
- **RLS (Row-Level Security):** reforço de multi-tenancy no nível do banco.
- **Upsert:** `INSERT ... ON CONFLICT (...) DO UPDATE`.

### MySQL / MariaDB
- **Engine:** confirme InnoDB (transacional, FK) e não MyISAM. Charset `utf8mb4` (o `utf8` é só 3 bytes — não cobre emoji). Collation consistente.
- **Online DDL:** `ALGORITHM=INPLACE, LOCK=NONE` quando suportado; senão use pt-online-schema-change/gh-ost pra tabela grande. DDL implica commit implícito (não dá rollback de DDL dentro de transação).
- **Limite de chave / prefixo de índice:** índices em `VARCHAR` longo podem precisar de prefixo. `TEXT`/`BLOB` exigem prefixo.
- **AUTO_INCREMENT** vs UUID (ver Apêndice C). `DATETIME` vs `TIMESTAMP` (range e timezone diferentes — `TIMESTAMP` converte pra UTC).
- **Upsert:** `INSERT ... ON DUPLICATE KEY UPDATE`. Dinheiro em `DECIMAL`.
- **Replicação:** binlog; cuidado com statements não-determinísticos em replicação statement-based.

### SQL Server
- **Clustered index = ordem física** da tabela (geralmente a PK). Escolha a chave clusterizada com cuidado (afeta todos os índices não-clusterizados).
- **Covering index** via `INCLUDE`. Filtered indexes. Columnstore pra analytics.
- Isolation: habilite `READ_COMMITTED_SNAPSHOT` pra evitar leitores bloqueando escritores. Cuidado com lock escalation.
- Tipos: `DATETIME2` (não `DATETIME`), `DECIMAL`/`MONEY` pra dinheiro, `NVARCHAR` pra unicode, `UNIQUEIDENTIFIER` pra GUID. `MERGE` pra upsert (conhecer os bugs/cuidados).

### Oracle
- Sequences + triggers (ou `IDENTITY` em 12c+) pra autoincremento. `VARCHAR2` (não `VARCHAR`). `NUMBER` pra dinheiro. `TIMESTAMP WITH TIME ZONE`.
- Partitioning forte (range/list/hash). Bitmap indexes pra baixa cardinalidade em DW. `MERGE` pra upsert. Cuidado com tratamento de string vazia = NULL.

### SQLite
- **`ALTER TABLE` é limitado:** historicamente só add column / rename. Mudança maior = recriar tabela (create new → copy → drop → rename). Migrations precisam disso.
- Tipagem dinâmica (type affinity) — não confie no banco pra forçar tipo; valide na app. Sem tipo nativo de boolean/datetime (use INTEGER/TEXT). Concorrência de escrita limitada (1 writer); WAL mode ajuda. Ótimo pra dev/teste/embarcado, não pra alta concorrência.

## Apêndice B — NoSQL

### MongoDB
- **Modele pelo padrão de acesso, não pela "forma normalizada".** Embed o que é lido junto e tem cardinalidade limitada; referencie (com `_id`) o que cresce sem limite ou é compartilhado.
- Atenção ao limite de 16MB por documento e a arrays que crescem sem teto (anti-pattern unbounded array).
- **Índices** importam tanto quanto em SQL: índice composto respeita a regra ESR (Equality, Sort, Range). `explain()` pra checar uso. Índice único, parcial, TTL (expiração automática).
- **Transações multi-documento** existem (replica set/sharded) mas custam — prefira modelagem que torne a operação atômica num único documento quando der.
- Schema validation (`$jsonSchema`) pra não virar terra sem lei. Cuidado com consistência eventual em leituras de secundário (`readConcern`/`writeConcern`).

### Redis
- É store em memória — **escolha a estrutura certa** (string, hash, list, set, sorted set, stream, HyperLogLog), não jogue JSON em string sempre.
- **TTL/expiração** explícito no que é cache. Defina política de eviction (`maxmemory-policy`).
- Padrões: cache-aside, rate limiting (INCR+EXPIRE), lock distribuído (Redlock — conhecer as ressalvas), fila/stream, leaderboard (sorted set).
- Persistência (RDB/AOF) e o fato de que cache pode sumir — o código nunca pode *depender* do dado estar lá.

## Apêndice C — Chave primária: `uuid` vs autoincremento

- **Autoincremento (`bigint`/`serial`/identity):** compacto, índice sequencial sem fragmentação, ótima localidade. Mas expõe contagem/ordem (enumerável) e atrapalha geração distribuída/merge offline.
- **UUID v4 (aleatório):** não enumerável, gerável no cliente/distribuído. Mas é grande (16 bytes) e **fragmenta índice B-tree** (inserções aleatórias) — penaliza write-heavy.
- **UUID v7 / ULID (ordenável por tempo):** melhor dos dois mundos pra muitos casos — não enumerável e com boa localidade de inserção. Prefira se for adotar UUID novo.
- **Regra prática:** num projeto existente, **siga o que já existe**. Em greenfield, decida pelo tradeoff e **documente**.

## Apêndice D — Lendo plano de execução (EXPLAIN)

- **Sinais ruins:** `Seq Scan`/full table scan em tabela grande quando havia filtro seletivo; `Nested Loop` sobre muitas linhas sem índice; estimativas de linha muito longe do real (estatísticas desatualizadas → rode `ANALYZE`); `Sort`/`Hash` derramando em disco; índice existente sendo ignorado (tipo incompatível no filtro, função na coluna sem índice de expressão).
- **Postgres:** `EXPLAIN (ANALYZE, BUFFERS)` mostra tempo e custo reais. MySQL: `EXPLAIN ANALYZE` / `EXPLAIN FORMAT=JSON`. SQL Server: plano de execução real + `SET STATISTICS IO`.
- **Índice composto:** a ordem das colunas importa — coloque as de igualdade primeiro, depois range/sort (regra ESR vale aqui também). Um índice em `(a, b)` serve filtro por `a` e por `a,b`, mas não por `b` sozinho.
- **Covering index:** se o índice contém todas as colunas que a query lê, evita ir à tabela (index-only scan).

## Apêndice E — Migrations seguras / zero-downtime

- **Expand → Migrate → Contract** (a regra de ouro pra mudança incompatível):
  1. *Expand:* adicione o novo (coluna/tabela nullable, nova FK sem NOT NULL) — compatível com o código antigo e o novo.
  2. *Migrate:* faça deploy do código que escreve nos dois lugares; backfill em lote dos dados antigos.
  3. *Contract:* quando ninguém mais usa o antigo, remova (numa migration posterior).
- **Renomear coluna** sem downtime = add nova → copiar → escrever nas duas → ler da nova → dropar a antiga depois. Rename direto quebra o app rodando.
- **Backfill em lote:** `UPDATE` por faixas de PK/lotes com pausa, não um `UPDATE` único que trava a tabela e estoura o WAL/undo log.
- **Adicionar NOT NULL/constraint** em tabela grande: adicione `NOT VALID` (Postgres) e valide depois, ou cheque em lote antes de aplicar.
- Toda migration deve ser **idempotente o suficiente** pra reentrância (use `IF NOT EXISTS` quando a ferramenta não garante) e ter rollback testado.

## Apêndice F — Padrões de query avançados

- **CTEs** (`WITH`) pra legibilidade; cuidado com CTE materializada (Postgres < 12 era barreira de otimização; 12+ pode inline). **Recursive CTE** pra hierarquia/grafo (árvore de categorias, BOM, org chart).
- **Window functions** pra análise sem colapsar linhas: `ROW_NUMBER/RANK/DENSE_RANK` (dedup, top-N por grupo), `LAG/LEAD` (diferença entre linhas), running total (`SUM() OVER (ORDER BY ...)`), `NTILE`/percentil. Entenda a `frame clause` (`ROWS BETWEEN ...`).
- **Dedup top-N por grupo:** `ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) = 1`.
- **Agregação:** `GROUP BY` + `HAVING`; `FILTER (WHERE ...)` (Postgres) pra agregação condicional; `GROUPING SETS`/`ROLLUP`/`CUBE` pra subtotais.
- **Upsert** conforme o banco (seção por-RDBMS). **Soft delete** consistente (sempre filtrar). **Paginação keyset:** `WHERE (created_at, id) < (:last_ts, :last_id) ORDER BY created_at DESC, id DESC LIMIT n`.

## Apêndice G — Data warehousing / analytics (quando a task é OLAP, não OLTP)

- **Star schema:** fato (métricas + FKs) cercado de dimensões (atributos). Snowflake = dimensões normalizadas. Não modele relatório pesado em cima de tabelas OLTP normalizadas se o volume dói.
- **Slowly Changing Dimensions:** Tipo 1 (sobrescreve), Tipo 2 (versiona com `valid_from/valid_to` + flag current). Escolha conforme a necessidade de histórico.
- **Colunar:** columnstore (SQL Server), particionamento + compressão, tabelas de agregado/materialized views pra acelerar. Carga incremental (CDC, watermark por timestamp) em vez de full reload.
- **Separação OLTP × OLAP:** analytics pesado vai pra réplica/warehouse, não bate no primário transacional.

## Apêndice H — Guia por ORM / ferramenta

- **Prisma:** schema declarativo (`schema.prisma`); `prisma migrate dev/deploy`; relações via `@relation`; cuidado com N+1 (use `include`/`select`, não loop); `prisma migrate` gera SQL — revise o SQL gerado em mudança sensível. Índice via `@@index`, unique via `@@unique`.
- **TypeORM/Sequelize/Drizzle:** migrations versionadas; eager vs lazy loading explícito; evite `synchronize: true` em produção (gera DDL automático perigoso).
- **SQLAlchemy + Alembic:** `alembic revision --autogenerate` **não é confiável sozinho** — revise sempre o script gerado (não pega tudo, ex.: mudança de tipo, alguns índices). `relationship()` lazy loading → N+1; use `selectinload`/`joinedload`.
- **Django ORM:** `makemigrations`/`migrate`; `select_related` (join, 1-N reverso/FK) e `prefetch_related` (N-N/1-N) contra N+1; `RunPython` pra data migration (com `reverse_code`!); `.only()/.defer()` contra over-fetch.
- **ActiveRecord (Rails):** migrations reversíveis (`change` vs `up`/`down`); `includes`/`preload`/`eager_load` contra N+1; `strong_migrations` gem pega migration perigosa; índice via `add_index ... algorithm: :concurrently`.
- **GORM (Go):** `AutoMigrate` é limitado (não dropa coluna, não muda tipo com segurança) — pra produção prefira migration SQL explícita (golang-migrate/goose). `Preload` contra N+1.
- **Regra transversal:** o ORM esconde SQL, mas **você é responsável pelo SQL que ele gera.** Em query quente, ligue o log de SQL do ORM e rode `EXPLAIN` no que sai. ORM mal usado é a fonte #1 de N+1 e over-fetch.

---

## Anti-padrões fatais (database)

- ❌ Editar uma migration já aplicada/commitada em vez de criar uma nova
- ❌ Migration sem caminho de volta (e sem avisar que é irreversível)
- ❌ Query montada com string + input do usuário (SQL injection)
- ❌ N+1 escondido num loop com query dentro (ou ORM lazy mal usado)
- ❌ FK sem índice
- ❌ Dinheiro em `float`/`double`
- ❌ `SELECT *` em código de produção
- ❌ Esquecer o filtro de tenant em schema multi-tenant (vazamento entre clientes)
- ❌ `DELETE`/`UPDATE` sem `WHERE` (ou com `WHERE` que pega mais do que devia) — confirme o alcance
- ❌ Naming fora da convenção do projeto (camelCase numa base snake_case, etc.)
- ❌ Backfill de tabela enorme num único `UPDATE` que trava produção
- ❌ Criar índice em tabela grande sem `CONCURRENTLY` (Postgres) / sem online DDL (MySQL) num horário de pico
- ❌ Transação longa segurando lock enquanto faz chamada HTTP externa
- ❌ Rename direto de coluna/tabela com o app rodando (quebra deploy) — use expand/contract
- ❌ `synchronize: true` / `AutoMigrate` gerando DDL automático em produção
- ❌ utf8 (3 bytes) em MySQL quando precisa de emoji/unicode pleno (use utf8mb4)
- ❌ `timestamp` naive quando devia ser `timestamptz`/com timezone
