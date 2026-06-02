# Domínio: Frontend / UI

Rulebook injetado no prompt do subagent `general-purpose` quando a story for de UI/frontend. **Stacka em cima do `@dev` BMAD**, não substitui — o subagent é Dev + UI, não só UI.

> Skill oficial obrigatória: invoque `frontend-design` (plugin `claude-plugins-official`) **toda vez** que houver story de UI. Ela guia a parte estética/criativa. Este rulebook diz **como usar** ela no contexto do projeto.

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)

1. **DETECTE o design system existente do projeto ANTES de pensar em estética.**
2. **Se existir um padrão** → siga ele rigorosamente. A skill `frontend-design` entra como referência de qualidade técnica (estados, motion, hierarquia), **não** como licença pra "redesenhar bold".
3. **Se NÃO existir padrão** → aí sim invoque `frontend-design` no modo cheio (commit a uma direção estética distintiva) e estabeleça o sistema enquanto implementa.
4. **Anti-IA-genérico vale nos dois modos** (regras abaixo).

> O objetivo nunca é "imponha estética premium tipo Linear/Stripe/Vercel". O objetivo é **consistência intencional** — que pode ser a do projeto ou, na ausência, uma direção bold deliberadamente escolhida.

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
