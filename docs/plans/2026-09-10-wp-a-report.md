# WP-A — CLI e instalação (release 0.12.0) — report

Data: 2026-09-10. Branch `release/0.12.0`. Plano: `docs/plans/2026-09-10-release-0.12.0.md`. Achados: `/home/axcel/cbs-lab/docs/analises/2026-09-10-auditoria-skill.md` (CLI: 1, 8, 12, 13, 14, 17, 18, 19).

Status: **concluído** (A1–A6). Nada commitado; mudanças no working tree.

## Arquivos alterados

| Arquivo | Itens |
|---|---|
| `src/atualizar.js` | A1, A6 |
| `src/instalar-bmad.js` | A2, A4 |
| `src/bmad.js` | A2, A3 |
| `src/status.js` | A3 |
| `src/superpowers.js` | A3 |
| `src/instalar.js` | A2, A6 |
| `src/remover.js` | A2 (achado 19) |
| `bin/cli.js` | ajuda (A1, A3, A4) |
| `base/commands/atualizar.md` | A1, A2 |
| `base/commands/instalar-bmad.md` | A2, A4 |
| `base/config/models.yml` | **novo** (A6 / B2) |
| `test/smoke.js` | **novo** (A5) |
| `package.json` | A5 (`"test": "node --test test/smoke.js"`) |
| `INSTALL.md` | docs de tudo acima |

## Flags reais do BMAD (verificadas)

`npx -y bmad-method@latest install --help` (6.12.0): `--directory`, `--modules`, `--tools`, `--action <install|update|quick-update>`, `--communication-language`, `--document-output-language`, `--output-folder` (default `_bmad-output`), `--shims/--no-shims`, `-y/--yes`. Não existe `--update`. Subcomandos: `install`, `status`, `uninstall [-y] [--directory]`.

Instalação real feita **só** em diretório de rascunho (`$scratchpad/bmad-lab`, HOME temporário), nunca em projeto do usuário:

- `install --directory <dir> --action install --tools claude-code --modules bmm,core --communication-language pt-BR --document-output-language pt-BR --yes` → exit 0, `_bmad/` + 29 skills `bmad-*` em `.claude/skills/`, `installShims: false`, `communication_language: pt-BR` e `document_output_language: pt-BR` em `_bmad/core/config.yaml` e `_bmad/bmm/config.yaml`. `--modules bmm,core` é aceito ("Using modules from command-line: bmm, core").
- `uninstall --directory <dir> -y` → remove `_bmad/` **e** `.claude/skills/bmad-*`; preserva `_bmad-output/` e skills não-bmad (`minha-skill` sobreviveu).
- **Descoberta:** sem `--directory`, o instalador pergunta "Installation directory:" mesmo com `--yes`; sem TTY o prompt é cancelado e o BMAD **sai com 0** sem instalar nada. O código antigo (`src/instalar-bmad.js`) não passava `--directory`, então `cbs instalar` rodado pela ferramenta Bash falhava silenciosamente. Corrigido: `--directory <cwd>` sempre, e `exitCode = 1` quando `_bmad/` não aparece após o install.

## Por item

### A1 — `atualizar` sem TTY (achado 8) + `atualizar.md` (achado 1)

`src/atualizar.js`:
- `if (!process.stdin.isTTY)` → `modo = 'todos'` (comportamento `--auto-bmad`) com aviso `(sem TTY: atualizando BMAD em todos os projetos registrados, como --auto-bmad; use --skip-bmad ou --projetos pra restringir)`. Nunca mais chama `readline` sem terminal.
- Nova flag `--projetos /a,/b` (ou `--projetos=/a,/b`): restringe os alvos aos registrados nesse filtro (caminhos normalizados com `path.resolve`; desconhecidos são avisados e ignorados). Implica modo automático. Existe pra o `/atualizar` poder perguntar ao usuário via `AskUserQuestion` e devolver a escolha pra CLI.
- `base/commands/atualizar.md`: fluxo em 5 passos — `atualizar --skip-bmad` → `status` (lista projetos + versão BMAD) → pergunta todos/alguns/nenhum → `atualizar --skip-self-update --auto-bmad` ou `--projetos ...`. Removida a flag inexistente `install --update`; o comando não ensina flag do BMAD (a CLI é quem roda `install --action update --directory <p> --tools claude-code --yes`). Aviso explícito pra nunca rodar sem `--skip-bmad`/`--auto-bmad`/`--projetos` antes de perguntar.
- `bin/cli.js`: ajuda documenta `--projetos` e o comportamento sem TTY.

### A2 — BMAD 6.12 (achados 1, 12, 14, 19)

- `src/instalar-bmad.js`: `--directory <cwd>`, `--communication-language pt-BR --document-output-language pt-BR` (constante `IDIOMA_BMAD`). Sem TTY e BMAD já existente: assume `[p]ular` em vez de travar. Lista de agentes pós-install sem `@sm`/`@qa` (agora `@analyst @pm @architect @ux-designer @dev` + nota de que QA/stories são workflows `bmad-review`/`bmad-create-epics-and-stories`).
- `src/bmad.js`: `CANDIDATOS_BMAD = ['_bmad']` (removidos `.bmad-core`, `.bmad`, `bmad-core`). `atualizarBmadEmProjeto` já usava `install --action update --directory <dir> --tools claude-code --yes` (mantido).
- `src/instalar.js`: mensagem "escreve em .bmad-core/" → `_bmad/, _bmad-output/ e .claude/skills/bmad-*`.
- `src/remover.js`: `/plugin uninstall superpowers@obra` → `superpowers@superpowers-marketplace`; `rm -rf .bmad-core` → `npx bmad-method uninstall --directory <projeto> -y`.
- `base/commands/instalar-bmad.md`: comando real com todas as flags, checagem pós-install por `_bmad/` + `_bmad/_config/manifest.yaml` + `.claude/skills/bmad-*`, documenta `--update`/`--force`/`-y`.
- Varredura final: `grep -rn '.bmad-core|.bmad/|@qa|@sm|install --update|superpowers@obra' src bin INSTALL.md base/commands/{atualizar,instalar-bmad}.md test package.json` → 0 ocorrências.

### A3 — `status` (achado 18)

`src/status.js` agora mostra, além do que já mostrava:
- **Personas instaladas**: `~/.claude/personas/**/*.md` (base) + `~/.claude/cbs-overrides/personas/**/*.md` (override), marcando sobrescritas; aviso quando `personas/review/` está vazia (hoje está — WP-C cria).
- **Modelo por papel**: existência de `cbs-overrides/models.yml`.
- **Superpowers**: versão lida de `installed_plugins.json` via nova `versoesPlugin()` em `src/superpowers.js` (entrada `scope: user` primeiro; outras versões listadas). Não depende mais do binário `claude` no PATH.
- **Skills de domínio detectadas**: tabela fixa `SKILLS_DOMINIO` — plugins `frontend-design`, `ui-ux-pro-max` (via `installed_plugins.json`) e skills `design-taste-frontend`, `redesign-existing-projects`, `dba` (via `~/.claude/skills/<nome>/SKILL.md`). Se o WP-B/roteador usar outros nomes, ajustar essa tabela.
- **BMAD**: versão no cwd e em cada projeto registrado, lida de `_bmad/_config/manifest.yaml` (`installation.version`) pela nova `versaoBmadEm()` em `src/bmad.js` (regex, sem dependência de yaml). Projetos inexistentes ou sem `_bmad/` marcados com ✗.

### A4 — `instalar-bmad --force` (achado 13)

`src/instalar-bmad.js` → `desinstalarBmad()`:
1. Lista o que vai apagar (`_bmad/` + N skills `bmad-*` em `.claude/skills/`; avisa que `_bmad-output/` e outras skills ficam).
2. Confirmação `[s/N]`, a menos que `-y`/`--sim`. Sem TTY e sem `-y` → erro `--force precisa de confirmação; sem TTY, passe -y pra confirmar.` (exit 1, nada apagado).
3. `npx bmad-method uninstall --directory <dir> --yes`; se falhar, remove `_bmad/` manualmente. Em qualquer caso varre `.claude/skills/bmad-*` (diretórios) restantes.
4. Segue pro `install --action install ...`.

`-y`/`--sim` são filtrados antes de repassar extras ao BMAD (que já recebe `--yes`).

### A5 — `test/smoke.js` (achado 17)

`node:test`, 12 testes, HOME temporário (`mkdtemp`), stdin fechado (simula Bash sem TTY):
`--help`; comando desconhecido → 1; `status` em HOME vazio; `instalar --apenas-global --skip-superpowers` (skills/commands/personas incl. `review/` se existir no base, marcador, `.versao-instalada`, `models.yml` idêntico ao default com as 5 chaves); reinstalar não sobrescreve `models.yml` customizado; `atualizar --skip-self-update --skip-bmad` preserva `models.yml` e persona editada sem marcador; `atualizar` sem TTY e sem projetos não bloqueia; com projeto inválido limpa o registro; `status` pós-install; `instalar-bmad --force` sem `-y` sem TTY aborta sem apagar; `status` lê versão do manifest de projeto registrado; `remover -y` apaga só marcados e preserva overrides.

`package.json`: `"test": "node --test test/smoke.js"`. `.npmignore` já excluía `test/`.

### A6 — `personas/review/` e `models.yml`

- `copiarArvore` (instalar) e `atualizarArvore` (atualizar) são recursivos: `base/personas/review/` será copiado automaticamente quando o WP-C criar os arquivos. O smoke test valida `personas instaladas == personas do base` (deepEqual), então cobre `review/` assim que existir.
- `base/config/models.yml` criado com o default do B2 (`implementer: sonnet, reviewer: opus, final_review: opus, e2e: sonnet, investigar: inherit`), comentado (valores aceitos, override por `models=...`/`modelo=...`).
- `garantirModelsOverride()` (exportada de `src/instalar.js`, usada por `instalar` e `atualizar`): copia pra `~/.claude/cbs-overrides/models.yml` **só se não existir**; nunca sobrescreve. `atualizar` conta como "criado" ou "preservado" no resumo.

## Evidência

`npm test`:
```
> claude-bmad-superpowers@0.11.0 test
> node --test test/smoke.js

✔ cli --help sai com 0 e lista os comandos
✔ comando desconhecido sai com 1
✔ status num HOME vazio não quebra e reporta não instalado
✔ instalar --apenas-global copia skills, commands, personas e models.yml
✔ instalar de novo não sobrescreve models.yml customizado
✔ atualizar --skip-self-update --skip-bmad preserva models.yml e override sem marcador
✔ atualizar sem TTY e sem projetos registrados não bloqueia em prompt
✔ atualizar sem TTY com projeto registrado inválido não bloqueia e limpa o registro
✔ status depois de instalar lista skills, personas e models.yml
✔ instalar-bmad --force sem TTY e sem -y aborta sem apagar nada
✔ status lê a versão do BMAD do manifest de um projeto registrado
✔ remover -y apaga só arquivos com marcador e preserva cbs-overrides
ℹ tests 12  ℹ pass 12  ℹ fail 0  ℹ duration_ms 678
```

`node bin/cli.js status` no HOME real (só leitura):
```
Versão do pacote (este npx): 0.11.0
Versão instalada em ~/.claude: 0.11.0
Skills do pacote ativos (6): executor-bmad-superpowers, grelhar, handoff, investigador-de-ideia, refinador-de-prompt, wayfinder
Commands do pacote ativos (11): atualizar, executar, grelhar, handoff, instalar-bmad, investigar, mapear, piloto, refinar-auto, refinar, revisar
Personas instaladas (3 base, 0 override):
  dominios/database.md
  dominios/frontend.md
  ponytail.md
  ⚠  nenhuma persona em personas/review/ (seguranca, cobertura-de-testes)
Modelo por papel: ✗ cbs-overrides/models.yml ausente (rode instalar/atualizar)
Claude Code CLI: ✓ encontrado
Plugin Superpowers: ✓ 6.3.0 (superpowers@superpowers-marketplace, escopo user)
  também: 6.1.1 (superpowers@superpowers-marketplace, escopo project em /home/axcel/expia)
  também: 6.1.1 (superpowers@superpowers-marketplace, escopo project em /home/axcel)
Skills de domínio detectadas:
  ✓ frontend-design (plugin) — frontend greenfield
  ✓ ui-ux-pro-max (plugin) — reviewer de UI (a11y, touch)
  ✗ design-taste-frontend (skill) — frontend greenfield (taste-skill)
  ✗ redesign-existing-projects (skill) — frontend em projeto existente (taste-skill)
  ✓ dba (skill) — database
BMAD no diretório atual: ✗ não detectado (rode /instalar-bmad dentro do projeto)
Projetos BMAD registrados (9):
  ✓ /home/axcel/CobraAI  BMAD 6.12.0
  ✓ /home/axcel/MizuConecta-Laravel  BMAD 6.12.0
  ✓ /home/axcel/trading-new  BMAD 6.12.0
  ✓ /home/axcel/NorFlor  BMAD 6.12.0
  ✓ /home/axcel/expia  BMAD 6.12.0
  ✓ /home/axcel/Konnexa  BMAD 6.12.0
  ✓ /home/axcel/vernier-mining-analyst  BMAD 6.12.0
  ✓ /home/axcel/SigaminaApp  BMAD 6.12.0
  ✓ /home/axcel/IndusData  BMAD 6.12.0
```

`instalar-bmad` real no diretório de rascunho (HOME temporário), stdin fechado:

| Fluxo | Resultado |
|---|---|
| `instalar-bmad` (fresh) | exit 0; `_bmad/` + 29 skills; registrado no `.projetos-bmad` do HOME temp; `pt-BR` nas configs |
| `instalar-bmad --update` | exit 0; "Using action from command-line: update"; 29 skills |
| `instalar-bmad --force` (sem `-y`) | exit 1; "--force precisa de confirmação"; `_bmad/` intacto |
| `instalar-bmad --force -y` (com `bmad-orfa/` extra) | exit 0; uninstall removeu `_bmad/` e `bmad-*`; `minha-skill/` e `_bmad-output/meu-doc.md` preservados; reinstalou 29 skills |

## Decisões e ressalvas

- **Sem TTY → `--auto-bmad`** (plano A1) em vez de `modo = 'n'` (sugestão do achado 8). Consequência: `npx claude-bmad-superpowers atualizar` cru pela ferramenta Bash atualiza BMAD em todos os projetos registrados. O `/atualizar` foi escrito pra nunca fazer isso sem perguntar (usa `--skip-bmad` primeiro). Se preferir o default conservador, é 1 linha em `src/atualizar.js` (`modo = 'n'` no branch `!isTTY`).
- Idioma `pt-BR` (literal do plano). O BMAD guarda a string livre em `communication_language`; `"Português (Brasil)"` (sugestão do achado 14) seria igualmente válido — trocar `IDIOMA_BMAD` se o WP-B preferir.
- Detecção de BMAD só por `_bmad/`: projeto com BMAD 4.x (`.bmad-core/`) passa a aparecer como "não detectado". É o comportamento correto pra 6.12 (as skills `bmad-*` não existem lá), mas é mudança de comportamento.
- `--modules bmm,core` mantido (aceito pela 6.12; `core` é built-in e aparece no manifest). `--output-folder` não passado (default já é `_bmad-output`). `--no-shims` não passado: com `-y` a 6.12 já instala sem shims (`installShims: false`).
- `remover -y` no smoke test: `-y` funcionava (`--sim`/`-y`), sem mudança.
- `src/auto-update.js` (achado 23, `git pull` com trabalho local) não estava no plano; não tocado.

## Fora do escopo (pra outros WPs / fechamento)

- `README.md`: cita "3 skills / 8 comandos", `superpowers@obra`, `.bmad-core`; precisa alinhar com o `status` novo (6 skills, 11 commands, personas `review/`, `models.yml`, `--projetos`, comportamento sem TTY). WP-B (B9).
- `base/personas/review/{seguranca,cobertura-de-testes}.md` ainda não existem (WP-C); o `status` avisa até lá.
- Nomes em `SKILLS_DOMINIO` (`src/status.js`) devem bater com os que o roteador do executor (WP-B B4) e `frontend.md` (WP-C) usarem.
- `base/VERSAO` e `package.json` continuam `0.11.0`; CHANGELOG `0.12.0` fica pro fechamento.
- `docs/plans/` está untracked (contém o plano e este report).
