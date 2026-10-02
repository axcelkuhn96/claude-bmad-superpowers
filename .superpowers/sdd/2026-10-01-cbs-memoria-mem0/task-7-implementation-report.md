# Task 7 — instalador Qdrant e operação, execução em fixture isolada

**Estado:** implementação operacional local pronta para review; **liberação de Mem0 bloqueada** pelos gates prospectivos/hardware abaixo. Checkout `feat/cbs-memoria`, base da Task7 `a4a7853`. Produto não foi publicado, enviado, implantado no servidor do usuário ou ativado em Windows.

## Arquivos exclusivos da Task7

| Arquivo | Mudança | SHA-256 após aplicação |
|---|---|---|
| `base/memoria/deploy/install-qdrant.sh` | Instalador Linux de Qdrant pinado, persistente, privado/autenticado, idempotente e com rotação explícita. | `f93e94df9a6c28dc60a30c5445a81b6a5bcaa99fcfdcb07292c4032c8f8a7180` |
| `test/memoria-qdrant-install.sh` | Smoke sem Docker real, com fake na fronteira Docker para entradas inseguras, posse/drift, rerun, rotação, TLS e segredo. | `2116fd256eca634c8e89584371dd3c291cca8e7082dede0fda2a74773c1b4826` |
| `test/memoria-windows-validation.ps1` | Diagnóstico Windows com JSON por controle; mantém `BLOCKED_UNSUPPORTED`, sem ativar Mem0 ou editar configuração real. | `e4c827de396b0cfaac5ba920241b08ebe0526775928532fcd3eb42ee4e3ba839` |
| `/home/axcel/cbs-lab/docs/operacao/qdrant-memoria.md` | Guia de instalação, coleção cliente, auth/TLS, backup, restore, rotação e rollback. | `30c4cdf7bccbcfa977a9118aa8fc74c8ddb7322179152cc4d4618ffd4126f2df` |
| `/home/axcel/cbs-lab/docs/analises/2026-10-01-memoria-mem0-aceite.md` | Parecer `BLOCKED` com evidência operacional e gates pendentes, sem percentual inflado. | `a7e833f134eafcf43b649dc7bbcd11af61ddeaa3fa6eaca8e8dd389233d04564` |

## RED → GREEN e verificação aplicada

- RED inicial do shell smoke isolado: script ausente, exit 1 em `QDRANT_API_KEY_FILE`/arquivo de instalador; RED adicional para IP privado sem TLS retornou `FAIL private bind needs TLS before Docker: status=0 ... docker calls=0->3`, capturando a exposição. GREEN no produto: `bash test/memoria-qdrant-install.sh` → exit 0, `PASS invalid inputs before Docker, foreign/drift refusal, idempotence, rotation, TLS, secret isolation`.
- `bash -n base/memoria/deploy/install-qdrant.sh test/memoria-qdrant-install.sh` → exit 0. Parser PowerShell para `test/memoria-windows-validation.ps1` → 0 erros; no Linux, o script retornou exit 2 e JSON `UNSUPPORTED_PLATFORM`, corretamente sem alegar prova nativa.
- `npm test` após aplicação, sem mudanças de core simultâneas: exit 0, **654 testes / 20 suites / 0 falhas / 0 skipped**, duração `38024 ms`. Não houve rerun opcional da suíte após esse verde.
- `node /home/axcel/.claude/scripts/gate-seguranca.js`: exit 0, Gitleaks 0 segredos; **gate parcial** porque Semgrep está desligado pelo usuário e npm audit não rodou (sem lockfile/rede/instalação conforme saída). Resultado literal: `GATE: APROVADO COM RESSALVAS`.
- `git diff --check` → exit 0. Nenhum `shellcheck` instalado.

## Docker real pré-aplicação do mesmo módulo

GO restrito permitiu fixture Docker apenas em `/tmp/cbs-m0-07-installer-20261002`, antes da cópia byte-idêntica do instalador ao produto. A imagem local `amd64` confirmou label `v1.19.1` e RepoDigest `qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10`. Execução `python3 /tmp/cbs-m0-07-installer-20261002/docker-smoke.py` terminou exit 0:

1. Bootstrap como UID:GID `1000:1000`, config dono local/modo `0600`, storage privado. Segredo ausente do `docker inspect`, Docker logs, argv e stdout observados. `/readyz` retornou 200; chamada anônima a `/collections` foi negada; autenticada, aceita.
2. Coleção de 384 dimensões recebeu pontos `1001` (`active`) e `1002` (`superseded`) com payloads e vetores. Rerun do instalador preservou **mesmo ID de container e mesmos pontos**; restart também preservou.
3. Snapshot full baixado: `162816` bytes, SHA-256 `168b76e0abe96c8f581b1fea6789c9d1f79b2be9a22b79957cbd461a633e124e`; cópia conferida. Restore `--storage-snapshot` em instância limpa própria recuperou IDs, vetores, payloads e estados; hash canônico pré/pós `ab59bc8bc2e860fdd66c2d256c862daaa613ced657bb652a82ad576d89020eb2`.
4. Troca de chave sem `QDRANT_ROTATE_KEY=1` foi recusada; rotação explícita do container próprio rejeitou chave antiga, aceitou a nova e reteve pontos. Container primário e restore foram removidos somente após checagem de ID/labels/data-dir; arquivos privados removidos.

`python3 /tmp/cbs-m0-07-installer-20261002/docker-tls-smoke.py` terminou exit 0 em IP privado local `172.17.0.1`, com TLS nativo e certificado SAN verificado por CA explícita; anônimo `401`, autenticado `200`. Container próprio removido após checagem de identidade. Nenhum container preexistente/desconhecido foi removido.

Uma amostra `docker stats --no-stream` do serviço primário após o smoke: CPU `0.21%`, RAM `110.7MiB / 30.65GiB`, NetIO `9.29kB / 14.3kB`, BlockIO `36.9kB / 4.1kB`; storage `419698094` bytes, snapshot no servidor `162944` bytes. Esses números não são pico, p50/p95, carga de duas máquinas ou sizing. Evidência serializada em `/tmp/cbs-m0-07-installer-20261002/docker-smoke-result.json` e `docker-tls-result.json`.

## Contrato do instalador

`QDRANT_API_KEY_FILE` aponta arquivo regular existente, absoluto, proprietário local, `0600`, sem symlink/hardlink e fora de Git. `QDRANT_DATA_DIR` é diretório absoluto/canônico, privado `0700`, dono local e vazio no bootstrap; storage/snapshots são bind mounts persistentes. `QDRANT_BIND_IP` recusa 0.0.0.0/:: e IP público; IP privado exige cert/key nativos em arquivos privados, enquanto loopback HTTP autenticado serve ao túnel local. O script gera YAML privado `0600` com segredo e monta só leitura; não usa `QDRANT__SERVICE__API_KEY` nem `_FILE` inexistente. Container fixo `cbs-mem0-qdrant`, digest pinado, porta 6333, restart `unless-stopped`, `--workdir /qdrant/storage` e `--entrypoint /qdrant/qdrant`. Não para nem remove container desconhecido, não atualiza imagem silenciosamente e não apaga dados. Rerun com mudança de chave/config exige rotação explícita e valida propriedade antes de parar somente o container CBS.

Qdrant aceita [`--config-path`](https://qdrant.tech/documentation/ops-configuration/configuration/), recomenda [API key, bind e TLS](https://qdrant.tech/documentation/security/) e documenta [snapshot full/restauração inicial/compatibilidade minor](https://qdrant.tech/documentation/operations/snapshots/). O servidor armazena somente Qdrant; SDK, CLI e E5 permanecem locais. A chave admin ampla não consegue impor um escritor por projeto; o guia exige escritor designado e transferência quiescente.

## Limites e parecer

- O PowerShell agora produz controles separados para NTFS/owner SID/DACL, aliases Git, guards de produção, lock/crash de filhos **próprios**, paths/versões de runtime existente e E5 CPU/DirectML opcionais sem downloads. Ele mantém `BLOCKED_UNSUPPORTED`, não altera configurações reais de Claude/Codex, não sinaliza processos do usuário e marca hooks, trust, outbox/replay, duas máquinas e ativação Windows como `unsupported`/`unproved`. Só parser/Linux guard foram executados aqui; não há prova Windows nativa. Diagnóstico futuro nessa máquina não equivale a suporte de produção.
- O teste Docker isolado não prova servidor final, rede/firewall/certificado real, rootless/SELinux, duas máquinas, isolamento entre projetos ou E2E de cliente. Permissões/UID/arquivo hardlink foram verificadas na fixture; filesystem POSIX persistente do futuro host precisa ser escolhido/checado pelo operador. A configuração do provider em `a4a7853` já permite HTTP estrito em `127.0.0.1` e HTTPS privada; não houve mudança de core nesta task.
- Aceite humano prospectivo continua **zero casos novos congelados com respostas e revisão**, e duas máquinas/Windows reais indisponíveis. Benchmark retrospectivo de cinco perguntas é diagnóstico. A captura p95 `≤250 ms` falhou anteriormente na segunda rodada fixa (Codex `251,229 ms`). Faltam p50/p95 e picos por componente de cliente/servidor, chamadas/tokens/custo Sol/Sonnet, rollback real do opt-in em sessão nova e review final. Portanto, **não recomendar opt-in, publicação automática, sizing 4/8 GB ou liberação Windows**. Erro futuro crítico de identidade, autoria, tempo, precedência humana ou projeto bloqueia o gate mesmo se persistência passar.

### Ponytail

Reusei Bash/Python stdlib/Docker CLI; não adicionei dependência npm, daemon, API Mem0 ou banco extra. As validações novas são o mínimo necessário para a borda de segurança do instalador. Nível: full.
