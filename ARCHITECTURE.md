# ARCHITECTURE

Este documento explica como eu resolvi o desafio, **por que** tomei cada decisão e **como provei** que ela funciona. Termos técnicos ficam em inglês porque são os nomes usados no código.

## 1. A ideia central

O desafio pede um sistema que continue correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo**, e quando o processo morre no pior momento. Minha abordagem foi não depender da aplicação para isso:

1. **O Postgres é a fonte da verdade.** Saldo não negativo, ledger imutável, unicidade e consistência saldo ↔ ledger são impostos por `CHECK`, `UNIQUE`, FKs e triggers. Se a aplicação tiver um bug, o banco recusa o dado inválido.
2. **Um efeito, um commit.** Transação, lançamento no ledger, saldo, inbox e eventos da outbox entram na **mesma transação SQL**. Resposta, ack e publicação só acontecem depois do `COMMIT`.
3. **Nada assume entrega única nem ordem.** Idempotência persistente, inbox, outbox e um worker para referências que chegam atrasadas.
4. **Lock por wallet.** A `walletId` é a unidade de concorrência: wallets diferentes andam em paralelo, a mesma wallet é serializada.
5. **Provar quebrando.** Testes com Postgres e SQS reais, processos reais e `SIGKILL`; e eu quebrei o código de propósito (tirei o `FOR UPDATE`, apaguei constraints, confirmei a mensagem antes de processar) para ver se os testes falhavam.

```
HTTP ─┐                                      ┌─ outbox publisher ─▶ wagering-events.fifo
      ├▶ ProcessWagerTransaction ─▶ Postgres ┤
SQS ──┘   (inbox, lock da wallet, ledger,    └─ reference worker (PENDING_REFERENCE)
           saldo e outbox: tudo no mesmo commit)
```

HTTP e SQS usam o **mesmo caso de uso**. Camadas: `domain/` (regras puras), `application/` (casos de uso e portas) e `infra/` (Postgres, HTTP, SQS). `domain/` e `application/` não importam Nest, ORM, zod nem AWS.

## 2. Exigência → solução → prova

| O desafio exige | Como eu resolvi | Onde está a prova |
|---|---|---|
| Sem `number`/`float` para dinheiro | `Money` em `bigint` (centavos) | `money.test.ts` |
| Saldo nunca negativo, mesmo com race | `FOR UPDATE` na wallet e `CHECK (balance >= 0)` | `wager-store.test.ts`, `concurrency_test2` |
| Ledger nunca sobrescrito nem apagado | Triggers, e a aplicação só tem `SELECT, INSERT` | `schema.test.ts` |
| Saldo sempre igual ao ledger | Triggers deferidos checados no `COMMIT` + reconciliação | `schema.test.ts`, `reconciliation.test.ts` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `payloadHash` | `wagering.test.ts`, `concurrency_test1` |
| Não publicar antes do commit | Outbox gravada na mesma transação | `wager-store.test.ts`, `outbox-publisher.test.ts` |
| Vários publishers sem duplicar trabalho | `FOR UPDATE SKIP LOCKED` | `outbox.test.ts` (`concurrency_test6`) |
| Funcionar com várias instâncias | Só Postgres e SQS coordenam as instâncias | `multi-instance.test.ts` (3 processos reais) |
| Reversão antes da referência | `PENDING_REFERENCE` + worker com backoff e TTL | `pending-reference.test.ts`, `concurrency_test7` |
| Morrer depois do commit e antes do ack | Inbox absorve a reentrega | `consumer-crash.test.ts`, `concurrency_test8` |

## 3. Decisões

### 3.1 Correção financeira

**Money.** Guarda **centavos em `bigint`** e a moeda. O desafio fixa escala 2 e só preciso somar, subtrair e comparar, então inteiros são exatos e não há arredondamento. Entrada aceita só `^(0|[1-9][0-9]{0,16})\.[0-9]{2}$`; `"25"`, `"1e2"`, `"-1.00"`, `""` e `NaN` são recusados. Moedas diferentes lançam erro de domínio.

- **Mapeamento no banco:** `numeric(20,2)` e `char(3)` em colunas separadas, reidratados com `Money.fromDb`. O domínio não conhece o ORM.
- **Trade-off:** o esqueleto do desafio usa `Decimal`. Para mais casas, multiplicação ou divisão eu trocaria o interior por `decimal.js`; a API de `Money` não muda.

**Wallet e ledger.** `version` começa em 1 e só sobe quando o saldo muda. Cada mudança de saldo gera exatamente um lançamento imutável (`balance_before ± amount = balance_after`). `LOSS` e rejeições não geram lançamento. O saldo inicial vira uma transação interna `OPENING` com lançamento `CREDIT`, na mesma transação da criação.

**Reconciliação.** `POST /wallets/:id/reconciliation` compara saldo, `version` e último lançamento com o ledger numa transação `REPEATABLE READ READ ONLY`. Divergência **não é corrigida**: é logada (sem valores), contada em `reconciliation_mismatches_total` e sinalizada na resposta.

### 3.2 Concorrência

**Lock pessimista por wallet** (`SELECT … FOR UPDATE`) em `READ COMMITTED`.

- Depois do `FOR UPDATE`, as leituras já enxergam o commit de quem estava na frente. Por isso a idempotência é conferida de novo com a wallet travada.
- O `UPDATE` do saldo também é guardado por `version`. Sob o lock ele nunca falha; é defesa em profundidade.
- **Por que não otimista:** numa wallet muito usada, `version` otimista gera colisões e retries. O lock enfileira só as operações daquela wallet.
- **Retry:** falhas temporárias do banco (deadlock, lock timeout, conexão) são repetidas até 5 vezes, em no máximo 10 s. Acabou: `503` com `Retry-After: 1`, e o provedor reenvia com a mesma `Idempotency-Key`. Erros de invariante (`CHECK`, FK, triggers) não são repetidos.
- **Timeouts coerentes:** `lock (2 s) < statement (5 s) < idle-in-tx (15 s)`, o orçamento do caso de uso cabe na visibilidade do SQS e o drain do shutdown cabe no `stop_grace_period`. A aplicação **não sobe** se essas regras forem violadas (`src/globals.ts`).
- **Trade-off:** o throughput de **uma** wallet é limitado pela fila do lock dela.

### 3.3 Idempotência

`Idempotency-Key` é obrigatório (padrão recomendado: `{providerId}:{externalTransactionId}`). O banco garante `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.

**`payloadHash`:** SHA-256 do **JSON canônico** de `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}` e `referenceExternalTransactionId` (omitido se não existe). Canônico = chaves ordenadas recursivamente, sem espaços, `playerId` e `walletId` em minúsculas. A chave, o `messageId`, `occurredAt` e os headers **não** entram.

| Situação | Resultado |
|---|---|
| Chave nova | processa |
| Mesma chave e mesmo hash | **replay**: devolve o resultado guardado (com o saldo daquele momento), `idempotentReplay: true` |
| Mesma chave e hash diferente | `409 IDEMPOTENCY_KEY_CONFLICT` (não é replay) |
| Chave nova com `externalTransactionId` já usado | `409 EXTERNAL_TRANSACTION_ID_CONFLICT` |
| Duas requisições iguais ao mesmo tempo | uma processa; a outra espera o lock e recebe replay |

### 3.4 Mensageria e falhas

**Inbox.** A linha `(consumer_name, message_id)` entra na mesma transação do efeito financeiro. O hash é o SHA-256 de `{type, data}`. Mesmo id e mesmo hash: duplicata, sem efeito novo. Mesmo id e hash diferente: vai para a DLQ.

**Consumer.** Mensagens de uma wallet (`MessageGroupId`) rodam em ordem; wallets diferentes, em paralelo. O **ack só vem depois do commit**.

| Resultado | Ação |
|---|---|
| Processada, rejeitada por regra, pendente, replay ou duplicata | ack |
| Erro permanente (payload inválido, conflito de idempotência, wallet inexistente, `FORBIDDEN_PROVIDER`…) | copia para a DLQ com `errorCode` e depois apaga |
| Erro temporário ou inesperado | não apaga; volta com backoff `min(2^receiveCount, 60) s` |

Depois de 5 recebimentos sem ack, a *redrive policy* move a mensagem para a DLQ. `bun run dlq:redrive` devolve a DLQ à fila principal.

**Outbox.** Os eventos entram na mesma transação, então nada sai antes do commit. O publisher usa `SKIP LOCKED`, e falha de envio faz backoff de `2^n` s (até 300 s). Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionFailed` e `WalletBalanceChanged` (só quando o saldo muda). A entrega é *at-least-once*, então quem consome deve deduplicar por `eventId`.

**Referências fora de ordem.** Quando a referência não existe, a transação é gravada como `PENDING_REFERENCE`. Um worker a reprocessa sob o lock da wallet, com a mesma `decide()`:

- Pega até 10 por vez com `SKIP LOCKED` e um *lease* de 30 s (se o worker morrer, outro assume).
- Quando uma `BET`, `WIN` ou `REFUND` termina, os dependentes da mesma wallet ficam devidos na hora.
- Sem referência ainda: backoff de `2^n` s (até 60 s, com jitter).
- **Limite (TTL): 10 minutos**, no relógio do banco. Passou: `REJECTED` com `REFERENCE_NOT_FOUND` e o evento de rejeição. Escolhi 10 min porque cobre as reentregas do SQS (5 recebimentos, cerca de 2 min) mais a janela de reenvio do provedor, sem deixar uma reversão aberta para sempre.
- 3 erros seguidos no mesmo item → `FAILED` (`PROCESSING_FAILED`) com evento.

**O que acontece em cada falha:**

| Falha | Efeito |
|---|---|
| Morre antes do `COMMIT` | Rollback. O cliente reenvia a mesma chave, ou a mensagem volta |
| Morre depois do `COMMIT`, antes da resposta | O cliente reenvia e recebe replay |
| Morre depois do `COMMIT`, antes do ack | A mensagem volta; o inbox absorve, sem efeito novo |
| Morre depois do `COMMIT`, antes de publicar | O evento está na outbox; outra instância publica |
| Publisher envia e morre antes de marcar | Outro reenvia o mesmo `eventId` |
| `COMMIT` com resultado desconhecido | O retry cai em replay |
| Postgres fora | Retry; esgotou: `503` (HTTP) ou retry da mensagem (SQS) |
| SQS fora | Consumer pausa e tenta; outbox faz backoff; o HTTP continua aceitando |

**Shutdown (`SIGTERM`):** `/health/ready` passa a `503`, o consumer devolve as mensagens não iniciadas, publisher e worker terminam o ciclo, com no máximo 20 s de espera.

### 3.5 Modelagem e arquitetura

**Regras de negócio.** `decide()` é uma função pura do domínio. A primeira verificação que falha define o resultado: moeda ≠ wallet, jogador ≠ dono, referência ausente (`PENDING_REFERENCE`), referência inválida ou não processada, valor diferente da referência, saldo insuficiente.

**Máquina de estados de `WagerTransaction`:**

```
PENDING (só em memória) ─▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ─▶ PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais
```

Mudar um estado terminal lança `InvalidTransactionStateError` e o banco também recusa (trigger `wager_transactions_guard`).

**ORM: MikroORM**, usado de forma **parcial** de propósito. Uso o pool, o `EntityManager.transactional()`, o `Migrator` (migrations reversíveis) e `em.execute()` com SQL explícito. **Não** uso entidades, Unit of Work nem Identity Map. Motivos:

1. A ordem de escrita precisa ser explícita (transação → lançamento → saldo → outbox) por causa das FKs e dos triggers, e o `flush` decide a ordem pela topologia das entidades.
2. O Identity Map poderia devolver uma wallet em cache, e não a linha que acabou de ser travada.
3. `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, `SET LOCAL` e o relógio do banco são mais claros em SQL.
4. O domínio não pode depender do ORM.

**Estratégia transacional:** uma unidade de trabalho = uma transação SQL curta, com `lock_timeout`, `statement_timeout` e `idle_in_transaction_session_timeout` por `SET LOCAL`. Nenhuma chamada de rede acontece dentro dela (a única exceção é o envio da outbox, com timeout menor que o `idle_in_transaction_session_timeout`). Os erros do driver são traduzidos num só lugar (`translateDbError`) para classes da aplicação, então `application/` nunca vê um código SQLSTATE. **Trade-off:** mais SQL escrito à mão, em troca de controle total sob concorrência.

**Schema.** Três migrations reversíveis, rodadas por comando (nunca no boot) pelo usuário `wagering_owner`. A aplicação usa `wagering_app`, sem DDL e só com `SELECT, INSERT` no ledger.

### 3.6 Testes

Integração e concorrência usam **Postgres e LocalStack reais**, e cada arquivo cria o próprio banco e as próprias filas. A suíte de concorrência sobe **processos reais** da aplicação (`bun src/main.ts`) e os derruba com `SIGKILL` e `SIGTERM`.

| Cenário do desafio | Teste |
|---|---|
| 100,00 e duas apostas de 80,00 | `wager-store.test.ts`, `wagering.test.ts`, `concurrency_test2` |
| Mesma aposta 50 vezes em paralelo | `wagering.test.ts`, `concurrency_test1` |
| Wallets diferentes em paralelo | `concurrency_test3` |
| 3 ou mais instâncias | `multi-instance.test.ts` |
| Worker morto depois do commit e antes do ack | `consumer-crash.test.ts` |
| Dois publishers na mesma outbox | `outbox.test.ts` (`concurrency_test6`) |
| `ROLLBACK`/`REFUND` antes da referência | `pending-reference.test.ts`, `concurrency_test7` |
| Reinício com prova de consistência | `restart.test.ts` (`concurrency_test8`) |

Os testes terminam conferindo que `wallet.balance` é igual ao saldo reconstruído pelo ledger. A suíte de concorrência passou 10 vezes seguidas (`bun run test:concurrency:soak`).

### 3.7 Observabilidade

- **Logs** em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. O logger descarta `amount`, `balance`, `money`, `payload` e `authorization`.
- **Métricas** em memória, por instância: transações por status, replays, duplicatas do inbox, retries, conflitos de lock, DLQ, resultados da outbox, `outbox_lag_seconds` e latência. Saem em `GET /metrics` (JSON) e a cada 30 s no log. O desafio pede as métricas, mas não define endpoint nem formato, então não usei Prometheus. Os `p50/p95/p99` vêm dos buckets, são limites superiores e por instância.
- **Health:** `/health/live` e `/health/ready` (Postgres e SQS), públicos.

### 3.8 Autenticação

O desafio aceita não implementar, e eu **não implementei, por questão de tempo**. Deixei o ponto de extensão explícito:

- `ProviderIdentityPort.resolve(request) → Principal` (`provider`, `admin`, `trusted-internal`, `anonymous-dev`). O adaptador atual devolve sempre `anonymous-dev`.
- `AuthGuard` global: toda rota precisa estar marcada (`@Public`, `@ProviderRoute` ou `@AdminRoute`).
- `assertCanActAs`: um `provider` só age pelo próprio `providerId` (`403 FORBIDDEN_PROVIDER`), e consultar a transação de outro dá `404`. `POST /wallets` e a reconciliação são só de `admin`.
- Mensagens do SQS entram como canal interno confiável, mas passam pelas mesmas validações de domínio.

**Desenho que eu adotaria:** Keycloak, um *client* por provedor (`client_credentials`) com a claim `provider_id`, validação do JWT por JWKS num novo adaptador de `ProviderIdentityPort`, e a role `wallet-admin` para as rotas de admin. Os casos de uso não mudam.

## 4. Interpretações do enunciado

1. **Uma reversão por referência, por qualquer operação** (a regra 4 fala em "mesmo tipo"; a minha leitura é um pouco mais estrita). Um `WIN` ou `LOSS` sobre uma `BET` já revertida é rejeitado com `REFERENCE_ALREADY_REVERSED`. O banco garante isso com o índice único parcial `ux_single_reversal`.
2. `ROLLBACK` aceita `BET`, `WIN` ou `REFUND` (um `ROLLBACK` de `REFUND` vira um débito). `REFUND`, `WIN` e `LOSS` só referenciam `BET`.
3. Reversão que deixaria o saldo negativo é rejeitada com `INSUFFICIENT_FUNDS_FOR_REVERSAL` (código diferente de uma aposta sem saldo) e fica gravada.
4. Referência em outra wallet, jogador, moeda ou rodada → `REFERENCE_MISMATCH`.
5. Moeda da transação diferente da wallet é uma **rejeição gravada** (`CURRENCY_MISMATCH`), não um `400`.
6. `LOSS` aceita valor `0.00`; os outros tipos exigem valor positivo.

## 5. Referência: status HTTP e códigos de falha

O mapeamento é o mesmo em todos os endpoints. Erros usam `application/problem+json` (`type`, `title`, `status`, `code`, `detail`, `retryable`, `correlationId`) e nunca ecoam valores recebidos nem stack.

| Situação | HTTP | `code` |
|---|---|---|
| Aplicada | `200` | `status: PROCESSED` |
| Aceita, aguardando referência | `202` | `status: PENDING_REFERENCE` |
| Rejeitada por regra de negócio (ou `FAILED`) | `422` | `status: REJECTED` e `failureCode` |
| Payload inválido | `400` | `VALIDATION_ERROR` |
| Falta `Idempotency-Key` | `400` | `MISSING_IDEMPOTENCY_KEY` |
| Mesma chave, payload diferente | `409` | `IDEMPOTENCY_KEY_CONFLICT` |
| `externalTransactionId` já usado | `409` | `EXTERNAL_TRANSACTION_ID_CONFLICT` |
| Wallet duplicada | `409` | `WALLET_ALREADY_EXISTS` |
| Provedor sem permissão | `403` | `FORBIDDEN_PROVIDER` |
| Wallet inexistente (ao enviar) | `422` | `WALLET_NOT_FOUND` |
| Não encontrado | `404` | `NOT_FOUND` |
| Corpo maior que 16 KiB | `413` | `PAYLOAD_TOO_LARGE` |
| Falha temporária de infraestrutura | `503` + `Retry-After: 1` | `TRANSIENT_FAILURE` (reenviar com a mesma chave) |
| Erro inesperado | `500` | `INTERNAL_ERROR` |

Há dois `422`: o resultado de negócio gravado (`application/json`) e o `WALLET_NOT_FOUND` (`application/problem+json`, nada gravado).

**Taxonomia de `failureCode`** (rejeições gravadas; nenhuma deve ser reenviada sem mudar a causa):

| Código | Quando |
|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | `ROLLBACK` deixaria o saldo negativo |
| `CURRENCY_MISMATCH` | moeda diferente da wallet |
| `PLAYER_WALLET_MISMATCH` | `playerId` não é o dono da wallet |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do TTL |
| `REFERENCE_MISMATCH` | referência de outra wallet, jogador, moeda ou rodada |
| `REFERENCE_KIND_NOT_ALLOWED` | combinação de tipos inválida |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada ou falhou |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência |
| `PROCESSING_FAILED` | o worker errou 3 vezes (`FAILED`) |

## 6. Limitações e próximos passos

**Limitações:**

1. **Sem autenticação real:** decidi não fazer autenticação por questão de tempo. Hoje qualquer chamador pode agir como qualquer provedor ou como admin.
2. **Ordem dos eventos** é *best-effort* com vários publishers (todo evento de saldo traz `walletVersion` para ordenar), e a entrega é *at-least-once*.
3. **Wallet muito usada:** as operações da mesma wallet são sequenciais.
4. **Só escala 2**, sem reversão parcial. A lista `SUPPORTED_CURRENCIES` vale só na criação da wallet.
5. **`/health/ready` depende do SQS:** se ele cair, a instância fica `503`, mesmo podendo aceitar transações pelo HTTP.
6. **Postgres fora por muito tempo** pode levar mensagens válidas à DLQ (depois de 5 recebimentos); use `dlq:redrive`.
7. **Sem retenção:** ledger, transações, inbox e outbox só crescem. Banco único, sem réplica nem failover.
8. **Métricas** por instância, zeradas no restart, com percentis aproximados. Sem dashboard nem OpenTelemetry.
9. **Testes:** o LocalStack não reproduz o bloqueio de grupo do FIFO real, então os testes conferem o comportamento do consumer, e não a ordem global da fila. Não há teste da imagem Docker, nem de queda e volta do Postgres ou do SQS durante carga. O teste de carga (opcional) não foi feito.

**O que eu faria a seguir:** integrar o Keycloak, fazer o teste de carga com percentis exatos, adicionar testes de queda e volta do Postgres e do SQS, e um job de retenção para as tabelas que só crescem.
