# Domínio: Integração / API externa / Webhook

Rulebook lido por caminho pelo subagent `general-purpose` quando a task consome ou expõe API de terceiro, recebe webhook, faz sync com sistema externo, ou adiciona "mais um conector". **Stacka em cima do `@dev` BMAD e do ponytail**, não substitui — e, se houver, em cima do domínio de linguagem (`laravel` | `python` | `node`), com ordem @dev → ponytail → linguagem → integracao. Como domínio de **área**, sua regra inegociável vence a da linguagem em conflito.

> Destilado de `api-connector-builder` (ECC, MIT), `rules/http-client.md` (Laravel Boost, MIT) e da seção de webhooks de `payment-integration` (wshobson, MIT). Reescrito em pt-BR; o subagent tem o codebase na frente — este arquivo dá o critério, não o código.

## Gatilhos (Fase 3 do executor)
- Arquivos: `app/Services/*Client*`, `app/Integrations/`, `integrations/`, `providers/`, `connectors/`, `*Webhook*`, `routes/api.php` com rota sem CSRF, `config/services.php`, `.env.example` com `*_API_KEY`/`*_SECRET`.
- Story menciona: API, SDK, token, OAuth, webhook, sync, importar de X, gateway de pagamento, ERP, WhatsApp/Meta, e-mail transacional, fila de eventos externos.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)
1. **Antes de abrir a doc do vendor, leia ≥ 2 integrações que já existem no projeto** e mapeie: layout de arquivos, onde fica config/segredo, modelo de auth, tratamento de erro, retry/paginação, como se registra (service provider? registry? DI?), como se testa (fake? fixture gravada?).
2. **Se existe padrão de conector → replique-o.** O conector novo tem que parecer que sempre esteve ali. Não importe arquitetura de outro ecossistema. Não copie o conector mais velho se há um mais novo que virou padrão.
3. **Se não existe padrão →** estabeleça o mínimo (client + mapeamento + entrypoint + teste) e documente em 1 parágrafo onde outros devem seguir.
4. **Só o que a story precisa:** auth, entidades-chave, operações de leitura/escrita usadas, paginação/rate limit, modelo webhook-ou-polling. Não modele a API inteira.

## Detecção (reporte antes de codar)
```
### Integrações existentes detectadas
- Conectores lidos: <A>, <B> · padrão: <descrição de 1 linha>
- Config/segredo: config/services.php + env | settings | vault
- HTTP: Http facade / Guzzle / httpx / requests / fetch · timeouts padrão?
- Erro: exceção de domínio? retorno nulo? log?
- Testes: Http::fake / responses / nock / VCR · fixtures em tests/Fixtures?
- Webhooks existentes: verificação de assinatura? idempotência por event id?
Modo: seguir padrão | estabelecer padrão
```

## Regras inegociáveis (valem sempre)

**Chamada de saída**
- Timeout explícito (conexão e resposta) em toda chamada; nunca o default da lib. Retry multiplica o tempo — conte isso no job/request que chama.
- **Retry só em operação idempotente** (GET, ou POST com `Idempotency-Key` estável por tentativa). Retry em falha de conexão, 5xx, 429 — nunca em 4xx de validação.
- Cheque o status antes de consumir o payload (`throw()`/`raise_for_status()` ou branch explícito por status). 404 esperado é caso tratado, não exceção engolida.
- Chamadas independentes em paralelo (pool) quando fizer diferença; erro tratado por resposta.
- Segredo: config lendo env; nunca em log, nunca em mensagem de erro, nunca commitado. Redija headers em log.
- Rate limit do vendor respeitado (limiter no job/cliente), não "tenta até passar".
- URL/host nunca vem do usuário sem allowlist (SSRF). TLS nunca desligado (`verify=False`, `rejectUnauthorized: false`).

**Webhook de entrada**
- **Verificar assinatura com o SDK/algoritmo oficial** antes de qualquer coisa (comparação em tempo constante: `hash_equals`/`hmac.compare_digest`/`timingSafeEqual`); sem assinatura → 401/403 e log. Preservar o **raw body** (middleware de JSON pode quebrar HMAC).
- **Idempotente por event id:** persistir o id recebido (unique) e ignorar repetido. Provedores reentregam e não garantem ordem.
- **Responder 2xx rápido** e enfileirar o trabalho pesado (job). Timeout do provedor gera reentrega e duplicidade.
- Não confiar no payload pra estado que importa (pagamento, saldo): re-buscar na API do provedor.
- Rota fora do CSRF só porque tem assinatura — nunca as duas coisas ausentes.

**Dados**
- Mapeie o externo pro domínio (DTO/array tipado/model) em uma camada; o resto do app não conhece o formato do vendor.
- Versão da API fixada (header/URL) e anotada.

## Testes (obrigatórios)
- Happy path com resposta gravada/fake; **timeout**, **falha de conexão**, **5xx**, **429**, **4xx de validação**; webhook: assinatura inválida, evento duplicado, payload fora de ordem.
- `preventStrayRequests()`/equivalente ligado: teste não pode bater na internet.
- Sandbox/test mode do vendor separado de produção (credencial de teste tem que **falhar** em prod).

## Loop obrigatório de validação (antes de Ready for Review)
- Suíte do conector + suíte dos conectores vizinhos (você pode ter mexido em base comum).
- Se há sandbox acessível: uma chamada real registrada no Dev Agent Record (o quê, status, tempo). Se não há, declare.
- Gate de segurança da stack (`composer audit` | `pip-audit` | `npm audit`) e varredura de segredo no diff.

## Saída esperada (além do @dev)
- Bloco "Integrações existentes detectadas" + lista do que replicou do padrão da casa.
- Tabela: operação → idempotente? → retry? → timeout.
- Webhook: como verifica assinatura, como deduplica, o que vai pra fila.
- Envs novas adicionadas ao `.env.example` (com placeholder, nunca valor real).

## Anti-padrões fatais
- ❌ Começar pela doc do vendor e "importar" a arquitetura do SDK pro projeto.
- ❌ Retry em POST sem idempotência. ❌ Sem timeout. ❌ `catch` que transforma falha do vendor em `null` silencioso.
- ❌ Webhook sem verificação de assinatura "porque é interno". ❌ Processar webhook síncrono e pesado.
- ❌ Segredo em log/stack trace. ❌ Mockar a lib HTTP em vez de fakear a resposta.
