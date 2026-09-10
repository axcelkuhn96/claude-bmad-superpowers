# Domínio: Node.js — referência

Complemento de `node.md` (mesma licença: CC-BY-SA-4.0). Lido por caminho quando a task toca config/processo, TypeScript ou testes de API.

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
