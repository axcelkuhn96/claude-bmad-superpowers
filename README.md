# claude-bmad-superpowers

Workflow PT-BR para Claude Code que une **BMAD-METHOD** (planejamento estruturado com agentes PM/Architect/SM/Dev/QA) e **Superpowers** (brainstorming disciplinado, TDD, subagents, verificação real) num fluxo coerente de **discovery → planejamento → execução**.

Nasceu da observação de que BMAD e Superpowers se complementam: um traz o "o quê/por quê", o outro traz o "como" com rigor. Mas usados separados é cerimônia. Esse pacote junta os dois com nomes em português e atalhos que fazem sentido no dia a dia.

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
| Prompt em mãos | `/executar <prompt>` | BMAD planeja → Superpowers implementa (7 fases, TDD obrigatório) |
| Atalho fim-a-fim | `/piloto <ideia>` | Refina → mostra prompt → pede OK → executa |

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

claude: [refina → mostra prompt premium → você OK →
         executa as 7 fases:
           1. intake
           2. brainstorming técnico (2-3 abordagens)
           3. plano BMAD (PM+Architect+SM geram shards/stories)
           4. confirmação
           5. impl TDD incremental
           6. QA + security review (subagents)
           7. entrega com checklist]
```

---

## As 3 skills

- **`refinador-de-prompt`** — transforma ideia crua em prompt premium em tags XML. Usa memória (claude-mem se disponível), Explore subagent pra mapear código, detecta se BMAD está no projeto. Distingue dúvidas **bloqueantes** (pergunta) de **não-bloqueantes** (assume e marca como suposição).

- **`investigador-de-ideia`** — modo discovery/discussão. **Proíbe** edição de código-fonte. Só escreve em `docs/`. Faz enquadramento → investigação leve → brainstorming disciplinado (Superpowers) → análise BMAD analyst+pm → recomendação com tradeoffs → opcional: gera PRD draft.

- **`executor-bmad-superpowers`** — executor com 7 fases obrigatórias: intake, brainstorming técnico, plano BMAD real (invoca `@pm`/`@architect`/`@sm` e gera shards no fs), confirmação, implementação TDD (Superpowers), QA + security review com subagents, entrega.

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
