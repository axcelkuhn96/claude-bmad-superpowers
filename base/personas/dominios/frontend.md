# Domínio: Frontend / UI

Lido por caminho pelo subagent `general-purpose` em task de UI. **Stacka em cima do `@dev` BMAD e do ponytail** (@dev → ponytail → linguagem → frontend); como área, vence a linguagem em conflito. Conteúdo completo: `dominios/frontend-referencia.md`.

## 1. Antes de escolher: detecte (Passo 1)
Design system existente? (`tailwind.config.*`, tokens, `components/ui/`, lib UI, `DESIGN.md`/`PRODUCT.md`/`design-system/*/MASTER.md`, `docs/design.md`). Referência visual no brief (URL, screenshot, Figma, "igual ao X")? Reporte "Design system detectado" e o **Modo** (Passo 0: Operar | Persuadir | Ler | Experienciar).

## 2. Escolha UMA skill por situação (nunca empilhe)
| Situação | Use | Depois |
|---|---|---|
| **Greenfield** — sem design system | skill `frontend-design` (plugin oficial) em modo cheio | Passo 2B + complemento de tokens em 3 camadas |
| **Projeto existente** — há padrão | nenhuma skill: siga o padrão (Passo 2A); o reviewer aplica o **Checklist do reviewer de UI** | anti-IA-genérico + piso de craft |
| **Referência visual** dada | Design Read do taste-skill (`design-taste-frontend`, se instalado; senão a linha do Passo 0 com dials) | Passo 2A ou 2B conforme o projeto |

**Persuadir** liga os dials; **Operar** (app, CRUD, admin) segue o projeto, não "embeleza". Nunca invoque `ui-ux-pro-max`, `impeccable` ou `--persist` no subagent.

**Site público novo ou redesign** (landing, portfólio, marketing, editorial): use o adaptador curto "Evidência por seção" em `frontend-referencia.md` no brief e no report já existentes. Ele aproveita os princípios de conteúdo/asset do Taste sem invocar outra skill nem alterar o roteador acima. Não se aplica a app/CRUD/admin.

## 3. Sempre
- Anti-IA-genérico, estados completos (loading/empty/error/success/disabled), a11y AA, tokens > literais, DRY de CSS.
- Piso de craft antes de editar; **validação visual** (Playwright, venv `/tmp/pwval`, nunca `agent-browser`) antes de Ready for Review — ou declare que não validou.
- Laravel/Blade: `x-*`, `@class`, `{{ }}`, `@vite` (seção "Projeto Laravel/Blade").
- React / React Native → `frontend-referencia.md` §React / §React Native (regras + Build quebrado).

## 4. Saída (além do @dev)
"Design system detectado" + Modo + skill escolhida (por quê) · primitivos reutilizados/criados · estados por componente · validação visual · tradeoffs. Reviewer: tabela "UI — audit" (0–20).
