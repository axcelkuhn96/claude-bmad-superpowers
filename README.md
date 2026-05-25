# claude-bmad-superpowers

> Workflow PT-BR para [Claude Code](https://claude.com/claude-code): **refina sua ideia com a memória do projeto e entrega pra uma execução de qualidade** — TDD real, subagents isolados e dois reviewers por task.

Um pacote de **3 skills** e **7 comandos** em português que amarram três coisas que já funcionam bem, cada uma no seu nível:

| Camada | Quem faz | Papel |
|---|---|---|
| **Front-end PT-BR** (o diferencial) | skills deste pacote | Refina sua ideia com alinhamento + memória, e faz discovery sem tocar código |
| **Motor de execução** | [Superpowers](https://github.com/obra/superpowers) | brainstorming → plano → subagents com TDD + 2 reviews → verificação. Garante "desenvolver certo, sem erro" |
| **Planejamento de produto** (opcional) | [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | PRD, épicos, stories — pra discovery e features grandes/multi-story |

Em vez de competir, cada peça fica no que faz bem: **você refina em português, o Superpowers executa com rigor, o BMAD ajuda quando o escopo é de produto.**

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

1. **Skills + comandos** → copia as 3 skills e 7 comandos pra `~/.claude/skills/` e `~/.claude/commands/`.
2. **Superpowers** → detecta/instala o plugin via marketplace do Claude Code (ou te mostra o comando exato se precisar rodar dentro do app).
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

Comandos de manutenção:

| Comando | Pra que |
|---|---|
| `/instalar-bmad` | Instala o BMAD no projeto atual (delega pra `cbs instalar-bmad`, interativo) |
| `/atualizar` | Atualiza o pacote + Superpowers + BMAD dos projetos registrados |

> **`--bmad`** em `/executar` ou `/piloto` força o planejamento estruturado do BMAD (PRD/épicos/stories) antes do plano. Por padrão é opt-in — só vale a pena em feature grande/multi-story.

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
                  → superpowers:writing-plans  (plano com tasks)
                  → 🛑 "Posso implementar? [s/N]"
                  → superpowers:subagent-driven-development
                       · implementer subagent (TDD, contexto isolado) por task
                       · spec reviewer + code quality reviewer por task
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

- **`executor-bmad-superpowers`** — orquestrador que **não implementa inline**. Delega a execução ao Superpowers (`writing-plans` → `subagent-driven-development` → `verification-before-completion`), com ponto de parada pedindo OK antes de codar. BMAD entra só opt-in.

---

## Memória (claude-mem)

Se você tem o **claude-mem** instalado, as skills invocam `mem-search` (ou `claude-mem:*`) **como primeira ação** — antes de planejar qualquer coisa. Isso traz pro contexto decisões anteriores, padrões já estabelecidos e bugs já resolvidos no mesmo domínio, citando os IDs das memórias usadas no prompt.

Sem claude-mem, as skills marcam "Memória: não disponível" e seguem normalmente.

---

## BMAD: quando entra

BMAD **não fica no caminho da execução de feature única** (seria cerimônia redundante — o prompt refinado já é spec suficiente pro Superpowers). Ele entra em dois lugares:

1. **Discovery** (`/investigar`) — perspectivas analyst/pm pra avaliar produto/mercado.
2. **Features grandes/multi-story** — com `--bmad`, gera PRD → épicos → stories antes do plano de execução.

### E o `@dev` do BMAD?

O BMAD tem um agente Dev (`@dev`), mas ele **não é dispachado como tipo de agente** — isso traria uma persona com agenda própria pra dentro da execução, fugindo do plano/TDD (mesmo problema de usar `voltagent-*` como implementer). Em vez disso, no caminho `--bmad`, as **convenções do `@dev`** (seguir as tasks/subtasks da story, marcar checkboxes, atualizar File List + Dev Agent Record, status → Ready for Review) são **injetadas no prompt do implementer `general-purpose`**. Resultado: você mantém o isolamento + TDD + 2 reviewers do Superpowers e ainda ganha a disciplina de story do BMAD. Sem `--bmad`, o implementer segue só o plano do `writing-plans`.

Pra instalar no projeto:

```bash
cd meu-projeto
cbs instalar-bmad        # interativo, registra o projeto pro /atualizar
```

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
