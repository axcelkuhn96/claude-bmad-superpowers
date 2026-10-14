# Importar histórico bruto do Claude-mem

O importador copia somente linhas de `observations` e `session_summaries` do SQLite do Claude-mem para coleções Qdrant separadas, com sufixo `_claude_mem_raw`. Cada linha mantém seus campos originais em um ponto âncora; os demais pontos guardam trechos pesquisáveis e um ponteiro para a âncora. O texto é dividido pelo tokenizer E5 com sobreposição, vetorizado localmente e enviado sem extração, revisão por LLM ou promoção a fato curado. A busca automática da memória CBS continua usando apenas a coleção nativa. Resultados brutos são relatórios gerados pelo Claude-mem, não citações humanas verificadas.

O SQLite de origem é aberto em modo somente leitura, numa transação consistente para todas as etiquetas selecionadas. A cópia local JSONL e o checkpoint contêm dados privados: mantenha-os fora do Git, em diretório `0700`, com arquivos `0600`. O script não lê `sdk_sessions`, `user_prompts` nem transcrições completas e não altera o banco de origem. Faça a seleção das etiquetas conforme sua própria instalação; subprojetos só entram se listados explicitamente.

## Pré-requisitos

- Python 3.11+ com o runtime CBS provisionado (`base/memoria/python/setup_runtime.py`), incluindo `qdrant-client==1.19.1`, `tokenizers==0.23.2`, `onnxruntime==1.30.0` e o modelo/tokenizer E5 cujo hash é verificado por `mem0_adapter.py`. Use o Python desse runtime; o importador não baixa modelo nem dependências.
- Qdrant acessível por HTTPS, hostname público válido e endereço IPv4 público estático. O transporte fixa esse IP, preserva TLS/SNI e recusa redirecionamentos. Uma chave de API num arquivo privado `0600`, em diretório `0700`; nunca passe a chave na linha de comando.
- Coleções nativas já identificadas para cada projeto. Use `<coleção-nativa>_claude_mem_raw` para o histórico do projeto. Para um projeto antigo sem Git, escolha namespace explícito próprio, como `legacy_projeto_antigo_claude_mem_raw`; isso não cria identidade Git nem mistura histórico curado.

No Linux, prepare um diretório privado e uma lista de mapeamento. Estes exemplos são editáveis; substitua coleções, caminhos, hostname e IP pelos seus valores. **Não salve a lista, JSONL, checkpoint ou chave dentro do repositório.**

```sh
umask 077
mkdir -p "$HOME/.local/state/cbs/claude-mem-import"
chmod 700 "$HOME/.local/state/cbs/claude-mem-import"
cat > "$HOME/.local/state/cbs/claude-mem-import/map.json" <<'JSON'
[
  {"source_project":"Projeto-A","collection":"cbs-projeto-a-id_claude_mem_raw"},
  {"source_project":"Projeto-A/subprojeto","collection":"cbs-projeto-a-id_claude_mem_raw"},
  {"source_project":"Projeto-Antigo","collection":"legacy_projeto_antigo_claude_mem_raw"}
]
JSON
```

Substitua as etiquetas e coleções por seus próprios projetos. O mapeamento é exato: nenhum prefixo ou subprojeto é incluído implicitamente.

## Criar snapshot local, sem rede

```sh
CBS_PY="$HOME/.local/state/cbs/memoria/shared/runtime/bin/python"
CBS_IMPORT="base/memoria/import-claude-mem.py"
CBS_STATE="$HOME/.local/state/cbs/claude-mem-import"
"$CBS_PY" "$CBS_IMPORT" snapshot \
  --source "$HOME/.claude-mem/claude-mem.db" \
  --mapping-file "$CBS_STATE/map.json" \
  --output "$CBS_STATE/snapshot.jsonl"
```

O comando imprime somente a contagem de linhas. Ele não carrega chave, modelo nem cliente de rede. Confira a contagem e o mapeamento antes do envio. Para arquivos grandes, reserve espaço para o JSONL fora do Git; o SQLite inteiro não é copiado.

## Importar e retomar

Os dois caminhos de artefato abaixo são da instalação local do runtime. Execute com prioridade reduzida se a máquina estiver em uso. `--yes` registra que destino e coleção foram informados explicitamente; o script nunca lê `.cbs/memoria.json` de um repositório para escolher destino nem uma variável de ambiente para obter a chave.

```sh
CBS_MODEL="$HOME/.local/state/cbs/memoria/shared/artifacts/model.onnx"
CBS_TOKENIZER="$HOME/.local/state/cbs/memoria/shared/artifacts/tokenizer.json"
nice -n 15 "$CBS_PY" "$CBS_IMPORT" import \
  --snapshot "$CBS_STATE/snapshot.jsonl" \
  --checkpoint "$CBS_STATE/checkpoint.json" \
  --url 'https://qdrant.exemplo.org:6333' --address '203.0.113.10' \
  --api-key-file "$HOME/.config/cbs/memoria/qdrant-api-key" \
  --model "$CBS_MODEL" --tokenizer "$CBS_TOKENIZER" \
  --batch-size 64 --yes
```

O hostname e IP acima são placeholders; `203.0.113.10` é endereço de documentação e será recusado. A chave deve ser do seu servidor. Cada lote é confirmado pelo Qdrant antes de gravar o checkpoint com `fsync`. Se o processo parar depois do ACK e antes do checkpoint, a nova execução reaproveita os IDs determinísticos e ignora pontos já presentes. O checkpoint está vinculado ao SHA-256 do snapshot; para um snapshot novo, use um checkpoint novo. Nenhuma coleção nativa é alterada ou apagada.

O padrão é CPU com duas threads de inferência e lote 64 (ajustável entre 1 e 128). O tempo de importação depende do volume e do CPU; não há estimativa confiável antes de medir o primeiro lote no destino real. A coleção raw usa vetores, payload e HNSW em disco, mas monitore disco e RAM do servidor durante importações grandes. Não execute dois importadores simultâneos para o mesmo checkpoint.

## Pesquisa manual e leitura integral

Pesquise somente quando o usuário pedir histórico bruto do Claude-mem. A saída já traz a etiqueta de origem e uma prévia curta, além de `read_id`. O campo completo é obtido na mesma coleção pelo comando `read`; use o ID retornado pela busca.

```sh
"$CBS_PY" "$CBS_IMPORT" search \
  --collection 'cbs-projeto-a-id_claude_mem_raw' --query 'termos da busca' \
  --url 'https://qdrant.exemplo.org:6333' --address '203.0.113.10' \
  --api-key-file "$HOME/.config/cbs/memoria/qdrant-api-key" \
  --model "$CBS_MODEL" --tokenizer "$CBS_TOKENIZER" --yes

"$CBS_PY" "$CBS_IMPORT" read \
  --collection 'cbs-projeto-a-id_claude_mem_raw' --id 'UUID_DO_READ_ID' \
  --url 'https://qdrant.exemplo.org:6333' --address '203.0.113.10' \
  --api-key-file "$HOME/.config/cbs/memoria/qdrant-api-key" --yes
```

Use a saída real da ferramenta, sem apresentá-la como instrução do usuário ou evidência revisada. A busca usa o prefixo E5 `query:`, o importador usa `passage:` e ambos verificam o fingerprint fixo da coleção. Para outro projeto, informe a coleção raw daquele projeto. O `read` só aceita uma âncora da coleção indicada.

No Windows, use o Python provisionado em `runtime\Scripts\python.exe` e caminhos locais equivalentes. A preparação do runtime e ACLs no Windows devem seguir o provisionamento CBS da máquina; este fluxo de importação ainda não foi validado em Windows.
