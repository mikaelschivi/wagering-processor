# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores de jogos.

O sistema continua correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo**, e quando um processo morre antes ou depois do commit. As decisões técnicas, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

**O que ele faz**

- Cria wallets e mantém o saldo consistente com um **ledger** imutável.
- Recebe transações por **HTTP** e por **SQS**, com o mesmo caso de uso.
- Garante **idempotência persistente** (no banco, não em memória).
- Usa **inbox** e **outbox** transacionais, com publishers concorrentes.
- Reprocessa transações cuja referência chegou fora de ordem (`PENDING_REFERENCE`).
- Funciona com várias instâncias ao mesmo tempo.

**Stack:** Bun 1.4 · TypeScript (strict) · NestJS 11 · MikroORM 6 · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose.

**Agentes:** Claude Code com Opus 5.5 para planning e review, e Sonnet 5.5 para execução.

## Como rodar

Você precisa de [Bun](https://bun.sh) 1.4+ e Docker com Docker Compose.

**Opção 1: aplicação na sua máquina**

```bash
bun install
cp .env.example .env
docker compose up -d --wait postgres localstack
bun run migrate:up
bun run queues:create
bun run start                  # http://localhost:3000
```

**Opção 2: tudo no Docker, com 3 instâncias**

```bash
docker compose up -d --build --wait
# app-1: http://localhost:3001 · app-2: :3002 · app-3: :3003
```

> As filas do LocalStack se perdem quando ele reinicia. Se `/health/ready` responder `503`, rode `bun run queues:create`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun test` | Roda todos os testes (precisa do Postgres e do LocalStack no ar) |
| `bun run test:unit` | Só os unitários (não precisam de Docker) |
| `bun run test:concurrency` | Só os testes de concorrência, com processos reais |
| `bun run typecheck` | Checa os tipos |
| `bun run migrate:up` / `migrate:down` | Aplica / desfaz as migrations (`down` apaga os dados) |
| `bun run queues:create` | Cria as filas e a DLQ |
| `bun run dlq:redrive` | Devolve as mensagens da DLQ para a fila principal |

## API

| Rota | Para que serve |
|---|---|
| `POST /wallets` | Cria uma wallet |
| `GET /wallets/:walletId` | Saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo com o ledger |
| `POST /wagering/transactions` | Envia uma transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta uma transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness e readiness |
| `GET /metrics` | Métricas em JSON |

Exemplo:

```bash
P=$(cat /proc/sys/kernel/random/uuid)
W=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir o mesmo comando devolve `idempotentReplay: true`, e o saldo não muda. A tabela de status HTTP e de códigos de falha está no [ARCHITECTURE.md](ARCHITECTURE.md#api-status-http-e-códigos-de-falha).

## Fila SQS

A aplicação lê `wager-transactions.fifo` (mensagem `WagerTransactionRequested`, formato do enunciado). Mensagens com erro permanente vão para `wager-transactions-dlq.fifo`. Os eventos da outbox saem por `wagering-events.fifo`.

## Testes

Os testes de integração e de concorrência usam **Postgres e LocalStack reais** (nada é mockado). Cada arquivo cria o próprio banco e as próprias filas e apaga tudo no final.

| Pasta | O que cobre |
|---|---|
| `test/unit` | Regras de domínio e casos de uso (stores em memória) |
| `test/integration` | Schema e constraints, stores, rotas HTTP, consumer, outbox, métricas |
| `test/concurrency` | Processos reais da aplicação: 3 instâncias, publishers concorrentes, reinício e `SIGKILL` |

## Variáveis de ambiente

O `.env.example` traz o necessário para desenvolvimento. Os demais valores (timeouts, limites, intervalos) têm padrão em `src/globals.ts`. A aplicação **não sobe** se uma variável for inválida ou se os timeouts não forem coerentes entre si.

## Observabilidade

Logs em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` (sem valores financeiros). `x-correlation-id` volta na resposta. `GET /metrics` mostra contadores, gauges e histogramas, e o mesmo snapshot é logado a cada 30 s.
