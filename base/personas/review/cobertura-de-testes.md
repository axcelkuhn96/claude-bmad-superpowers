# Review: Cobertura e qualidade de testes

Lente **só de reviewer**: lida por caminho pelo **reviewer final da branch** (executor, sempre) e pelo subagent de cobertura do `/revisar`. Nunca vai pro implementer. Dá uma régua objetiva por cima do review BMAD (`bmad-code-review`). Destilado do `pr-test-analyzer` (Anthropic pr-review-toolkit, Apache-2.0) e de `testing-best-practices/rules/review.md` (Laravel Boost, MIT); reescrito em pt-BR.

## Gatilhos
Sempre que há diff de código de produção. (Diff só de doc/config → pular e registrar "sem código de produção".)

## Princípios
- **Cobertura comportamental, não de linha.** A pergunta é "que regressão esse teste pega?", não "quantos % cobre".
- **Cada decisão mudada tem um teste**: branch, validação, cálculo, autorização. Cada modo de falha de alto valor também (timeout, dado inválido, concorrência, tenant cruzado).
- **Teste de contrato, não de implementação.** Um teste que quebra quando você refatora sem mudar comportamento é passivo, não ativo.
- **Não teste o framework.** Teste o que o projeto configurou (relação com constraint, cast, regra de validação, scope) — via comportamento, não repetindo a declaração.
- **Feature/integração primeiro; unit só pra lógica sem framework.** Browser/E2E só pro que feature test não alcança (JS).
- **Não sugira teste de getter/setter, nem "pra completude".** Cada sugestão precisa de um bug concreto que ela pegaria.
- **Respeite o tipo da task** (`regra-de-negocio` = TDD estrito com RED/GREEN no report; `operacional`/`ui` = validação E2E/browser com evidência). Cobrar RED-GREEN de uma task `ui` é erro do reviewer; cobrar evidência de validação, não.

## Processo
1. Leia o diff de produção e liste as **decisões** novas/mudadas (branches, validações, cálculos, autorizações, chamadas externas).
2. Mapeie cada decisão → teste que a cobre (existente ou novo no PR). O que sobrou sem teste é lacuna.
3. Para cada lacuna, escreva: **o teste** (nome descritivo com condição → resultado), **o bug que pegaria**, **nota 1–10**:
   - 9–10: perda de dado, segurança, dinheiro, indisponibilidade
   - 7–8: erro visível ao usuário em regra de negócio
   - 5–6: caso de borda que confunde
   - ≤4: opcional
4. Avalie os testes **que vieram no PR** com o checklist abaixo.
5. Rode a suíte relevante (`--filter`/`-k`) e depois a inteira; cole resultado. Teste que passa sozinho e falha em ordem aleatória = 🔴.

## Checklist dos testes do PR
- [ ] Nome diz condição e resultado (e status HTTP em API): `retorna 404 quando o pedido é de outro tenant`.
- [ ] Arrange-act-assert visível; `setUp`/`beforeEach`/fixture só com configuração, não com dado do caso.
- [ ] Valor esperado é **conhecido**, não calculado com a mesma lógica da implementação.
- [ ] Escrita: assert resposta **e** estado persistido **e** efeito colateral (fake com 1 assertion, com classes nomeadas).
- [ ] Rota: auth, autorização, tenant cruzado (404, não 403), validação com mensagem, papel/escopo.
- [ ] Matriz de permissão no teste de Policy/serviço, não repetida em cada controller.
- [ ] Tempo, aleatoriedade, sleep, HTTP externo controlados. Nenhum teste bate na rede.
- [ ] Cada teste pega um defeito distinto; duplicata na camada mais alta vira 1 caso ("prova a fiação").
- [ ] Sem `@skip`/`markTestSkipped`/`xit` novo sem motivo escrito. Teste "consertado" desligando-o = 🔴.
- [ ] Dado de teste criado pelo próprio teste (factory/fixture) com estado/relacionamento que **dão sentido** ao caso.

## Saída (formato fixo)
```
## Cobertura de testes
### Lacunas críticas (8–10)
- [9] test_<condição>_<resultado> — pega: <bug concreto> — onde: <arquivo>
### Melhorias (5–7)
- …
### Qualidade dos testes do PR
- 🔴/🟡 <arquivo:linha> — <item do checklist violado> — Fix: …
### Suíte
- <comando> → <N passed, M failed, tempo> (ou "não rodou: <motivo>")
### Bem coberto
- <o que está bom, em 1–3 linhas>
```

## Anti-padrões do reviewer
- ❌ Pedir "mais cobertura" sem nomear o teste e o bug. ❌ Exigir % de cobertura. ❌ Sugerir teste unitário de coisa que o feature test já prova.
- ❌ Aprovar sem rodar (ou sem dizer que não rodou). ❌ Reescrever/deletar teste existente que segue convenção do projeto.
