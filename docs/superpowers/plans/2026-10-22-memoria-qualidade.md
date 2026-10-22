# CBS Memória: qualidade, histórico e continuidade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Melhorar a recuperação e a utilidade da memória persistente do CBS, medir a mudança com sessões reais, oferecer inspeção legível e entregar continuidade entre sessões de Claude Code e Codex.

**Architecture:** O Qdrant continua sendo a fonte da curadoria e o Mem0 continua publicando seus pontos; a busca combina candidatos vetoriais e textuais da **mesma coleção**, aplica a mesma política de confiança aos dois e só então ordena. A mesma chamada Haiku que já extrai até cinco memórias por checkpoint poderá anexar contexto curto, rotulado como síntese gerada e ligado às referências autenticadas. Exportação Markdown e handoff são visões locais derivadas, sem novo escritor remoto.

**Tech Stack:** Node.js ESM, Python, Mem0 SDK, Qdrant 1.19.1, ONNX E5 multilíngue de 384 dimensões, hooks nativos Claude Code/Codex, `node:test` e testes Python focados.

**Spec:** Este documento também contém o desenho e os contratos da melhoria; requisitos e tarefas estão abaixo, no mesmo arquivo.

## Global Constraints

- **Decisão explícita do usuário:** fazer os cinco itens; executar primeiro busca híbrida (1), contexto (2) e avaliação (5), depois exportação/histórico (4) e handoff automático (3). Reutilizar a skill CBS `/handoff`.
- **Proposta de desenho deste plano:** a avaliação estabelece o baseline de 0.15.10 antes do ajuste da busca; as entregas podem usar commits separados, mas só avançam à fase seguinte após seus gates.
- **Restrição explícita do usuário:** no servidor fica **somente o Qdrant já existente**. Nenhuma instalação, atualização de Docker/Qdrant, serviço, banco, daemon, binário, modelo ou dependência npm/pip no servidor. Índice de payload é recurso nativo do Qdrant, criado por API autenticada a partir do cliente local; fusão, curadoria, contexto, exportação, avaliação e handoff executam no cliente. Mesma coleção, mesmo encoder e no máximo **um embedding por consulta**. Preservar SHA/fingerprint, E5, 384 dimensões, prefixos, normalização e suporte CUDA/DirectML/CPU atual.
- Não mudar seleção Claude-mem vs Mem0, owner/writer, consentimento, escopo de projeto/worktree, TLS/pin de destino, secret store ou autoridade de escrita. Histórico Claude-mem bruto continua fora do recall automático.
- Não tocar N8N, encerrar sessões CLI do usuário, pedir sudo, versionar credenciais, histórico integral de conversa ou PII desnecessária. Exportações locais privadas por padrão. Windows nativo permanece sob seu gate físico atual; testes simulados não o liberam.
- Manter hooks rápidos e fail-open onde já são fail-open; fallback para busca vetorial quando índice textual ainda não existe ou rota textual falha, preservando abstenção e erro tipado quando a busca inteira falha.
- Checkpoints e lotes antigos mantêm política e prova congeladas. Leitores novos aceitam payloads anteriores; nova síntese não força reprocessamento nem consome tentativas de lote já selado.
- Testes focados e smoke pequenos; sem suíte pesada ou chamada paga por prompt. A mesma chamada Haiku por checkpoint poderá gastar **mais tokens**: limitar saída e medir o aumento real. Não presumir que custo permaneça igual.

## Review Focus

1. Nome técnico como `HML_TRIPEX_COMP`, código de erro ou identificador com `_`/`-`: a busca textual deve achar correspondência verificável sem transformar palavra comum de `MatchTextAny` em falsa evidência. Testes nas tarefas 2 e 3.
2. Memória pessoal de outro owner, projeto ou worktree, ponto `pending`/`superseded`, validade vencida e legado: nenhum entra por via lexical, exportação ou handoff. Testes nas tarefas 2, 3, 7 e 8.
3. Qdrant sem índice, indisponível ou resposta parcial/paginada: não declarar ausência nem salvar cursor como completo; usar fallback explícito e provar que não houve vazamento. Testes nas tarefas 2 e 7.
4. Assistente relata sucesso sem confirmação humana/fonte: contexto e handoff dizem “relato gerado/não verificado”; não elevam isso a regra. Lote v4 antigo continua publicável sem campo novo. Testes nas tarefas 4 e 8.
5. Stop/PreCompact/SessionEnd/Interrupt duplicados, Ctrl-C sem hook e troca de checkout: estado local é atômico e idempotente; retomada usa somente projeto/owner/root válidos e não apaga ao ler. Testes nas tarefas 8 e 9.

## Estado de partida e decisões de desenho

Em 0.15.10, `base/memoria/python/mem0_adapter.py` usa `memory.search` com `user_id`, `status=active`, `top_k` crescente até 2048 e `MIN_RECALL_SCORE=0.85`. `base/memoria/context.mjs` repete esse piso e valida projeto, escopo, owner, proveniência e validade antes de renderizar até 500 bytes de contexto. `base/memoria/mcp-readonly.mjs` separa `curated|legacy|all`; hooks usam só curadoria. Não há índice full-text da curadoria criado pela rota principal. O Qdrant remoto foi consultado somente para versão, **1.19.1**; suporte a `MatchTextAny` não prova existência do índice em cada coleção.

Os checkpoints de conversa juntam cinco pares completos (`conversation-batches.mjs`); `candidates.mjs` envia **uma** chamada Haiku, com até cinco candidatos. `conversation-proof.mjs`, `outbox.mjs`, `auto-publish.mjs` e o adaptador validam fonte, offsets, hashes, consentimento e publicação. Há um corpus de **11 casos, 8 dev/3 holdout**, em `base/memoria/evals/curation-v1.json`; `evaluation.mjs` mede curadoria de outputs fornecidos, **não** retrieval real nem autenticidade de rótulos. A skill `base/skills/handoff/SKILL.md` já fixa estrutura manual e redige segredos; `base/commands/handoff.md` a invoca interativamente. O fluxo automático reutilizará esse contrato editorial, sem executar a skill dentro do hook.

### Contrato 1 — busca híbrida

1. Índice Qdrant full-text no payload `data` da coleção curada, criado idempotentemente pela CLI administrativa local `cbs memoria indexar-texto --project <raiz>` via API do Qdrant e checado no início da rota textual. Não criar sparse slot/BM25, instalar software no servidor ou reescrever vetores/pontos. Em coleções existentes, índice ausente = rota vetorial atual; indexação pode ser habilitada depois sem bloquear hooks. Operação de índice nunca ocorre no hook de 1 segundo. Validar coleção/destino confiáveis e log sem segredo.
2. Consulta textual lê **no máximo 32** candidatos (`MatchText` para identificadores, `MatchTextAny` só como expansão dentro do mesmo limite), com filtros remotos `project_id`, `user_id`, `status=active`; leitura sem vetor. Token distintivo é identificador ASCII de 4–80 caracteres com letra e separador `_`, `.`, `/`, `:` ou `-` entre grupos alfanuméricos, ou sigla maiúscula de ≥2 letras seguida de dígito (`ERR42`). Uma consulta sem esse token usa a rota vetorial atual. Confirmar em `data` a ocorrência do identificador inteiro após NFKC+casefold e fronteiras alfanuméricas; tokenizer do Qdrant só gera candidatos. Mais de 32 candidatos ou paginação não permitem afirmar completude; fallback vetorial.
3. Ordenar o canal lexical **antes** da fusão: mais identificadores técnicos inteiros coincidentes, depois maior cobertura de termos distintos da consulta, depois ID estável. Ordem de `scroll`/UUID não é relevância. Consulta vetorial conserva limite atual, embedding único e piso semântico **0.85**. A lista lexical não recebe `score=1`, `scoreSource=mem0_sdk_search` nem passa pelo mesmo piso fingindo similaridade. Cada candidato tem `retrievalEvidence: {vectorScore?: number, vectorRank?: number, lexicalRank?: number, literalSpans?: string[]}` e `scoreSource: 'hybrid_verified'` quando elegível. O status de índice e falhas não aparecem como memória.
4. União por ID validado com **todos os vetores elegíveis como prefixo ordenado imutável**, exatamente na ordem de `selectRecall`, inclusive empates; até 20 slots. IDs lexicais novos preenchem apenas slots restantes, ordenados por coincidência literal, cobertura e ID. RRF `1/(60+rank)` pode anotar interseções e ordenar a cauda lexical, mas nunca desloca, substitui, elimina ou reordena o prefixo vetorial. Não truncar a união antes da reserva do prefixo. O canal lexical só participa se tiver token técnico distintivo confirmado literalmente. Extrair validador compartilhado de payload remoto para rotas vetorial, lexical e histórica; `_row` mantém a verificação SDK/vetor que já faz, enquanto lexical/histórico validam o ponto Qdrant diretamente **sem inventar linha SDK ou vetor**. A política de recall exige projeto/owner/status ativo/validade/proveniência/forma do registro gerado e passa por `selectRecall`. Se não houver prova lexical, só passa score vetorial ≥0.85. Limites de 20 itens retornados e 500 bytes de injeção permanecem.
5. `source=legacy` continua rota própria, com rótulo “gerado, não verificado”; `source=all` agrega curadoria híbrida e legado **sem** misturar autoridade. Automatic recall permanece apenas curadoria. Falha lexical produz `vector_only` observável; falha da rota vetorial **não** converte uma busca ampla em resultado de alta confiança: admitir lexical somente com identificador literal distintivo, política completa e limite estrito; caso contrário resultado tipado `unavailable`/`abstain`.

### Contrato 2 — contexto ligado aos fatos

- Cada candidato de conversa pode trazer `context: [{kind, summary, source_message_ids}]`, `kind ∈ problem|reason|attempt|pending`, até quatro entradas, `summary` até 256 bytes UTF-8 e IDs distintos contidos em `source_refs`. Campos ausentes ou `[]` são válidos. O texto principal, dedup key, `claim_sha256`, `candidate_key`, ID remoto e embedding continuam calculados **só do fato**; contexto não muda identidade semântica.
- Haiku produz esses campos na **resposta existente**; aumentar apenas o orçamento necessário da mesma chamada, com teto de bytes/tokens e registro de uso. Não fazer chamada adicional para resumir, nem forçar contexto em todo candidato. Referências existem no checkpoint e seu trecho literal foi validado; a síntese do contexto é marcada `generated_unverified`, inclusive quando reflete fala do assistente. Sem referência suficiente ou conteúdo seguro, descartar o campo sem rejeitar o fato inteiro. Se o fato recebe ACK `duplicate` de memória antiga sem contexto, manter seu ID/metadados intactos, registrar `duplicate_without_context` e concluir o checkpoint; não sobrescrever o ponto nem gerar outra extração para preencher o campo.
- Gravar contexto opcional na metadata da memória ativada após prova local; verificar remote ACK; expor em `get/source` e, quando couber no orçamento, em recall marcado como síntese gerada. Não armazenar transcrição bruta remota. Lotes v4 sem campo e memória antiga mantêm leitura/ativação normais. Payloads v4 antigos já selados nunca passam por nova exigência de schema, não reiniciam limite diário nem trocam sua prova congelada.
- `pending` operacional de handoff pode ser efêmero local com TTL de 7 dias; pendência passageira não vira memória durável nem regra do usuário. Correção/supersession do fato aplica-se também à exibição de seu contexto.

### Contrato 5 — avaliação comparável

- Congelar corpus **v2 privado de 30 casos** derivados de sessões reais Claude Code e Codex locais, preservando os 11 casos já existentes como sementes com revisão de fonte. Proposta: **21 dev/9 holdout**, ao menos seis casos por cada risco: identificadores exatos, negação/correção, contexto/motivo, escopo cruzado, validade/obsolescência e abstenção; classes podem se sobrepor. Guardar `case_id`, source CLI/projeto, hash do trecho, excerto mínimo necessário, pergunta, IDs relevantes e motivo da etiqueta. O usuário dispensou anonimização para uso local, mas **conversas de clientes/projetos privados não entram no Git nem são enviadas a outro serviço**; corpus real fica 0600 em estado local, com hashes/manifesto e relatório agregado sem conteúdo sensível. Fixtures técnicas sanitizadas e o harness podem ser públicos. Rótulos revisados independentemente por agente são **`agent_reviewed`**, jamais `human` sem revisão humana real.
- Congelar corpus/splits **antes de alterar retrieval/prompt** e registrar observação vetorial read-only de 0.15.10. Essa observação prévia é histórica, **não** comparação pareada se a coleção mudar. Na avaliação offline, gravar **um artefato imutável por consulta** contendo candidatos vetoriais e textuais, IDs, payload mínimo, hashes dos conteúdos, metadados de elegibilidade e ranks coletados na mesma revisão operacional; rodar algoritmo 0.15.10 (só vetor) e novo algoritmo **sobre esse mesmo artefato**, sem novas consultas entre os braços. `paired_replay=true` prova comparação de ranking no conjunto congelado, não qualidade live da recuperação Qdrant. Se não for possível estabelecer a mesma revisão operacional ou algum payload mudar, `paired_replay=false` e nenhum gate quantitativo baseado em diferença é aprovado. Holdout fica fechado durante ajuste do `dev`; uma passagem final sem autotuning no holdout.
- Ampliar `evaluation.mjs`/`evaluation-cli.mjs` com artefato de retrieval versionado separadamente dos outputs de extração: IDs/ranks/scores/evidência por consulta, sem segredos. Medir hit@1/3/5, recall@5, precision@5 e MRR sobre IDs relevantes, além de acerto em abstenção, vazamento cross-owner/projeto, resultado superseded/stale e erro de contexto. Para curadoria, manter false save, missed durable, duplicate, correction, scope/type. Tempo, tokens e custo **somente quando observados**, senão `null` + cobertura; não fabricar valor nem significância estatística para 30 casos.
- Gates propostos, antes de ver o holdout: zero vazamentos/segredos e zero antigo superseded injetado; nenhum caso negativo de identificador exato vira falsa memória; hit@5 e MRR **não menores que baseline** no dev e holdout; melhora em ≥3 dos casos de exatidão em que o vetor errou sem regredir outro; false save/erro de escopo não piores que baseline; latência hook p95 ≤1s ou fallback dentro do orçamento nativo. Se não houver ≥3 erros vetoriais elegíveis, gate de melhora vira “não demonstrado” e requer medir mais casos, não declarar ganho. Métricas com denominador 0 = não medidas. Este conjunto é gate de regressão operacional, **não** prova estatística universal.
- Usar no máximo **30 chamadas pagas de smoke** no total desta etapa, preferindo replay de outputs existentes e avaliação offline; CPU/GPU local com limites atuais. Sem benchmark grande, sem extrair corpus inteiro à força.

### Contrato 4 — exportação e histórico

- `cbs memoria exportar --project <raiz> --output <diretório-privado>` cria snapshot Markdown **derivado**, por ID imutável, com manifesto JSON `{version, projectId, ownerId, collectionFingerprint, createdAt, cursorComplete, count, sha256}`; páginas de Qdrant limitadas a 64 pontos/4 MiB e cursor com limite total explícito de 10.000 pontos. Filtrar no servidor por projeto/status e revalidar payload, owner, confiança e proveniência em validador histórico próprio. `active` e `superseded` aparecem com estado e ligação `supersedes_id/superseded_by`; validade já vencida é exibida **somente no histórico, marcada como expirada**, nunca no recall. `pending`/legado bruto ficam fora. Arquivos locais modo 0600, diretório 0700, nome seguro por UUID, escrita temporária + fsync + rename. Sem autopush, sem novo repositório/daemon.
- Exportação repetida com mesmos IDs/estado gera conteúdo estável (manifesto pode variar no timestamp); paginação incompleta/falha deixa versão anterior íntegra e retorno tipado. O Markdown não pode ser reimportado como verdade automaticamente. `cbs memoria historico --project ... --id <id>` lê a mesma visão/snapshot privado, mostra cadeia de correções e proveniência; se remoto divergente, sinaliza snapshot desatualizado.

### Contrato 3 — handoff automático usando nossa skill

- Reutilizar os **campos e a redação de segurança** de `base/skills/handoff/SKILL.md` em helper testável `base/memoria/handoff-format.mjs`. `/handoff` manual continua sendo comando/skill e tem prioridade editorial; hooks não disparam skill, CLI interativa ou nova chamada LLM.
- Material local compacto: checkpoint validado (inclusive quando curadoria seleciona zero fatos), contextos rotulados do item 2, estado da sessão com `projectId`, owner, `nativeRoot`, `projectRoot`, CLI, `sourceSessionId`, hashes de fonte e identidade Git do checkout (`commonGitDir`, `worktreeGitDir`, branch ou HEAD detached, source HEAD). O parser automático usa **allowlist**: último pedido humano em excerto ≤160 bytes e último passo relatado pelo assistente em excerto ≤160 bytes, apenas se passarem filtros conhecidos de segredos/PII e `containsSecret`; URLs/caminhos de artefato só se estiverem sob `nativeRoot` validado. Texto de origem é dado não confiável, escapado/rotulado, nunca instrução para o próximo agente. Filtros não provam ausência de todo PII/prompt injection: na dúvida, abster-se. Sem campo seguro, usar só IDs/hashes operacionais ou abster-se. Atualização em `Stop`, `PreCompact`, `SessionEnd` e Codex `Interrupt`; `UserPromptSubmit`/captura existente dá cobertura de progresso e fallback de idle para Ctrl-C/terminal sem hook. A entrega ocorre no próximo `SessionStart` do mesmo projeto/owner/checkout, com TTL de 7 dias, até **300 bytes** no contexto automático e link ao documento privado maior; não entregar a outro worktree silenciosamente. Branch precisa ser a mesma e source HEAD ancestral do HEAD atual; em detached HEAD exigir OID idêntico. Mudança de branch/rebase/checkout produz handoff `stale` apenas para inspeção manual, sem injeção, mas não bloqueia commits normais posteriores na mesma branch.
- Estado 0600/0700, gravação atômica e hash de fonte, **um registro por `sourceSessionId`**, sem sobrescrever sessão paralela. No próximo start, selecionar só a fonte elegível mais recente encerrada (`SessionEnd`/`Interrupt`) ou ociosa há ≥5 min sem evento posterior; empate, sessões concorrentes ativas ou identidade incerta = abstenção. Receipt por `(projectId, ownerId, nativeRoot, checkoutFingerprint, sourceSessionId, sourceHash, targetSessionId)` evita repetição na mesma sessão. Crash antes do receipt pode repetir a entrega; documentar **at-least-once com dedupe após receipt**, sem limite artificial ou promessa de exactly-once. Ler não apaga; limpeza após TTL e sem referência, nunca como efeito da leitura. Excluir artefatos de handoff/outbox da própria captura para evitar recursão. Este handoff editorial é separado de `authority.mjs`/writer transfer, que já usa termo “handoff” para autoridade.
- Retomada não confia cegamente em resumo: instrução humana atual prevalece, artefatos referenciados só por caminho, relato do assistente e memória legada identificados; não entregar segredos/PII. Se não houver prova de owner/root, não injetar e deixar o documento privado para inspeção autorizada. Fallback de idle cobre ausência de SessionEnd sem prometer que todo Ctrl-C chama hook.

## Mapa de arquivos e responsabilidade

| Unidade | Arquivos existentes | Novos arquivos planejados |
|---|---|---|
| Busca e confiança | `base/memoria/python/mem0_adapter.py`, `base/memoria/context.mjs`, `base/memoria/mcp-readonly.mjs`, `base/memoria/hook-recall.mjs`, `base/memoria/bridge.mjs`, `base/memoria/provision.mjs` | `base/memoria/hybrid-rank.mjs` se a fusão ficar isolada; `test/memoria-hybrid-recall.test.js` |
| Extração contextual | `base/memoria/extract-contract.mjs`, `candidates.mjs`, `conversation-proof.mjs`, `auto-publish.mjs`, `outbox.mjs`, `python/mem0_adapter.py`, `context.mjs` | Testes focados nos `test/memoria-conversation-contract.test.js`, `test/memoria-conversation-proof.test.js`, `test/memoria-auto-publish.test.js` |
| Avaliação | `base/memoria/evaluation.mjs`, `evaluation-cli.mjs`, `evals/curation-v1.json`, `test/memoria-evaluation.test.js` | `base/memoria/evaluation-retrieval.mjs`, `test/memoria-evaluation-retrieval.test.js`, `test/fixtures/memoria-quality-v2-minimal.json` sanitizado; corpus real e receipts locais privados fora do Git |
| Exportação | `base/memoria/cli.mjs`, `bridge.mjs`, `python/mem0_adapter.py`, `mcp-readonly.mjs` | `base/memoria/export.mjs`, `test/memoria-export.test.js`, `test/test_mem0_export.py` |
| Handoff | `base/skills/handoff/SKILL.md`, `base/commands/handoff.md`, `base/memoria/checkpoint.mjs`, `capture-hook.mjs`, `session-checkout.mjs`, `hook-recall.mjs`, `native.mjs` | `base/memoria/handoff-format.mjs`, `handoff-state.mjs`, `test/memoria-handoff-auto.test.js` |

## Fase A — preparação de baseline, depois itens 1, 2 e 5

### Task 1: Congelar dados e baseline de 0.15.10 (preparação read-only)

**Files:** Nenhum arquivo de produto; corpus de 30 casos, manifesto de fonte, respostas vetoriais, outputs existentes e receipts privados 0600 sob `~/.local/state/cbs/evals/`, fora do Git.

**Interfaces:** Manifesto privado `{baselineCommit, corpusSha256, splitSha256, collectionObservationSha256, cases:30, dev:21, holdout:9}`. Fonte local Claude `~/.claude/projects/**/*.jsonl` e Codex `~/.codex/sessions/**/rollout*.jsonl` lida por parser read-only; observação da busca 0.15.10 registra IDs/ranks/scores, versão e hashes do conteúdo observado. Rótulos de agente identificados como `agent_reviewed`, sem se declarar humanos; `collectionObservationSha256` não presume snapshot transacional Qdrant.

- [ ] Selecionar 30 casos de sessões reais com excerto mínimo e hash; revisão de fonte independente por agente; guardar corpus privado 21 dev/9 holdout e hashes antes de qualquer alteração de retrieval ou prompt.
- [ ] Consultar a rota vetorial 0.15.10 read-only, registrar ranks/scores/latência observada e congelar manifesto SHA256; rotular como observação histórica, sem alegar snapshot transacional nem comparação pareada. Usar CLI de avaliação v1 atual só para outputs que já existem; nenhuma implementação nova nesta preparação.
- [ ] Verificar 30 IDs únicos, 21/9, fonte verificável e permissões 0600/0700; se prova faltar, `unmeasured`. Sem commit, sem transcrição integral nem chamada paga em massa.

### Task 2: Índice e candidatos textuais no Qdrant (item 1)

**Files:** Modify `base/memoria/python/mem0_adapter.py`, `base/memoria/cli.mjs`, `base/memoria/provision.mjs`; test `test/test_mem0_adapter.py`, `test/test_mem0_remote.py`, `test/memoria-cli-status.test.js` (fixture pequena, não Qdrant de produção).

**Interfaces:** Python `lexical_candidates(client, collection: str, project: str, query: str, limit: int = 32) -> list[dict]`; `validate_curated_payload(point, project, owner, purpose: Literal['recall','history'], now) -> dict | None`; `ensure_text_index(client, collection: str) -> dict` só via CLI administrativa local e API nativa do Qdrant, sem instalar nada no servidor. `purpose='history'` aceita `superseded`/expirado com rótulo, nunca `pending`; `purpose='recall'` exige ativo/válido. Resposta do worker preserva `kind/items` e acrescenta evidência lexical separada. Sem alteração de `verify_collection`/fingerprint.

- [ ] RED: consulta exata de `HML_TRIPEX_COMP` e `ERR42` acha ID com span literal; “servidor” genérico não libera lexical; índice ausente, 33 candidatos e falha de rede retornam fallback tipado; filtros impedem `pending`, outro projeto, outro owner e legado. `scroll` em ordem UUID não determina lexicalRank.
- [ ] GREEN: CLI `indexar-texto` cria índice `data` via API autenticada/idempotente; usar `MatchText` e `MatchTextAny` com orçamento, validar ocorrência literal e payload diretamente pelo validador compartilhado, sem fabricar `_row`/vetor. Não mexer no texto/vetor dos pontos.
- [ ] Rodar `python3 -m unittest test.test_mem0_adapter test.test_mem0_remote` conforme venv/test helper existente; commit isolado. Conferir compatibilidade real no Qdrant 1.19.1 com coleção descartável pequena, sem transcrição/segredo no log.

### Task 3: Fusão, confiança e entrega Claude/Codex (item 1)

**Files:** Create `base/memoria/hybrid-rank.mjs`, `test/memoria-hybrid-recall.test.js`; modify `base/memoria/context.mjs`, `base/memoria/hook-recall.mjs`, `base/memoria/mcp-readonly.mjs`, `base/memoria/mcp.mjs`, `base/memoria/python/mem0_adapter.py`; extend `test/memoria-recall.test.js`, `test/memoria-mcp-readonly.test.js`.

**Interfaces:** `rankHybrid(vectorRows, lexicalRows, {limit=20, rrfK=60}): row[]` preserva integralmente o prefixo vetorial elegível na ordem de `selectRecall` e só acrescenta IDs lexicais novos nos slots restantes; `selectRecall(results, {projectId, now, ownerId, preserveHybridOrder=false})` aceita `scoreSource='hybrid_verified'` apenas com evidência lexical verificável ou score vetorial ≥0.85; `preserveHybridOrder=true` mantém a ordem filtrada desta lista validada. `searchProject` e MCP preservam contrato `kind/items`; item inclui `retrievalEvidence` sem promover rank a score. `legacy/all/curated` e contexto automático seguem contratos anteriores. O hook reserva 100 ms do teto nativo de 1 s para transporte/renderização. Saturação vetorial de 2048 retorna degradação tipada com fallback lexical verificado quando houver.

- [ ] RED: teste rank une mesmo ID, mantém 0.85 no vetor, ordena lexical por coincidência inteira/cobertura/ID, aceita ID técnico confirmado, rejeita lexical frouxo/outro owner/stale/superseded, limita 20/500 bytes e preserva o prefixo vetorial até no `renderRecall`; interseções e 20 vetores nunca derrubam IDs do baseline. Testar fallback vetorial no índice ausente, saturação e tipagem no remote down.
- [ ] GREEN: um embedding por query, RRF só após filtros/validação, `scoreSource` com prova explícita, falha parcial observável sem injeção indevida. Não somar cosine e rank textual.
- [ ] Rodar `node --test test/memoria-hybrid-recall.test.js test/memoria-recall.test.js test/memoria-mcp-readonly.test.js` e Python focado; commit isolado.

### Task 4: Contexto curto na mesma extração Haiku (item 2)

**Files:** Modify `base/memoria/extract-contract.mjs`, `candidates.mjs`, `conversation-proof.mjs`, `auto-publish.mjs`, `outbox.mjs`, `python/mem0_adapter.py`, `context.mjs`, `mcp-readonly.mjs`; tests `test/memoria-conversation-contract.test.js`, `test/memoria-conversation-proof.test.js`, `test/memoria-auto-publish.test.js`, `test/test_mem0_adapter.py`.

**Interfaces:** `candidate.context?: Array<{kind:'problem'|'reason'|'attempt'|'pending',summary:string,source_message_ids:string[]}>`; metadata remota `context_generated?: {version:1, items:[...], trust:'generated_unverified', source_refs_sha256:string}`. `validateConversationProof` valida campos opcionais contra refs existentes e segurança, sem mudar prova/identidade do fato. `get/source` exibe rotulado; recall só se couber em 500 bytes.

- [ ] RED: resposta antiga sem contexto e checkpoint v4 antigo continuam aceitos/publicáveis; ACK `duplicate` de fato antigo sem contexto não sobrescreve ponto nem falha o checkpoint; contexto com ID inventado, segredo, >4 itens, >256 bytes ou owner alheio é descartado sem perder fato válido; assistente não vira fato verificado.
- [ ] GREEN: atualizar schema/prompt e código de saída da **mesma** chamada Haiku; manter máximo 5 candidatos/checkpoint, registrar input/output tokens e duração; validar e salvar metadata opcional após ACK existente.
- [ ] Rodar `node --test test/memoria-conversation-contract.test.js test/memoria-conversation-proof.test.js test/memoria-auto-publish.test.js` e Python focado; commit isolado.

### Task 5: Avaliação offline de recuperação pareada (item 5)

**Files:** Create `base/memoria/evaluation-retrieval.mjs`, `test/memoria-evaluation-retrieval.test.js`, `test/fixtures/memoria-quality-v2-minimal.json` sanitizado; modify `base/memoria/evaluation.mjs`, `base/memoria/evaluation-cli.mjs`, `test/memoria-evaluation.test.js`. Não incluir corpus/respostas reais sensíveis no Git.

**Interfaces:** `validateMemoryCorpusV2(corpus): boolean`; `evaluateMemoryOutputs(corpus, outputs, {split})` mantém v1 e reconhece v2; `evaluateRetrieval(corpus, runs, {split}): report`; `runs` v1 registra por caso `candidate_set_sha256`, `query`, `vector_candidates`, `lexical_candidates`, `payload_hashes`, `eligibility_metadata`, `returned_ids`, `latency_ms?`, `retrieval_version`. CLI `cbs memoria avaliar --retrieval <arquivo.json> --corpus ... --split ...`. Executar baseline 0.15.10 e ranking novo sobre a **mesma lista congelada**, com `paired_replay=false` se hashes/revisão divergirem. Não apresentar replay como busca live pareada.

- [ ] RED: v2 rejeita caso sem hash/trecho de origem, segredo e rótulo `human` sem prova, aceita 30 casos 21/9 e preserva v1; hit@k/MRR/precision/recall com 2 relevantes e abstenção negativa; IDs fora do conjunto, owner/projeto alheio e snapshot divergente não contam como comparação pareada.
- [ ] GREEN: implementar métricas e relatórios com denominadores/cobertura/`null` explícitos; computar os dois algoritmos sobre o mesmo artefato de candidatos congelado agora, mantendo a observação prévia da Task 1 separada. Rótulo v2 `agent_reviewed` separado de `human`.
- [ ] Rodar `node --test test/memoria-evaluation-retrieval.test.js test/memoria-evaluation.test.js`; commit apenas da fixture sanitizada e avaliador, sem corpus real.

### Task 6: Gate de avaliação da fase A (itens 1, 2 e 5)

**Files:** Extend `test/memoria-evaluation-retrieval.test.js`, `test/memoria-evaluation.test.js`; report privado no mesmo diretório de eval, sem novo plano no Git.

**Interfaces:** Observação histórica da Task 1 separada da comparação offline `paired_replay` de dois algoritmos sobre um artefato de candidatos congelado pela Task 5. Dev e holdout separados; report inclui métricas por classe, hashes, cobertura, custo/latência observados e status de cada gate.

- [ ] RED: fixture com melhora falsa causada por drift, owner leak ou caso negativo contaminado falha o gate; campos não observados ficam `null`.
- [ ] GREEN: comparar dev sem ajustar holdout, rodar holdout uma vez e 3 smokes reais no máximo em cada CLI para busca, contexto, indisponibilidade/abstenção; registrar se houve ou não uso de GPU, sem extrapolar velocidade.
- [ ] Rodar testes focados de avaliação e relatório privado. Se gate falhar, corrigir Tasks 2–4 e repetir comparativo em **novo** dev; não relabelar holdout para fazer passar. Review independente antes da fase B.

## Fase B — item 4, depois item 3

### Task 7: Exportação Markdown privada e histórico de correções (item 4)

**Files:** Create `base/memoria/export.mjs`, `test/memoria-export.test.js`, `test/test_mem0_export.py`; modify `base/memoria/cli.mjs`, `base/memoria/python/mem0_adapter.py`, `base/memoria/python/worker.py`, `README.md`.

**Interfaces:** `exportCurated({cwd, sessionId, outputDir, stateRoot, maxPoints=10000}): Promise<{kind,count,manifestPath?}>`; Python `list_curated_page(client, collection, project, owner, offset, limit=64)` retorna pontos e cursor sem vetor; `readMemoryHistory(snapshotDir, id): {kind, versions, snapshotSha256}` segue `supersedes_id`/`superseded_by` sem ciclos. CLI `cbs memoria historico --project <raiz> --id <uuid> --snapshot <diretório>`; entrada administrativa usa confiança/destino atuais, sem MCP amplo. Markdown por ID; manifesto e snapshot completos só após última página validada.

- [ ] RED: fixture com páginas 64+1, cursor repetido, 10.001 pontos, falha mid-page, symlink e diretório público; export anterior fica intacto, item outro owner/pending/legado não aparece, supressão de segredos funciona.
- [ ] RED: cadeia com ciclo, elo ausente, ID externo ao projeto, snapshot desatualizado e versão antiga superseded informa limitação sem confundir com regra ativa; reexportar mesmo estado preserva hashes de páginas.
- [ ] GREEN: usar `scroll` limitado, revalidar status/proveniência/owner/hash com `purpose='history'` da Task 2 (aceita `superseded`/expirado e os rotula, nunca os injeta), escrever em staging privado e trocar atomicamente apenas snapshot completo; mostrar cadeia por vínculo, README explica fonte derivada/retenção e reimport não automático; sem Git autopush.
- [ ] Rodar `node --test test/memoria-export.test.js` e `python3 -m unittest test.test_mem0_export`; review de privacidade e commit isolado.

### Task 8: Formato e estado seguro do handoff automático (item 3)

**Files:** Create `base/memoria/handoff-format.mjs`, `base/memoria/handoff-state.mjs`, `test/memoria-handoff-auto.test.js`; read `base/skills/handoff/SKILL.md`, `base/commands/handoff.md`; modify skill apenas se necessário para apontar ao formato compartilhado.

**Interfaces:** `formatHandoff({projectId, ownerId, nativeRoot, checkoutFingerprint, sourceSessionId, checkpoint, memories, now}): {summary, markdown, sourceHash}`; `saveHandoff(stateDir, value)` guarda por sourceSessionId; `loadHandoff(stateDir, identity)` seleciona sessão elegível e valida projeto/owner/root/branch/ancestralidade/TTL. Resumo de injeção ≤300 bytes; arquivo maior privado; material sem fato durável pode resultar de checkpoint verificável.

- [ ] RED: estrutura manual mantém Objetivo/Estado/Artefatos/Decisões/Pendências/Riscos/Segredos/Skills; parser allowlist rejeita padrões conhecidos de segredo/PII e instrução maliciosa testada, e abstém quando incerto; caminho fora do checkout/owner bloqueado, fonte só do assistente rotulada; duas sessões paralelas não se sobrescrevem, branch trocada/rebase é `stale`, commit descendente é aceito; sem fatos = handoff operacional ou abstain, sem chamar Haiku.
- [ ] GREEN: helper editorial usa mesmo contrato da skill e refs, documentos atômicos 0600/0700, TTL 7 dias e hash; não escreve em `docs/handoffs/` sem `/handoff` manual.
- [ ] Rodar `node --test test/memoria-handoff-auto.test.js`; commit isolado.

### Task 9: Captura, entrega e fallback de sessão (item 3)

**Files:** Modify `base/memoria/checkpoint.mjs`, `capture-hook.mjs`, `native.mjs`, `hook-recall.mjs`, `session-checkout.mjs`; test `test/memoria-handoff-auto.test.js`, `test/memoria-recovery.test.js`, `test/memoria-windows-transport.test.js`.

**Interfaces:** `updateHandoffFromCapture({cli,event,payload,result,stateRoot})` consome apenas checkpoint autenticado; `deliverHandoffAtSessionStart({cli,payload,stateRoot})` devolve contexto ≤300 bytes ou null com receipt por sessão. Prioridade de injeção: instrução humana corrente > `/handoff` manual > handoff automático > recall ordinário; não ler artefato de outro owner/root.

- [ ] RED: Stop/PreCompact/SessionEnd/Interrupt duplicados deixam um estado; Ctrl-C sem hook usa último checkpoint/idle no próximo start; crash antes do receipt pode repetir a entrega, e depois do receipt ela é deduplicada; nenhuma captura recursiva/outbox loop; hook ausente em plataforma antiga abstém.
- [ ] GREEN: costurar helper após captura, usar eventos nativos já registrados; on SessionStart validar binding/checkout/owner e budget antes de injetar, gravação de receipt atômica, leitura sem remoção. Não chamar skill interativa nem broker só para compor handoff.
- [ ] Rodar `node --test test/memoria-handoff-auto.test.js test/memoria-recovery.test.js test/memoria-windows-transport.test.js`; smoke manual novo Claude/Codex Linux com mesmo root e outro worktree. Gate físico Windows continua separado; commit isolado.

### Task 10: Integração, operação e publicação posterior

**Files:** Modify `README.md`, `CHANGELOG.md` e documentação curta de operação em `docs/memoria/` somente se a execução revelar passo operacional indispensável; adicionar crédito a [Akita/ai-memory](https://github.com/akitaonrails/ai-memory) pelas ideias, sem copiar código/licença. Testes existentes e novos citados acima.

**Interfaces:** Release contém demonstração dos 5 itens, hashes da avaliação, resultado de gates, fallback/rollback e instruções de uso; export é local e handoff manual segue disponível.

- [ ] Executar testes focados da mudança, smoke de busca/escrita/recall/controle owner em uma máquina + Qdrant, comparar baseline dev/holdout e verificar documentação. Reviewer fresco inspeciona segurança, ranking, proveniência, migração, Claude/Codex e riscos de Windows.
- [ ] Rollback por fase: desligar lexical e voltar à busca vetorial sem reindexar corpus; ignorar `context_generated` sem tocar fatos; remover apenas snapshots derivados; desativar entrega automática sem apagar `/handoff` manual; preservar IDs/ACKs/filas/cursors.
- [ ] Após gates passarem, preparar release e só então deploy geral dos projetos/perfis, GitHub e npm conforme autorização de publicação vigente; verificar artefato publicado e aplicação nos projetos. Este plano, isoladamente, não instala, migra ou publica nada.

## Critério de aceite geral

Um desenvolvedor pergunta por um identificador exato ou por uma decisão e recebe memória correta, com origem/escopo respeitados, ou abstenção clara; a nova avaliação mostra o ganho sem perder casos anteriores. Cada memória pode ser inspecionada como Markdown e correções aparecem em sequência. Ao trocar de sessão no mesmo projeto/owner/checkout, Claude ou Codex recebe continuidade curta e verificável, enquanto `/handoff` continua disponível para um documento completo por pedido explícito. Não há novo serviço, nova chamada LLM por prompt, reprocessamento imposto a lotes antigos nem promessa de Windows físico sem a prova separada.
