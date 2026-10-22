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

1. Nome técnico como `HML_TRIPEX_COMP`, código de erro ou identificador com `_`/`-`: a busca textual deve achar correspondência verificável sem transformar palavra comum de `MatchTextAny` em falsa evidência. Testes nas tarefas 3 e 4.
2. Memória pessoal de outro owner, projeto ou worktree, ponto `pending`/`superseded`, validade vencida e legado: nenhum entra por via lexical, exportação ou handoff. Testes nas tarefas 3, 4, 7 e 8.
3. Qdrant sem índice, indisponível ou resposta parcial/paginada: não declarar ausência nem salvar cursor como completo; usar fallback explícito e provar que não houve vazamento. Testes nas tarefas 3 e 7.
4. Assistente relata sucesso sem confirmação humana/fonte: contexto e handoff dizem “relato gerado/não verificado”; não elevam isso a regra. Lote v4 antigo continua publicável sem campo novo. Testes nas tarefas 5 e 8.
5. Stop/PreCompact/SessionEnd/Interrupt duplicados, Ctrl-C sem hook e troca de checkout: estado local é atômico e idempotente; retomada usa somente projeto/owner/root válidos e não apaga ao ler. Testes nas tarefas 8 e 9.

## Estado de partida e decisões de desenho

Em 0.15.10, `base/memoria/python/mem0_adapter.py` usa `memory.search` com `user_id`, `status=active`, `top_k` crescente até 2048 e `MIN_RECALL_SCORE=0.85`. `base/memoria/context.mjs` repete esse piso e valida projeto, escopo, owner, proveniência e validade antes de renderizar até 500 bytes de contexto. `base/memoria/mcp-readonly.mjs` separa `curated|legacy|all`; hooks usam só curadoria. Não há índice full-text da curadoria criado pela rota principal. O Qdrant remoto foi consultado somente para versão, **1.19.1**; suporte a `MatchTextAny` não prova existência do índice em cada coleção.

Os checkpoints de conversa juntam cinco pares completos (`conversation-batches.mjs`); `candidates.mjs` envia **uma** chamada Haiku, com até cinco candidatos. `conversation-proof.mjs`, `outbox.mjs`, `auto-publish.mjs` e o adaptador validam fonte, offsets, hashes, consentimento e publicação. Há um corpus de **11 casos, 8 dev/3 holdout**, em `base/memoria/evals/curation-v1.json`; `evaluation.mjs` mede curadoria de outputs fornecidos, **não** retrieval real nem autenticidade de rótulos. A skill `base/skills/handoff/SKILL.md` já fixa estrutura manual e redige segredos; `base/commands/handoff.md` a invoca interativamente. O fluxo automático reutilizará esse contrato editorial, sem executar a skill dentro do hook.

### Contrato 1 — busca híbrida

1. Índice Qdrant full-text no payload `data` da coleção curada, criado idempotentemente no provisionamento administrativo e checado no início da rota textual. Não criar sparse slot/BM25, nem reescrever vetores ou pontos. Em coleções existentes, índice ausente = rota vetorial atual; indexação pode ser habilitada posteriormente sem bloquear hooks. Operação de índice só ocorre na ferramenta administrativa, nunca no hook de 1 segundo. Provisionar com filtro/prova de coleção confiável e log sem segredo.
2. Consulta textual lê **no máximo 32** candidatos (`MatchText` para termos normalizados, `MatchTextAny` apenas para expansão controlada), com filtros remotos `project_id`, `user_id`, `status=active`; leitura sem vetor. Consulta sem token distintivo não abre uma rota lexical frouxa. IDs/códigos exigem confirmação literal normalizada contra `data` do payload; tokenizer do Qdrant é gerador de candidatos, não prova final da ocorrência. Mais de 32 candidatos ou paginação não permitem afirmar completude; fallback vetorial.
3. Consulta vetorial conserva limite atual, embedding único e piso semântico **0.85**. A lista lexical não recebe `score=1`, `scoreSource=mem0_sdk_search` nem passa pelo mesmo piso fingindo similaridade. Cada candidato tem `retrievalEvidence: {vectorScore?: number, vectorRank?: number, lexicalRank?: number, literalSpans?: string[]}` e `scoreSource: 'hybrid_verified'` quando elegível. O status de índice e falhas não aparecem como memória.
4. União por ID validado e fusão por **RRF `1/(60+rank)`** dos canais disponíveis; empate por ID estável. O canal lexical só participa se tiver token técnico distintivo confirmado literalmente. Mesmo achado lexicalmente, cada ponto passa por validação `_row`, projeto/owner/status/validade/proveniência/forma do registro gerado e por `selectRecall`. Se não houver prova lexical, ele só passa com score vetorial ≥0.85. Limites atuais de 20 itens retornados e 500 bytes de injeção permanecem.
5. `source=legacy` continua rota própria, com rótulo “gerado, não verificado”; `source=all` agrega curadoria híbrida e legado **sem** misturar autoridade. Automatic recall permanece apenas curadoria. Falha lexical produz `vector_only` observável; falha da rota vetorial **não** converte uma busca ampla em resultado de alta confiança: admitir lexical somente com identificador literal distintivo, política completa e limite estrito; caso contrário resultado tipado `unavailable`/`abstain`.

### Contrato 2 — contexto ligado aos fatos

- Cada candidato de conversa pode trazer `context: [{kind, summary, source_message_ids}]`, `kind ∈ problem|reason|attempt|pending`, até quatro entradas, `summary` até 256 bytes UTF-8 e IDs distintos contidos em `source_refs`. Campos ausentes ou `[]` são válidos. O texto principal, dedup key, `claim_sha256`, `candidate_key`, ID remoto e embedding continuam calculados **só do fato**; contexto não muda identidade semântica.
- Haiku produz esses campos na **resposta existente**; aumentar apenas o orçamento necessário da mesma chamada, com teto de bytes/tokens e registro de uso. Não fazer chamada adicional para resumir, nem forçar contexto em todo candidato. Referências existem no checkpoint e seu trecho literal foi validado; a síntese do contexto é marcada `generated_unverified`, inclusive quando reflete fala do assistente. Sem referência suficiente ou conteúdo seguro, descartar o campo sem rejeitar o fato inteiro.
- Gravar contexto opcional na metadata da memória ativada após prova local; verificar remote ACK; expor em `get/source` e, quando couber no orçamento, em recall marcado como síntese gerada. Não armazenar transcrição bruta remota. Lotes v4 sem campo e memória antiga mantêm leitura/ativação normais. Payloads v4 antigos já selados nunca passam por nova exigência de schema, não reiniciam limite diário nem trocam sua prova congelada.
- `pending` operacional de handoff pode ser efêmero local com TTL de 7 dias; pendência passageira não vira memória durável nem regra do usuário. Correção/supersession do fato aplica-se também à exibição de seu contexto.

### Contrato 5 — avaliação comparável

- Congelar corpus **v2 privado de 30 casos** derivados de sessões reais Claude Code e Codex locais, preservando os 11 casos já existentes como sementes com revisão de fonte. Proposta: **21 dev/9 holdout**, ao menos seis casos por cada risco: identificadores exatos, negação/correção, contexto/motivo, escopo cruzado, validade/obsolescência e abstenção; classes podem se sobrepor. Guardar `case_id`, source CLI/projeto, hash do trecho, excerto mínimo necessário, pergunta, IDs relevantes e motivo da etiqueta. O usuário dispensou anonimização para uso local, mas **conversas de clientes/projetos privados não entram no Git nem são enviadas a outro serviço**; corpus real fica 0600 em estado local, com hashes/manifesto e relatório agregado sem conteúdo sensível. Fixtures técnicas sanitizadas e o harness podem ser públicos. Rótulos revisados independentemente por agente são **`agent_reviewed`**, jamais `human` sem revisão humana real.
- Rodar baseline 0.15.10 **antes de alterar retrieval/prompt**, e congelar hash de corpus, split, versão de código, snapshot/IDs da coleção e resultados vetoriais. Avaliação offline posterior reexecuta ranking em candidatos registrados com mesmo snapshot; relatório diz quando não houve consulta live. Se coleção mudou, registrar drift e não chamar a comparação de pareada. Holdout fica fechado durante ajuste do `dev`; uma passagem final sem autotuning no holdout.
- Ampliar `evaluation.mjs`/`evaluation-cli.mjs` com artefato de retrieval versionado separadamente dos outputs de extração: IDs/ranks/scores/evidência por consulta, sem segredos. Medir hit@1/3/5, recall@5, precision@5 e MRR sobre IDs relevantes, além de acerto em abstenção, vazamento cross-owner/projeto, resultado superseded/stale e erro de contexto. Para curadoria, manter false save, missed durable, duplicate, correction, scope/type. Tempo, tokens e custo **somente quando observados**, senão `null` + cobertura; não fabricar valor nem significância estatística para 30 casos.
- Gates propostos, antes de ver o holdout: zero vazamentos/segredos e zero antigo superseded injetado; nenhum caso negativo de identificador exato vira falsa memória; hit@5 e MRR **não menores que baseline** no dev e holdout; melhora em ≥3 dos casos de exatidão em que o vetor errou sem regredir outro; false save/erro de escopo não piores que baseline; latência hook p95 ≤1s ou fallback dentro do orçamento nativo. Se não houver ≥3 erros vetoriais elegíveis, gate de melhora vira “não demonstrado” e requer medir mais casos, não declarar ganho. Métricas com denominador 0 = não medidas. Este conjunto é gate de regressão operacional, **não** prova estatística universal.
- Usar no máximo **30 chamadas pagas de smoke** no total desta etapa, preferindo replay de outputs existentes e avaliação offline; CPU/GPU local com limites atuais. Sem benchmark grande, sem extrair corpus inteiro à força.

### Contrato 4 — exportação e histórico

- `cbs memoria exportar --project <raiz> --output <diretório-privado>` cria snapshot Markdown **derivado**, por ID imutável, com manifesto JSON `{version, projectId, ownerId, collectionFingerprint, createdAt, cursorComplete, count, sha256}`; páginas de Qdrant limitadas a 64 pontos/4 MiB e cursor com limite total explícito de 10.000 pontos. Filtrar no servidor por projeto/status e revalidar cada item como em `get`/recall, incluindo owner. `active` e `superseded` aparecem com estado e ligação `supersedes_id/superseded_by`; `pending`/legado bruto ficam fora. Arquivos locais modo 0600, diretório 0700, nome seguro por UUID, escrita temporária + fsync + rename. Sem autopush, sem novo repositório/daemon.
- Exportação repetida com mesmos IDs/estado gera conteúdo estável (manifesto pode variar no timestamp); paginação incompleta/falha deixa versão anterior íntegra e retorno tipado. O Markdown não pode ser reimportado como verdade automaticamente. `cbs memoria historico --project ... --id <id>` lê a mesma visão/snapshot privado, mostra cadeia de correções e proveniência; se remoto divergente, sinaliza snapshot desatualizado.

### Contrato 3 — handoff automático usando nossa skill

- Reutilizar os **campos e a redação de segurança** de `base/skills/handoff/SKILL.md` em helper testável `base/memoria/handoff-format.mjs`. `/handoff` manual continua sendo comando/skill e tem prioridade editorial; hooks não disparam skill, CLI interativa ou nova chamada LLM.
- Material local compacto: checkpoint validado (inclusive quando curadoria seleciona zero fatos), contextos rotulados do item 2, estado da sessão com `projectId`, owner, `nativeRoot`, `projectRoot`, CLI e hashes de fonte. Atualização em `Stop`, `PreCompact`, `SessionEnd` e Codex `Interrupt`; `UserPromptSubmit`/captura existente dá cobertura de progresso e fallback de idle para Ctrl-C/terminal sem hook. A entrega ocorre no próximo `SessionStart` do mesmo projeto/owner/checkout, com TTL de 7 dias, até **300 bytes** no contexto automático e link ao documento privado maior; não entregar a outro worktree silenciosamente. Se nada seguro houver, abster-se.
- Estado 0600/0700, gravação atômica e hash de fonte. Receipt por `(projectId, ownerId, nativeRoot, sourceSessionId, sourceHash, targetSessionId)` evita repetição na mesma sessão. Crash entre renderização e receipt pode repetir uma vez: documentar **at-least-once com dedupe por receipt**, sem promessa de exactly-once. Ler não apaga; limpeza após TTL e sem referência, nunca como efeito da leitura. Excluir artefatos de handoff/outbox da própria captura para evitar recursão. Este handoff editorial é separado de `authority.mjs`/writer transfer, que já usa termo “handoff” para autoridade.
- Retomada não confia cegamente em resumo: instrução humana atual prevalece, artefatos referenciados só por caminho, relato do assistente e memória legada identificados; não entregar segredos/PII. Se não houver prova de owner/root, não injetar e deixar o documento privado para inspeção autorizada. Fallback de idle cobre ausência de SessionEnd sem prometer que todo Ctrl-C chama hook.

## Mapa de arquivos e responsabilidade

| Unidade | Arquivos existentes | Novos arquivos planejados |
|---|---|---|
| Busca e confiança | `base/memoria/python/mem0_adapter.py`, `base/memoria/context.mjs`, `base/memoria/mcp-readonly.mjs`, `base/memoria/hook-recall.mjs`, `base/memoria/bridge.mjs`, `base/memoria/provision.mjs` | `base/memoria/hybrid-rank.mjs` se a fusão ficar isolada; `test/memoria-hybrid-recall.test.js` |
| Extração contextual | `base/memoria/extract-contract.mjs`, `candidates.mjs`, `conversation-proof.mjs`, `auto-publish.mjs`, `outbox.mjs`, `python/mem0_adapter.py`, `context.mjs` | Testes focados nos `test/memoria-conversation-contract.test.js`, `test/memoria-conversation-proof.test.js`, `test/memoria-auto-publish.test.js` |
| Avaliação | `base/memoria/evaluation.mjs`, `evaluation-cli.mjs`, `evals/curation-v1.json`, `test/memoria-evaluation.test.js` | `base/memoria/evaluation-retrieval.mjs`, `test/memoria-evaluation-retrieval.test.js`, `test/fixtures/memoria-quality-v2-minimal.json` sanitizado; corpus real e receipts locais privados fora do Git |
| Exportação | `base/memoria/cli.mjs`, `bridge.mjs`, `python/mem0_adapter.py`, `mcp-readonly.mjs` | `base/memoria/export.mjs`, `test/memoria-export.test.js`, `test/test_mem0_export.py` |
| Handoff | `base/skills/handoff/SKILL.md`, `base/commands/handoff.md`, `base/memoria/checkpoint.mjs`, `capture-hook.mjs`, `session-checkout.mjs`, `hook-recall.mjs`, `native.mjs` | `base/memoria/handoff-format.mjs`, `handoff-state.mjs`, `test/memoria-handoff-auto.test.js` |

## Fase A — itens 1, 2 e 5

### Task 1: Congelar corpus e baseline de qualidade (item 5, pré-condição)

**Files:** Create `test/fixtures/memoria-quality-v2-minimal.json` com casos técnicos sanitizados; modify `base/memoria/evaluation.mjs`, `base/memoria/evaluation-cli.mjs`, `test/memoria-evaluation.test.js`. Corpus de 30 casos, artefatos de fonte e respostas reais privados 0600 sob `~/.local/state/cbs/evals/`, fora do Git.

**Interfaces:** `validateMemoryCorpusV2(corpus): boolean`; `evaluateMemoryOutputs(corpus, outputs, {split})` mantém v1 e reconhece v2; `evaluateCli` aceita `--corpus`; fontes locais Claude `~/.claude/projects/**/*.jsonl` e Codex `~/.codex/sessions/**/rollout*.jsonl` lidas por parser read-only, com excertos mínimos e hash. Rótulo v2 `adjudication.source='agent_reviewed'` separado de `human`.

- [ ] RED: teste rejeita caso sem hash/trecho de origem, segredo no corpus e claim `human` sem prova; aceita 30 casos, 21 dev/9 holdout; outputs v1 permanecem válidos.
- [ ] GREEN: escolher 30 casos de sessões reais sem extrapolar, revisão independente de fonte por agente e congelar SHA256 do corpus/splits; salvar corpus/baseline 0.15.10, versão e limitações em arquivos privados 0600. Não rodar extração paga em massa.
- [ ] Rodar `node --test test/memoria-evaluation.test.js`; commit apenas da fixture técnica sanitizada e avaliador, sem casos reais/transcrições integrais. Se rótulos não forem verificáveis, marcar `unmeasured` e bloquear alegação de qualidade.

### Task 2: Avaliação offline de recuperação pareada (item 5)

**Files:** Create `base/memoria/evaluation-retrieval.mjs`, `test/memoria-evaluation-retrieval.test.js`; modify `base/memoria/evaluation-cli.mjs`. Não incluir respostas remotas sensíveis no Git.

**Interfaces:** `evaluateRetrieval(corpus, runs, {split}): report`; `runs` v1 registra para cada caso `snapshot_sha256`, `query`, `vector_candidates`, `lexical_candidates`, `returned_ids`, `latency_ms?`, `retrieval_version`. CLI `cbs memoria avaliar --retrieval <arquivo.json> --corpus ... --split ...`. Mesmos IDs/snapshot para baseline e candidato; report marca `paired=false` em drift.

- [ ] RED: teste de hit@k/MRR/precision/recall com 2 relevantes e abstenção negativa; rejeita ID fora do conjunto, owner/projeto alheio e snapshot divergente como comparação pareada.
- [ ] GREEN: implementar métricas e relatórios com denominadores/cobertura/`null` explícitos; registrar baseline vetorial congelado antes do ajuste dos ranks.
- [ ] Rodar `node --test test/memoria-evaluation-retrieval.test.js test/memoria-evaluation.test.js`; commit isolado.

### Task 3: Índice e candidatos textuais no Qdrant (item 1)

**Files:** Modify `base/memoria/python/mem0_adapter.py`, `base/memoria/provision.mjs`; test `test/test_mem0_adapter.py`, `test/test_mem0_remote.py` (fixture pequena, não Qdrant de produção).

**Interfaces:** Python `lexical_candidates(client, collection: str, project: str, query: str, limit: int = 32) -> list[dict]`; `ensure_text_index(client, collection: str) -> dict` só via CLI administrativa local e API nativa do Qdrant, sem instalar nada no servidor. Resposta do worker preserva `kind/items` e acrescenta evidência lexical separada. Sem alteração de `verify_collection`/fingerprint.

- [ ] RED: consulta exata de `HML_TRIPEX_COMP` acha ID com span literal; “servidor” genérico não libera lexical; índice ausente, 33 candidatos e falha de rede retornam fallback tipado; filtros impedem `pending`, outro projeto, outro owner e legado.
- [ ] GREEN: criar índice `data` explicitamente/idempotente no provisionamento autenticado; usar `MatchText` e `MatchTextAny` com orçamento, validar ocorrência literal e revalidar payload via `_row`. Não mexer no texto/vetor dos pontos.
- [ ] Rodar `python3 -m unittest test.test_mem0_adapter test.test_mem0_remote` conforme venv/test helper existente; commit isolado. Conferir compatibilidade real no Qdrant 1.19.1 com coleção descartável pequena, sem transcrição/segredo no log.

### Task 4: Fusão, confiança e entrega Claude/Codex (item 1)

**Files:** Create `base/memoria/hybrid-rank.mjs`, `test/memoria-hybrid-recall.test.js`; modify `base/memoria/context.mjs`, `base/memoria/hook-recall.mjs`, `base/memoria/mcp-readonly.mjs`, `base/memoria/mcp.mjs`, `base/memoria/python/mem0_adapter.py`; extend `test/memoria-recall.test.js`, `test/memoria-mcp-readonly.test.js`.

**Interfaces:** `rankHybrid(vectorRows, lexicalRows, {limit=20, rrfK=60}): row[]`; `selectRecall` aceita `scoreSource='hybrid_verified'` apenas com evidência lexical verificável ou score vetorial ≥0.85. `searchProject` e MCP preservam contrato `kind/items`; item inclui `retrievalEvidence` sem promover rank a score. `legacy/all/curated` e contexto automático seguem contratos anteriores.

- [ ] RED: teste rank une mesmo ID, mantém 0.85 no vetor, aceita ID técnico literalmente confirmado, rejeita lexical frouxo/outro owner/stale/superseded, limita 20/500 bytes e é determinístico; teste de fallback vetorial no índice ausente e tipagem no remote down.
- [ ] GREEN: um embedding por query, RRF só após filtros/validação, `scoreSource` com prova explícita, falha parcial observável sem injeção indevida. Não somar cosine e rank textual.
- [ ] Rodar `node --test test/memoria-hybrid-recall.test.js test/memoria-recall.test.js test/memoria-mcp-readonly.test.js` e Python focado; commit isolado.

### Task 5: Contexto curto na mesma extração Haiku (item 2)

**Files:** Modify `base/memoria/extract-contract.mjs`, `candidates.mjs`, `conversation-proof.mjs`, `auto-publish.mjs`, `outbox.mjs`, `python/mem0_adapter.py`, `context.mjs`, `mcp-readonly.mjs`; tests `test/memoria-conversation-contract.test.js`, `test/memoria-conversation-proof.test.js`, `test/memoria-auto-publish.test.js`, `test/test_mem0_adapter.py`.

**Interfaces:** `candidate.context?: Array<{kind:'problem'|'reason'|'attempt'|'pending',summary:string,source_message_ids:string[]}>`; metadata remota `context_generated?: {version:1, items:[...], trust:'generated_unverified', source_refs_sha256:string}`. `validateConversationProof` valida campos opcionais contra refs existentes e segurança, sem mudar prova/identidade do fato. `get/source` exibe rotulado; recall só se couber em 500 bytes.

- [ ] RED: resposta antiga sem contexto e checkpoint v4 antigo continuam aceitos/publicáveis; contexto com ID inventado, segredo, >4 itens, >256 bytes ou owner alheio é descartado sem perder fato válido; assistente não vira fato verificado.
- [ ] GREEN: atualizar schema/prompt e código de saída da **mesma** chamada Haiku; manter máximo 5 candidatos/checkpoint, registrar input/output tokens e duração; validar e salvar metadata opcional após ACK existente.
- [ ] Rodar `node --test test/memoria-conversation-contract.test.js test/memoria-conversation-proof.test.js test/memoria-auto-publish.test.js` e Python focado; commit isolado.

### Task 6: Gate de avaliação da fase A (itens 1, 2 e 5)

**Files:** Extend `test/memoria-evaluation-retrieval.test.js`, `test/memoria-evaluation.test.js`; report privado no mesmo diretório de eval, sem novo plano no Git.

**Interfaces:** Baseline congelado de Task 1/2 e candidate run pareado de Tasks 4/5, com dev e holdout separados. Report inclui métricas por classe, hashes, cobertura, custo/latência observados e status de cada gate.

- [ ] RED: fixture com melhora falsa causada por drift, owner leak ou caso negativo contaminado falha o gate; campos não observados ficam `null`.
- [ ] GREEN: comparar dev sem ajustar holdout, rodar holdout uma vez e 3 smokes reais no máximo em cada CLI para busca, contexto, indisponibilidade/abstenção; registrar se houve ou não uso de GPU, sem extrapolar velocidade.
- [ ] Rodar testes focados de avaliação e relatório privado. Se gate falhar, corrigir Tasks 3–5 e repetir comparativo em **novo** dev; não relabelar holdout para fazer passar. Review independente antes da fase B.

## Fase B — item 4, depois item 3

### Task 7: Exportação Markdown privada e histórico de correções (item 4)

**Files:** Create `base/memoria/export.mjs`, `test/memoria-export.test.js`, `test/test_mem0_export.py`; modify `base/memoria/cli.mjs`, `base/memoria/python/mem0_adapter.py`, `base/memoria/python/worker.py`, `README.md`.

**Interfaces:** `exportCurated({cwd, sessionId, outputDir, stateRoot, maxPoints=10000}): Promise<{kind,count,manifestPath?}>`; Python `list_curated_page(client, collection, project, owner, offset, limit=64)` retorna pontos e cursor sem vetor; `readMemoryHistory(snapshotDir, id): {kind, versions, snapshotSha256}` segue `supersedes_id`/`superseded_by` sem ciclos. CLI `cbs memoria historico --project <raiz> --id <uuid> --snapshot <diretório>`; entrada administrativa usa confiança/destino atuais, sem MCP amplo. Markdown por ID; manifesto e snapshot completos só após última página validada.

- [ ] RED: fixture com páginas 64+1, cursor repetido, 10.001 pontos, falha mid-page, symlink e diretório público; export anterior fica intacto, item outro owner/pending/legado não aparece, supressão de segredos funciona.
- [ ] RED: cadeia com ciclo, elo ausente, ID externo ao projeto, snapshot desatualizado e versão antiga superseded informa limitação sem confundir com regra ativa; reexportar mesmo estado preserva hashes de páginas.
- [ ] GREEN: usar `scroll` limitado, revalidar status/proveniência/owner/validade e hash, escrever em staging privado e trocar atomicamente apenas snapshot completo; mostrar cadeia por vínculo, README explica fonte derivada/retenção e reimport não automático; sem Git autopush.
- [ ] Rodar `node --test test/memoria-export.test.js` e `python3 -m unittest test.test_mem0_export`; review de privacidade e commit isolado.

### Task 8: Formato e estado seguro do handoff automático (item 3)

**Files:** Create `base/memoria/handoff-format.mjs`, `base/memoria/handoff-state.mjs`, `test/memoria-handoff-auto.test.js`; read `base/skills/handoff/SKILL.md`, `base/commands/handoff.md`; modify skill apenas se necessário para apontar ao formato compartilhado.

**Interfaces:** `formatHandoff({projectId, ownerId, nativeRoot, checkpoint, memories, now}): {summary, markdown, sourceHash}`; `saveHandoff(stateDir, value)` e `loadHandoff(stateDir, identity)` guardam e filtram por owner/projeto/root/TTL. Resumo de injeção ≤300 bytes; arquivo maior privado; material sem fato durável pode resultar de checkpoint verificável.

- [ ] RED: estrutura manual mantém Objetivo/Estado/Artefatos/Decisões/Pendências/Riscos/Segredos/Skills; segredo e PII são redigidos, caminho de outro checkout/owner bloqueado, fonte só do assistente rotulada; sem fatos = handoff operacional ou abstain, sem chamar Haiku.
- [ ] GREEN: helper editorial usa mesmo contrato da skill e refs, documentos atômicos 0600/0700, TTL 7 dias e hash; não escreve em `docs/handoffs/` sem `/handoff` manual.
- [ ] Rodar `node --test test/memoria-handoff-auto.test.js`; commit isolado.

### Task 9: Captura, entrega e fallback de sessão (item 3)

**Files:** Modify `base/memoria/checkpoint.mjs`, `capture-hook.mjs`, `native.mjs`, `hook-recall.mjs`, `session-checkout.mjs`; test `test/memoria-handoff-auto.test.js`, `test/memoria-recovery.test.js`, `test/memoria-windows-transport.test.js`.

**Interfaces:** `updateHandoffFromCapture({cli,event,payload,result,stateRoot})` consome apenas checkpoint autenticado; `deliverHandoffAtSessionStart({cli,payload,stateRoot})` devolve contexto ≤300 bytes ou null com receipt por sessão. Prioridade de injeção: instrução humana corrente > `/handoff` manual > handoff automático > recall ordinário; não ler artefato de outro owner/root.

- [ ] RED: Stop/PreCompact/SessionEnd/Interrupt duplicados deixam um estado; Ctrl-C sem hook usa último checkpoint/idle no próximo start; crash depois de injetar pode repetir no máximo uma vez e receipt deduplica; nenhuma captura recursiva/outbox loop; hook ausente em plataforma antiga abstém.
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
