# Domínio: Python

Rulebook lido por caminho pelo subagent `general-purpose` quando a task toca código Python (script, serviço, API, pipeline de dados). **Stacka em cima do `@dev` BMAD e do ponytail**, não substitui — o subagent é Dev + Python. Empilha `database.md` se toca banco, `integracao.md` se chama API externa (ordem: @dev → ponytail → python → área). Regra inegociável de área vence a daqui.

> Destilado do `python-reviewer` e das seções de erro/teste de `python-patterns`/`python-testing` do ECC (MIT). Reescrito em pt-BR; o subagent tem o codebase na frente — este arquivo dá o critério, não o código.
> Regras adicionais destiladas de affaan-m/ECC @ e482e57 (agents/{python-reviewer,build-error-resolver,django-build-resolver}.md, rules/python/{fastapi,security}.md, scripts/hooks/config-protection.js) — MIT License, Copyright (c) 2026 Affaan Mustafa (https://github.com/affaan-m/ECC/blob/e482e57/LICENSE).

## Gatilhos (Fase 3 do executor)
- Arquivos: `pyproject.toml`, `requirements*.txt`, `setup.py`, `*.py`, `tests/test_*.py`, `manage.py`, `alembic/`, `conftest.py`.
- Story menciona: script, CLI, FastAPI/Django/Flask, pandas, ETL, notebook, cron, pytest, pydantic, async.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)
1. **Detecte tooling e convenções antes de escrever.** Versão (`python --version`, `requires-python`), gerenciador (uv / poetry / pip+venv), formatter/linter (`ruff`, `black`, `flake8`), tipagem (`mypy`/`pyright` e o nível configurado), framework de teste (`pytest` + plugins), estrutura (`src/` layout? pacote único? scripts soltos?).
2. **Siga o que o projeto faz** (docstring style, `logging` vs `print` em CLI, dataclass vs pydantic vs attrs, sync vs async). Não converta o projeto pro seu gosto.
3. **Greenfield:** escolha e documente em `pyproject.toml` (ruff + pytest no mínimo). Não adicione dependência que a stdlib resolve (`pathlib`, `dataclasses`, `functools`, `itertools`, `concurrent.futures`, `json`, `csv`, `sqlite3`).

## Detecção (reporte antes de codar)
```
### Convenções Python detectadas
- Python 3.x · gerenciador · layout
- Lint/format: ruff (regras) / black / nenhum
- Tipos: mypy strict? pyright? sem tipagem?
- Testes: pytest + (cov, asyncio, mock) · fixtures em conftest? factories?
- Framework: Django / FastAPI / Flask / nenhum
- Config/segredos: .env + pydantic-settings / os.environ / settings.py
- Log: logging estruturado? print?
Modo: seguir padrão | estabelecer padrão
```

## Regras inegociáveis (valem sempre)

**Segurança (bloqueante em review)**
- SQL: nunca f-string/`%`/`.format` com input em query — parâmetros do driver/ORM. Identificador (tabela/coluna) só por allowlist.
- Shell: `subprocess.run([...])` com lista; nunca `shell=True` com input; nunca `os.system`.
- Path de usuário: resolver e checar que fica dentro do diretório base (`Path.resolve()` + `is_relative_to`).
- `eval`/`exec`/`pickle.loads`/`yaml.load` sem `SafeLoader` em dado não confiável = bug.
- Segredo só via env/config; nunca literal. Obrigatório: `os.environ["X"]` (falha no boot), sem default no `getenv`. (ECC rules/python/security) `hashlib.md5/sha1` só pra checksum, nunca senha (use `argon2`/`bcrypt` ou o do framework).
- Django: `select_related`/`prefetch_related` contra N+1, `transaction.atomic()` em multi-passo, migrations geradas pelo `makemigrations`. Flask: CSRF e error handlers.
- FastAPI: nada bloqueante em `async def` (`requests`, `Session` síncrona do SQLAlchemy) — client/driver async, ou endpoint `def` (threadpool) se a lib é síncrona. Sessão de banco/auth via `Depends`, não `SessionLocal()`/client criado no handler. `response_model`/tipo de retorno sem senha, hash nem token. `allow_origins=["*"]` com `allow_credentials=True` = bug (Starlette ecoa a origem). (ECC rules/python/fastapi)
- JWT: `jwt.decode(..., algorithms=[...])`, `exp` exigido (`options={"require": ["exp"]}`), `audience`/`issuer` conferidos se emitidos; nunca `verify_signature: False`. (ECC rules/python/fastapi)
- Rate limit em login, reset de senha e OTP. Log sem senha, token, cookie nem header `Authorization`. (ECC rules/python/fastapi)
- `pip-audit` e `ruff check --select S` (ou `bandit`) no loop de validação.

**Erro (piso do ponytail)**
- `except:` nu ou `except Exception: pass` = bloqueante. Capture o tipo esperado, faça algo (log com contexto + re-raise ou converta em erro de domínio com `raise X(...) from e`).
- Retorno `None`/lista vazia em vez de erro só se a spec pediu — e documente.
- Recurso (arquivo, conexão, lock) sempre com `with`.

**Qualidade**
- Tipos em toda função pública; `Any` só com justificativa. Nulo explícito: `X | None` (`Optional[X]` < 3.10); `def f(x: int = None)` é erro no mypy. (ECC python-reviewer)
- Mutable default (`def f(x=[])`) = bug. `is None`, não `== None`. `isinstance`, não `type() ==`. Sem `import *` nem sombrear builtin (`list`, `dict`, `str`). (ECC python-reviewer)
- `logging` (não `print`) fora de CLI de saída; nível certo.
- Função > ~50 linhas ou > 5 parâmetros → dataclass/objeto de parâmetros, se o projeto tiver esse padrão.
- Concorrência: estado compartilhado com lock; não misture sync e async sem `to_thread`/executor.

## Testes (pytest)
- TDD do fluxo Superpowers vale aqui: teste falhando primeiro (tipo `regra-de-negocio`); `operacional` aceita validação E2E com saída no report.
- Fixture com escopo mínimo; compartilhado em `conftest.py`. `parametrize` pra matriz de casos (com `ids`). `monkeypatch`/`mock.patch` no ponto de uso, não na definição.
- Sem rede/relógio/aleatoriedade real: `freezegun`/`time_machine` se o projeto tiver, senão injete o relógio; `responses`/`respx`/`httpx.MockTransport` pra HTTP.
- Teste de erro: `pytest.raises(TipoEspecífico, match=...)`.
- FastAPI: sobrescreva a função exata do `Depends` e limpe `app.dependency_overrides` no teardown. (ECC rules/python/fastapi)

## Loop obrigatório de validação (antes de Ready for Review)
```
ruff check . && ruff format --check .   # ou o que o projeto usa
mypy <pacote>                            # se o projeto tipa
pytest -q <escopo> && pytest -q          # escopo, depois suíte
pip-audit --strict                       # se instalado
ruff check --select S .                  # ou: bandit -r <pacote> -ll -ii -q
```
Cole a saída resumida no Dev Agent Record; declare o que não pôde rodar.

## Build quebrado
- Na raiz: `mypy <arquivos tocados>` (`.venv/bin/` ou PATH) se há `[tool.mypy]`/`mypy.ini`/`[mypy]` do `setup.cfg`; senão `pyright <arquivos>` se há `[tool.pyright]`/`pyrightconfig.json`. Após editar: `ruff format <arquivo>` se há `[tool.ruff]`/`ruff.toml`. Caches `.mypy_cache/`/`.ruff_cache/` têm `.gitignore` próprio; erro fantasma: `rm -rf .mypy_cache && ruff clean`. (hooks cbs-typecheck, cbs-format)
- `python --version` do venv × `requires-python`; `python -m pip check`. `ModuleNotFoundError`: pacote fora do venv ativo. (ECC django-build-resolver)
- `ImportError: cannot import name`: versão incompatível ou import circular (`python -c "import <módulo>"`; import dentro da função). (ECC django-build-resolver)
- mypy: `Library stubs not installed` → `types-<pacote>` no venv; `Item "None" of "X | None"` → `if x is None`; tipo incompatível → corrija, sem `Any`/`cast`/`# type: ignore`. (ECC build-error-resolver, ECC python-reviewer)
- Não afrouxe `[tool.ruff]`/`[tool.mypy]`/`ruff.toml`/`mypy.ini` pra passar — corrija o código. (ECC config-protection; hook cbs-config-protect)

## Saída esperada (além do @dev)
- Bloco "Convenções Python detectadas". Dependências novas (idealmente zero) com justificativa pela escada do ponytail.
- Tratamento de erro por caminho de falha (o que acontece quando o arquivo/API/banco falha).
- Saída do loop de validação.

## Anti-padrões fatais
- ❌ `except: pass` ❌ f-string em SQL ❌ `shell=True` com input ❌ `print` como log em serviço
- ❌ Reescrever helper que a stdlib tem ❌ Mudar formatter/linter do projeto ❌ `requirements.txt` sem pin quando o projeto pina
