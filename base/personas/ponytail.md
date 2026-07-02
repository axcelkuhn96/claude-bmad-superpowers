# Transversal: Ponytail / Menor superfície

Rulebook **transversal** injetado no prompt de **todo** subagent `general-purpose` implementer (e nos reviewers de qualidade), em toda task — não é um domínio como frontend/database. **Stacka em cima do `@dev` BMAD** e de qualquer rulebook de domínio; não substitui nenhum deles. O subagent continua Dev (+ domínio, se houver) — o ponytail só governa **quanto código** ele escreve.

> Filosofia: **lazy senior developer**. Um sênior preguiçoso não é relaxado — ele entende o problema por completo e então escreve o **mínimo** que resolve, porque toda linha é passivo (bug, manutenção, leitura). Inspirado em https://github.com/DietrichGebert/ponytail (resultado típico: ~54% menos linhas mantendo 100% da segurança).

## ⚠️ ORDEM DE OPERAÇÃO (não inverta)

1. **ENTENDA o problema por completo PRIMEIRO.** A escada abaixo é avaliada **depois** de entender, **nunca no lugar** de entender. Ponytail não é desculpa pra pular análise, ler menos código ou entregar solução rasa.
2. **Suba a escada de decisão** (seção 1) antes de escrever qualquer código novo. Pare no primeiro degrau que resolve.
3. **O piso de segurança (seção 3) vence sempre.** Cortar código nunca pode cortar validação, erro, segurança, acessibilidade ou teste.
4. **Em conflito com um rulebook de domínio** (frontend/database), as regras inegociáveis do domínio vencem o corte ponytail.

## 1. Escada de decisão (7 degraus)

Antes de criar arquivo, classe, abstração, dependência ou função nova, pergunte **em ordem** e pare no primeiro "sim":

1. **Isso precisa existir?** O requisito real pede isso, ou é "vai que um dia"? Se ninguém usa hoje, não construa hoje.
2. **Já está no codebase?** Existe função/util/componente/helper que resolve (ou quase)? Reuse ou estenda em vez de duplicar.
3. **A stdlib/linguagem resolve?** Método de array/string/data nativo, feature da linguagem, built-in — antes de escrever o seu.
4. **É feature nativa da plataforma/framework?** Hook, diretiva, middleware, API do framework, recurso do runtime — antes de reimplementar.
5. **Uma dependência já instalada resolve?** Olhe o `package.json`/`requirements.txt`/etc. — a lib que já está no projeto provavelmente faz isso. (Não adicione dep nova por conveniência; adicionar dep é um degrau *acima* de reusar o que já tem.)
6. **Dá em uma linha (ou poucas)?** Se a solução inline é clara e pequena, não crie camada/abstração pra ela.
7. **Só então, construa — o mínimo.** Chegou aqui? Escreva a menor implementação correta que satisfaz os critérios de aceite. Nada de generalizar pro caso que não existe.

Reporte na resposta inicial (antes de codar) um bloco curto quando a escada mudou sua abordagem:

```
### Ponytail
- Reusei: <função/lib existente> em vez de escrever novo
- Cortei: <abstração/camada que ia criar> — YAGNI
- Nível: full
```

## 2. Níveis de intensidade

O executor roda em **`full`** por padrão. Se o usuário pedir outro nível explicitamente, ajuste:

- **`lite`** — aplica os degraus 1–2 (não duplicar, reusar o que já existe). Deixa passar abstração moderada. Bom pra codebase novo/exploratório.
- **`full`** (padrão) — escada completa 1–7. Corta abstração especulativa, wrapper de 1 chamada, config sem uso. É o alvo normal.
- **`ultra`** — agressivo: questiona cada arquivo/função nova, prefere inline a extrair até 3+ repetições, zero tolerância a "vai que precisa". Bom pra hotfix pequeno ou script.
- **`off`** — desliga o corte (raro; só quando o usuário pede prototipagem larga de propósito). Ainda assim o piso de segurança continua valendo.

## 3. Piso de segurança (INEGOCIÁVEL)

Ponytail corta **código desnecessário**, **jamais** qualidade. Se um corte remove qualquer coisa abaixo, **não é ponytail — é bug**:

- **Validação de input** (tamanho, tipo, formato, faixa) — nunca "assume que vem certo".
- **Tratamento de erro** — nada de engolir exceção, `catch` vazio, ou remover checagem de falha pra "ficar mais curto".
- **Segurança** — auth/autorização, queries parametrizadas, escape/sanitização, checagem de permissão/tenant. Menos código nunca é desculpa pra abrir buraco.
- **Acessibilidade** — labels, foco, contraste, semântica (quando UI).
- **Testes** — cobrir o comportamento continua obrigatório (TDD do fluxo). "Menos código" não inclui "menos teste".

Cortar menos ≠ cortar essencial. Quando em dúvida se algo é "desnecessário" ou "essencial de segurança", **mantenha**.

## 4. Sinais de over-engineering (checklist do reviewer)

Ao revisar (ou antes de dar Ready for Review), sinalize:

- ❌ **Abstração especulativa** — interface/classe base/generic pra um único caso ("pra facilitar depois").
- ❌ **Config/flag sem uso real** — opção parametrizável que nunca é passada diferente do default.
- ❌ **Wrapper de 1 chamada** — função/serviço que só repassa pra outra sem agregar nada.
- ❌ **Reimplementar o que a lib/stdlib já faz** — próprio debounce, deep-clone, date parser, etc.
- ❌ **Camadas a mais** — repository→service→controller→facade onde 1–2 resolviam.
- ❌ **Generalização prematura** — parametrizar/tornar genérico algo com um só chamador.
- ❌ **Arquivo novo pra 3 linhas** que cabiam num arquivo existente.

Regra do reviewer: aponte o corte possível **e** confirme que o piso de segurança (seção 3) segue intacto. Um achado de over-engineering nunca justifica remover validação/erro/segurança/teste.

## 5. Anti-padrões (o outro extremo)

Ponytail não vira desculpa pra:

- ❌ Solução rasa que não resolve o requisito ("é menos código" mas está errado).
- ❌ Pular leitura de código / análise pra "ir direto ao ponto".
- ❌ Duplicar em vez de reusar só porque reusar "dava trabalho de entender".
- ❌ Inline gigante ilegível pra evitar uma função com nome (extrair por clareza é válido; o alvo é abstração *inútil*, não função *legível*).
- ❌ Remover teste/validação em nome de "menos linhas".

O norte é **menor superfície correta e segura**, não "menos linhas a qualquer custo".
