---
name: handoff
description: Use esta skill quando o usuário quiser compactar a conversa atual num documento de handoff pra outro agente (ou outra sessão) continuar o trabalho sem reler todo o histórico. Gatilhos "gera um handoff", "passa o bastão", "documento de continuação". Referencia artefatos em vez de duplicar, redige segredos e sugere próximas skills.
---

# Handoff

Você produz um **documento de handoff**: um resumo que permite a um agente novo (ou uma sessão futura) retomar o trabalho **sem** reler toda esta conversa.

Adaptado do padrão `handoff` de [mattpocock/skills](https://github.com/mattpocock/skills), no tom do CBS.

## Onde salvar

- Se existir `docs/` no projeto → salve em `docs/handoffs/<slug>-<data-curta>.md` (ex.: `docs/handoffs/regua-cobranca-0716.md`). Assim o handoff fica versionável junto do projeto.
- Se **não** existir `docs/` → salve no diretório temporário do SO (ex.: `$TMPDIR` / `/tmp`) pra não sujar o workspace, e informe o caminho ao usuário.

Se o usuário passou argumentos, trate-os como **descrição do foco da próxima sessão** e ajuste o documento pra isso.

## Regras não-negociáveis

1. **Referencie, não duplique.** Specs, planos, ADRs, issues, PRDs, commits e diffs que já existem entram como **link/caminho**, não copiados no corpo. O handoff aponta; não reescreve.
2. **Redija segredos.** Nunca inclua API keys, senhas, tokens, connection strings ou PII. Substitua por `[REDIGIDO]` e diga onde o segredo vive (ex.: "token em `.env` → `STRIPE_KEY`").
3. **Inclua "Skills sugeridas".** Uma seção dizendo quais skills/comandos o próximo agente deve invocar (`/refinar`, `/executar`, `/piloto`, `/revisar`, `/grelhar`, `/mapear`, `mem-search`, etc.) e por quê.
4. **Consulte a memória** (se disponível) pra referenciar decisões já registradas em vez de reexplicá-las.

## Formato do documento

```markdown
# Handoff: [título curto do trabalho]

> Gerado em [data]. Foco da próxima sessão: [do argumento, ou "continuar de onde parou"].

## Objetivo
[1-3 linhas: o que se está tentando fazer e por quê.]

## Estado atual
- [o que já foi feito / decidido — bullets curtos]
- [o que está em andamento agora]

## Artefatos (não duplicados — siga os links)
- Spec/PRD: [caminho ou URL]
- Plano: [caminho]
- Branch/commits relevantes: [nomes/hashes]
- Diff em aberto: [resumo de 1 linha + como ver: `git diff ...`]
- Memórias claude-mem: [IDs, se houver]

## Decisões tomadas
- [decisão] → [resolução] (por quê, se não-óbvio)

## Pendências / questões abertas
- [ ] [o que falta decidir ou fazer]

## Riscos / armadilhas
- [o que pode morder o próximo agente]

## Segredos referenciados (redigidos)
- [nome do segredo] → vive em [local], valor `[REDIGIDO]`

## Skills sugeridas pro próximo passo
- `/[comando]` — [por quê agora]
```

## Fluxo

1. **Memória primeiro** (se disponível): `mem-search` com o tema, pra não reexplicar o que já está registrado.
2. Levante os artefatos existentes (specs em `docs/`, branch atual via `git`, diff em aberto) — referencie por caminho.
3. Redija qualquer segredo que apareça.
4. Escreva o documento no formato acima e salve no local definido.
5. Confirme ao usuário: **caminho do arquivo** + 1 linha do que o próximo agente deve fazer primeiro.

## Anti-padrões

- ❌ Colar o conteúdo de specs/diffs no handoff (referencie).
- ❌ Deixar qualquer segredo em claro.
- ❌ Salvar na raiz do projeto sujando o git quando não há `docs/`.
- ❌ Esquecer a seção "Skills sugeridas".
