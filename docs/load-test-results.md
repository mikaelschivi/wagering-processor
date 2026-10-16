# Resultado do teste de carga

Gerado por `bun run test:load` em 2026-10-16T13:12:55.029Z.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | 12th Gen Intel(R) Core(TM) i5-1235U, 12 CPUs lógicas, 15.3 GB de RAM |
| Sistema | 6.18.42-1-cachyos-lts |
| Bun | 1.4.0 |
| Commit | 94b491f (com alterações não commitadas) |
| Instâncias da aplicação | 3 (http://localhost:3001, http://localhost:3002, http://localhost:3003), cada uma com todos os papéis |
| Infraestrutura | postgres:16.4, localstack/localstack:4.0.3 (Docker Compose, na mesma máquina) |

## Método

- O gerador de carga roda na mesma máquina da aplicação, do Postgres e do LocalStack, então os números absolutos **não** representam um ambiente de produção. Vale comparar as fases entre si.
- 100 wallets com saldo inicial alto (para que não haja rejeição por saldo) e 1 wallet quente. Semente aleatória: 1. Concorrência: 60 requisições em voo. As requisições se espalham em rodízio pelas 3 instâncias.
- **muitas wallets:** 1500 rodadas (`BET` e depois `WIN` ou `LOSS` referenciando a aposta, 70% / 30%). Cerca de 10% das apostas são reenviadas com a mesma chave e devem voltar como replay.
- **wallet quente:** 500 apostas de 1,00 na mesma wallet, todas em paralelo.
- **fora de ordem:** 40 `REFUND` enviados antes da sua `BET` (esperado: `202`); mede o tempo até o worker resolver.
- Um `503` ou erro de rede é reenviado com a mesma `Idempotency-Key` (até 20 vezes), como o contrato pede ao provedor. A latência de cada requisição inclui as tentativas.
- Os percentis são **exatos**, calculados sobre o tempo de cada requisição medido no cliente (nearest-rank).

## Resultados por fase

| Fase | Requisições | Req/s | p50 (ms) | p90 | p95 | p99 | máx | Erros | Retries |
|---|---|---|---|---|---|---|---|---|---|
| muitas wallets | 3162 | 746 | 80.2 | 104.1 | 112.6 | 123.5 | 143.1 | 0 | 0 |
| wallet quente | 500 | 234 | 249.9 | 312.8 | 322.7 | 340.3 | 349.0 | 0 | 0 |
| fora de ordem | 80 | 237 | 40.4 | 70.3 | 74.1 | 81.5 | 81.5 | 0 | 0 |
| **total** | 3742 | | 83.1 | 203.8 | 269.8 | 317.2 | 349.0 | 0 | 0 |

Taxa de erro: 0.00%. Um erro é qualquer resposta diferente da esperada naquela fase.

## Referências fora de ordem

40 de 40 `REFUND` foram resolvidos pelo worker. Tempo entre a chegada da `BET` e o `REFUND` ficar `PROCESSED` (ms): p50 120.1, p95 215.7, máx 226.4.

## Do lado do servidor

| Métrica | Valor |
|---|---|
| Transações novas processadas (contador, soma das instâncias, durante o teste) | 3580 |
| Replays idempotentes | 162 |
| Retries internos do caso de uso | 0 |
| Conflitos de lock (deadlock ou lock timeout) | 0 |
| Espera pelo lock da wallet (desde o início das instâncias) | p99 estimado (por bucket) até 250.0 ms, máx 299.0 ms |
| Atraso da outbox no fim (`outbox_lag_seconds`) | 0 s |
| Tempo para a outbox esvaziar depois da carga | 0.8 s |
| Mensagens na DLQ | 0 |

## Correção depois da carga

- Wallets conferidas: 101. Reconciliação consistente: **101 de 101**.
- Saldo diferente do esperado pelo cliente (saldo inicial menos apostas mais ganhos): **0**.

## Limitações deste teste

- Gerador e sistema compartilham CPU, memória e disco; o Docker em laptop e o LocalStack não são o ambiente real.
- Não há aquecimento separado das medições nem repetição para medir variância. Rode mais de uma vez para ver a variação.
- A fase "wallet quente" mostra o custo do lock por wallet: as operações da mesma wallet são sequenciais.
- Os contadores do servidor são por instância e somados aqui. Os percentis do servidor são estimativas por bucket; os percentis da tabela acima são os exatos.
