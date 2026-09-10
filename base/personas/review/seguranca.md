# Review: Segurança + falha silenciosa

Lente **só de reviewer** (task reviewer de toda task backend — `laravel` | `python` | `node` | `integracao`; reviewer final e `/revisar` sempre). Cobre o que `security-guidance` e `/security-review` excluem (rate limit, hardening, CORS, CVE, testes, falha silenciosa). Tabelas por stack e gate: `review/seguranca-referencia.md`.

## Ordem
1. **Superfícies** do diff: entradas (request, webhook, arquivo, fila), saídas (HTML, JSON, log), shell/SQL/HTTP.
2. **Gate**: cole o resumo de `node ~/.claude/scripts/gate-seguranca.js`. Não rodou? Diga.
3. **Tabela comum** no diff todo; **tabela da stack** nas linhas que batem.
4. **Falha silenciosa** em todo `catch`/`except`/`.catch`/`?.`/`?? default`/retry.
5. **Piso do ponytail**: nenhum corte removeu validação/erro/segurança/teste.

## Tabela comum
| Padrão | Sev | Fix |
|---|---|---|
| Segredo literal; `.env` versionado | 🔴 | env + config; rotacionar |
| SQL/NoSQL montado com string de input | 🔴 | binding/ORM; allowlist de coluna |
| Shell com input (`exec`, `shell=True`, `os.system`) | 🔴 | API nativa; `execFile`/lista |
| Rota de escrita sem auth **ou** sem autorização | 🔴 | middleware + policy/`can()` |
| Registro de outro tenant acessível | 🔴 | escopo + teste cross-tenant → 404 |
| Mass assignment / input direto no ORM | 🔴 | allowlist + schema validado |
| Saldo/estoque lido e alterado sem lock/transação | 🔴 | `FOR UPDATE` em transação |
| Webhook sem assinatura ou sem dedupe por event id | 🔴 | `dominios/integracao.md` |
| Senha em texto puro / MD5-SHA1 | 🔴 | bcrypt/argon2 do framework |
| `unserialize`/`pickle`/`yaml.load` de dado externo | 🔴 | JSON / `safe_load` |
| HTML não escapado com dado de usuário | 🟡→🔴 | escape padrão; allowlist |
| URL de usuário em fetch (SSRF); redirect sem allowlist | 🟡 | allowlist; bloquear IP privado |
| Upload/download com path/tipo/tamanho de usuário | 🟡 | tipo+tamanho; nome gerado; prefixo |
| Login/reset/OTP/rota cara sem rate limit | 🟡 | throttle por conta e IP |
| Segredo/PII em log, exception ou erro | 🟡 | redigir; genérico pro cliente |
| CORS `*` com credenciais; cookie sem `HttpOnly`/`Secure`/`SameSite` | 🟡 | config explícita |
| `DEBUG` ligável em prod; `audit` falhou | 🟡 | pipeline; atualizar |

Não reportar: placeholder em `.env.example`; credencial em `tests/`; chave pública; MD5 checksum.

## Falha silenciosa
- 🔴 catch amplo que engole; fallback não pedido (`[]`/`null`/default); mock fora de teste; captura que impede rollback.
- 🟡 log-and-continue; retry que esgota calado; "algo deu errado"; rede/arquivo/banco sem timeout/erro.

## Saída
```
## Segurança
- 🔴 <arquivo:linha> — <padrão> — <impacto> — Fix: <concreto>
- ✅ Superfícies: … · Gate: <resultado> · Tabela de stack lida: sim/não
## Falhas silenciosas
- 🔴 <arquivo:linha> — catch de <tipo> esconde <erros> — Fix: …
```
Sem achado não é "OK": liste o que checou. ❌ Teoria sem linha e input. ❌ Aprovar sem gate.
