# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.15.9] - 2026-10-21

### Adicionado
- **Reprocessamento controlado da extração automática:** uma operação privada vinculada ao projeto, destino, proprietário, consentimento e perfil de execução permite retomar checkpoints elegíveis com a conta Haiku selecionada. A execução registra seu próprio perfil e consumo, preservando a proveniência, as filas e os contadores anteriores; um crédito adicional por operação e checkpoint é deduplicado sem zerar o histórico.
- **Limites explícitos do replay:** a operação limita linhas e chamadas de extração e mantém as verificações de origem, vínculo, autorização e publicação. Checkpoints com prova quebrada ou outros impedimentos continuam retidos; a presença na fila não comprova memória publicada.

## [0.15.8] - 2026-10-21

### Atualizado
- **`/investigar` orientado por evidências:** apura dúvidas, suspeitas e ideias no ambiente pertinente ao relato, inclusive produção quando houver acesso read-only já autorizado. Distingue fatos confirmados, hipóteses e pontos não verificados; uma investigação pode concluir que não encontrou defeito no escopo observado.
- **Memória como pista histórica:** consulta o provedor pertinente antes da conclusão, confirma itens relevantes no estado atual e registra indisponibilidade sem inventar lembranças ou usar outro provedor como substituto.
- **Resposta proporcional:** apresenta achados, fontes e limites antes de oferecer sugestão de correção quando cabível. Deixa de impor tabela de alternativas, análise de impacto, PRD e relatório para toda investigação; `docs/analises/` é usado quando útil ou solicitado. O fluxo permanece read-only para código, dados, configuração e serviços.

## [0.15.7] - 2026-10-20

### Corrigido
- **Escrita manual Mem0 após atualização do Claude Code:** a remoção do executável de extração selecionado deixa de invalidar o consentimento de publicação automática já válido. `remember` e o estado de escrita manual continuam disponíveis nos projetos Mem0 conhecidos quando proprietário, escritor, projeto, destino e consentimento permanecem válidos, sem nova configuração do extrator ou reinício da CLI.
- **Extração automática após atualização oficial:** o runtime pode resolver o executável atual na mesma instalação e perfil para retomar lotes já capturados, inclusive em sessões iniciadas antes da atualização. O vínculo do projeto, as provas da fonte, a autorização, o destino e os contadores permanecem sujeitos às verificações existentes; caminhos de outra instalação ou perfil não são aceitos.

## [0.15.6] - 2026-10-16

### Corrigido
- **Fila do serviço de memória:** chamadas simultâneas aguardam dentro do prazo absoluto da operação, em lugar do corte fixo de 100 ms. Mantém um único encoder, até duas chamadas em espera e rejeição de pedidos expirados ou cancelados antes da execução.
- **Diagnóstico de gravação:** erros conhecidos de fila, prazo e indisponibilidade do worker são preservados na fase de inclusão; a reconciliação mantém a identidade do pedido quando a confirmação falha após a gravação.

## [0.15.5] - 2026-10-15

### Documentação
- **Crédito ao Mem0:** atribuição ao projeto e à licença Apache 2.0 no README.
- **Memória compartilhada:** esclarece o uso do Qdrant central por diferentes projetos e usuários, com memórias de projeto, filtro de proprietário para memórias pessoais e contexto separado por coleção.

## [0.15.4] - 2026-10-15

### Corrigido
- **MCP e encoder compartilhado:** no Linux, buscas, leituras e pedidos explícitos de gravação usam o broker local, preservando um único encoder e a proteção de exclusividade. Corrige `worker_exited` causado pela rota MCP que iniciava um worker sem o lock obrigatório. O broker verifica o vínculo do projeto e a autorização; gravações preservam a prova do pedido e o consentimento em cada suboperação.

## [0.15.3] - 2026-10-15

### Corrigido
- **YAML do agente de revisão final:** descrição de `cbs-final-reviewer.md` entre aspas para permitir leitura por parsers YAML estritos.

## [0.15.2] - 2026-10-15

### Corrigido
- **Retomada da fila em sessões longas:** na publicação automática por conversa, o teto de extração passa a valer por sessão e dia UTC. O histórico acumulado é preservado e o consumo diário persiste sob o lock do outbox, inclusive após reinício; um relógio que recua não renova o orçamento. Na migração, consumo antigo sem data comprovada é carregado para o dia atual.
- **Limite como adiamento:** lotes que atingiram o teto voltam a ser considerados no próximo gatilho elegível após a renovação ou aumento autorizado do orçamento. Manifestos já extraídos podem ser publicados sem nova chamada ao modelo. Erros de formato e de prova da fonte continuam retidos, preservando confiança, consentimento, deduplicação e confirmação remota.

- **Recuperação do serviço local no Linux:** o worker mantém um `flock` exclusivo durante toda a sua vida, adquirido antes de carregar E5. Guardas novas são publicadas atomicamente e podem ser reconciliadas após queda sem permitir dois encoders; o inode do lock permanece estável. Guardas legadas ou malformadas continuam bloqueadas até diagnóstico seguro. O protocolo Windows permanece inalterado.

## [0.15.0] - 2026-10-14

### Adicionado
- **Avaliação offline da curadoria:** `cbs memoria avaliar --outputs resultados.json [--corpus corpus.json] [--split dev|holdout|all]` compara saídas fornecidas com um corpus versionado de onze casos, incluindo três reservados para revisão. Relata contrato, evidência, segredos, estados temporários, duplicatas exatas, cobertura, tentativas e uso informado. Métricas semânticas dependem de adjudicação declarada; fixtures não medem precisão do Haiku nem confirmam gravações no Qdrant. O comando não chama modelo, embedding ou serviço de memória.
- **Inventário incremental de skills:** `cbs skills inventario` lê `SKILL.md` nas raízes globais, do projeto e dos caches de plugins Claude/Codex, com limites de leitura. `--snapshot`, `--save-snapshot`, `--changed`, `--root` e `--json` comparam hash de conteúdo e referências locais; snapshots de escrita ficam no estado privado do CBS. Cache em disco não comprova plugin habilitado, divergência de hash é informativa e uso permanece não medido.
- **Brief de site público por seção:** o rulebook frontend pede objetivo, afirmação comprovada, fonte e origem/licença ou prompt do asset no brief/report existente; presença visual é conferida em captura Playwright. Restrito a sites públicos novos ou redesenhos.

Inspiração seletiva: [ECC eval-harness](https://github.com/affaan-m/ECC/blob/b92f181b3b748d1abbc2afd94af6aa7d8c8fca29/skills/eval-harness/SKILL.md), [ECC skill-stocktake](https://github.com/affaan-m/ECC/blob/b92f181b3b748d1abbc2afd94af6aa7d8c8fca29/skills/skill-stocktake/SKILL.md) (MIT, Affaan Mustafa) e [Taste skill](https://github.com/Leonxlnx/taste-skill/blob/f624f37a8c650b9cc550253104925efe4c8de246/skills/taste-skill/SKILL.md). As métricas, o inventário e o adaptador são implementações próprias do CBS; nenhum runner externo ou workflow visual foi instalado.

## [0.14.2] - 2026-10-14

### Corrigido
- **Retomada da curadoria:** falhas recuperáveis persistem com estado tipado e podem ser tentadas novamente dentro do orçamento da sessão, sem repetir indefinidamente chamadas inválidas. Um lote pendente não equivale a memória gravada.
- **Contexto para seleção:** a busca coleta no máximo 64 pontos da primeira página de Qdrant por projeto/escopo, seleciona até oito memórias completas e limita a 4.096 bytes UTF-8 a soma de texto e condição. Esse contexto é auxiliar para reduzir repetição e conflito; não transforma memórias antigas em prova do fato novo. A busca saturada registra degradação. O caminho reaproveita a chamada de curadoria e o embedding existentes, sem chamada adicional a Haiku ou E5 por desenho.
- **Diagnóstico da curadoria:** o contador durável do outbox registra `ready`, `saturated` ou `unavailable` para o contexto usado na seleção, separado da confirmação de gravação. Deduplicação de paráfrases é melhor esforço, não garantia semântica.

### Atualizado
- **Superpowers 7.0.0 e BMAD 6.12.4:** referências ativas seguem os nomes de skills atuais. Para uma ideia ainda não refinada no modo normal, o brainstorming 7.0 exige aprovação da descrição antes do plano; o CBS mantém a aprovação do plano antes da execução. `--auto` preserva a dispensa explícita de perguntas intermediárias. Contratos foram conferidos nas fontes; o fluxo interativo completo dessas versões requer validação em sessão nova.
- **Ponytail:** rulebook transversal adaptado do [Ponytail 5.2.0](https://github.com/DietrichGebert/ponytail/tree/v5.2.0) (Dietrich Gebert, MIT) agora explicita revisão dos chamadores e riscos do fluxo, teste pequeno para lógica nova e análise do código tocado fora do diff. O CBS distribui somente sua adaptação, sem plugin ou hooks Ponytail; benchmarks upstream não medem este rulebook.

### Verificado
- Na sessão Mizu encerrada com Ctrl+C, houve uma memória confirmada às 21:22:15 UTC (18:22:15 em São Paulo). Esse caso comprova uma gravação; não garante que todo fechamento por Ctrl+C acione o hook ou produza candidato útil.

## [0.14.1] - 2026-10-14

### Adicionado
- **Gravação explícita em sessão normal:** `cbs_memoria.remember` recebe um pedido direto de guardar memória e envia o conteúdo ao escritor local já autorizado, sem esperar cinco trocas nem chamar Haiku. O resultado `stored` só é devolvido após confirmação do Qdrant; pedidos idênticos retornam `duplicate` com o ID existente. Ausência de consentimento, proprietário, escritor ou projeto confiável produz um resultado tipado sem declarar gravação.
- **Proveniência do MCP:** a memória de pedido explícito é rotulada como texto fornecido pelo agente ao MCP (`mcp_agent`, `assistant_report`, `explicit_mcp`), sem atribuir o texto literalmente ao usuário ou marcá-lo como revisão humana. O registro local conserva o pedido e o vínculo de projeto para recuperação após falhas.

### Corrigido
- **Registro do Codex:** a lista permitida de ferramentas do MCP inclui `remember` e a ativação atualiza registros CBS antigos que ainda tinham somente `search`, `get` e `status`. O Claude Code também precisa de uma nova sessão para mostrar a ferramenta instalada.

## [0.14.0] - 2026-10-14

### Adicionado
- **Curadoria por conversa em lotes:** após cada cinco trocas completas entre pessoa e resposta final visível da LLM, Haiku avalia a conversa e pode selecionar zero ou mais decisões, regras, correções e soluções duráveis, mantendo referências verificáveis à fonte. Resumos brutos não são publicados como memória. O cronograma `cbs memoria extractor-schedule --mode conversation --turns 5 --max-calls 100` preserva consentimento, proprietário e escritor; o limite de 100 chamadas e os contadores persistem entre reinícios e retomadas.
- **Flush nos limites de ciclo de vida:** `PreCompact` e `SessionEnd` processam lotes restantes menores que cinco; o `Interrupt` do Codex solicita flush assíncrono. Após fechamento abrupto, lotes parciais persistidos são recuperados no próximo hook depois de 30 minutos de inatividade; uma fala humana sem resposta final permanece pendente.
- **Proveniência de conversa:** payload v4 identifica resumos de conversa e registra referências com papel, hash, posição e trecho. A resposta do assistente não é atribuída à pessoa, tratada como revisão humana ou fato verificado. Análise, raciocínio, sidechains e subagentes internos são excluídos.
- **Deduplicação entre lotes:** novos fatos idênticos são reconciliados antes da gravação, sem outra chamada ao modelo. Paráfrases equivalentes e memórias v3 sem chave de deduplicação podem gerar cópias.

## [0.13.3] - 2026-10-14

### Corrigido
- **Sessões Mem0 retomadas:** um hook nativo válido atualiza proprietário e extrator que ficaram vazios antes da adesão, respeitando o consentimento atual e a identidade do projeto. Vínculos de proprietário já registrados não são trocados.
- **Captura inicial:** o primeiro hook autorizado estabelece um ponto de corte durável; o histórico já presente na transcrição não é reenviado para extração. Mensagens futuras seguem para os checkpoints, sem reiniciar o limite de quatro chamadas Haiku por sessão.
- **Claude Code em worktrees:** a ativação e os checkpoints usam a raiz ativa da worktree para validar os hooks nativos, mantendo o vínculo com o projeto Git principal.

## [0.13.2] - 2026-10-14

### Adicionado
- **Gravação automática Mem0 com adesão explícita por projeto:** os hooks nativos de Claude Code e Codex capturam mensagens humanas; checkpoints acionam até quatro chamadas Haiku por sessão e geram no máximo cinco candidatos por checkpoint. O cliente valida fonte literal, tipo, escopo, consentimento e escritor ativo antes de gerar embeddings locais e gravar no Qdrant. A proveniência distingue validação automática de revisão humana.
- **Retomada da publicação:** checkpoints persistidos são retomados após falha transitória, sem repetir a extração já concluída. O processo de retentativa nasce sob demanda, tem duração limitada e não instala serviço no startup do computador. A adesão vale para sessões novas; outros projetos mantêm a gravação automática desligada.
- **Perfis independentes:** o registro do proprietário de um perfil Claude Code não substitui o de outro. O MCP de sessões normais permanece somente de leitura (`search`, `get`, `status`); a gravação automática é feita pelos hooks e pelo escritor local autorizado.

## [0.13.1] - 2026-10-13

### Adicionado
- **Memória Mem0 opcional por projeto (experimental):** seleção local explícita para novas sessões Claude Code/Codex, exclusiva em relação ao claude-mem padrão. Captura, extração por CLI, SDK Mem0 e embeddings E5 ficam no cliente; o servidor executa Qdrant autenticado. Candidatos exigem fonte, ator, data, escopo e revisão; a publicação automática permanece desativada.
- **MCP `cbs_memoria` somente de leitura em sessões normais:** `search`, `get` e `status` consultam o projeto Git confiável diretamente no catálogo de ferramentas do Claude Code/Codex, sem `cbs memoria launch`. Pedidos em linguagem natural usam `search`; `cbs memoria activate` registra automaticamente o MCP no projeto e perfil Claude Code (incluindo `CLAUDE_CONFIG_DIR`) ou no perfil global do Codex. Entradas divergentes são preservadas e bloqueiam o registro; uma nova sessão vê o MCP após a ativação. O MCP de gravação vinculado ao launcher permanece separado.
- **Consulta manual de histórico legado pelo MCP:** `search` pode incluir registros brutos importados do Claude-mem, sempre rotulados como gerados e não verificados; `source: "curated"` limita a busca à curadoria e `get` lê o resultado identificado. Os hooks automáticos consultam apenas a curadoria.
- **Extração Haiku opt-in:** seleciona poucas mensagens duráveis; cada candidato deriva `source_note` da citação literal completa e exata da fonte curta (até 512 bytes), com ator, origem, data e IDs locais. O proprietário revisa no TTY antes do envio ao SDK (`infer=False`). A paráfrase do modelo não é usada como fonte.
- **Instalador privado do Qdrant:** script `.sh` e guia de operação, com armazenamento persistente, autenticação e procedimentos de backup/restauração.
- **Destino Qdrant público opcional:** `qdrant.allow_public: true` aceita HTTPS com nome TLS validado e IPv4 público fixo explícito, sem redirecionamentos; o destino privado continua sendo o padrão. Modo, endereço, URL e coleção ficam vinculados à confiança local e exigem nova ativação após mudança.
- **Chave Qdrant local:** em Linux, aceita `~/.config/cbs/memoria/qdrant-api-key` pertencente ao usuário, com arquivo `0600` e diretórios privados `0700`; `CBS_MEMORIA_QDRANT_KEY` tem precedência. A chave só é lida após a validação do destino confiável.
- **Configuração nativa versionada:** ativação explícita por `--allow-tracked-native`, com snapshot restrito ao arquivo e ao índice Git para preservar edições existentes e permitir restauração segura.
- **Histórico claude-mem bruto:** importação opcional para coleção separada por projeto, com consulta e leitura manuais; sem LLM na migração e sem inclusão no recall automático. O importador usa IDs estáveis por linha/trecho, checkpoint vinculado ao snapshot/destino/modelo e reconciliação remota na retomada. Veja [o tutorial](docs/memoria/importar-claude-mem.md).
- **Subagentes nomeados**: todo dispatch das skills e comandos passa `name` curto, kebab-case, único na sessão, no padrão `<papel>-<escopo>` (`impl-t3`, `rev-t3`, `rerev-t3-r2`, `explore-auth`, `rev-final`), pra você falar com o agente por `@nome`/`SendMessage`. Regra canônica em `executor-bmad-superpowers/referencia/dispatch.md` §2; o override de Model Selection passado ao SDD exige `name` em todo implementer e reviewer. Codex: nome do agente de `~/.codex/agents` quando existir; nome da instância no mesmo padrão quando o runtime aceitar.

### Corrigido
- **Busca Mem0 no Qdrant remoto:** o cliente REST usa timeout explícito de 30 s para respostas de busca, dentro do prazo de 120 s do broker.
- **Broker Mem0 em sessões ociosas:** o gatilho nativo acorda o runtime local sob demanda em sessões normais; a conexão autenticada preserva o worker de recall enquanto a CLI está aberta e libera recursos depois.
- **Probe do plugin claude-mem no Codex:** verifica no JSON da CLI que o plugin está realmente instalado no marketplace esperado, sem confundir "not installed" com instalação.
- **Compatibilidade Node 24:** a resolução do endereço fixado para ativação e autoridade HTTPS aceita o formato de resposta DNS usado pelo Node 24.
- **Restauração de configuração versionada:** uma interrupção após escrita parcial retoma a restauração do snapshot; alterações posteriores do usuário ou deriva do índice são recusadas sem sobrescrita.
- **`cbs-no-verify`, falsos positivos**: as flags só contam dentro da mesma invocação git; `-n` só conta em `commit`/`am`; corpo de heredoc é dado. `pgrep -f "git commit"`, `find -name`, `echo -ne`, `nice -n` e `cherry-pick -n` passam. Medido em 9.993 comandos reais: 116 → 5 bloqueios, nenhum bloqueio novo.
- **`cbs-format`/`cbs-typecheck`**: ferramenta ou interpretador indisponível (exit 127, ENOENT, EACCES) vira skip silencioso. Acaba o ruído "pint falhou (exit 127)" sem PHP e os bloqueios falsos no Stop. O diretório do node é anexado ao PATH do spawn, então tsc/prettier/biome rodam mesmo com o node fora do PATH.
- **Gravação manual de memória:** deadline ausente (`null`) não bloqueia a gravação; deadlines `0` ou no passado continuam bloqueados.
- **Integridade da fonte Haiku:** exige igualdade com a citação literal completa, preservando espaços, caixa e Unicode; não aceita substring editável que possa remover contexto, inclusive uma negação.
- **Revisão Mem0 com estado isolado:** propaga a raiz de estado escolhida até a gravação no SDK, permitindo concluir a revisão de uma sessão preparada nesse estado.
- **Captura na TUI nativa do Codex:** reconhece a mensagem humana autenticada pelos eventos da sessão, preservando a rejeição de contexto injetado como fonte humana.

### Validado em QA local
- Gatilho de skill em sessões normais de Claude Code e Codex alcançou o contexto nativo Mem0 e recuperou a regra congelada nas duas CLIs. A ativação Linux fica experimental, com as verificações locais de confiança e propriedade mantidas; a prova não cobre recall antes do primeiro gatilho nem constitui aceite de qualidade geral.
- Ciclo automático de captura, checkpoint, extração Haiku, revisão no terminal, gravação e recuperação em sessão nova, uma vez em Claude Code e uma vez na TUI do Codex. No Codex, a própria CLI foi interrompida após o checkpoint durável, antes da revisão.
- Correção e replay do mesmo checkpoint após interrupção de worker próprio e indisponibilidade temporária do Qdrant: uma versão ativa recuperável, sem perda ou duplicação no ensaio. A revisão no terminal foi automatizada para QA e a fonte desse ensaio era sintética.
- Transporte HTTPS remoto do Qdrant: TLS com CA/nome, autenticação positiva e negativa e operações SDK com coleção de QA temporária; não equivale à prova do pipeline completo de memórias remoto.

### Limitações conhecidas
- O lote de 44.021 registros do histórico Claude-mem segue em execução; cobertura e qualidade final ainda não foram aceitas.
- Windows permanece sem prova de release (`windows_release_unproved`); a validação física caberá a outro responsável. Julgamento do proprietário, RF-19 completo e pipeline de memórias no Qdrant remoto seguem pendentes.
- A prova operacional Haiku confirmou seleção e abstenção no pequeno conjunto real avaliado. Um comparativo contextual com fontes reais e quatro respostas nativas de Claude/Codex demonstrou lembrança útil da regra nos braços com memória, sem ferramentas ou dano material observado. Auditoria Astra: PASS limitado ao caso; os controles também eram seguros. O julgamento do proprietário e RF-19 completo permanecem pendentes. A prova entre duas máquinas foi adiada pelo proprietário para depois da implantação.
- A rota Sol aguarda prova de isolamento de ferramentas.

## [0.13.0] - 2026-09-27

Traz do ECC (affaan-m/ECC, MIT, commit e482e57) só o que serve às stacks Laravel, Node/TypeScript, React/React Native e Python. Nada novo é carregado por sessão.

### Adicionado
- **Hooks globais** em `~/.claude/hooks/cbs-*.mjs` (ESM pela extensão, sem dependências, sem `npx`; nenhum `package.json` em `~/.claude/hooks`, então hooks `.js` CommonJS seus ali continuam funcionando), registrados por merge idempotente no `~/.claude/settings.json` (backup em `settings.json.cbs-backup`; hooks e chaves alheias intactos):
  - `cbs-format.mjs` (PostToolUse `Edit|Write|MultiEdit`): formata só o arquivo editado com pint, `ruff format`, biome ou prettier **do projeto**, quando há ferramenta e config; em silêncio quando não há. Só roda binário que outro usuário local não consegue plantar (dono = você ou root; diretórios não graváveis por outros).
  - `cbs-no-verify.mjs` (PreToolUse `Bash`): bloqueia `--no-verify`, `git commit -n`/`git am -n` e `-c core.hooksPath=…` em commit/push/merge/rebase/am/cherry-pick, fail-closed (texto cru ambíguo bloqueia); não bloqueia os casos comuns de string, echo, `grep`/`gh`, mensagem de commit ou comentário. Escape: `CBS_HOOKS_DESLIGADOS=no-verify`.
  - `cbs-config-protect.mjs` (PreToolUse `Edit|Write|MultiEdit`): bloqueia qualquer mudança em config existente de ESLint, Prettier, Biome, Pint, PHPStan, PHP-CS-Fixer, Ruff, mypy, Stylelint e nas seções `[tool.ruff]`/`[tool.mypy]` do `pyproject.toml` (compara antes/depois; análise que falha ou passa de 3 s bloqueia); criar config nova é permitido. Escape: `CBS_PERMITIR_CONFIG=1`.
  - `cbs-typecheck.mjs` (Stop): tsc, phpstan e mypy/pyright só nas stacks tocadas; bloqueia o fim do turno uma vez com o resumo dos erros; teto de 60 s; nunca grava `*.tsbuildinfo`/cache de build no repo do usuário.
  - Controle por env: `CBS_HOOKS=off` e `CBS_HOOKS_DESLIGADOS=format,typecheck,no-verify,config`.
  - Launcher POSIX `~/.claude/hooks/cbs-node.sh` resolve o `node` mesmo depois de troca de versão no nvm/fnm/volta; launcher ou script ausente → hook não faz nada (nunca quebra a sessão).
  - CLI: `--sem-hooks` em `instalar`/`atualizar` copia os arquivos mas não registra os hooks no `settings.json`. **Não é persistente**: o próximo `atualizar` (ou `/atualizar`) sem a flag registra de novo — pra manter desligado, exporte `CBS_HOOKS=off`. `status` lista os hooks CBS ativos; `remover` tira só as entradas CBS do `settings.json`.
  - `atualizar` e `remover` limpam o legado das builds de desenvolvimento 0.13-dev: entradas `cbs-*.js` no `settings.json` (o `atualizar` troca pelas `.mjs`), os `cbs-*.js` com marcador e o `~/.claude/hooks/package.json` quando é byte a byte o da dev (`{ "type": "module" }`); qualquer outro conteúdo é preservado.
  - Codex: `base/codex/hooks/codex-hooks.json` com os eventos equivalentes (`Bash` e `apply_patch`), declarado no plugin (exige o CBS instalado em `~/.claude`; os hooks só rodam depois de marcados como confiáveis no Codex).
- **AgentShield no gate**: quando o diff (ou o working tree) toca `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json` ou `hooks.json` (todos em qualquer profundidade) ou `hooks/` (só na raiz do repo), o gate roda `agentshield` em modo estático (nunca `--opus`); achado alto ou crítico reprova, sem supressão — corrija a config ou aceite conscientemente. O pacote não depende dele (`npm i -g ecc-agentshield`); ausente ou com erro vira gate parcial.
- `/blindar`: auditoria read-only de `~/.claude`, `~/.codex` e do projeto com o AgentShield; relatório em `docs/analises/<data>-blindar.md`. O relatório inclui achados da sua config global: não commite em repositório público.
- Agente `cbs-build-fixer` e papel `build_fixer` (`codex: backend_terra`): destrava build/typecheck com a menor mudança; o executor o despacha em task BLOCKED por build ou quando o Stop continua falhando.
- Personas: regras duras do ECC em `laravel.md`, `python.md` e `node.md` (com seção "Testes"), todos com "Build quebrado"; seções React e React Native (com "Build quebrado") em `frontend-referencia.md`; sinais de roteamento de React Native.

### Alterado
- **Mudança de comportamento do gate:** gitleaks ausente ou com erro agora **reprova** o gate (antes era "gate parcial"). As demais ferramentas continuam como parcial.
- **`.gitleaks.toml` ausente no HEAD não reprova**: o gate cai pras regras default do gitleaks (sem allowlist; nunca lê a política do working tree) e avisa `✓ gitleaks: sem .gitleaks.toml no HEAD — regras default`. Política presente no HEAD continua sendo a única fonte confiável (o endurecimento abaixo vale sempre).
- Gate endurecido: ambiente git imutável (`GIT_NO_REPLACE_OBJECTS`, `GIT_NO_LAZY_FETCH`) com shim pro gitleaks, fotografia do índice e do working tree, `.gitleaks.toml` lido do HEAD, detecção de `git replace`, kill-switch `.semgrep-desligado` ao lado do script (desliga o semgrep sozinho; não é fail-open do gate).
- Achados históricos revisados do gitleaks saem do código: lista opcional por projeto em `~/.claude/cbs-overrides/gate-achados-revisados.json` (`{ "<caminho absoluto do projeto>": ["<sha256 do achado>"] }`).
- `npm test` roda a suíte inteira (smoke, hooks, merge do settings.json, gate gitleaks, achados revisados, AgentShield).

### Limitações conhecidas
- **Codex:**
  - os hooks só rodam depois de marcados como confiáveis no Codex; sem isso ficam inertes, sem aviso;
  - `apply_patch` rodado pelo shell (chega ao hook como `Bash`) só é coberto pelo `cbs-config-protect`: o Codex não dispara PostToolUse nessa rota, então o `cbs-format` não formata e o `cbs-typecheck` não enxerga essas edições;
  - nessa rota o Codex não informa o diretório: config protegida ou `pyproject.toml` em caminho **relativo** é bloqueada pelo nome, mesmo quando a mudança não afrouxa nada (escape `CBS_PERMITIR_CONFIG=1`, ou use a ferramenta `apply_patch`);
  - patch fora do texto do comando (`apply_patch < arquivo.patch`, `apply_patch "$(cat p)"`) não é inspecionável e passa como Bash comum;
  - o Codex roda o hook com `$SHELL -c`: validado com sh, bash e zsh; fish e nushell não verificados.
- **Windows:** os hooks exigem Git Bash (`sh`); não há caminho nativo `.cmd`/PowerShell. `cbs-format` e `cbs-typecheck` não resolvem shims `.cmd` e ficam em silêncio.
- **Diretório não confiável = no-op silencioso** do `cbs-format` e do `cbs-typecheck`: root num container sobre bind mount de outro dono, WSL em `/mnt/c` (777) e diretórios 777 (ex.: `storage/` do Laravel). A checagem cobre o binário de entrada, não o que ele carrega (`vendor/`, `node_modules/`).
- **Falsos positivos conhecidos** (fail-closed de propósito):
  - `cbs-no-verify`: `xargs -n1 git commit`, `git commit -- --no-verify`, `git log --grep "--no-verify"`, `git -c core.hooksPath=… log` e heredoc cujo texto cita `--no-verify`. Escape: `CBS_HOOKS_DESLIGADOS=no-verify`. Fora do alcance: `git pull --no-verify`, `--config-env=core.hooksPath`, `GIT_CONFIG_*`, `git config core.hooksPath`, `HUSKY=0`, alias (`git ci -n`), `-c core.hooksPath` sem `=` e git chamado sem a palavra `git`.
  - `cbs-config-protect`: comentário ou espaço mudado dentro de `[tool.ruff]`/`[tool.mypy]`; comando Bash que só cita um cabeçalho de patch com nome protegido (ex.: `cat > x.patch <<'EOF' … *** Update File: .eslintrc.json`, ou uma mensagem de commit com esse texto); patch que o hook não consegue aplicar do mesmo jeito que o Codex. Escape: `CBS_PERMITIR_CONFIG=1`.
- **`cbs-typecheck`:** phpstan e mypy recebem os arquivos tocados na linha de comando, o que sobrepõe `paths` do `phpstan.neon` e `files` do mypy; `CLAUDE_PROJECT_DIR` velho ou apontando pra diretório inexistente → nada é checado (não cai pro `cwd` do payload); `tsc` içado na raiz de um monorepo (sem `node_modules/.bin/tsc` no pacote) → sem checagem.
- **AgentShield** não tem supressão de achado: corrija a config ou aceite o REPROVADO conscientemente.
- Pré-existente (desde a 0.12): `~/.claude/scripts/package.json` (`{ "type": "module" }`) faz qualquer `.js` CommonJS seu em `~/.claude/scripts/` falhar no load; o `atualizar` o lista como customização preservada e o `remover` não o apaga.

## [0.12.0] - 2026-09-10

Release guiada por três análises em `cbs-lab/docs/analises/` (auditoria do pacote, histórico de uso de 169 sessões, pesquisa de 45 personas/skills). Requer Superpowers ≥ 6.3.0 e BMAD ≥ 6.12.0.

### Adicionado
- **Modo autônomo**: `/piloto --auto` e `/executar --auto` (ou `auto` como primeira palavra). Um único gate obrigatório antes de `git push`/deploy/merge em main; o executor responde sozinho os menus do BMAD, do brainstorming e do writing-plans. Sem TTY/`CLAUDE_AUTONOMOUS` comporta como `--auto`.
- **Modelo por papel** em `~/.claude/cbs-overrides/models.yml` (10 papéis: orchestrator, architect, implementer_backend, implementer_frontend, refactor, reviewer, final_reviewer, tester, explorer, search), com duas colunas por papel: `claude:` (agente nomeado ou modelo) e `codex:` (nome do agente). Override por argumento `models=papel:valor,...` ou `modelo=opus`. Precedência: argumento > override > default. Sem haiku.
- **9 agentes Claude Code** instalados em `~/.claude/agents/` (`cbs-architect`, `cbs-reviewer`, `cbs-final-reviewer`, `cbs-backend`, `cbs-frontend`, `cbs-refactor`, `cbs-tester`, `cbs-explorer`, `cbs-search`), espelhando os agentes do Codex (`architect_sol`, `reviewer_sol`, `final_reviewer_sol`, `backend_terra`, `frontend_terra`, `refactor_terra`, `tester_luna`, `explorer_luna`, `search_spark`). Override em `cbs-overrides/agents/`.
- **Runtime Claude/Codex**: as skills detectam o runtime e, no Codex, despacham só por nome de agente (nunca passam modelo).
- **Personas de domínio**: `dominios/laravel.md` (Laravel Boost + ECC), `dominios/python.md`, `dominios/node.md` (Express/TypeScript, segurança em primeiro), `dominios/integracao.md` (conectores, HTTP client, webhooks). Roteamento por sinais de arquivo/story, até 2 domínios por task, ordem `@dev → ponytail → linguagem → área`.
- **Lentes de review** em `personas/review/`: `seguranca.md` (sempre no reviewer de qualquer backend; tabelas PHP/Python/Node em `seguranca-referencia.md`) e `cobertura-de-testes.md` (reviewer final). Só reviewers recebem.
- **Gate de segurança** `~/.claude/scripts/gate-seguranca.js` (Node, cross-platform): gitleaks + semgrep com baseline + `composer audit`/`pip-audit` + `ruff --select S`/`npm audit`. Roda antes de DONE/push em task backend; exit 1 bloqueia, ferramenta ausente só avisa.
- `/revisar` vira skill (`revisor`) e gate final automático do `/piloto`/`/executar`.
- `/investigar` estritamente read-only, com seção obrigatória "O que quebra se mudar".
- TDD por tipo de tarefa: `regra-de-negocio` mantém RED-GREEN; `operacional`/`ui` aceitam validação E2E/browser.
- `frontend.md` vira roteador de 2 KB (escolhe uma skill por situação: `frontend-design`, checklist do `ui-ux-pro-max` 2.13, Design Read do taste-skill); conteúdo integral + modos de superfície, piso de craft e checklist do reviewer de UI em `frontend-referencia.md`.
- CLI: `atualizar --projetos a,b`; `status` mostra Superpowers, BMAD por projeto, personas, agentes, `models.yml` e skills de domínio; `test/smoke.js` (13 testes, HOME temporário) em `npm test`.

### Alterado
- Executor alinhado ao `subagent-driven-development` 6.3.0: implementer, task reviewer, re-review, final reviewer, ledger, briefs/reports em `.superpowers/sdd/`, para antes do Finish e chama `finishing-a-development-branch` uma vez; branch `feat/<slug>` quando estiver em main.
- Personas e rulebooks passados **por caminho** (`~/.claude/personas/...`), nunca colados no dispatch. Executor de 23,7 KB para 16,4 KB; tabelas em `referencia/`.
- BMAD 6.12: `bmad-prd`, `bmad-create-epics-and-stories`, `bmad-spec`, `bmad-architecture`; `_bmad/` em todo lugar; instalação com `--directory`, `--action update`, idioma pt-BR.
- Saída no chat de 1 linha por fase; detalhe em `.superpowers/sdd/*-report.md`.
- `/refinar` e `/refinar-auto` viram alias de `/piloto --so-refinar`.
- `remover` usa `bmad-method uninstall` e `superpowers@superpowers-marketplace`.

### Corrigido
- `atualizar` travava sem TTY (readline); agora sem TTY equivale a `--auto-bmad`.
- `instalar-bmad` sem `--directory` saía 0 sem instalar quando não havia TTY.
- `instalar-bmad --force` apagava `_bmad/` mas deixava as skills `bmad-*`.
- `npm test` apontava para arquivo inexistente.

### Removido
- Referências a `@qa`, `@sm`, `.bmad-core/`, `bmad-create-prd`, `bmad-create-architecture`, `install --update`, `superpowers@obra`.
- `haiku` dos valores aceitos.

## [0.11.0] - 2026-07-16

### Mudou — grelhar agora pergunta no seletor interativo do CLI
- **Toda pergunta da `grelhar` vai pela ferramenta `AskUserQuestion`** (seletor interativo), nunca mais como texto corrido. Cada pergunta traz **2 a 4 opções concretas** pra alimentar o debate, com a **recomendação como primeira opção** marcada `(Recomendado)` — e o **tradeoff de cada opção** na descrição (o que ganha × o que custa). O usuário sempre tem "Other" automático pra responder livre.
- **Uma pergunta por chamada, ainda.** A ferramenta aceita até 4 por vez, mas a skill manda **uma** — mandar várias atordoa e impede resolver as dependências da árvore de decisão em ordem.
- **Novas regras de montagem:** `header` curto (máx. 12 chars) pra área da decisão; **proibido opção-espantalho** (toda alternativa precisa ser defensável por alguém sensato); usar `preview` quando a decisão for comparar algo concreto (dois formatos de código, shapes de dado, layouts), que renderiza lado a lado; se o usuário escolher "Other" e abrir premissa nova, **reordenar a árvore** antes de seguir.
- **Fallback preservado:** fora do Claude Code (sem `AskUserQuestion`), a skill cai pro formato texto — uma pergunta por vez, recomendação explícita e alternativas numeradas com tradeoff.
- **Anti-padrões novos:** perguntar em texto corrido tendo o seletor; várias perguntas numa chamada; opção espantalho; pergunta sem tradeoff na descrição.
- **README** e descrição da skill/comando atualizados pra refletir o seletor.

## [0.10.0] - 2026-07-16

### Adicionado — 3 skills adaptadas de mattpocock/skills (agora 6 skills, 11 comandos)
- **`grelhar` (skill) + `/grelhar` (comando)** — interrogatório implacável (grilling): **uma pergunta por vez com resposta recomendada**, descendo a árvore de decisão até entendimento compartilhado. Distingue **fato** (busca sozinha via Explore/Read/Grep) de **decisão** (pergunta ao usuário). Não implementa nem gera prompt — ao fechar, sugere `/refinar`, `/executar` ou `/mapear`.
- **`wayfinder` (skill) + `/mapear` (comando)** — pra trabalho grande demais pra uma sessão só e ainda nebuloso. Cartografa um **mapa de decisões** em `docs/mapas/<slug>.md` (adaptado do issue tracker do original pra markdown local) e resolve **tickets** (pesquisa/protótipo/grelhar/tarefa) um a um, com "névoa de guerra", fronteira, HITL×AFK e "uma decisão por sessão". Evolução do `/investigar`; planeja **decisões, não deliverables**; proíbe editar código de aplicação.
- **`handoff` (skill) + `/handoff` (comando)** — compacta a conversa num **documento de continuação** pra outro agente/sessão retomar sem reler o histórico. **Referencia** artefatos (specs/planos/commits/diffs) por caminho em vez de duplicar, **redige** segredos (API keys, senhas, PII) e inclui seção "Skills sugeridas". Salva em `docs/handoffs/` (se houver `docs/`) ou no diretório temporário do SO.

### Mudou — grelhar entra no pipeline do `/piloto`
- **`/piloto` agora é `grelhar` → `refinar` → OK → `executar`.** Nova **Etapa 1 (Grelhar)** roda o interrogatório antes de refinar, pra afiar as decisões antes de gastar tokens gerando o prompt. A grelha se auto-escala (ideia trivial fecha em 1-2 perguntas; grande destrincha vários galhos) e, se o escopo for grande demais, oferece `/mapear`. A **Etapa 2 (Refinar)** recebe as decisões fechadas e o "Alinhamento" da refinador vira **confirmação rápida** — sem reabrir as mesmas perguntas. Etapas renumeradas (executar virou Etapa 4).
- **`refinador-de-prompt`:** nota na Fase 4 (Gap analysis) pra **escalar pro `grelhar`** quando as dúvidas bloqueantes forem muitas e interdependentes (árvore, não lista) — vale pro `/refinar` standalone.
- **README:** contagem "6 skills e 11 comandos"; tabela "Como usar" com `/mapear`, `/grelhar`, `/handoff`; diagrama do pipeline com os 3 novos fluxos e o `/piloto` incluindo grelhar; seção "As 6 skills" com os 3 novos verbetes.

### Distribuição
- Zero mudança de CLI — o `instalar`/`atualizar` já copia `base/skills/` e `base/commands/` recursivamente, então as 3 skills e os 3 comandos são distribuídos e cobertos pelo fluxo de override automaticamente. Mensagens de ajuda do instalador atualizadas.

## [0.9.0] - 2026-07-02

### Adicionado — Gate de modelo na execução
- **Novo gate na Fase 4 do executor:** junto do "Posso implementar? [s/N]", o executor pergunta em qual modelo rodar os subagents de execução — **atual** ou **sonnet** (duas opções só).
  - **atual** (padrão): sem override — a skill `superpowers:subagent-driven-development` segue o tiering próprio dela (mecânico → barato, julgamento → padrão, review final → mais capaz) a partir do modelo da sessão.
  - **sonnet**: o executor injeta uma restrição global e a skill dispara **todos** os implementer/reviewer subagents em `model: sonnet` (bom pra padronizar/economizar em feature grande ou mecânica).
- **Base do mecanismo:** a `subagent-driven-development` (v6.1.0) lê as restrições globais antes de disparar e especifica o modelo explicitamente em cada subagent — então o gate é enforçável por-subagent, não só no nível de sessão. Modo `--auto` assume `s` + modelo **atual**.

### Mudou
- **Fase 5 do executor:** novo passo 6.1 que repassa a escolha do gate como restrição global pro Superpowers (e ao fallback manual). **README:** diagrama do pipeline cita o gate de modelo + nova subseção "Gate de modelo (atual ou sonnet)".

## [0.8.0] - 2026-07-02

### Adicionado — Rulebook transversal ponytail (anti-over-engineering)
- **Novo rulebook `base/personas/ponytail.md`.** Diferente dos rulebooks de domínio (frontend/database, que são **por-task**), o ponytail é **transversal** — injetado no prompt de **todo** subagent implementer/reviewer, em qualquer task. Importa a filosofia [ponytail](https://github.com/DietrichGebert/ponytail) ("lazy senior developer"): entender o problema por completo e **depois** subir uma escada de decisão de 7 degraus (existe? já no codebase? stdlib? nativo? dep instalada? 1 linha? só então build) pra escrever o mínimo.
- **Piso de segurança inegociável:** ponytail corta código desnecessário, **jamais** validação, tratamento de erro, segurança, acessibilidade ou teste. Inclui níveis (`lite`/`full`/`ultra`/`off`, padrão `full`) e checklist de over-engineering pro reviewer.
- **Nova seção "Orquestração: teammate vs ultracode"** no executor e no README: guia conceitual de quando escalar a orquestração pra **teammate** (subagent persistente e endereçável via `SendMessage`) ou **ultracode** (Workflow multi-agente determinístico), sem trocar o motor `subagent-driven-development`.

### Mudou
- **Executor:** novo princípio não-negociável ("Menor superfície (ponytail)"). **Fase 5** injeta o `ponytail.md` completo (incondicional) em todo implementer, empilhado `@dev` → ponytail → domínio; caminho com precedência de override (`cbs-overrides` → base), igual aos domínios. **Fase 6** injeta o ponytail no code review pra sinalizar over-engineering sem afrouxar o piso de segurança.
- **README:** nova camada "Anti-over-engineering (sempre, transversal)" na tabela; seção "Ponytail: menos código, mesma segurança"; ponytail citado no diagrama do pipeline.
- **Distribuição:** zero mudança de CLI — o `instalar`/`atualizar` já copia `base/personas/` recursivamente, então o `ponytail.md` é distribuído e coberto pelo fluxo de override automaticamente.

## [0.7.0] - 2026-06-08

### Adicionado — Rulebook de domínio database
- **Novo rulebook `base/personas/dominios/database.md`.** Segundo domínio com expertise própria (depois do frontend), empilhado em cima do `@dev` BMAD. Diferente do frontend, **não há skill oficial** a invocar — a expertise (DBA sênior + SQL pro) está destilada no próprio rulebook, self-contained.
- **Cobre** (task de feature, não DBA-ops): detecção de schema/ORM/migration antes de qualquer DDL; modo dual (seguir padrão existente × greenfield); regras inegociáveis (migration reversível, queries parametrizadas, índice em FK, sem N+1, sem `SELECT *`, dinheiro em `numeric`, transação atômica, filtro de tenant); loop de validação (up/down + EXPLAIN + isolamento de tenant).
- **Apêndices de profundidade (estilo enciclopédico):** especificidades por RDBMS (PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, SQLite); NoSQL (MongoDB, Redis); PK uuid×autoincremento (incl. uuidv7/ULID); leitura de plano de execução (EXPLAIN); migrations zero-downtime (expand→migrate→contract); padrões de query avançados (CTEs, window functions, keyset pagination); data warehousing (star schema, SCD); guia por ORM (Prisma, TypeORM, SQLAlchemy/Alembic, Django, ActiveRecord, GORM).

### Mudou
- **Fase 3 do executor** agora classifica tasks também como **database** (sinais: `migrations/`, `prisma/schema.prisma`, `db/migrate/`, `alembic/`, `.sql`, models/repositories; menção a tabela/coluna/query/índice/migração/schema).
- **Fase 5 do executor** carrega `database.md` e injeta o conteúdo completo no prompt do implementer **e** do code quality reviewer (QA de banco: índices, plano de execução, rollback, isolamento de tenant). Como não há skill oficial, a instrução é seguir o rulebook destilado literalmente.
- **README** atualizado: seção "Database (implementado nesta versão)" e heading dos rulebooks agora lista frontend + database.

## [0.6.0] - 2026-06-02

### Adicionado — Rulebook de domínio frontend
- **Nova camada `personas/dominios/` no pacote.** Em cima do `@dev` BMAD (que já é injetado em todo subagent `general-purpose` desde a v0.4.3), o executor agora empilha um **rulebook específico de domínio** quando a task pertence ao domínio. Mesmo padrão persona-as-instructions — o `subagent_type` continua SEMPRE `general-purpose`. Nesta versão, **só frontend** está implementado; tasks de outros domínios seguem só com `@dev` puro (comportamento herdado).
- **Fase 3 agora classifica cada task como frontend ou não.** A marcação alimenta a Fase 5.
- **Fase 5 carrega o rulebook do domínio** de `~/.claude/cbs-overrides/personas/dominios/<dominio>.md` (se existir) ou `~/.claude/personas/dominios/<dominio>.md` e cola o conteúdo completo no prompt do implementer subagent.

### Frontend rulebook (`base/personas/dominios/frontend.md`)
- **Skill oficial `frontend-design`** (plugin `claude-plugins-official`) é obrigatória — instruída explicitamente no prompt do implementer ANTES de codar UI. Sem ela, a saída cai em "AI slop".
- **Modo dual — não impõe estética sempre.** Passo 1: detectar o design system existente do projeto (Tailwind config / theme / componentes / Storybook / motion / tema). Passo 2A: **se existe padrão**, segui-lo rigorosamente (reusa primitivos, mantém tipografia, motion, escala de espaçamento; `frontend-design` entra como checklist técnico de estados/hierarquia/qualidade, NÃO como licença pra "redesenhar bold"). Passo 2B: **só quando não há padrão**, comita a uma direção estética distinta via `frontend-design` e estabelece tokens já em config.
- **Anti-IA-genérico vale nos dois modos**: sem lorem ipsum, sem emoji como ícone, estados completos obrigatórios (loading/empty/error/foco/disabled), acessibilidade AA, hierarquia tipográfica deliberada, copy alinhada ao i18n do projeto.
- **Padronização de CSS / nomenclatura — DRY de estilo**: token > literal (hex hardcoded só com justificativa); 3+ repetições de classes → extrair (cn/cva/utility/componente); naming consistente (kebab-case CSS modules, BEM se o projeto é BEM, data-attributes Radix-style); um conceito = um nome (não introduzir sinônimos); não duplicar tokens em arquivos diferentes; animação e breakpoints têm nome também. Varredura final do diff antes de fechar a story.
- **Loop de validação visual obrigatório**: dev server up + golden path + 2 estados + dark mode + teclado + mobile breakpoint, anotados no Dev Agent Record. Se ambiente headless, declarar explicitamente "não validado visualmente".

### Mudou
- **CLI**: `instalar`, `atualizar` e `remover` agora tratam `base/personas/` (copia pra `~/.claude/personas/`, preserva customizações em `~/.claude/cbs-overrides/personas/`, remove apenas arquivos com marcador).
- **`caminhos.js`**: novo constant `DIR_PERSONAS` (`~/.claude/personas/`).
- **README** atualizado com seção sobre rulebooks de domínio e como sobrescrever.

## [0.5.1] - 2026-05-25

### Corrigido (consistência de docs)
- **INSTALL.md** atualizado: 7 → **8 commands**; marcador descrito como rodapé (não header); passo do Superpowers agora diz "detecta e mostra o comando" (não "instala via CLI"); `.bmad-core/` → `_bmad/` e BMAD marcado como requisito do `/executar`.
- **Comando do Superpowers padronizado** em todos os docs: `/plugin marketplace add obra/superpowers-marketplace` + `/plugin install superpowers@superpowers-marketplace` (antes o INSTALL.md tinha `superpowers@obra`, que não bate com o nome real do marketplace).
- **README**: passo 2 da instalação não promete mais "instala" o plugin — diz "detecta e mostra o comando exato" (plugins não instalam via CLI fora do app).
- **Descrição do pacote (package.json) e do repo GitHub** atualizadas: removido "BMAD opcional"; agora "Superpowers (motor) + BMAD (disciplina) integrados".

## [0.5.0] - 2026-05-25

### Mudança de arquitetura — BMAD + Superpowers SEMPRE juntos
- **Revertido o opt-in da v0.4.0.** Decisão do usuário: BMAD e Superpowers passam a rodar **sempre em conjunto, em camadas**, sem flag pra desligar. Superpowers é o **motor** (subagents isolados por task, TDD, 2 reviewers, contexto limpo); BMAD é a **disciplina** (gera as stories no planejamento e suas personas `@dev`/`@qa`/review são injetadas em cada subagent `general-purpose`). Nenhum dos dois roda "puro".
- **Fase 3 sempre BMAD primeiro:** `bmad-create-prd` (se houver produto/arquitetura) + `bmad-create-story`/`epics-and-stories` → `superpowers:writing-plans` converte em plano. Mesmo caso pequeno gera ao menos 1 story (rastreabilidade story↔código↔teste).
- **Detecção inicial:** BMAD vira requisito — sem BMAD, o executor para e oferece `/instalar-bmad`; só simula as personas se o usuário recusar.
- **Removido `--bmad`** como opt-in dos comandos `executar.md`/`piloto.md` e da skill (agora é o comportamento padrão).
- README repositionado: BMAD deixa de ser "opcional" e passa a "sempre em conjunto com Superpowers".

### Adicionado
- **Novo comando `/revisar`** (8º comando): revisa tudo que foi feito (mudanças da branch / working tree) com code review + QA + security, delegando a subagents `general-purpose` com as personas BMAD injetadas (`bmad-code-review`, `@qa`/TEA). Read-only por padrão — emite relatório com achados por severidade e veredito de merge, e só corrige (via `subagent-driven-development`) com OK do usuário.

## [0.4.3] - 2026-05-25

### Adicionado
- **Personas BMAD estendidas a TODOS os subagents `general-purpose`** (antes só o implementer). No caminho `--bmad`, cada subagent continua sendo `general-purpose` (regra rígida mantida — nunca dispachar `@dev`/`@qa`/`bmad-agent-*`/`code-reviewer`/`qa-expert` como tipo de agente), mas o prompt injeta as convenções do agente BMAD correspondente ao papel:
  - **Implementer** → Dev agent (`@dev`)
  - **Spec reviewer** → review do BMAD (conferir contra critérios de aceite e tasks da story)
  - **Code quality reviewer** + **QA da Fase 6** → QA/Test agent (`@qa`/TEA: test design, testes baseados em risco, rastreabilidade)
  - **Code review da Fase 6** → review do BMAD (`bmad-code-review`)
  - **Security** → sem equivalente no BMAD; segue `general-purpose` + checklist.
- Fase 6 ganhou regra de subagent explícita (igual à Fase 5): tudo roda em `general-purpose`, nunca em agente de domínio/plugin.

## [0.4.2] - 2026-05-25

### Adicionado
- **Disciplina do Dev agent do BMAD (`@dev`) dentro do implementer `general-purpose`** — só no caminho `--bmad` (quando há story files BMAD). O `subagent_type` continua `general-purpose` (a regra rígida da v0.4.1 é mantida — nunca dispachar `@dev`/`bmad-agent-dev` como tipo de agente), mas o prompt de cada implementer passa a injetar as convenções do `@dev`: implementar tasks/subtasks da story em ordem com checkboxes, TDD por task, atualizar File List + Dev Agent Record, validar critérios de aceite e marcar status → Ready for Review. Junta o isolamento + TDD + 2 reviewers do `general-purpose` com a disciplina de story do BMAD. Fora do `--bmad`, o implementer segue só o plano do `writing-plans`.

## [0.4.1] - 2026-05-25

### Corrigido
- **Implementer subagent agora é fixado em `general-purpose`.** Sessão real mostrou o executor delegando a `superpowers:subagent-driven-development`, que chutou um nome de agente especialista (`backend-developer`) — inexistente — e caiu no vizinho mais próximo da lista de plugins instalados (`voltagent-core-dev:backend-developer`). Esses agentes de domínio/plugin trazem system prompt e agenda próprios, toolset limitado e fogem do plano/TDD entregue, quebrando a garantia de qualidade. Fase 5 da `executor-bmad-superpowers` agora tem regra rígida: implementer SEMPRE `general-purpose`, nunca `voltagent-*`/`*-pro`/`*-specialist`/`*-expert`; se um nome de especialista não existir, usar `general-purpose` em vez de buscar o match mais parecido.

## [0.4.0] - 2026-05-24

### Reposicionamento (decisão de arquitetura)
- **Superpowers vira a espinha dorsal da execução; BMAD vira opt-in.** Validado por sessão real (`f992fd4b`): a delegação ao `subagent-driven-development` funciona (implementer subagent assume a implementação, contexto principal limpo). Conclusão: empilhar refinador + BMAD-story + writing-plans era cerimônia redundante pra feature única.
- **Fase 3 do executor**: default agora é só `superpowers:writing-plans` (o prompt refinado já é spec). BMAD (`bmad-create-prd`/`create-story`) só entra opt-in — feature grande/multi-story ou flag `--bmad`.
- **BMAD reposicionado** pra camada de discovery/planejamento de produto (`/investigar`, features grandes), fora do caminho de execução de feature única.
- README reescrito deixando claro: front-end PT-BR (refinar+memória) é o diferencial, Superpowers é o motor de qualidade, BMAD é planejamento de produto opcional.
- `executar.md`/`piloto.md`: documentam `--bmad` como opt-in.

## [0.3.0] - 2026-05-24

### Mudança de arquitetura
- **Executor agora DELEGA ao Superpowers real em vez de reimplementar.** Diagnóstico (sessões `bcf5870f`/`609f0c5d`/`89756461`): o executor descrevia brainstorming/TDD/subagent na própria SKILL.md e o modelo fazia tudo inline no contexto principal — os subagents quase não disparavam e o contexto poluía. Pesquisa na fonte primária (Superpowers v5.1.0) mostrou que `subagent-driven-development` mantém o contexto principal só como orquestrador e despacha implementer + 2 reviewers por task.
- **Fase 3 (Planejamento):** BMAD gera spec/stories → `superpowers:writing-plans` converte em plano executável com tasks discretas.
- **Fase 5 (Execução):** agora **delega a `superpowers:subagent-driven-development`** — implementer subagent isolado por task + spec reviewer + code quality reviewer. O contexto principal só orquestra. Fallback pra TDD manual se Superpowers ausente.
- **Sem worktree:** instrução explícita pra trabalhar na branch atual (não invocar `using-git-worktrees`), conforme preferência do usuário.
- Removida a prosa que reimplementava RED-GREEN e regras de subagent inline (agora vêm das skills reais).
- `executar.md` e `piloto.md` ajustados pra refletir a delegação.

## [0.2.10] - 2026-05-24

### Alterado
- **Removida a seção "Versão curta para colar"** do `refinador-de-prompt`. O prompt premium completo já é o entregável; a versão curta era redundante. Agora são 4 seções (Diagnóstico, Contexto usado, Dúvidas, Prompt final premium) em vez de 5.

## [0.2.9] - 2026-05-24

### Corrigido
- **Executor agora invoca as skills Superpowers/BMAD formais**, não só aplica o método. Análise da sessão `bcf5870f` mostrou TDD real mas sem invocar `superpowers:test-driven-development`, e plano sem invocar agentes/skills BMAD. Mudanças:
  - Fase 2 → invoca `superpowers:brainstorming`
  - Fase 3 → invoca skills BMAD reais (`bmad-create-prd`, `bmad-create-architecture`, `bmad-create-story`, ou agentes `bmad-agent-*`), escalando pelo tamanho da tarefa
  - Fase 5 → invoca `superpowers:test-driven-development` (+ `systematic-debugging` se travar)
  - Fase 6 → invoca `superpowers:requesting-code-review`
  - Fase 7 → invoca `superpowers:verification-before-completion` antes de declarar pronto
- **Fase 4 virou PONTO DE PARADA HARD**: executor agora termina a mensagem com "Posso implementar? [s/N]" e espera resposta antes de tocar em código. Antes emitia o cabeçalho mas seguia direto codando.

## [0.2.8] - 2026-05-24

### Corrigido
- **`mem-search` agora é obrigatório em primeiro lugar**, sem julgamento. Análise da sessão `5954fb4b` mostrou 0/3 invocações de claude-mem mesmo com a v0.2.5 mandando. Reforço em duas camadas:
  - **Nos 5 slash commands**: ordem numerada explícita — "1. PRIMEIRO invoque Skill mem-search. 2. SÓ DEPOIS invoque a skill principal."
  - **No topo das 3 SKILL.md**: novo bloco "⚠️ PRIMEIRA AÇÃO — SEMPRE consultar memória persistente" antes do bloco de formato obrigatório.
- Espera-se agora que `mem-search` apareça como primeira tool call em cada slash command.

## [0.2.7] - 2026-05-24

### Adicionado
- **Fase 5 — Alinhamento prévio** no `refinador-de-prompt`: ANTES de gerar o prompt premium, skill agora emite um resumo curto (`## Alinhamento` com "Entendi" + "Decisões que precisam de OK seu" + "Tradeoffs") e **PARA**, esperando o usuário confirmar. Usuário decide tudo ANTES do prompt — não vê suposições enterradas só depois.
- Loop de iteração que era Fase 6 virou Fase 7. Pra ajustar antes do prompt, basta dizer o que mudar na fase de alinhamento. Pra ajustar depois, mesma coisa via loop final.
- `/refinar-auto` continua pulando a Fase 5 (assume tudo e vai direto — esse é o propósito do auto).

## [0.2.6] - 2026-05-24

### Adicionado
- **Loop de iteração no `/refinar`** (Fase 6 do `refinador-de-prompt`): depois de emitir o prompt, skill SEMPRE pergunta "Quer ajustar algo? `ok` pra fechar ou diga o que mudar". Permite co-decidir sem rodar `/refinar` do zero várias vezes. Aceita `ok`/`pode`/`tá bom`/`fechado` como sinal de fim. Qualquer outro texto = ajuste → re-emite formato completo.
- `/piloto` ajustado pra esperar o `ok` do loop do refinador antes de perguntar "executar agora?".

## [0.2.5] - 2026-05-24

### Adicionado
- **Integração explícita com claude-mem** nas 3 skills. Antes era genérico ("se houver memória, consulte"); agora é imperativo com nomes específicos: `mem-search`, `claude-mem:mem-search`, `claude-mem:smart-explore`, `claude-mem:knowledge-agent`, MCP tools `*memory_search*` etc. Se nenhuma aparecer disponível, marca "Memória: nada encontrado" e segue. Antes o LLM ignorava o claude-mem mesmo instalado.

## [0.2.4] - 2026-05-24

### Corrigido
- **Slash commands agora FORÇAM invocação da Skill tool**. Texto antigo "Invoque a skill X" era ambíguo — o LLM lia como "trabalhe nessa pegada" e improvisava sem chamar o Skill tool. Novo texto: "AÇÃO OBRIGATÓRIA AGORA: invoque a ferramenta `Skill` com `skill: \"<nome>\"` antes de qualquer outra coisa". Validado em análise de JSONL: sessões antigas tinham 0 Skill tool calls; agora deve ter ≥1 por slash command.

## [0.2.3] - 2026-05-24

### Corrigido
- **Skills agora seguem formato rígido sempre**, independente do tamanho da tarefa. Adicionada seção `## ⚠️ FORMATO OBRIGATÓRIO` no topo de cada SKILL.md:
  - `refinador-de-prompt`: sempre emite Diagnóstico/Contexto/Dúvidas/Prompt final/Versão curta — mesmo se recomendar "não faça"
  - `investigador-de-ideia`: sempre as 6 fases com cabeçalho explícito
  - `executor-bmad-superpowers`: sempre as 7 fases com cabeçalho + 8 seções fixas na entrega
- Antes, em casos pequenos, as skills adaptavam pra resposta livre — útil mas não auditável. Agora estrutura é fixa, conteúdo se adapta.

## [0.2.2] - 2026-05-24

### Corrigido
- **BMAD install agora 100% não-interativo no caminho feliz**: passa `--modules bmm,core` explicitamente, fixando os módulos oficiais. Isso pula a tela de seleção de módulos E a pergunta sobre custom/community modules (que aparecia mesmo com `--yes`).

## [0.2.1] - 2026-05-24

### Corrigido
- **Detecção do Superpowers** agora lê `~/.claude/plugins/installed_plugins.json` em vez de tentar `claude /plugin list` (que não funciona fora do app). Detecta de verdade.
- **Instalação do Superpowers** não tenta mais via CLI (não funciona pra plugins). Mostra instruções claras: `/plugin marketplace add obra/superpowers-marketplace` + `/plugin install superpowers@superpowers-marketplace`.
- **BMAD install nunca mais cai em Quick Update**: passa `--action install` (ou `update`, dependendo do que o usuário escolher) explicitamente. Antes o BMAD entrava em `quick-update` quando detectava instalação prévia, ignorando `--tools claude-code` (resultando em "No IDE selected").
- **`instalar-bmad` agora pergunta** quando BMAD já existe: reinstalar do zero / update / pular. Flags `--force` e `--update` pra modo não-interativo.

## [0.2.0] - 2026-05-24

### Adicionado
- **`instalar` agora instala TUDO de uma vez**: skills/commands (global) + plugin Superpowers + BMAD no diretório atual. Um único comando (`npx claude-bmad-superpowers instalar`) cobre todo o setup. Flags: `--apenas-global` / `--skip-bmad` / `--skip-superpowers`.
- **Novo subcomando `instalar-bmad`** na CLI: `npx claude-bmad-superpowers instalar-bmad` roda o instalador interativo do BMAD no terminal do usuário (TTY real) e registra o projeto automaticamente. O slash command `/instalar-bmad` foi atualizado pra delegar nele via `!` prefix.
- **Self-update do pacote** no `atualizar`: detecta modo de instalação (git clone vs npm) e faz `git pull --ff-only` ou re-exec via `npx claude-bmad-superpowers@latest`.
- **Update real do BMAD nos projetos registrados**: itera `~/.claude/cbs-overrides/.projetos-bmad` e roda `npx bmad-method install --action update --tools claude-code` em cada um (com modos `todos`, `selecionar` ou flag `--auto-bmad`).
- Flags novas no `atualizar`: `--skip-self-update`, `--skip-bmad`, `--auto-bmad` / `-y`.
- Limpeza automática de projetos inválidos (diretórios removidos) do registro.

### Alterado
- `atualizar` agora roda em 4 etapas explícitas (self-update → base → Superpowers → BMAD), com cabeçalhos visíveis na saída.

## [0.1.0] - 2026-05-24

### Adicionado
- CLI Node cross-platform (`claude-bmad-superpowers` / `cbs`) com subcomandos `instalar`, `atualizar`, `remover`, `status`.
- 3 skills: `refinador-de-prompt`, `investigador-de-ideia`, `executor-bmad-superpowers`.
- 7 commands: `/refinar`, `/refinar-auto`, `/investigar`, `/executar`, `/piloto`, `/instalar-bmad`, `/atualizar`.
- Modelo de camadas (base read-only + overrides) para preservar customizações no update.
- Instalação automática do plugin Superpowers via marketplace do Claude Code.
- Detecção e instalação per-project do BMAD-METHOD.
