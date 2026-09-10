# Review: Segurança — referência por stack e gate

Complemento de `review/seguranca.md`. O reviewer lê **só a tabela da stack** que bate com o diff (a tabela comum está no arquivo curto). O subagent Security do reviewer final e do `/revisar` lê o arquivo inteiro.

## Gate (camada 2 — roda antes de DONE e antes de push)
Script distribuído pelo pacote: `node ~/.claude/scripts/gate-seguranca.js` (override: `~/.claude/cbs-overrides/scripts/gate-seguranca.js`). Uso: `gate-seguranca.js [dir] [--base <ref>]`. Detecta a stack pelos arquivos do projeto e roda:

```bash
# todas — segredos nos commits da branch e SAST só do que é novo (base = branch de origem)
gitleaks git --log-opts="$BASE..HEAD" --no-banner --redact
semgrep scan --config p/owasp-top-ten --config p/secrets $PACKS \
  --baseline-commit "$BASE" --metrics=off --error --quiet --json -o .superpowers/sdd/semgrep.json
# laravel/php                 python                                      node
composer audit                # pip-audit --strict ; ruff check --select S   # npm audit --audit-level=high
# (+ vendor/bin/psalm se psalm.xml existe)   (ou bandit -r . -ll -ii)         (pnpm/yarn/bun equivalentes)
```

`$PACKS` = `p/php` | `p/python`+`p/django`/`p/flask` | `p/nodejs`+`p/javascript` (+`p/typescript`) — packs verificados no registry em 2026-09-10 (`p/laravel` e `p/express` não existem). Exit 1 = segredo ou achado novo/vulnerabilidade alta → task **não** está DONE. Ferramenta ausente = linha "não instalado — gate parcial" com exit 0: o reviewer registra o que não rodou, nunca aprova em silêncio. Supressão só com `# nosemgrep: <id> — <motivo>`, allowlist em `.gitleaks.toml` ou `--ignore-vuln` justificado no Dev Agent Record; o reviewer confere cada justificativa. Instalação (uma vez, fora do pacote): `pipx install semgrep pip-audit bandit`; gitleaks: binário do release em `~/.local/bin`; `composer`/`npm` já vêm com o projeto.

## Tabela PHP / Laravel
| Padrão | Sev | Fix |
|---|---|---|
| `$guarded = []`; `Model::create($request->all())`; `fill($request->input())` | 🔴 | `$fillable` + `$request->validated()` (Form Request) |
| `DB::raw`/`whereRaw`/`orderByRaw`/`DB::select` com string de input; `orderBy($request->sort)` (coluna injetada) | 🔴 | bindings `?`; allowlist de coluna/direção |
| Rota de escrita sem `auth`/`auth:sanctum` **ou** sem `authorize()`/`Gate`/Policy | 🔴 | middleware + Policy; teste 403 |
| `Model::find($id)` sem escopo de tenant/owner; relação não usada (`$user->posts()->find`) | 🔴 | global scope / relação + teste cross-tenant → 404 (não 403) |
| `{!! $x !!}`, `Js::from` indevido, `new HtmlString($input)`, `->html($input)` em Mailable | 🟡→🔴 | `{{ }}`; sanitizador com allowlist |
| `unserialize($input)`; `include`/`require` com input; `extract($request->all())`; `eval` | 🔴 | JSON; allowlist; remover |
| `exec`/`shell_exec`/`system`/`Process::run("… $x")` com input | 🔴 | `Process::run([...])` com array |
| Senha comparada com `==`/`===`; `md5`/`sha1` pra senha; assinatura de webhook comparada com `==` | 🔴 | `Hash::check`; `hash_equals` |
| `Storage::disk()->get/put/delete($request->path)`; `response()->download($input)` | 🔴 | nome gerado; `basename` + prefixo; disco privado |
| `redirect($request->url)`/`redirect()->to($input)`; `Http::get($request->url)`; `Http::withOptions(['verify' => false])` | 🟡 | allowlist; `intended()`; nunca desligar TLS |
| Upload sem `mimes:`/`mimetypes:`/`max:`; salvo em `public/` executável | 🟡 | regras no Form Request; `storage/app/private` |
| Login/reset/OTP sem `throttle:` (ou sem `RateLimiter::for('login')` por e-mail+IP) | 🟡 | `throttle:login` por conta **e** IP |
| `APP_DEBUG=true` alcançável; `APP_KEY` literal; `.env` commitado; `config()` lido com default secreto | 🟡→🔴 | `.env.example` + pipeline; rotacionar |
| Webhook em `VerifyCsrfToken::$except`/`withoutMiddleware` **sem** verificar assinatura | 🔴 | verificar assinatura (SDK) antes de tudo |
| `composer audit` com advisory; `roave/security-advisories` ausente em projeto novo | 🟡 | atualizar/justificar; adicionar em `require-dev` |
| Cookie de sessão sem `secure`/`http_only`/`same_site` em `config/session.php`; `SANCTUM_STATEFUL_DOMAINS` com `*` | 🟡 | config explícita |
| `try { … } catch (\Exception $e) { }` / `report($e); return null;` sem a story pedir | 🔴 | ver Falha silenciosa |

## Tabela Python (Django / FastAPI / scripts)
| Padrão | Sev | Fix |
|---|---|---|
| `cursor.execute(f"… {x}")`, `%` / `.format` em SQL; `.raw()`/`.extra()` com input | 🔴 | parâmetros `%s`/`:x`; ORM |
| `subprocess(..., shell=True)`, `os.system`, `os.popen` com input | 🔴 | `subprocess.run([...])`; `shlex.quote` só como último recurso |
| `pickle`/`marshal`/`shelve`/`yaml.load` sem `SafeLoader`/`torch.load` sem `weights_only` em dado externo | 🔴 | JSON / `yaml.safe_load` / schema |
| `eval`/`exec`/`compile` com input; `importlib.import_module(input)` | 🔴 | remover; allowlist |
| `mark_safe`, `\|safe`, `{% autoescape off %}`, `Markup()`, `jinja2.Environment()` sem `autoescape` | 🟡→🔴 | escape padrão; `select_autoescape` |
| `open(user_path)`, `send_file(input)`, `os.path.join(base, input)` sem `resolve()` + prefixo | 🔴 | `Path(base, input).resolve()` + `is_relative_to(base)` |
| `requests.get(user_url)` (SSRF); `verify=False`; sem `timeout=` | 🟡 | allowlist de host; nunca `verify=False`; timeout sempre |
| View/router de escrita sem `permission_classes`/`login_required`/`Depends(current_user)` | 🔴 | dependência de auth + teste 401/403 |
| `Model.objects.get(id=…)` sem filtro de owner/tenant; `get_object_or_404(Model, pk=…)` em recurso escopado | 🔴 | `filter(tenant=request.tenant)` + teste cross-tenant → 404 |
| `Model(**request.data)`, `**payload` sem Pydantic/serializer; `fields = '__all__'` em serializer de escrita | 🔴 | schema/serializer com allowlist |
| `hashlib.md5/sha*` pra senha; `random` pra token; `jwt.decode(..., options={"verify_signature": False})` / sem `algorithms=` | 🔴 | `make_password`/argon2; `secrets`; `algorithms=[...]` + `exp` |
| `DEBUG=True` alcançável; `ALLOWED_HOSTS=['*']`; `SECRET_KEY` literal/default; `.env` commitado | 🟡→🔴 | env + pipeline |
| `@csrf_exempt` em view de sessão; `CORS_ALLOW_ALL_ORIGINS=True` com credenciais; `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` off | 🟡 | remover/allowlist; flags on |
| `xml.etree`/`minidom`/`lxml` em XML externo (XXE) | 🟡 | `defusedxml` |
| `assert` como checagem de auth (some com `-O`); `except Exception: pass` | 🔴 | `if … raise`; ver Falha silenciosa |
| Login/reset/OTP sem `django-ratelimit`/`slowapi`; upload sem tipo/tamanho | 🟡 | limiter por conta **e** IP; validar |
| `pip-audit` com advisory; `ruff --select S`/`bandit -ll` com HIGH não justificado | 🟡 | atualizar/justificar; `# noqa: S… — motivo` |

## Tabela Node / Express / TypeScript
| Padrão | Sev | Fix |
|---|---|---|
| App que serve HTML sem `helmet()`; CSP ausente/`unsafe-inline` por preguiça; `x-powered-by` ligado | 🟡 | `app.use(helmet({ contentSecurityPolicy: { directives: … } }))`; `app.disable('x-powered-by')` |
| Login/reset/OTP/rota cara só com limiter global ou sem limiter | 🟡 | `express-rate-limit`/`rate-limiter-flexible` **por rota sensível**, chave conta+IP |
| JWT: `verify` sem `algorithms` fixo, sem `exp`, `decode()` no lugar de `verify()`, segredo curto/literal, sem revogação/rotação no logout | 🔴 | `jose`/`jsonwebtoken.verify(t, key, { algorithms: ['HS256'] })`; `exp` curto + refresh rotativo; segredo ≥ 256 bits via env; blocklist |
| Senha com `md5`/`sha*`/texto puro; `crypto.createCipher` (sem IV) | 🔴 | `bcrypt` (cost ≥ 12) ou `argon2`; `createCipheriv` |
| `req.body`/`req.query`/`req.params`/header usado sem schema (zod/joi/ajv) antes do handler | 🔴 | schema na borda → 400 com `issues`; tipos via `z.infer` |
| `db.query(\`… ${x}\`)`, `knex.raw`/`sequelize.query` com concat; `ORDER BY ${req.query.sort}` | 🔴 | parâmetros `$1`/`?`; allowlist de coluna |
| `find(req.body)`, `{ $gt }`/`$where`/`$regex` vindos do cliente; `findOne({ email, password })` com objeto | 🔴 | schema com tipos primitivos; `mongo-sanitize`; nunca operador do cliente |
| `path.join(base, req.params.file)`/`res.sendFile`/`fs.*`/`multer` com nome de usuário sem checar prefixo | 🔴 | `path.resolve` + `startsWith(base + sep)`; nome gerado; storage privado |
| `cors()` sem `origin` (= `*`) **com** `credentials: true`; origin refletido do request | 🟡 | allowlist explícita de origins |
| Cookie de sessão sem `httpOnly`/`secure`/`sameSite`; nome default `connect.sid`; `MemoryStore` em prod | 🟡 | flags + nome próprio + store externo |
| `process.env.X \|\| 'secret'`; segredo/token/PII em `console.log`/pino sem `redact`; `res.json(user)` com hash | 🔴 | config validada no boot (falha se faltar); `redact`; DTO/allowlist de campos |
| `npm audit` com high/critical; lockfile ausente/ignorado (`npm install` em CI) | 🟡 | atualizar/justificar; `npm ci` + lockfile commitado |
| `Object.assign`/spread/`lodash.merge`/`deepmerge` com objeto de input sem schema (`__proto__`, `constructor`) | 🟡 | schema primeiro; `Object.create(null)`; `--disable-proto=delete` |
| `eval`/`new Function`/`vm.run*` com input; `child_process.exec` com string; `require(variável)`/`import(input)` | 🔴 | remover; `execFile`/`spawn` com array; import estático |
| `express.json()`/`urlencoded()` sem `limit`; query arrays sem `hpp` onde não são esperadas | 🟡 | `limit` global e menor por rota; `hpp()` |
| `res.redirect(req.query.next)` sem allowlist | 🟡 | allowlist de path/host |
| Stack/`err.message` pro cliente; `process.on('uncaughtException')` que loga e continua | 🟡 | handler central: 500 genérico + log; `exit(1)` pra não-operacional |
| Regex sobre input com backtracking catastrófico; `express.static` apontando pra pasta com `.env`/uploads | 🟡 | regex linear/`re2` + limite de tamanho; pasta só de assets |

## Fontes
ECC `security-reviewer` (MIT) · laravel/boost `rules/security.md` (MIT) · psalm/plugin-laravel (lista de sinks; MIT) · Anthropic `silent-failure-hunter` e prompt do `security-guidance` (Apache-2.0) · OWASP Node.js Security Cheat Sheet (CC-BY-SA-4.0) · Express "Production Best Practices: Security" (CC-BY-4.0) · goldbergyoni/nodebestpractices §6 (CC-BY-SA-4.0) · OWASP Top 10:2025 (referência). Reescrita em pt-BR com atribuição; as tabelas Node/Python derivadas de fontes CC-BY-SA seguem essa licença.
