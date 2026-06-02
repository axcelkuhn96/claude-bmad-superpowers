# claude-bmad-superpowers

> Workflow PT-BR para [Claude Code](https://claude.com/claude-code): **refina sua ideia com a memória do projeto e entrega pra uma execução de qualidade** — TDD real, subagents isolados e dois reviewers por task.

Um pacote de **3 skills** e **8 comandos** em português que amarram quatro camadas, cada uma no seu nível:

| Camada | Quem faz | Papel |
|---|---|---|
| **Front-end PT-BR** (o diferencial) | skills deste pacote | Refina sua ideia com alinhamento + memória, e faz discovery sem tocar código |
| **Motor de execução** | [Superpowers](https://github.com/obra/superpowers) | brainstorming → plano → subagents com TDD + 2 reviews → verificação. Garante "desenvolver certo, sem erro" |
| **Disciplina de processo** (sempre) | [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | Gera as stories no planejamento e injeta as personas (`@dev`, `@qa`, review) em cada subagent do Superpowers |
| **Expertise por domínio** (quando aplicável) | rulebooks em `personas/dominios/` + skills oficiais | Em cima do `@dev`, empilha regras específicas do domínio (ex.: frontend invoca a skill oficial `frontend-design` e detecta o design system do projeto pra evitar IA-genérico). |

Em vez de competir, cada peça fica no que faz bem: **você refina em português, e a execução roda sempre com o Superpowers como motor + o BMAD como disciplina injetada dentro dele** (story → `@dev` → review/`@qa`).

---

## Índice

- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Como usar](#como-usar-escolhe-pelo-grau-de-maturidade-da-ideia)
- [Como o pipeline funciona](#como-o-pipeline-funciona)
- [Exemplo de fluxo real](#exemplo-de-fluxo-real)
- [As 3 skills](#as-3-skills)
- [Memória (claude-mem)](#memória-claude-mem)
- [BMAD: quando entra](#bmad-quando-entra)
- [Rulebooks de domínio](#rulebooks-de-domínio-frontend-)
- [CLI de referência](#cli-de-referência)
- [Customização que sobrevive a updates](#customização-que-sobrevive-a-updates)
- [Desinstalar](#desinstalar)
- [Troubleshooting](#troubleshooting)

---

## Pré-requisitos

- **Node 18+** (`node --version`)
- **Claude Code** instalado e logado (`claude --version`)
- **Git** (necessário pro BMAD e pros worktrees opcionais)
- Opcional, recomendado: **[claude-mem](https://github.com/thedotmack/claude-mem)** — se presente, as skills consultam sua memória de sessões anteriores antes de planejar.

---

## Instalação

Um comando instala tudo (cross-platform — Linux, macOS, Windows, WSL):

```bash
npx claude-bmad-superpowers instalar
```

Isso faz, em ordem:

1. **Skills + comandos + rulebooks de domínio** → copia as 3 skills, 8 comandos e os rulebooks (`personas/dominios/*.md`) pra `~/.claude/skills/`, `~/.claude/commands/` e `~/.claude/personas/`.
2. **Superpowers** → detecta o plugin; se não estiver instalado, mostra o comando exato pra rodar **dentro do Claude Code** (instalação de plugin não funciona via CLI fora do app).
3. **BMAD** → instala no diretório atual se você estiver dentro de um projeto (interativo). Pra pular: `--apenas-global`.

> Atalho: depois de instalar, os binários `claude-bmad-superpowers` e `cbs` ficam disponíveis. Use `cbs` pra digitar menos.

**Flags do `instalar`:**

| Flag | Efeito |
|---|---|
| `--apenas-global` / `--skip-bmad` | Não instala BMAD no diretório atual (só skills/comandos/Superpowers) |
| `--skip-superpowers` | Não tenta instalar o plugin Superpowers |

Verifique a qualquer momento:

```bash
cbs status
```

---

## Como usar (escolhe pelo grau de maturidade da ideia)

| Você tem... | Use | O que acontece |
|---|---|---|
| Ideia fuzzy, dúvida estratégica | `/investigar <tema>` | Pensa junto, mapeia o código, brainstorm, recomenda. **Não toca em código.** |
| Ideia clara mas crua | `/refinar <ideia>` | Co-desenha com você (alinhamento + memória) e gera um prompt premium |
| Ideia crua, sem querer perguntas | `/refinar-auto <ideia>` | Igual ao `/refinar` mas assume tudo não-crítico (marca as suposições) |
| Prompt/spec em mãos | `/executar <prompt>` | Superpowers executa com rigor: plano → subagents + TDD → verify |
| Atalho fim-a-fim | `/piloto <ideia>` | `/refinar` + `/executar` numa conversa só |
| Quer revisar o que foi feito | `/revisar [escopo]` | Code review + QA + security das mudanças (subagents `general-purpose` + personas BMAD). Reporta achados; só corrige com seu OK. |

Comandos de manutenção:

| Comando | Pra que |
|---|---|
| `/instalar-bmad` | Instala o BMAD no projeto atual (delega pra `cbs instalar-bmad`, interativo) |
| `/atualizar` | Atualiza o pacote + Superpowers + BMAD dos projetos registrados |

> **BMAD roda sempre** em `/executar` e `/piloto`: o planejamento gera as stories com BMAD antes do plano do Superpowers, e cada subagent de execução carrega a persona BMAD do seu papel. Não há flag pra desligar — é o comportamento padrão.

---

## Como o pipeline funciona

```
/investigar  →  discovery (sem código)
                mem-search → enquadra → Explore subagent → brainstorm →
                análise BMAD (analyst/pm) → recomendação → opcional PRD

/refinar     →  ideia → prompt premium
                mem-search → contexto (CLAUDE.md, código) →
                ALINHAMENTO (você decide junto) → prompt → loop de ajuste

/executar    →  prompt → código entregue
                mem-search
                → executor (orquestrador, NÃO implementa inline)
                  → BMAD gera stories (bmad-create-prd/story)
                  → classifica domínio por task (frontend, …)
                  → superpowers:writing-plans  (stories → plano com tasks)
                  → 🛑 "Posso implementar? [s/N]"
                  → superpowers:subagent-driven-development
                       · implementer general-purpose
                         + persona @dev (TDD, isolado)
                         + rulebook do domínio (se aplicável — ex. frontend invoca skill oficial frontend-design)
                       · spec reviewer + code quality reviewer general-purpose
                         + personas review/@qa do BMAD, por task
                  → superpowers:verification-before-completion
                  → entrega com checklist

/piloto      →  /refinar  +  /executar  (fim-a-fim)
```

**Por que isso protege seu contexto:** na fase de execução, o contexto principal só **orquestra** — cada task vira um subagent isolado que implementa e é revisado. O grosso do trabalho (grep, leitura, edição, testes) acontece nos subagents, não no seu chat principal.

---

## Exemplo de fluxo real

```text
você: /investigar vale a pena adicionar régua de cobrança pós-vencimento?

claude: [mem-search → enquadra problema → Explore mapeia código atual →
         brainstorm de 4 abordagens → análise BMAD analyst+pm →
         recomenda abordagem X com tradeoff explícito →
         oferece gerar PRD em docs/]

você: gera o PRD

claude: [escreve docs/regua-pos-vencimento.md]

você: /piloto implementa a régua conforme docs/regua-pos-vencimento.md

claude: [mem-search → refina (alinhamento, você OK) →
         "Posso executar?" → você OK →
         executor delega ao Superpowers:
           · writing-plans (plano com tasks)
           · "Posso implementar?" → você OK
           · subagent-driven-development (implementer + 2 reviewers por task)
           · verification-before-completion
           · entrega com checklist]
```

---

## As 3 skills

- **`refinador-de-prompt`** — transforma ideia crua em prompt premium (tags XML). Consulta memória (claude-mem) primeiro, mapeia o código, e **para num "Alinhamento" pra você co-decidir as escolhas ANTES de gerar o prompt**. Depois do prompt, ainda tem um loop "quer ajustar algo?". Distingue dúvidas bloqueantes (pergunta) de não-bloqueantes (assume e marca).

- **`investigador-de-ideia`** — modo discovery/discussão. **Proíbe edição de código-fonte** (só escreve em `docs/`). Faz enquadramento → investigação leve (Explore) → 3-5 abordagens com tradeoffs → análise BMAD analyst+pm → recomendação → opcional PRD draft. Use quando ainda está decidindo *o quê* fazer.

- **`executor-bmad-superpowers`** — orquestrador que **não implementa inline**. Delega a execução ao Superpowers (`writing-plans` → `subagent-driven-development` → `verification-before-completion`), com ponto de parada pedindo OK antes de codar. BMAD entra **sempre**: gera as stories no planejamento e injeta `@dev`/`@qa`/review em cada subagent.

---

## Memória (claude-mem)

Se você tem o **claude-mem** instalado, as skills invocam `mem-search` (ou `claude-mem:*`) **como primeira ação** — antes de planejar qualquer coisa. Isso traz pro contexto decisões anteriores, padrões já estabelecidos e bugs já resolvidos no mesmo domínio, citando os IDs das memórias usadas no prompt.

Sem claude-mem, as skills marcam "Memória: não disponível" e seguem normalmente.

---

## BMAD + Superpowers: sempre juntos

BMAD e Superpowers **rodam sempre em conjunto**, em camadas — não são alternativas e não há flag pra desligar:

1. **Discovery** (`/investigar`) — perspectivas analyst/pm pra avaliar produto/mercado.
2. **Execução** (`/executar`, `/piloto`) — BMAD gera as stories antes do plano, e suas personas são injetadas nos subagents do Superpowers (ver abaixo).

### Como BMAD entra sem virar uma persona solta

O BMAD tem agentes (`@dev`, `@qa`/TEA, etc.), mas eles **nunca são dispachados como tipo de agente** — isso traria uma persona com agenda própria pra dentro da execução, fugindo do plano/TDD (mesmo problema de usar `voltagent-*` como implementer). Em vez disso, **todo subagent continua `general-purpose`** e as **convenções do agente BMAD correspondente ao papel** são injetadas no prompt:

| Subagent (`general-purpose`) | Persona BMAD injetada |
|---|---|
| Implementer | `@dev` — tasks/subtasks da story, File List, Dev Agent Record, Ready for Review |
| Spec reviewer | review BMAD — confere contra critérios de aceite e tasks da story |
| Code quality reviewer / QA | `@qa`/TEA — test design, testes baseados em risco, rastreabilidade |
| Code review | `bmad-code-review` |
| Security | sem equivalente BMAD — `general-purpose` + checklist |

Resultado: você mantém o isolamento + TDD + 2 reviewers do Superpowers (o motor) e ainda ganha a disciplina de story/QA do BMAD (o processo) em cada etapa. Por isso o BMAD é **requisito** — sem ele instalado, o executor para e oferece `/instalar-bmad`.

Pra instalar no projeto:

```bash
cd meu-projeto
cbs instalar-bmad        # interativo, registra o projeto pro /atualizar
```

---

## Rulebooks de domínio (frontend, …)

Em cima do `@dev` BMAD, o executor empilha um **rulebook específico de domínio** quando a task envolve uma área onde "código bom" tem regras próprias. O subagent continua `general-purpose` — o conteúdo do rulebook é injetado no prompt, mesmo trick do persona-as-instructions.

**Onde mora:** `~/.claude/personas/dominios/<dominio>.md` (base) e `~/.claude/cbs-overrides/personas/dominios/<dominio>.md` (override do usuário — sobrescreve o base por arquivo). O `/atualizar` preserva o que tá em `cbs-overrides/`.

### Frontend (implementado nesta versão)

Quando a task é de UI:

1. **Skill oficial `frontend-design`** (do plugin `claude-plugins-official` da Anthropic) é invocada SEMPRE pelo implementer antes de codar. Sem ela, a saída cai em "AI slop" (purple gradients, Inter por toda parte, dashboards genéricos).
2. **Detecção de design system primeiro.** Antes de qualquer pensamento estético, o subagent procura no projeto: Tailwind config, theme/tokens, biblioteca UI (shadcn, Radix, etc.), componentes recorrentes, Storybook, motion lib, modo dark/light, i18n.
3. **Modo dual:**
   - **Padrão existe** → segue o padrão do projeto rigorosamente (reusa primitivos, tipografia, motion, escala de espaçamento). A skill `frontend-design` entra como checklist técnico de qualidade (estados, hierarquia, acessibilidade), **não** como sugestão de mudar o tom.
   - **Padrão NÃO existe** → aí sim comita a uma direção estética distinta (brutalista, editorial, refinada, etc.) via `frontend-design` e estabelece tokens já em config.
4. **Anti-IA-genérico em ambos os modos:** sem lorem, sem emoji como ícone, estados completos obrigatórios (loading/empty/error/foco/disabled), contraste AA, hierarquia tipográfica deliberada, copy alinhada ao i18n do projeto.
5. **DRY de CSS / nomenclatura:** token > literal, 3+ repetições → extrair (cn / cva / utility / componente), naming consistente com o projeto, um conceito = um nome, tokens duplicados em arquivos diferentes são sinalizados.
6. **Loop de validação visual obrigatório** antes de Ready for Review: dev server up + golden path + 2 estados + dark mode + teclado + 1 breakpoint mobile, anotados no Dev Agent Record. Se o ambiente é headless, declara isso explicitamente — nunca alega "validei" sem ter rodado.

> **Não vai sempre te dar Linear/Stripe/Vercel.** Vercel é referência de *disciplina* de execução, não fórmula. Se seu projeto já tem um padrão, o subagent segue ele; se não tem, aí sim comita uma direção bold.

### Customizar pro seu projeto

Quer endurecer regras (ex.: bloquear instalar shadcn novo, exigir biblioteca de ícones específica, exigir uso do design system X)? Crie:

```bash
~/.claude/cbs-overrides/personas/dominios/frontend.md
```

Esse arquivo sobrescreve o base por completo. O `/atualizar` não toca nele. Você pode começar copiando o base:

```bash
cp ~/.claude/personas/dominios/frontend.md ~/.claude/cbs-overrides/personas/dominios/frontend.md
# edita, adiciona suas regras
```

Tasks que não envolvem UI seguem só com o `@dev` BMAD padrão (comportamento herdado das versões anteriores) — frontend é o único domínio com rulebook próprio nesta versão.

---

## CLI de referência

```bash
cbs instalar         # tudo: skills + comandos + Superpowers + BMAD (no cwd)
cbs instalar-bmad    # só BMAD no diretório atual (interativo) + registra
cbs atualizar        # self-update + skills/comandos + Superpowers + BMAD dos projetos
cbs remover          # desinstala skills/comandos (preserva cbs-overrides/)
cbs status           # versão instalada, skills/comandos ativos, plugins, BMAD
```

**Flags do `atualizar`:**

| Flag | Efeito |
|---|---|
| `--skip-self-update` | Não tenta atualizar o próprio pacote (git pull / npx @latest) |
| `--skip-bmad` | Não mexe no BMAD dos projetos registrados |
| `--auto-bmad` / `-y` | Atualiza BMAD em todos os projetos sem perguntar |

O `atualizar` detecta como o pacote foi instalado (clone git ou npm) e se atualiza sozinho; depois reescreve só a camada base, **preservando suas customizações** (veja abaixo).

---

## Customização que sobrevive a updates

Modelo de **camadas**: o pacote escreve arquivos com um marcador no rodapé; o `atualizar` só sobrescreve esses. Suas edições ficam separadas e nunca são tocadas.

```
~/.claude/
├── skills/refinador-de-prompt/SKILL.md   ← base (atualizado pelo `atualizar`)
├── commands/refinar.md                    ← base (atualizado pelo `atualizar`)
└── cbs-overrides/                         ← SEU, nunca tocado pelo update
    ├── skills/<nome>/SKILL.md             ← sua versão custom
    └── commands/<nome>.md                 ← sua versão custom
```

Quer alterar um comando sem perder no update? Crie a versão custom em `~/.claude/cbs-overrides/`.

---

## Desinstalar

```bash
cbs remover          # remove skills/comandos do pacote; preserva cbs-overrides/
```

Não desinstala o Superpowers nem o BMAD — a saída mostra os comandos pra isso (`/plugin uninstall superpowers@superpowers-marketplace`, etc.).

---

## Troubleshooting

| Sintoma | Solução |
|---|---|
| `comando claude não encontrado` | Claude Code não está no PATH. A CLI imprime as instruções pra instalar o Superpowers manualmente dentro do app. |
| Superpowers não instalou | Dentro do Claude Code: `/plugin marketplace add obra/superpowers-marketplace` e `/plugin install superpowers@superpowers-marketplace` |
| BMAD pede perguntas no install | O `cbs instalar-bmad` passa `--modules bmm,core --tools claude-code` pra rodar não-interativo; se ainda perguntar, responda conforme aparece |
| Quero reinstalar do zero | `cbs remover && cbs instalar` (suas customizações em `cbs-overrides/` sobrevivem) |

Mais detalhes em [INSTALL.md](INSTALL.md).

---

## Contribuir

Issues e PRs bem-vindos. Foco: conteúdo das skills, novas integrações, exemplos.

## Licença

MIT — veja [LICENSE](LICENSE).

## Créditos

- [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) — BMad Code
- [Superpowers](https://github.com/obra/superpowers) — Jesse Vincent (obra)
- [Claude Code](https://claude.com/claude-code) — Anthropic
