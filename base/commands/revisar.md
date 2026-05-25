---
description: Revisa tudo que foi feito (mudanças da branch / working tree) — code review + QA + security com Superpowers e personas BMAD, em subagents general-purpose. Read-only por padrão: reporta achados e só corrige com seu OK.
---

**ORDEM OBRIGATÓRIA — sem julgamento, sem exceção:**

1. **PRIMEIRO**: invoque `Skill` com `skill: "mem-search"` passando o tema das mudanças como query. Se não existir, tente `claude-mem:mem-search`; se nenhuma existir, registre "Memória: não disponível".

2. **Determine o escopo (sem editar nada):**
   - Se o usuário passou argumentos (arquivos, PR, descrição), use-os como escopo.
   - Senão, levante o que mudou: `git status` + `git diff` (não-commitado) e, se estiver numa branch de feature, `git diff <base>...HEAD` pros commits da branch.
   - Liste os arquivos/áreas que vão ser revisados antes de começar.

3. **Revisão — delegada a subagents `subagent_type: "general-purpose"` (NUNCA `code-reviewer`/`qa-expert`/`security-auditor`/`voltagent-*`/`bmad-agent-*` como tipo de agente):**
   - Invoque `superpowers:requesting-code-review` se existir no ambiente.
   - Despache subagents `general-purpose` com as personas BMAD injetadas no prompt:
     - **Code review** → convenções do review do BMAD (`bmad-code-review`): conferir contra os critérios de aceite/story, padrões do projeto, escopo (nada fora do pedido).
     - **QA** → `@qa`/TEA: cobertura de testes, casos de borda, falhas previsíveis (timeout, dado inválido, concorrência), rastreabilidade story↔código↔teste.
     - **Security** → checklist (auth/autorização, validação de input, exposição de dados, injection, XSS, permissões por tenant, idempotência, secrets). O BMAD não tem agente de security dedicado — aqui é só o checklist no `general-purpose`.
   - O contexto principal **só orquestra**: o trabalho de ler diffs e código acontece nos subagents, não no chat principal.

4. **Relatório final (formato fixo, sempre):**

```
## Escopo revisado
- arquivos / commits / áreas

## Achados por severidade
- 🔴 Bloqueante: ...
- 🟡 Atenção: ...
- 🟢 OK: ...

## Cobertura de testes
- o que está testado / lacunas

## Segurança
- itens do checklist + achados

## Veredito
- Pronto pra merge? O que falta.
```

5. **NÃO corrija nada sem OK.** Termine perguntando: **"Quer que eu corrija os 🔴/🟡 agora? [s/N]"**. Se `s`, aí sim delegue as correções ao `superpowers:subagent-driven-development` (implementer `general-purpose` + persona `@dev`), na branch atual, sem worktree.

Escopo (opcional — vazio = revisar mudanças da branch atual):

$ARGUMENTS
