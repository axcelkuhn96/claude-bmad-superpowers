# WP-C — Personas e gate de segurança (release 0.12.0) — report

Data: 2026-09-10 · branch `release/0.12.0` · sem commit (por instrução). Fonte: `/home/axcel/cbs-lab/docs/analises/2026-09-10-pesquisa-personas.md` §5.1–5.7, §7, §9.

## Arquivos

| Arquivo | Ação | Bytes | Limite |
|---|---|---|---|
| `base/personas/dominios/laravel.md` | novo (§5.1) | 7499 | ≤ 8192 ✓ |
| `base/personas/dominios/python.md` | novo (§5.2) | 5584 | ≤ 8192 ✓ |
| `base/personas/dominios/node.md` | novo (§5.7; segurança é a 1ª seção de regras inegociáveis) | 8089 | ≤ 8192 ✓ |
| `base/personas/dominios/node-referencia.md` | novo — config/log/processo, TypeScript, testes movidos pra caber no limite | 1915 | — |
| `base/personas/dominios/integracao.md` | novo (§5.3) | 6067 | ≤ 8192 ✓ |
| `base/personas/dominios/frontend.md` | **reescrito** como roteador (uma skill por situação) | 2030 | ≤ 2048 ✓ |
| `base/personas/dominios/frontend-referencia.md` | novo — conteúdo anterior integral + adendo §5.6 (Passo 0 modos, piso de craft, dials, tokens 3 camadas, Laravel/Blade, checklist do reviewer de UI) + Fontes | 22285 | — |
| `base/personas/review/seguranca.md` | novo (§5.4 v2, bloco curto; gatilho = qualquer backend) | 3068 | ≤ 3072 ✓ |
| `base/personas/review/seguranca-referencia.md` | novo — gate + tabelas PHP/Python/Node completas + Fontes | 10607 | — |
| `base/personas/review/cobertura-de-testes.md` | novo (§5.5) | 4336 | — |
| `base/personas/README.md` | novo — domínios, lentes, quando cada um é injetado, ordem de empilhamento | ~2,6 KB | — |
| `base/scripts/gate-seguranca.js` | novo, executável (§9.4 camada 2) — **porte Node/ESM, sem shell**, Windows/Linux/macOS; `.sh` original removido a pedido do orquestrador | ~14 KB | — |
| `base/scripts/package.json` | novo — `{ "type": "module" }` pra o `.js` rodar como ESM em `~/.claude/scripts/` (fora do repo) em qualquer Node ≥ 18 | 21 | — |
| `src/caminhos.js` | +`DIR_SCRIPTS` (`~/.claude/scripts`) | | |
| `src/instalar.js` | copia `base/scripts/` → `~/.claude/scripts/`; marcador `// claude-bmad-superpowers:base vX` em `.js` de scripts; `chmod 755`; linha `scripts/` no README de overrides | | |
| `src/atualizar.js` | mesmo marcador/chmod; `atualizarArvore(base/scripts)` | | |
| `src/remover.js` | remove `~/.claude/scripts/*` com marcador e dirs vazios | | |

Verificações: `wc -c` acima; zero ocorrências de `.bmad-core`, `@qa`, `@sm` em `base/personas/**` e `base/scripts/**` (`grep -rn` → nenhuma); nada do `frontend.md` anterior foi perdido (checagem linha a linha por script: 0 linhas faltando; 0 linhas do adendo faltando).

**Formato/"frontmatter":** `frontend.md`, `database.md` e `ponytail.md` não têm YAML frontmatter — o cabeçalho deles é `# Domínio: …` + parágrafo de empilhamento + blockquote de fonte. Os novos seguem exatamente esse formato. Não adicionei YAML pra não divergir dos existentes (nada no `src/` ou nas skills parseia frontmatter de persona).

## Teste do gate (`node gate-seguranca.js`)

Ferramentas na máquina: só `npm`/`pnpm`/`yarn`/`uv`/`pipx`. (Cenários rodados primeiro com o `.sh`, depois **repetidos com o porte `.js`** — mesmos exits e mesmas linhas.) Pra testar exit 1 usei binários **fora do sistema** (scratchpad da sessão, não instalados em `~/.local/bin`): gitleaks 8.30.1 (tarball do release), `semgrep` 1.176.1, `ruff`, `pip-audit` via shims `uvx`. Segredo fake: `AKIA…(chave fake de 20 caracteres no formato AWS)` (formato AWS válido, não é o `…EXAMPLE` que o gitleaks allowlista).

| Cenário | Exit | Saída (resumo) |
|---|---|---|
| A) dir temporário, `package.json` mínimo + `config.js` com AKIA, **sem** gitleaks/semgrep no PATH | **0** | `⚠ gitleaks: não instalado — gate parcial` · `⚠ semgrep: não instalado — gate parcial` · `⚠ npm audit: não rodou (sem lockfile ou sem rede)` · `GATE: APROVADO COM RESSALVAS — ferramentas ausentes/com erro: gitleaks semgrep npm` |
| B) idem, com gitleaks + semgrep, não-git (modo `gitleaks dir`) | **1** | `✗ gitleaks: 1 segredo(s)` → `config.js:2 — aws-access-token` · `✗ semgrep: 1 achado(s) ERROR/WARNING (ERROR=1)` → `config.js:2 detected-aws-access-key-id-value [ERROR]` · `GATE: REPROVADO — 2 achado(s)` |
| C) repo git, `main` limpa, branch `feature` com commit do segredo (modo `gitleaks git --log-opts=BASE..HEAD` + `semgrep --baseline-commit`) | **1** | `base: 046d52ee (+1 commit(s))` · gitleaks 1 segredo · semgrep 1 achado **novo vs base** · REPROVADO |
| D) repo git, branch limpa (+1 commit) | **0** | `✓ gitleaks: 0 segredos` · `✓ semgrep: 0 achados ERROR/WARNING novos vs base (0 no total)` · `⚠ npm audit` (sem lockfile) · APROVADO COM RESSALVAS |
| E) node com `package-lock.json` e `lodash@4.17.15` | **1** | `✗ npm audit: 1 vulnerabilidade(s) high/critical` → `Severity: high` · REPROVADO |
| F) python `requirements.txt` com `requests==2.19.0` + `subprocess.run(cmd, shell=True)` | **1** | `✗ semgrep: app.py:4 subprocess-shell-true [ERROR]` · `✗ pip-audit: 36 vulnerabilidade(s)` · `✗ ruff --select S: app.py:4:12: S602` · REPROVADO — 38 |
| G) python "limpo" (`requests==2.32.4`) | **1** | `✗ pip-audit: 2 vulnerabilidade(s)` — real: `PYSEC-2026-2275`, fix 2.33.0 (achado genuíno, não bug do script) |
| `--help` | 0 | imprime o cabeçalho de uso |
| H) cópia instalada em HOME fake (`~/.claude/scripts/gate-seguranca.js` + `package.json` ao lado, fora do repo) sobre o cenário F | **1** | idem F — prova que o ESM resolve sem o `package.json` do repo |

Saída sempre ≤ 20 linhas (`head -20`); JSON/txt completos em `.superpowers/sdd/` (`gitleaks-*.json`, `semgrep.json`, `npm-audit.txt`, `pip-audit.txt`, `ruff-S.txt`, `composer-audit.txt`, `psalm.txt`). `node --check` OK. No `.js`: zero `shell:true`, zero `bash`/`sh -c`/`which`/`grep`/`sed`/pipes — binários resolvidos no PATH pelo próprio script (respeita `PATHEXT` no Windows); `npm` roda como `node npm-cli.js`; `.cmd`/`.bat` no Windows vão por `cmd.exe /d /s /c` com argv constante (Node recusa spawn direto de `.cmd` sem shell).

**Instalação pelo CLI (HOME fake):** `instalar --apenas-global --skip-superpowers` → `→ Copiando scripts...`; `~/.claude/scripts/gate-seguranca.js` (+ `package.json`) com modo 755 e rodapé `// claude-bmad-superpowers:base v0.11.0 — edite em ~/.claude/cbs-overrides/scripts/…`. `atualizar --skip-self-update --skip-bmad` → 35 arquivos atualizados, marcador e 755 mantidos. `remover -y` → script removido e `~/.claude/scripts/` apagado.

## `npm test`

```
ok 1 - cli --help sai com 0 e lista os comandos
ok 2 - comando desconhecido sai com 1
ok 3 - status num HOME vazio não quebra e reporta não instalado
ok 4 - instalar --apenas-global copia skills, commands, personas e models.yml
ok 5 - instalar --apenas-global copia base/scripts/*.js executáveis e com marcador
ok 6..13 (instalar de novo, atualizar ×3, status ×2, instalar-bmad --force, remover)
# pass 13  # fail 0
```

Rodada final (após o porte pra `.js`): **13 pass / 0 fail** (`not ok 4` da primeira rodada era o schema de `models.yml` WP-A ↔ WP-B, já alinhado por eles). Teste 5 (adicionado pelo WP-A) ajustado por mim pra `*.js` + marcador `//`; teste 13 checa remoção de `gate-seguranca.js`.

## Decisões

1. **Destino dos scripts:** `~/.claude/scripts/` (base) e `~/.claude/cbs-overrides/scripts/` (override), seguindo o padrão `personas/`. `.js` de scripts recebe marcador em comentário `//` — sem isso o `atualizar` "preservaria" o script pra sempre (a regra "sem marcador = customização do usuário") e ele nunca seria atualizado; `chmod 755` porque `writeFile` perde o modo. **Porte pra Node** (pedido do orquestrador, usuário também no Windows): ESM + `package.json` `{"type":"module"}` ao lado, porque o repo tem `type: module` (o `.js` vira ESM aqui) e `~/.claude/scripts/` não tem (viraria CJS; Node 18 não detecta ESM sozinho). Chamada canônica: `node ~/.claude/scripts/gate-seguranca.js [dir] [--base <ref>]`. Quem copiar pra `cbs-overrides/scripts/` precisa levar o `package.json` junto (ou usar `.mjs`).
2. **`node.md` > 8 KB no rascunho** (9,7 KB): movi "Config, log, processo", "TypeScript" e "Testes" pra `node-referencia.md`, deixando um resumo de 1 parágrafo com ponteiro. Regras de segurança e erro/async ficaram inteiras e na ordem pedida (segurança primeiro).
3. **Packs do semgrep:** `p/laravel` e `p/express` **não existem** no registry (HTTP 404, verificado 2026-09-10 — o relatório-fonte dizia que existiam). Gate usa `p/php` | `p/python` + `p/django`/`p/flask` | `p/nodejs` + `p/javascript` (+ `p/typescript`). Corrigido também em `seguranca-referencia.md`. Um pack inexistente derruba o semgrep inteiro (exit 7) — o script agora imprime a mensagem de erro do `semgrep.json` como "gate parcial".
4. **Severidade que reprova:** gitleaks (qualquer segredo), semgrep `ERROR`/`WARNING` (INFO só conta no total), audit da stack (composer advisory / pip-audit / ruff S / bandit MEDIUM+ / npm high+), psalm só se `psalm.xml` + `vendor/bin/psalm` existem. Erro de ferramenta (ENOLOCK, sem rede, exit inesperado) = "gate parcial", exit 0, nunca silencioso (`GATE: APROVADO COM RESSALVAS — ferramentas ausentes/com erro: …`).
5. **gitleaks:** modo `git --log-opts=BASE..HEAD` quando há commits à frente; modo `dir .` quando não é git, não há base, não há commits à frente **ou** o working tree está sujo (o executor pode rodar antes do commit). Base = merge-base com `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, ou `--base <ref>`.
6. **`eslint --plugin security` não entra no gate** (rascunho §9.4 dizia "só se o projeto já tem ESLint"): sem o plugin instalado o comando falha; o `node.md` já pede `npm run lint` no loop do implementer.
7. **`cobertura-de-testes.md`:** rascunho citava `@qa`/TEA; reescrito como lente do **reviewer final da branch** e do subagent de cobertura do `/revisar` (alinhado a `referencia/roteamento.md` §2 do WP-B). Adicionei um princípio sobre respeitar o tipo da task (`regra-de-negocio` vs `operacional`/`ui`, B6).
8. **`frontend.md` roteador:** três situações → uma skill: greenfield → `frontend-design`; projeto existente → nenhuma skill (seguir padrão; reviewer usa checklist de UI); referência visual → Design Read do taste-skill (`design-taste-frontend` se instalada, senão a linha do Passo 0). Proíbe invocar `ui-ux-pro-max`/`impeccable`/`--persist` no subagent. O texto original permanece íntegro em `frontend-referencia.md` (inclusive o blockquote "skill obrigatória", contextualizado por uma nota de abertura de que a escolha é do roteador).
9. **Licença:** `node.md`/`node-referencia.md` e as tabelas Node/Python de `seguranca-referencia.md` declaram CC-BY-SA-4.0 (derivadas de nodebestpractices/OWASP), como o relatório-fonte recomendou (§8.6). Se o dono não quiser arquivo sob outra licença no pacote MIT, é decisão dele.

## Pendências / preocupações

- **`npm test` vermelho no teste 4** por conflito de schema de `models.yml` entre WP-A (smoke) e WP-B (config). Fora do WP-C.
- `base/personas/README.md` é copiado pra `~/.claude/personas/README.md` (o `copiarArvore` copia tudo) e o `status` lista `README.md` entre as "personas instaladas" (`listarMd`) — cosmético; se incomodar, `status.js` pode filtrar `README.md` (WP-A).
- WP-B (`referencia/dispatch.md`, `roteamento.md`, `revisor/SKILL.md`) precisa citar a chamada `node ~/.claude/scripts/gate-seguranca.js` (override `~/.claude/cbs-overrides/scripts/gate-seguranca.js`) e os `review/seguranca-referencia.md`/`dominios/*-referencia.md` — avisado por SendMessage.
- Semgrep não sinalizou `exec("ls " + req.query.dir)` no teste C com `p/nodejs`+`p/javascript` (só o segredo) — cobertura das regras públicas, não do script; a tabela Node da lente cobre esse caso pelo reviewer.
- Nenhuma ferramenta do gate está instalada no sistema (`gitleaks`, `semgrep`, `pip-audit`, `ruff`, `bandit`, `composer` ausentes); em uso real o gate sairá "parcial" até o dono instalar (`pipx install semgrep pip-audit ruff bandit`; gitleaks do release em `~/.local/bin`).
- Windows não foi executado de fato (só Linux): o caminho `cmd.exe` pra `.cmd`/`.bat` e a resolução por `PATHEXT` foram escritos sem execução real — primeiro uso no Windows deve ser observado.
- Report anterior continha uma chave AWS fake literal que reprovava o gate do próprio repo; redigida pra `AKIA…(chave fake…)`. `.superpowers/` adicionado ao `.gitignore`.
