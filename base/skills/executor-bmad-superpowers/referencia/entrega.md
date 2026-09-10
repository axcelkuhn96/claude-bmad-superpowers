# Template — `docs/analises/<data>-entrega-<slug>.md` (executor, Fase 7)

No chat vai **uma linha**: `Fase 7 — entrega: testes X/X — docs/analises/<arquivo> — aguardando opção de integração`. Tudo abaixo vai no arquivo. Seções sem conteúdo levam 1 linha ("Nenhum").

Ordem na Fase 7: o SDD parou **antes** do Finish dele (workspace e ledger intactos) → você lê `.superpowers/sdd/<plano>/progress.md` → escreve este arquivo → commita entrega + revisão → apaga o workspace deste plano → chama `finishing-a-development-branch` uma única vez.

```markdown
# Entrega: <feature>

Data: <AAAA-MM-DD> · Branch: `<nome>` · Modo: auto | normal · Runtime: claude | codex
Papéis: implementer_backend=<x>, implementer_frontend=<y>, reviewer=<z>, final_reviewer=<w>, tester=<v> (agente nomeado ou modelo; `agente ausente: <nome>` quando caiu no modelo)
Plano: `docs/superpowers/plans/<arquivo>` · Stories: `<caminhos>` · BMAD: skill | template | simulado

## Resumo
[1–2 frases sobre o que foi entregue]

## Arquivos alterados
- ...

## Decisões e rulings
[Todas as linhas `Ruling:` do ledger do SDD, na ordem, cada uma com o custo se estiver errada. Lista exaustiva — uma decisão que morre com o workspace foi tomada em segredo.]

## Suposições (SUPOSIÇÃO)
[Obrigatório em --auto: cada suposição feita no lugar de uma pergunta, com o valor assumido]

## Comandos executados e saída
[verification-before-completion: comando + saída real colada, por comando (testes, build, lint)]

## Testes
- Passaram: N · Falharam: N (explique) · Cobertura nova: ...
- E2E / browser: caminho dos screenshots ou "não validado visualmente — ambiente headless"

## Gate de segurança (`node ~/.claude/scripts/gate-seguranca.js`)
- aprovado | aprovado com gate parcial (ferramentas ausentes: ...) | n.a. (sem task backend) — saída resumida colada

## Revisão final (Fase 6)
[achados 🔴/🟡 e o que foi corrigido, ou "pulada — sem gatilho"] · relatório: `docs/analises/<data>-revisao-<slug>.md`

## Como validar manualmente
1. ...

## Riscos restantes
- ...

## Próximos passos
- ...
```
