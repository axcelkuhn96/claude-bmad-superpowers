# Domínio: Frontend / UI — referência

Conteúdo integral do rulebook de frontend, lido **por caminho** pelo subagent depois do roteador `dominios/frontend.md` (que escolhe **uma** skill por situação: `frontend-design` em greenfield, checklist do reviewer em projeto existente, Design Read do taste-skill quando há referência visual). As menções a `frontend-design` abaixo valem quando o roteador a escolheu; o resto (detecção, modos, anti-IA-genérico, piso de craft, validação visual, checklist) vale sempre.

> §React e §React Native: regras adicionais destiladas de affaan-m/ECC @ e482e57 (agents/react-{reviewer,build-resolver}.md, rules/react{,-native}/*.md) — MIT License, Copyright (c) 2026 Affaan Mustafa (https://github.com/affaan-m/ECC/blob/e482e57/LICENSE).

---

Rulebook injetado no prompt do subagent `general-purpose` quando a story for de UI/frontend. **Stacka em cima do `@dev` BMAD**, não substitui — o subagent é Dev + UI, não só UI.

> A skill é escolhida pelo roteador `dominios/frontend.md`: `frontend-design` em greenfield, padrão existente sem skill adicional ou Design Read do Taste quando houver referência. Este rulebook complementa a escolha sem empilhar skills.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)

1. **DETECTE o design system existente do projeto ANTES de pensar em estética.**
2. **Se existir um padrão** → siga ele rigorosamente. A skill `frontend-design` entra como referência de qualidade técnica (estados, motion, hierarquia), **não** como licença pra "redesenhar bold".
3. **Se NÃO existir padrão** → aí sim invoque `frontend-design` no modo cheio (commit a uma direção estética distintiva) e estabeleça o sistema enquanto implementa.
4. **Anti-IA-genérico vale nos dois modos** (regras abaixo).

> O objetivo nunca é "imponha estética premium tipo Linear/Stripe/Vercel". O objetivo é **consistência intencional** — que pode ser a do projeto ou, na ausência, uma direção bold deliberadamente escolhida.

## Passo 0 — Modo da superfície

Antes do Passo 1, classifique **a superfície pedida** (não o produto) em 1 linha e reporte:

> **Modo:** <Operar | Persuadir | Ler | Experienciar> · <refinamento (preserva identidade, copy e tudo fora do escopo) | redesign (troca o mundo visual, preserva conteúdo, função e affordances nativas)> · audiência <quem> · tom <palavras do brief>.

- **Operar** (o caso normal do pacote — app, CRUD, dashboard, admin, editor, settings): escaneabilidade, consistência e expectativa nativa **vencem** expressão. A marca vive em detalhe preciso. Densidade e motion seguem o projeto; não "embeleze" tela de trabalho.
- **Persuadir** (landing, marketing, pricing, campanha): o visitante decide e age; aplique os dials abaixo antes de codar e reporte os valores.
- **Ler** (docs, artigo, ajuda, changelog): estrutura pra compreensão primeiro; depois faça valer a pena ficar.
- **Experienciar** (portfólio, galeria, showcase): o artefato lidera desde o primeiro viewport; a interface recua.
- A landing de uma ferramenta ainda é **Persuadir**; a documentação de uma marca de moda ainda é **Ler**. O brief pinado vence tudo (estética, era, fonte, paleta) — inclusive quando pede um dos "defaults banidos".
- Brief ambíguo entre dois modos → **uma** pergunta, não um questionário. Se dá pra inferir, declare e siga.
- **Fontes de sistema existentes a ler no Passo 1, se existirem no projeto:** `DESIGN.md` / `PRODUCT.md` (impeccable), `design-system/<slug>/MASTER.md` (ui-ux-pro-max), `docs/design.md` (este pacote). São o design system detectado — não gere outro, não rode `impeccable context` nem `--persist`.

## Passo 1 — Detecção do design system existente

Antes de escrever qualquer linha de CSS/JSX/etc., procure por:

- **Config de design tokens**: `tailwind.config.{js,ts,mjs}`, `theme.{js,ts}`, `tokens.{json,ts}`, `design-tokens/`, `src/styles/tokens.*`, CSS custom properties em `src/styles/`/`app/globals.css`
- **Sistema de componentes**: `src/components/ui/`, `src/components/primitives/`, `packages/ui/`, biblioteca instalada (shadcn/ui, Radix, Chakra, MUI, Mantine, Ant, etc. — checar `package.json`)
- **Padrões visuais recorrentes** em telas existentes: tipografia (família, escala), cor (paleta dominante + acentos), espaçamento (8px? 4px? múltiplos?), border-radius, shadow, motion (CSS-only? Motion? Framer? GSAP?)
- **Storybook / docs internos**: `.storybook/`, `apps/storybook/`, `docs/design/`, `STYLEGUIDE.md`
- **Tema dark/light**: como é alternado (data-attribute? class? next-themes? CSS prefers-color-scheme?)
- **i18n / copy**: arquivo de strings, biblioteca (next-intl, i18next, formatjs), idioma padrão

Reporte na sua resposta inicial (antes de codar) um bloco curto:

```
### Design system detectado
- Stack: [framework + lib UI ex: Next.js + shadcn/ui + Tailwind]
- Tokens: tailwind.config.ts (cores: primary/accent/muted; spacing escala 4px; radius .md .lg)
- Componentes base: src/components/ui/{button,card,input,...}
- Tipografia: var(--font-display) display + Inter body — definidas em app/layout.tsx
- Motion: tailwindcss-animate + Motion (framer-motion v11)
- Tema: next-themes class-based, dark mode default
- i18n: pt-BR como default via next-intl

Modo de operação: **seguir padrão existente** (não estabelecer novo)
```

ou:

```
### Design system detectado
Nenhum padrão prévio. Sem tokens, sem lib UI, sem componentes reutilizáveis.

Modo de operação: **estabelecer direção estética** via skill frontend-design
```

## Passo 2A — Modo "seguir padrão existente"

Quando o projeto JÁ tem design system:

- **Reuse primitivas, não recrie.** Se existe `<Button>`, use `<Button>`. Se a paleta é `primary/accent/muted`, NÃO crie classes hex avulsas. Toda exceção tem que ser justificada por escrito.
- **Match o ritmo do projeto** — mesma escala de espaçamento, mesmo border-radius default, mesmas elevações (shadow), mesma curva de animação. Inconsistência de 2px é IA-genérico.
- **Tipografia: use o que tá definido.** Não introduza família/peso/tamanho novo sem necessidade. Se o projeto usa um display font e Inter body, mantenha.
- **Componente novo segue a convenção de arquivo do projeto**: mesma estrutura (colocation? atomic? feature-folders?), mesma assinatura de props, mesma forma de export, mesmo padrão de teste.
- **Motion segue a curva e duração que já existe.** Se não há motion no projeto, **não invente** a menos que a story peça explicitamente.
- **Dark mode**: se o projeto tem, sua tela TEM que funcionar em ambos. Teste os dois.
- **`frontend-design` skill entra como checklist técnico** (estados, hierarquia, micro-interações de qualidade) — não como sugestão de mudar o "tom". O tom do projeto é o tom.

## Passo 2B — Modo "estabelecer direção"

Quando não há design system:

- Invoque `frontend-design` skill no modo cheio. Comita a UMA direção (brutalista, editorial, refinada minimalista, retro-futurista, etc.) — escolha intencional, não default.
- Estabeleça tokens (cores, tipografia, spacing, radius) **em arquivo de config** (Tailwind config / CSS vars), não inline. Próxima feature do projeto vai poder se ancorar.
- Crie pelo menos 1-2 primitivos reutilizáveis (`Button`, `Card`) já com o novo padrão — não deixe a próxima story sem base.
- Documente a direção escolhida em comentário curto na config ou em `docs/design.md` (1 parágrafo: tom, paleta, tipografia, motion).
- Linear/Stripe/Vercel são REFERÊNCIAS de qualidade de execução, não fórmulas. Não copie o look — copie a disciplina (intencionalidade, consistência, atenção a estados).

## Passo 2B (complemento) — tokens em 3 camadas e prioridade de estados (adaptado de ckm:design-system, MIT)
Ao estabelecer direção (sem design system prévio), organize tokens em **primitivo → semântico → componente** (`--color-blue-600` → `--color-primary` → `--button-bg`); componente nunca lê primitivo direto. Todo componente interativo declara os estados com esta **prioridade quando coexistem**: disabled > loading > active > focus > hover > default. Transição só em `color/background/border/box-shadow` com duração nomeada (`--duration-fast`).

## Anti-IA-genérico — vale SEMPRE (nos dois modos)

Estas regras independem de ter ou não design system:

**Conteúdo**
- ❌ Lorem ipsum. Use copy semântica do domínio do projeto (mesmo que placeholder, faça com sentido).
- ❌ Strings em inglês quando o produto é PT-BR (e vice-versa). Match com o i18n config.
- ❌ Emoji como ícone primário em UI séria (button "Salvar 💾"). Use o sistema de ícones do projeto (lucide, heroicons, etc.). Emoji decorativo deliberado em produto playful é OK.
- ❌ Imagens placeholder genéricas (unsplash random, "person 1.jpg"). Use o asset real ou skeleton/empty state desenhado.

**Estados completos (não-negociável)**
Toda tela/componente interativo precisa de:
- Loading (skeleton, spinner, ou disabled state — não "tela em branco")
- Empty (zero dados — o que mostrar? por que tá vazio? que ação convida?)
- Error (mensagem clara em PT-BR + ação de recovery, não só "Algo deu errado")
- Success / confirmação (quando aplicável — toast, redirect, micro-animação)
- Hover / focus / active visíveis (não dependa só de cor — contraste perceptível)
- Disabled (claramente disabled, não "parece clicável mas não funciona")

**Acessibilidade (não é opcional)**
- Contraste AA mínimo (4.5:1 texto normal, 3:1 grande). Verifique no token, não no chute.
- Navegação por teclado: tab order coerente, focus ring visível (não `outline: none` sem substituto).
- ARIA quando o componente é custom (modal → `role="dialog" aria-modal="true"`, etc.).
- Form labels associados (`<label htmlFor>` ou `aria-labelledby`). Placeholder NÃO é label.
- Imagens com `alt` significativo (ou `alt=""` se decorativo).
- Não use só cor pra transmitir estado (erro tem ícone + cor, não só cor).

**Hierarquia visual**
- Escala tipográfica DELIBERADA (4-5 tamanhos, não 12 random). Se o projeto tem, use a dele.
- Espaçamento em ritmo (múltiplos consistentes — 4px ou 8px). Não misture 7px, 13px, 15px.
- 1 elemento dominante por tela (CTA principal claro). Não competição entre 5 botões "iguais".
- Whitespace é design, não desperdício. Não preencha tudo.

**Composição em componentes**
- Componentes pequenos e compostos > 1 arquivo de 800 linhas.
- Props nomeadas como o projeto nomeia (se o projeto usa `variant="primary"`, não invente `kind="main"`).
- Separação concerns: lógica de dados (hooks, server actions) ≠ apresentação. UI puro recebe props.
- Reutilizável > específico-pra-tela quando faz sentido — mas não force abstração prematura.

**Padronização de CSS / nomenclatura — DRY de estilo**

A skill `frontend-design` já cuida da parte estética, mas a disciplina de **não repetir CSS** é responsabilidade desta camada. Regras:

- **Token > literal.** Se existe `--color-primary` / `theme.colors.primary` / `bg-primary` no projeto, use. Hex hardcoded (`#3b82f6`) só se for explicitamente um caso fora do sistema (e justifique).
- **Mesma combinação de classes 3+ vezes = extraia.** Padrões: `cn()` helper (clsx + tailwind-merge), `cva()` (class-variance-authority) pra variantes, componente reutilizável, ou utility class custom no Tailwind config. Escolha o que o projeto já usa.
- **Nomenclatura consistente — match o projeto.**
  - CSS modules: kebab-case (`.card-header`, não `.cardHeader`)
  - Classes utilitárias custom: mesmo prefixo do projeto (se ele usa `u-`, use `u-`)
  - BEM se o projeto é BEM (`.card`, `.card__header`, `.card--featured`)
  - CSS-in-JS (styled-components/emotion): PascalCase pros styled components (`StyledCard`)
  - Variáveis CSS: kebab-case com namespace (`--color-primary`, `--space-md`, não `--myVariable`)
  - data-attributes pra estado: `data-state="open"`, `data-variant="ghost"` (Radix-style se já uso) — NÃO crie classes `.is-open`, `.is-active` em paralelo às data-attributes.
- **Um conceito = um nome.** Se o projeto chama de `surface`, não introduza `card-bg`. Se chama de `muted`, não introduza `subtle`. Sinônimos espalhados = IA-genérico.
- **Escala numérica vs semântica — não misture.** Se o projeto usa semântico (`primary`, `accent`, `muted`), continue semântico. Se usa escala (`gray-100..gray-900`), continue escala. Misturar (`primary` + `gray-700`) quebra o sistema.
- **Não duplique tokens em arquivos diferentes.** Cor/spacing/radius mora em UM lugar (Tailwind config OU CSS vars OU theme.ts) — não nos três. Se encontrar duplicação no projeto, sinalize no relatório (não corrija fora de escopo, mas reporte).
- **Animação tem nome também.** Curvas (`ease-out-quart`), durações (`duration-fast`/`duration-base`) — defina nomes, não números soltos espalhados.
- **Breakpoints idem.** Use os tokens do projeto (`sm`, `md`, `lg` do Tailwind ou do CSS), nunca media query com valor hardcoded.

Antes de fechar a story, faça uma varredura no diff:
- Algum hex/rgb que devia ser token? → trocar.
- Alguma sequência de classes Tailwind repetida 3+ vezes? → extrair.
- Algum nome novo pra conceito existente? → renomear.
- Algum valor de px solto que devia ser variável de spacing? → trocar.

Reporte essa varredura no Dev Agent Record: "Padronização: substituí N hex por tokens, extraí M variantes via cva, renomeei X componente pra alinhar com convenção."

**Performance / qualidade de browser**
- Imagens com largura/altura definida (evitar CLS).
- Lazy load do que tá abaixo da fold.
- Não importe biblioteca inteira pra usar 1 ícone (`import { Save } from 'lucide-react'`, não `import * as Icons`).
- Bundle: cuidado com dependência nova "só pra isso". Verifique se primitives do projeto resolvem.

## Piso de craft — carregue logo antes de editar UI, em qualquer modo

**Verifique no resultado construído** (uma rodada de inspeção desktop + mobile, não um loop):
- Contraste: corpo e placeholder ≥ 4.5:1, texto grande ≥ 3:1; em superfície colorida, texto secundário tingido do matiz, nunca cinza.
- Profundidade: sombra tem offset **e** blur suave. Halo colorido sem offset é decoração.
- Espaçamento: grupos apertados, separação generosa, mais espaço **acima** de um título que abaixo. Leia os valores computados.
- Tipo: medida do corpo 65–75ch; display ≤ 6rem; tracking mínimo -0.04em; degraus de escala e peso óbvios; rode a **copy real** em todo breakpoint e conserte o que estoura.
- Motion: **um** momento autoral, não efeito espalhado nem a mesma entrada em toda seção; ease-out a partir de um estado já visível.
- Estados: hover, disabled, loading, error, empty + conteúdo real, controles funcionando, foco de teclado.
- Superfícies do browser: seleção de texto, caret, scrollbar, focus ring, underline offset, numerais tabulares em dado — carregam o design também.
- Copy: linguagem do produto; controle nomeia a ação; erro nomeia o problema e a saída.

**Recuse como default (o brief pode ganhar qualquer um de volta, exceto o marcado BAN):**
- Cards do mesmo tamanho (ícone + título + texto) como estrutura da página; card dentro de card.
- Hero-métrica (número grande, label pequeno, stats de apoio, acento).
- **Eyebrow/kicker acima de título — BAN.** Apague o rótulo; o título fala sozinho.
- Numeração de seção (01/02/03) sem sequência que informe. Modal pra tarefa que não exige interrupção.
- Texto em gradiente; glass/blur como decoração; `border-left` colorida > 1px em card/alerta; sombra dura `4px 4px 0` fora de um mundo neobrutalista.
- Sparkline/anel de progresso/retângulo arredondado como stand-in de conteúdo; monospace como fantasia de "técnico"; Impact/Arial Black/sans do sistema como display; emoji ou glifo unicode no lugar de ícone.
- Claro/escuro escolhido por categoria — escolha pela cena de uso.
- Os "tells" da skill `frontend-design` continuam: creme #F4F1EA + terracota, roxo em gradiente, Inter + slate-900 por toda parte, 3 cards iguais.

### Dials pra modo Persuadir (adaptado de taste-skill, MIT; o ui-ux-pro-max 2.13 expõe os mesmos via `--variance/--motion/--density`)
| Sinal do brief | Variância (1 simétrico–10 caos) | Motion (1 estático–10 cinemático) | Densidade (1 galeria–10 cockpit) |
|---|---|---|---|
| "minimalista / limpo / editorial / Linear" | 5–6 | 3–4 | 2–3 |
| "premium / Apple / luxo" | 7–8 | 5–7 | 3–4 |
| "agência / experimental / Awwwards" | 9–10 | 8–10 | 3–4 |
| landing SaaS padrão | 7 | 6 | 4 |
| "confiança / setor público / regulado / a11y crítica" | 3–4 | 2–3 | 4–5 |
| redesign-preservar | igual ao atual | +1 | igual |

- Se o brief bate com um **design system oficial** (Material, Fluent, Carbon, GOV.UK/USWDS, Polaris, Primer, Bootstrap, shadcn) → **instale o pacote oficial**, não recrie CSS. **Um sistema por projeto.**
- Estética sem pacote (glass, bento, brutalismo, editorial, aurora) → CSS nativo + Tailwind do projeto; não finja que é um "sistema".
- **CTA:** cabe em 1 linha no desktop (≤ 3 palavras); **uma label por intenção** na página inteira (não "Fale conosco" + "Entre em contato" + "Vamos conversar").
- Defaults banidos: ver "Recuse como default" acima.

### Evidência por seção — adaptador Taste para site público novo ou redesign

No **brief e report de frontend já existentes**, registre uma linha por seção de landing, portfólio, marketing ou editorial: **seção · propósito · afirmação sustentada · fonte da prova · status (`verificada`/`não verificada`) · caminho do asset · origem/licença ou prompt de geração · aparece na captura Playwright (`sim`/`não`/`não aplicável`)**. Se a seção não usa asset, marque `não aplicável`. Em redesign, preserve conteúdo e identidade definidos no brief e no design system existente.

Use só fatos que a fonte realmente sustenta; quando faltar prova, marque `não verificada` e ajuste a copy antes de publicar. Não invente depoimentos, números, clientes, direitos de uso nem evidência visual. Um caminho de asset no código não prova que ele apareceu: confira a captura desktop/mobile com Playwright (venv `/tmp/pwval`, nunca `agent-browser`) e marque `sim` apenas quando estiver visível. Aplique o mesmo critério ao reviewer de UI. Use a orientação do Taste para relacionar conteúdo, prova e imagem; não importe seus presets estéticos, cotas de seções ou chamadas obrigatórias de geração de imagem.

## Projeto Laravel/Blade (complemento)
Se o projeto é Laravel e o plugin `ui-ux-pro-max` está instalado, uma consulta pontual é permitida (não a skill inteira, não `--persist`):
`python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py" "<tema: form validation | blade component | livewire loading>" --stack laravel`
Regras que valem sempre em Blade: componente `x-*` com `@props` pra markup repetido; `@class` pra classe condicional; `{{ }}` (nunca `{!! !!}` com dado de usuário); `@vite` pra assets; diretivas Blade, não `<?php ?>`; layout único com `@extends`/`@section` ou componente de layout.

## React
Vale também no RN, menos DOM/SSR.
- Hook só no topo de componente/hook `use*` — nunca em `if`, loop, callback ou após `return` cedo (salvo `use()`). `react-hooks/*` só silenciado com motivo. (ECC rules/react/hooks)
- `useEffect` só sincroniza com sistema externo: derivado se calcula no render, reset por prop é `key` no pai, aviso ao pai no handler. (ECC rules/react/hooks)
- Effect com assinatura, timer, listener ou fetch devolve cleanup (`AbortController`/flag de resposta velha). (ECC react-reviewer)
- Estado não se muta (`arr.push`, `obj.x =`); valor do anterior em async/intervalo → `setX(x => …)`. `ref.current` só em effect/handler (salvo init lazy). (ECC react-reviewer, rules/react/hooks)
- `key` estável (id), nunca índice em lista que reordena, insere ou remove. (ECC rules/react/patterns)
- Com TanStack Query, SWR ou RSC, dado de servidor vem dele — sem `fetch` em `useEffect` nem cópia em store. (ECC rules/react/patterns)
- `<Suspense>` sobre dado que pode falhar tem Error Boundary acima (Next: `error.tsx`). (ECC rules/react/patterns)
- Ação só por clique em `<div>`/`<span>` → `<button>`/`<a>` nativo. (ECC react-reviewer)
- `dangerouslySetInnerHTML` só com fonte sob controle ou sanitizada por allowlist (DOMPurify ou o do projeto) na chamada; senão, texto. (ECC rules/react/security)
- URL de usuário em `href`/`src`: allowlist de esquema (`http:`/`https:`/`mailto:`) — o React 19 bloqueia `javascript:`, não `data:`. (ECC rules/react/security; medido React 19.3)
- `NEXT_PUBLIC_*`/`VITE_*`/`REACT_APP_*`/`EXPO_PUBLIC_*` vão pro bundle: nunca segredo. Token de sessão novo fora de `localStorage`/`sessionStorage` (cookie `httpOnly` se o backend é seu; SDK de auth adotado usa o dele). Esconder no JSX não autoriza: a API checa. (ECC rules/react/security)
- Com RSC/Next: `"use server"` é endpoint público — valida input e checa sessão/permissão; módulo com segredo ou cliente de banco leva `import "server-only"` (Next resolve sem instalar); registro inteiro (hash, token) não vira prop de Client Component; `"use client"` na folha interativa, não no layout. (ECC react-reviewer, rules/react/patterns; medido Next 16.3)
- Teste (se já há Testing Library): query por role/label/texto (`data-testid` por último); async com `findBy*`/`waitFor`, nunca `setTimeout`; `await` em `user.*`. (ECC rules/react/testing)

### Build quebrado
- Stop, caches e config intocável: `dominios/node.md` § Build quebrado (Vite: `node_modules/.vite`). Vite com `tsconfig.json` só de `references` (`files: []`): esse `tsc -p` passa com erro → use o `typecheck`/`build` do projeto (`tsc -b` só porque os filhos têm `noEmit`). Next: `next build` tipa; `tsc` avulso pede `next typegen`. (ECC react-build-resolver; hook cbs-typecheck; medido Vite 8/TS 6, Next 16.3)
- `Invalid hook call` → hook fora de componente, versões distintas de `react`/`react-dom` ou React duplicado (`npm ls react`). `@types/react` no major do `react`. `'React' is not defined` → `"jsx": "react-jsx"`. `Element type is invalid … undefined` → import default × nomeado. (ECC react-build-resolver; medido React 19.3)
- Hydration mismatch: `Date.now()`, `Math.random()`, `window`/`localStorage` no render ou HTML inválido (`<div>` em `<p>`) → valor de cliente em `useEffect`/`useSyncExternalStore`. Next: `Can't resolve 'fs'` no cliente → lógica pro servidor. (ECC react-build-resolver)

## React Native
CLI `expo`/`react-native` de `node_modules/.bin` (`npx` só fora de hook). Validação visual: simulador/emulador ou web (`expo start --web`, sem safe area/teclado nativo); declare o alvo ou "não validado". (ECC rules/react-native/production-readiness)
- Lista grande ou sem limite: `FlatList`/`SectionList` (ou `FlashList` instalado) com `keyExtractor` estável — nunca `.map()` em `ScrollView`. (ECC rules/react-native/performance)
- Tocável custom tem `accessibilityRole`/`role`; só ícone, `accessibilityLabel`/`aria-label`; estado em `accessibilityState`/`aria-*`; alvo ≥ 44pt/48dp (`hitSlop`); sem altura fixa que corte fonte ampliada. (ECC rules/react-native/accessibility)
- Safe area por `react-native-safe-area-context` (`SafeAreaView` do core: deprecated), sem offset fixo de notch. (ECC rules/react-native/coding-style; medido RN 0.87)
- `app.json`/`app.config` vão ao bundle: sem segredo. Token em Keychain/Keystore (`expo-secure-store` ou o do projeto), nunca `AsyncStorage`/MMKV sem cifra. (ECC rules/react-native/security)
- Param de rota/deep link, payload de push e resposta de API: valide com o schema do projeto (`safeParse`; `parse` lança no render). (ECC rules/react-native/patterns)
- Dep nativa nova: compatível com New Architecture (única desde RN 0.82) e, no Expo, por `expo install <pkg>` (versão do SDK). Mudança nativa exige build, não EAS Update. (ECC rules/react-native/production-readiness; medido RN 0.87)
- Teste: como §React (`testID` por último); E2E só no runner que já existe (Maestro/Detox). (ECC rules/react-native/testing)

### Build quebrado
- Typecheck como o Stop (`dominios/node.md`); lint: `expo lint` ou o do projeto. Versão nativa fora do SDK: `expo install --check` (`--fix`). (ECC rules/react-native/hooks; hook cbs-typecheck)
- Metro velho ou `Unable to resolve module`: `expo start --clear` ou `react-native start --reset-cache`. (fato de plataforma; medido Expo CLI 57, RN 0.87)
- `TurboModuleRegistry.getEnforcing … could not be found` após dep nativa: rebuild do binário (`expo run:ios|android`/dev build; RN puro: `pod install`), Metro não basta; Expo Go não carrega nativo fora do SDK. (ECC rules/react-native/production-readiness; medido RN 0.87)

## Loop obrigatório de validação visual

Antes de marcar a story como **Ready for Review**:

1. **Subir o dev server** (npm run dev / pnpm dev / etc.).
2. **Abrir a rota** e validar visualmente o golden path E pelo menos 2 estados (empty + error, ou loading + success).
3. **Verificar dark mode** se o projeto tem.
4. **Navegação por teclado** — Tab através da tela, Enter no CTA principal, Esc se houver modal.
5. **Mobile/responsivo** — pelo menos 1 breakpoint pequeno (360-414px) validado.
6. **Anotar no Dev Agent Record da story** quais estados foram visualmente validados (com link/path da rota), não só "testei".

Se o ambiente não permitir rodar o browser, **deixe explícito** no relatório final: "Não validei visualmente — ambiente headless. Recomendo validação manual nas rotas X, Y, Z antes do merge." Nunca alegue "validei" se não rodou.

## Saída esperada do subagent

Além do que o `@dev` BMAD pede normalmente (File List, Dev Agent Record, status Ready for Review):

- Bloco "### Design system detectado" no início da resposta (do Passo 1).
- Lista de **decisões estéticas tomadas** (se modo "estabelecer direção"): tom escolhido, paleta, tipografia, por quê.
- Lista de **primitivos reutilizados / criados**.
- Lista de **estados implementados** por componente/rota (loading, empty, error, success, etc.).
- **Validação visual**: o que foi checado no browser (rotas, breakpoints, dark mode, teclado). Ou nota explícita de "não foi possível validar visualmente".
- Em site público novo/redesign: registro "Evidência por seção" no mesmo report, com prova, origem/licença ou prompt dos assets e confirmação na captura Playwright.
- **Tradeoffs aceitos** (ex.: "não implementei animação de page-load porque o resto do projeto não tem motion ainda").

## Anti-padrões fatais (frontend)

- ❌ "Vou usar Tailwind soltinho sem olhar a config" → vai render IA-genérico
- ❌ Importar lib UI nova (shadcn, MUI...) quando o projeto já tem outra
- ❌ Criar nova paleta de cor "porque ficou bonito" — cliente espera consistência
- ❌ "Modern dashboard with purple gradient" — banido de fato (clichê IA)
- ❌ Esquecer dark mode quando o projeto tem
- ❌ `outline: none` no focus sem substituto
- ❌ Placeholder no lugar de label
- ❌ Loading = página em branco
- ❌ "Funciona no meu Chrome" sem testar teclado/responsivo
- ❌ Copiar JSX de outro projeto sem adaptar ao design system local

## Checklist do reviewer de UI (adaptado de ui-ux-pro-max 2.13 + audit do impeccable) — só pro code quality reviewer
Ordem de prioridade; pare no primeiro 🔴:
1. **A11y** 🔴 — contraste 4.5:1 (3:1 texto grande), foco visível 2–4px, `alt`, `aria-label` em botão só-ícone, tab order = ordem visual, `label for`, h1→h6 sem pulo, `prefers-reduced-motion` respeitado, estado não só por cor.
2. **Toque** 🔴 — alvo ≥ 44×44, gap ≥ 8px, nada só-hover, botão desabilita durante async com feedback.
3. **Layout/CLS** 🟡 — imagem com dimensão, skeleton em > 300ms, sem scroll horizontal em 360px, `min-h-dvh` não `100vh`, viewport sem `user-scalable=no`, corpo ≥ 16px no mobile.
4. **Consistência** 🟡 — mesmo set de ícones (SVG, não emoji), escala de elevação única, um CTA primário por tela, tokens em vez de hex.
5. **Tipografia** 🟡 — corpo 1.5–1.75 line-height, 45–75 caracteres por linha, escala definida, números tabulares em coluna de dado.
6. **Animação** 🟡 — 150–300ms micro / ≤ 400ms transição; só `transform`/`opacity`; máx. 1–2 elementos animados por view; saída mais curta que entrada.
7. **Forms** 🟡 — label visível (placeholder não é label), erro ao lado do campo, helper text onde há regra.
8. **Navegação** 🟡 — back previsível, bottom nav ≤ 5, deep link funciona.
9. **Charts** 🟢 — legenda, tooltip, cor acessível, não depende só de cor.
10. **Integridade de implementação** 🔴 — a tela expressa um sistema **deste** produto ou seria intercambiável com um produto qualquer? Drift do design system (hex solto, componente one-off onde existe primitivo), conteúdo decorativo/enganoso, itens do "Recuse como default" presentes sem o brief ter pedido.

Em site público novo/redesign, confira também as linhas "Evidência por seção": afirmações sem fonte marcada como verificadas, licença/origem inventada ou asset declarado que não aparece na captura bloqueiam a aprovação. Não aplique esta checagem a telas de app/CRUD/admin.

**Formato de saída do reviewer de UI** (entra no relatório junto do QA):

## Fontes
Rulebook original do pacote · adendo adaptado de pbakaus/impeccable (Apache-2.0: modos, piso de craft, score de audit, triagem), [Leonxlnx/taste-skill @ f624f37](https://github.com/Leonxlnx/taste-skill/blob/f624f37a8c650b9cc550253104925efe4c8de246/skills/taste-skill/SKILL.md) (MIT: Design Read, dials, regras de CTA, conteúdo e proveniência de assets), nextlevelbuilder/ui-ux-pro-max 2.13 (MIT: checklist por prioridade, `--stack laravel`), ckm:design-system (MIT: 3 camadas de token, prioridade de estados), skill oficial `frontend-design` (Apache-2.0), affaan-m/ECC (MIT: §React/§React Native). Reescrita em pt-BR.
