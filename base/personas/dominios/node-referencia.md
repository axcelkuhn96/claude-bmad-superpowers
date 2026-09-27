# Domínio: Node.js — referência

Complemento de `node.md` (mesma licença: CC-BY-SA-4.0). Lido por caminho quando a task toca config/processo, TypeScript, testes de API ou build quebrado.

> Seção "Build quebrado" destilada de affaan-m/ECC @ e482e57 (agents/build-error-resolver.md) — MIT License, Copyright (c) 2026 Affaan Mustafa (https://github.com/affaan-m/ECC/blob/e482e57/LICENSE).

## Config, log, processo
- `NODE_ENV=production` em prod. Lockfile commitado; `npm ci` em CI/imagem. Versão LTS. `node:` prefix nos built-ins.
- Log estruturado (pino/winston) em **stdout**, nível certo, `request-id` por request; nunca `console.log` como log de serviço; nunca senha/token/PII no log (`redact`).
- **Graceful shutdown**: em `SIGTERM`/`SIGINT` parar de aceitar conexões (`server.close`), drenar as em curso com timeout, fechar DB/fila, sair com código correto. Em Docker: `CMD ["node","dist/server.js"]` (npm não repassa sinal).
- Estado em store externo (sessão, cache, upload) — processo stateless.

## TypeScript
- `strict` ligado e **não afrouxado** no diff. `any` só com comentário do porquê; prefira `unknown` + narrowing. `!` só após guard. `as` não pra silenciar erro. Retorno explícito em função pública. `===`. `const` por default. Sem `require` em ESM (e vice-versa) sem motivo.

## Testes (vitest/jest + supertest)
- TDD do fluxo Superpowers (tipo `regra-de-negocio`). Comece por teste de **API** (supertest contra o app, sem `listen` ou `listen(0)`), unit só pra lógica pura.
- Cada fluxo cobre os **5 outcomes**: resposta (status + corpo), mudança de estado (DB/arquivo), chamada externa (`nock`/`msw`, nunca internet), mensagem em fila/evento, observabilidade (log/métrica) quando importa.
- Erros: 400 de validação com mensagem, 401/403, 404, e o caminho de exceção não-operacional (500 genérico + log).
- Nome com 3 partes: unidade → cenário → resultado esperado. AAA. Cada teste cria seu próprio dado; sem fixture global mutável. Tempo/aleatoriedade controlados (`vi.useFakeTimers`/`jest.useFakeTimers`).
- Middleware pesado testado isolado com `{req,res,next}` stub.

## Build quebrado (erro de módulo)
- `TS2835` (relativo sem extensão em `node16`/`nodenext`) → `./x.js`. `TS1479`/`ERR_REQUIRE_ESM` (CJS importando só-ESM) → `import()` ou `module: nodenext` (TS ≥5.8, Node ≥20.19/22.12); sem trocar o `type`. (ECC build-error-resolver)
- `paths` só vale no `tsc`: `ERR_MODULE_NOT_FOUND` em `@/…` no `node` → o resolvedor do projeto (`imports` `#…`, bundler, `tsx`). `Cannot find module` → caminho, `paths` ou pacote ausente. (ECC build-error-resolver)
