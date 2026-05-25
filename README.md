# claude-bmad-superpowers

Workflow PT-BR para Claude Code: **refina sua ideia com memória do projeto e entrega pra uma execução de qualidade** (TDD real, subagents isolados, dois reviewers por task).

**Como funciona a divisão:**
- **Front-end PT-BR (o diferencial):** `/refinar` co-desenha sua ideia (alinhamento + memória via claude-mem) antes de gerar o prompt; `/investigar` faz discovery sem tocar código.
- **Superpowers = motor de execução:** brainstorming → plano → `subagent-driven-development` (implementer isolado + spec reviewer + code quality reviewer por task) → verificação antes de declarar pronto. É quem garante "desenvolver certo, sem erro".
- **BMAD = planejamento de produto (opcional):** entra no discovery e em features grandes/multi-story. Não fica no caminho da execução de uma feature única.

Em vez de competir, cada peça fica no que faz bem: você refina em português, o Superpowers executa com rigor, o BMAD ajuda quando o escopo é de produto.

---

## Instalação

Pré-requisitos: Node 18+, [Claude Code](https://claude.com/claude-code) instalado e logado.

```bash
npx claude-bmad-superpowers instalar
```

A CLI faz:
1. Cria/popula `~/.claude/skills/` e `~/.claude/commands/` com as 3 skills e 7 commands.
2. Instala o plugin **Superpowers** via marketplace do Claude Code.
3. Avisa como instalar o **BMAD-METHOD** em cada projeto (ele é per-project).

Pra atualizar tudo depois:

```bash
npx claude-bmad-superpowers atualizar
```

Pra ver o que tá ativo:

```bash
npx claude-bmad-superpowers status
```

---

## Como usar (escolhe pelo grau de maturidade da ideia)

| Você tem... | Use | O que acontece |
|---|---|---|
| Ideia fuzzy, dúvida estratégica | `/investigar <tema>` | Pensa junto, mapeia, brainstorm, recomenda. **Não toca em código.** |
| Ideia clara mas crua | `/refinar <ideia>` | Vira prompt premium contextualizado pelo projeto |
| Prompt em mãos | `/executar <prompt>` | Superpowers executa com rigor (plano → subagents + TDD → verify). BMAD opt-in (`--bmad`) |
| Atalho fim-a-fim | `/piloto <ideia>` | Refina → mostra prompt → pede OK → executa via Superpowers |

E mais:

| Comando | Pra que |
|---|---|
| `/refinar-auto <ideia>` | Refina sem perguntar dúvidas não-críticas (assume e marca) |
| `/instalar-bmad` | Roda `npx bmad-method install` no projeto atual |
| `/atualizar` | Atalho pra `npx claude-bmad-superpowers atualizar` |

---

## Exemplo de fluxo real

```text
você: /investigar será que vale a pena adicionar régua de cobrança pós-vencimento?

claude: [enquadra problema → mapeia código atual (Explore subagent) →
         brainstorm 4 abordagens → análise BMAD analyst+pm →
         recomenda abordagem X com tradeoffs explícitos →
         oferece gerar PRD em docs/regua-pos-vencimento.md]

você: gera o PRD

claude: [escreve docs/regua-pos-vencimento.md]

você: /piloto implementa a régua conforme docs/regua-pos-vencimento.md

claude: [mem-search → refina (alinhamento + você OK) →
         "Posso executar?" → você OK →
         executor delega ao Superpowers:
           - writing-plans (plano com tasks)
           - "Posso implementar?" → você OK
           - subagent-driven-development:
               · implementer subagent (TDD, contexto isolado)
               · spec reviewer + code quality reviewer por task
           - verification-before-completion
           - entrega com checklist]
```

> Feature grande/multi-story? Use `/executar --bmad` ou `/piloto --bmad` pra o BMAD gerar PRD/épicos/stories antes do plano.

---

## As 3 skills

- **`refinador-de-prompt`** — transforma ideia crua em prompt premium em tags XML. Usa memória (claude-mem se disponível), Explore subagent pra mapear código, detecta se BMAD está no projeto. Distingue dúvidas **bloqueantes** (pergunta) de **não-bloqueantes** (assume e marca como suposição).

- **`investigador-de-ideia`** — modo discovery/discussão. **Proíbe** edição de código-fonte. Só escreve em `docs/`. Faz enquadramento → investigação leve → brainstorming disciplinado (Superpowers) → análise BMAD analyst+pm → recomendação com tradeoffs → opcional: gera PRD draft.

- **`executor-bmad-superpowers`** — orquestrador que **não implementa inline**: delega a execução ao Superpowers (`writing-plans` → `subagent-driven-development` com implementer + 2 reviewers por task → `verification-before-completion`). Ponto de parada pedindo OK antes de codar. BMAD opt-in pra features grandes.

---

## Customização que sobrevive a updates

O pacote usa **modelo de camadas**:

```
~/.claude/
├── skills/refinador-de-prompt/SKILL.md   ← base (atualizado pelo `atualizar`)
├── commands/refinar.md                    ← base (atualizado pelo `atualizar`)
└── cbs-overrides/                         ← seu, NUNCA tocado pelo update
    ├── skills/refinador-de-prompt/SKILL.md   ← se existir, MERGE depois do base
    └── commands/refinar.md                    ← se existir, SUBSTITUI o base
```

Quer alterar um comando? Crie a versão custom em `~/.claude/cbs-overrides/commands/refinar.md`. O `/atualizar` nunca apaga.

---

## Desinstalar

```bash
npx claude-bmad-superpowers remover
```

Remove skills/commands do pacote. Preserva `cbs-overrides/`. Não desinstala Superpowers nem BMAD (mostra os comandos pra isso).

---

## Contribuir

Issues e PRs bem-vindos. Foco: melhorar o conteúdo das skills, novas integrações (claude-mem, mcp-servers), traduções de exemplos.

## Licença

MIT — veja [LICENSE](LICENSE).

## Créditos

- [BMAD-METHOD](https://github.com/bmadcode/BMAD-METHOD) — Brian Madison
- [Superpowers](https://github.com/obra/superpowers) — Jesse Vincent (obra)
- [Claude Code](https://claude.com/claude-code) — Anthropic
