---
name: wayfinder
description: Use esta skill quando a ideia for grande demais pra uma sessão só e ainda estiver envolta em névoa — o caminho até o destino não está visível. Planeja o trabalho como um MAPA de decisões (arquivo markdown em docs/) e resolve os "tickets de decisão" um a um até o caminho ficar claro. Evolução do /investigar pra escopos grandes. Planeja decisões, não entrega deliverables.
---

# Wayfinder — cartografar o caminho

Chegou uma ideia grande, envolta em **névoa**: o caminho daqui até o **destino** ainda não está visível. Wayfinding é sobre **achar o caminho**, não sobre correr pro destino. Esta skill desenha o caminho como um **mapa compartilhado** (um arquivo markdown no projeto) e trabalha seus **tickets de decisão** — perguntas cuja resolução é uma **decisão**, não fatias de build pra executar — um de cada vez, até a rota ficar clara.

Adaptado do padrão `wayfinder` de [mattpocock/skills](https://github.com/mattpocock/skills). Onde o original usa um issue tracker, o CBS usa um **mapa markdown local** em `docs/mapas/`, no espírito do `/investigar` (discovery, sem tocar código de aplicação).

## Planejar, não fazer

Wayfinder é **planejamento** por padrão: cada ticket resolve uma **decisão**, e o mapa termina quando o caminho está claro — nada mais a decidir antes de alguém ir e **fazer** a coisa. A vontade de "já implementar" costuma ser o sinal de que você chegou na borda do mapa e é hora de passar o bastão (`/refinar` ou `/executar`). Produza **decisões, não entregas**.

Regra herdada do `/investigar`: **proibido editar código de aplicação** (`src/`, `lib/`, `app/`, etc.). Permitido só escrever o mapa e artefatos de pensamento em `docs/`.

## Referir por nome

Cada ticket tem um **título**. Em tudo que o humano lê, refira o ticket pelo **título**, nunca por um número cru. `T3, T4, T5` é ilegível; nomes se leem num relance.

## O Mapa

O mapa é **um arquivo markdown** em `docs/mapas/<slug>.md` — o artefato canônico. É um **índice**, não um depósito: lista as decisões tomadas e aponta pros tickets que guardam o detalhe. Uma decisão vive em **um** lugar (seu ticket); o mapa só resume e linka.

Os tickets podem viver **inline** no mesmo arquivo (seção `## Tickets`) para escopos médios, ou como arquivos irmãos `docs/mapas/<slug>/<ticket>.md` para escopos grandes. Escolha um e seja consistente.

### Corpo do mapa

```markdown
# Mapa: [nome do esforço]

## Destino
<o que chegar ao fim deste mapa significa — a spec, decisão ou mudança que este esforço busca. 1-2 linhas; toda sessão se orienta por isso antes de escolher um ticket.>

## Notas
<domínio; skills que cada sessão deve consultar; preferências fixas deste esforço>

## Decisões até agora
<!-- o índice — uma linha por ticket fechado: o suficiente pra julgar relevância, depois abre o ticket pro detalhe -->
- [título do ticket fechado](link/âncora) — <resumo de uma linha da resposta>

## Ainda não especificado
<!-- névoa em escopo que você ainda não consegue "ticketar"; gradua conforme a fronteira avança -->

## Fora de escopo
<!-- trabalho conscientemente descartado deste esforço; fechado, nunca gradua -->

## Tickets
<!-- os tickets abertos; cada um com Pergunta, Tipo, e o que bloqueia -->
```

### Tickets

Cada ticket é uma **pergunta**, dimensionada pra caber em uma sessão:

```markdown
### [título do ticket]
- **Tipo:** pesquisa | protótipo | grelhar | tarefa
- **Bloqueado por:** [títulos dos tickets que precisam fechar antes] (ou "nada")
- **Status:** aberto | em andamento | fechado
- **Pergunta:** <a decisão ou investigação que este ticket resolve>
- **Resposta:** <preenchida só na resolução>
```

A **fronteira** são os tickets abertos, não-bloqueados e não-reivindicados — a borda do conhecido, o que dá pra pegar agora. Um ticket está **desbloqueado** quando todo ticket que o bloqueia está fechado.

## Tipos de ticket

Cada ticket é **HITL** (human-in-the-loop, resolvido *com* o humano) ou **AFK** (só o agente). Um ticket HITL só resolve na troca ao vivo — o agente **nunca** responde no lugar do humano (um grelhar que responde as próprias perguntas quebrou isso).

- **Pesquisa** (AFK): ler docs, APIs de terceiros, recursos locais pra levantar um **fato** que a decisão espera. Resolvido por um **subagent** `Explore`/research. Use quando falta conhecimento fora do diretório atual.
- **Protótipo** (HITL): subir a fidelidade da conversa com um artefato barato e concreto pra reagir — um outline, um stub, um rascunho. Use quando a pergunta-chave é "como deveria parecer/comportar".
- **Grelhar** (HITL): conversa via skill `grelhar`, uma pergunta por vez. **O caso padrão.**
- **Tarefa** (HITL ou AFK): trabalho manual que precisa acontecer antes de uma **decisão** poder ser tomada — nada a decidir/prototipar/pesquisar, mas a discussão está bloqueada até isso ser feito (ex.: criar conta num serviço pra avaliar a API, mover dados pra ver a forma). É o único tipo que **faz** em vez de decidir — e se justifica por **desbloquear uma decisão**, não por entregar o destino. Resolvido quando o trabalho está feito; a resposta registra o que foi feito e os fatos resultantes que tickets posteriores dependem.

## Névoa de guerra

O mapa é **deliberadamente incompleto**: não cartografe o que ainda não dá pra ver. Além dos tickets vivos está a **névoa** — decisões e investigações que você sente que vêm mas ainda não consegue fixar, porque dependem de perguntas ainda abertas. Resolver um ticket **limpa a névoa à frente**, graduando o que agora é especificável em tickets novos — um de cada vez, até o caminho ficar claro e não sobrar ticket.

A seção **Ainda não especificado** é onde essa visão embaçada se escreve. **Névoa ou ticket?** O teste é se você consegue **enunciar a pergunta com precisão agora** — *não* se consegue respondê-la agora.
- **Ticket quando** a pergunta já está afiada — mesmo bloqueada e sem poder agir ainda.
- **Ainda não especificado quando** você não consegue formulá-la com essa nitidez. Não pré-fatie a névoa em pedaços de ticket.

## Fora de escopo

A névoa só se junta **em direção ao destino**. O destino fixa o escopo, então trabalho além dele é **fora de escopo** — não é névoa e não entra em "Ainda não especificado". Ganha sua própria seção. Nunca gradua; só volta se o destino for redesenhado, e aí como esforço novo.

## Invocação

Dois modos. Em qualquer um: **nunca resolva mais de um ticket por sessão** — exceto tickets de pesquisa.

### Cartografar o mapa

Usuário invoca com uma ideia solta.

1. **Nomear o destino.** Rode uma sessão `grelhar` (+ enquadramento estilo `/investigar`) pra fixar o que este mapa busca — a spec, decisão ou mudança. O destino fixa o escopo; decide-se primeiro.
2. **Mapear a fronteira.** Grelhe de novo, **em largura** desta vez: espalhe pelo espaço todo em vez de fundo num fio só, revelando as decisões abertas e os primeiros passos pegáveis agora. **Se isso não revelar névoa** — o caminho já está claro, a jornada cabe em uma sessão — você não precisa de mapa. Pare e diga: "isso cabe num `/refinar` direto".
3. **Criar o mapa** em `docs/mapas/<slug>.md`: Destino e Notas preenchidos, Decisões-até-agora vazio, a névoa esboçada em "Ainda não especificado".
4. **Criar os tickets que dá pra especificar agora** e ligar as dependências (o que bloqueia o quê).
5. **Disparar os subagents de pesquisa** pros tickets tipo pesquisa, em paralelo, capturando achados sem poluir o contexto principal.
6. Pare — cartografar é o trabalho de uma sessão; não resolve nada à mão.

### Percorrer o mapa

Usuário invoca com um mapa (caminho do arquivo). Ticket é opcional — sem ele, **você** escolhe a próxima decisão.

1. Carregue o **mapa** (a visão baixa-resolução, não todo ticket).
2. Escolha o ticket. Se o usuário nomeou um, use-o. Senão, pegue o primeiro da fronteira em ordem. **Reivindique**: marque Status `em andamento` antes de qualquer trabalho.
3. Resolva — **aproxime conforme precisar**: abra o corpo de tickets relacionados/fechados sob demanda; invoque as skills que as `## Notas` nomeiam. Na dúvida, use `grelhar`.
4. Registre a resolução: preencha **Resposta**, marque Status `fechado`, e **acrescente uma linha** em "Decisões até agora" do mapa.
5. Adicione tickets recém-revelados; **gradue** a névoa que a resposta tornou especificável, limpando-a de "Ainda não especificado". Se a resposta revelar que um ticket está além do destino, **mova-o pra Fora de escopo** em vez de resolvê-lo. Se invalidar partes do mapa, atualize/remova esses tickets.

## Próximo passo

Quando o caminho estiver claro (sem tickets abertos relevantes ao destino), o mapa vira insumo direto:
- `/refinar docs/mapas/<slug>.md` — pra virar prompt premium executável.
- `/executar` — se as decisões já bastam pra ir ao código.

## Anti-padrões

- ❌ Resolver mais de um ticket de decisão por sessão.
- ❌ Cartografar a névoa inteira de uma vez (pré-fatiar o que ainda não está afiado).
- ❌ Um agente responder no lugar do humano num ticket HITL.
- ❌ Implementar código de aplicação aqui (isto é discovery).
- ❌ Restated: repetir no mapa o detalhe que já vive num ticket.
