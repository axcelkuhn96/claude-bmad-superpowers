# Domínio: Node.js / Express / TypeScript

Rulebook lido por caminho pelo subagent `general-purpose` quando a task toca código Node (API Express/Fastify, worker, CLI, script TS/JS de servidor). **Stacka em cima do `@dev` BMAD e do ponytail**, não substitui — o subagent é Dev + Node. Empilha `database.md` se toca banco, `integracao.md` se chama API externa, `frontend.md` se é React/Vue no mesmo repo (ordem: @dev → ponytail → node → área). Regra inegociável de área vence a daqui.

> Adaptado de: Express "Production Best Practices" (CC-BY-4.0), goldbergyoni/nodebestpractices (CC-BY-SA-4.0), OWASP Node.js Security Cheat Sheet (CC-BY-SA-4.0), `typescript-reviewer` do ECC (MIT). Reescrito em pt-BR com atribuição; por derivar de fontes CC-BY-SA, **este arquivo é CC-BY-SA-4.0** + affaan-m/ECC @ e482e57 (MIT, Copyright (c) 2026 Affaan Mustafa).
> Regras adicionais destiladas de affaan-m/ECC @ e482e57 (agents/{typescript-reviewer,build-error-resolver}.md, rules/typescript/{coding-style,testing}.md, scripts/hooks/config-protection.js) — MIT License, Copyright (c) 2026 Affaan Mustafa (https://github.com/affaan-m/ECC/blob/e482e57/LICENSE).

## Gatilhos (Fase 3 do executor)
- Arquivos: `package.json` com `express` | `fastify` | `@nestjs/core` | `koa` | `hono`; `tsconfig.json`; `src/**/*.{ts,js,mjs,cjs}`; `server.{ts,js}`, `app.{ts,js}`, `routes/`, `controllers/`, `middlewares/`, `jobs/`, `workers/`; `vitest.config.*`/`jest.config.*`; `.env.example`.
- Story menciona: endpoint, rota, middleware, API REST, JWT, sessão, webhook (→ também `integracao`), job/cron/fila (BullMQ), CLI, script Node, TypeScript, upgrade de Node.
- Só componente React/Vue → `frontend` (não `node`). Next.js API route/server action → `node + frontend`.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)
1. **Detecte runtime, tooling e convenções antes de escrever.** Node (`.nvmrc`/`engines`), gerenciador e lockfile, ESM ou CJS, TS `strict`?, lint/format, framework e versão (Express 5 propaga rejeição de handler async; o 4 precisa de wrapper), validação (zod/joi/ajv), logger, teste (vitest/jest + supertest), ORM.
2. **Siga o que o projeto faz.** Não troque CJS↔ESM, não introduza zod onde o projeto usa joi, não mude de jest pra vitest, não adicione camada Repository/Service se as rotas chamam o ORM direto e isso é o padrão.
3. **Greenfield:** TS `strict`, ESM, zod, pino, vitest + supertest, eslint + prettier (ou biome); decisão documentada em 1 parágrafo no README/CLAUDE.md do projeto. Sem dependência que a stdlib resolve (`node:fs/promises`, `node:crypto`, `fetch` nativo, `structuredClone`).

## Detecção (reporte antes de codar)
```
### Convenções Node detectadas
- Node 22.x · pnpm · ESM · TS strict (sim/não)
- Framework: Express 5.x (ou 4.x + wrapper async)
- Validação: zod na borda (Request → schema → handler)
- Erros: classe AppError(isOperational, status) + middleware central em src/errors/
- Log: pino, request-id via middleware · Config: src/config.ts validando process.env no boot
- Auth: JWT (jose) / sessão (express-session + store) / nenhum
- Testes: vitest + supertest · porta aleatória · DB de teste: ...
- Lint/tsc: scripts `lint`, `typecheck`, `test`
Modo: seguir padrão | estabelecer padrão
```

## Regras inegociáveis (valem sempre)

**Validação e segurança (bloqueante em review — primeira coisa que o reviewer confere)**
- Toda entrada externa (body, query, params, headers usados, payload de fila/webhook) passa por schema na borda (zod/joi/ajv — o do projeto) **antes** do handler; 400 com lista de issues, sem eco de valor sensível. Tipos inferidos do schema (`z.infer`), não duplicados à mão.
- Query só por parâmetro/ORM; nunca template string com input em SQL. Mongo: nunca passar objeto de input direto em filtro (`{ $gt }` injection) — sanitize/schema com tipos primitivos.
- Sem `eval`/`new Function`/`vm` com input. `child_process`: `execFile`/`spawn` com array, nunca `exec` com string de usuário. Path de arquivo de usuário → `path.resolve` + checar prefixo. Redirect só pra allowlist. Regex de input sem catastrophic backtracking (ou `re2`).
- Auth em toda rota de escrita **e** autorização por recurso (owner/tenant) — autenticado ≠ autorizado. Teste cross-tenant → 404.
- Sessão: nome de cookie não-default; `secure`, `httpOnly`, `sameSite`, `path`, `expires`/`maxAge`; store externo (não memória) em produção. JWT: algoritmo fixo (`algorithms: [...]`), expiração curta, verificação por lib (`jose`/`jsonwebtoken`), revogação/rotação quando há logout; segredo ≥ 256 bits via env. Senha só com `bcrypt`/`argon2`.
- Rate limit em login/reset/OTP (por conta **e** por IP) e em rotas caras; brute-force = bloqueio progressivo (`express-rate-limit`/`rate-limiter-flexible` ou o proxy).
- `helmet()` (ou equivalente do framework) e `app.disable('x-powered-by')`. Limite de payload (`express.json({ limit })`, menor por rota quando cabe). `hpp` se query arrays não são esperadas. CORS com allowlist explícita — nunca `*` com credenciais.
- Resposta: só os campos necessários (allowlist/DTO), nunca `res.json(user)` com hash/segredo. Merge de objeto de input (`Object.assign`/spread/`merge`) só após schema (prototype pollution).
- Estado mutável de módulo (`let`/`Map` global) com dado de request/usuário vaza entre requests e tenants → escopo do handler ou store externo. (ECC typescript-reviewer)
- Segredo só via `process.env` validado **no boot** em um módulo de config (falha rápido se faltar); nunca literal, nunca `|| 'default'`, nunca em log. `npm audit --audit-level=high` (ou pnpm/yarn) no loop.

**Erros e async (bloqueante)**
- Toda promise é aguardada **ou** tem `.catch` com ação. Handler `async` em Express 4 passa erro pro `next` (wrapper) — nunca fica "flutuando". `array.forEach(async …)` = bug; use `for…of` ou `Promise.all`/`allSettled`.
- `await` sequencial em trabalho independente → `Promise.all`. `return await` dentro de `try` (pra capturar e manter stack).
- Erros são `Error` (ou subclasse com `cause`, `isOperational`, `status`); nunca `throw "string"`. `JSON.parse` de input sempre em try.
- `catch (e)`: `e` é `unknown` (`strict`) → `instanceof Error` antes de `.message`. Erro novo que embrulha `e` leva `{ cause: e }` (lib ≥ es2022); re-lançar o mesmo é `throw e`. (ECC rules/typescript/coding-style; medido TS 5.9)
- Em código `async`, I/O de callback → `node:fs/promises`, `node:stream/promises` ou `util.promisify`; não misture os estilos. (ECC typescript-reviewer)
- **Um** handler central de erro (último middleware, 4 args no Express) que loga com contexto e responde por tipo: operacional → status + mensagem segura; desconhecido → 500 genérico + log completo. Sem stack pro cliente.
- `process.on('unhandledRejection')`/`process.on('uncaughtException')`: **só** logar e `process.exit(1)` quando não-operacional. Nunca "engolir e seguir" — quem reinicia é o supervisor. Sem `domain`.
- `catch (e) {}` vazio ou `catch` que devolve `null`/`[]` sem log e sem a spec pedir = bug (piso do ponytail).
- EventEmitter/stream: assinar `'error'`; try/catch não pega. Nada de `*Sync` (fs, crypto, child_process) em caminho de request. CPU pesada → worker thread/fila.

**Config, log, processo · TypeScript · Testes** → `dominios/node-referencia.md` (lido por caminho; resumo: `NODE_ENV`, lockfile + `npm ci`, log estruturado sem PII, graceful shutdown em `SIGTERM`, processo stateless; TS `strict` nunca afrouxado, `any` só justificado; testes de API com supertest cobrindo os 5 outcomes, tempo/rede controlados).

## Testes
- Asserção async com `await`/`return` (`await expect(p).rejects…`): flutuante passa em falso. (ECC typescript-reviewer)
- Fluxo crítico com UI no mesmo repo: E2E no runner que o projeto já tem; sem runner, validação Playwright do tipo `ui` (sem dep nova). (ECC rules/typescript/testing)

## Build quebrado
- Reproduza como o Stop: `node_modules/.bin/tsc --noEmit --pretty false -p <tsconfig.json mais próximo>` (project references: script `typecheck`, não `tsc -b`). Pós-edição: `biome format --write <arq>` (com `biome.json(c)`) ou `prettier --write <arq>` (com config), de `node_modules/.bin`. (hooks cbs-typecheck, cbs-format; ECC typescript-reviewer)
- `incremental`/`composite`: até o `--noEmit` grava `*.tsbuildinfo` (`outDir` ou ao lado do tsconfig), que esconde erro após mudar `type`/tsconfig → `--incremental false` ou apague-o. Bundler: `rm -rf node_modules/.cache .next`; deps: `rm -rf node_modules && npm ci` ou o do gerenciador (lockfile fica). (ECC build-error-resolver; medido TS 5.9)
- Erro de módulo (ESM/CJS, `paths`, `.ts` direto) e `TS7016` → `dominios/node-referencia.md`.
- Tipo incompatível/`possibly 'undefined'` → corrija, guard ou schema; sem calar com `any`/`as`/`@ts-ignore` (inevitável: `@ts-expect-error` + motivo). (ECC build-error-resolver, ECC typescript-reviewer; medido TS 5.9)
- Não afrouxe `tsconfig` (`strict`…), eslint, prettier ou biome pra passar. (ECC typescript-reviewer, ECC config-protection; hook cbs-config-protect, exceto `tsconfig.json`)

## Loop obrigatório de validação (antes de Ready for Review)
```
npm run lint                   # eslint (+ eslint-plugin-security se o projeto tiver)
npm run typecheck              # tsc --noEmit -p tsconfig.json (ou build)
npm test -- <escopo> && npm test
npm audit --audit-level=high   # ou pnpm/yarn/bun audit
```
Use os scripts do projeto; se não existem, rode `tsc --noEmit` e `vitest run`/`jest --ci` direto. Cole a saída resumida no Dev Agent Record; declare o que não rodou.

## Saída esperada (além do @dev)
- Bloco "Convenções Node detectadas". Dependências novas (idealmente zero) justificadas pela escada do ponytail.
- Tabela por rota/handler nova: schema de entrada → auth/autorização → erros possíveis (status) → o que loga.
- Como o shutdown e os handlers de processo ficaram (ou "já existiam em X").
- Saída do loop de validação.

## Anti-padrões fatais
- ❌ `req.body` direto no ORM sem schema ❌ `res.json(user)` com hash ❌ segredo literal / `|| 'default'` ❌ `exec` com string de usuário
- ❌ Promise flutuante / `forEach(async)` / `catch` vazio ❌ `uncaughtException` que loga e **continua** ❌ `console.log` como log ❌ `*Sync` em request
- ❌ Afrouxar `strict`/adicionar `any` pra passar no tsc ❌ Trocar ESM/CJS, jest/vitest, zod/joi do projeto ❌ Adicionar Repository/Service "por arquitetura" onde não existe
