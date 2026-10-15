import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { OutboxPublisher } from "./application/outbox-publisher";
import { Clock, EventSender, IdGenerator, OutboxStore, ProviderIdentityPort, WagerStore, WalletStore } from "./application/ports";
import { Reconciliation } from "./application/reconciliation";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { APP_CONFIG, type AppConfig } from "./config";
import { createOrm } from "./infra/db/mikro-orm.config";
import { PostgresOutboxStore } from "./infra/db/postgres-outbox-store";
import { PostgresWagerStore } from "./infra/db/postgres-wager-store";
import { PostgresWalletStore } from "./infra/db/postgres-wallet-store";
import { AnonymousDevIdentity, AuthGuard } from "./infra/http/auth";
import { WagerTransactionsController, WalletsController } from "./infra/http/controllers";
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from "./infra/http/health.controller";
import { ProblemDetailsFilter } from "./infra/http/problem-details.filter";
import { OutboxRunner } from "./infra/outbox-runner";
import { ResourceCloser } from "./infra/shutdown";
import { ConsumerRunner, consumerLogger, SqsConsumer, WagerMessageHandler } from "./infra/sqs/consumer";
import { createSqsClient, queueReachable, SQS_CLIENT } from "./infra/sqs/client";
import { createProducerClient, SQS_PRODUCER_CLIENT, SqsEventSender } from "./infra/sqs/producer";
import { SystemClock, UuidV7Generator } from "./infra/system";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, identity: ProviderIdentityPort = new AnonymousDevIdentity()): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WagerTransactionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: ProviderIdentityPort, useValue: identity },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: Clock, useClass: SystemClock },
        { provide: IdGenerator, useClass: UuidV7Generator },
        {
          provide: CreateWallet,
          inject: [WalletStore, IdGenerator, Clock],
          useFactory: (store: WalletStore, ids: IdGenerator, clock: Clock) => new CreateWallet(store, ids, clock),
        },
        {
          provide: Reconciliation,
          inject: [WalletStore],
          useFactory: (store: WalletStore) => new Reconciliation(store),
        },
        { provide: MikroORM, useFactory: () => createOrm(config) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        {
          provide: WalletStore,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new PostgresWalletStore(orm, config),
        },
        {
          provide: WagerStore,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new PostgresWagerStore(orm, config),
        },
        {
          provide: ProcessWagerTransaction,
          inject: [WagerStore, IdGenerator, Clock],
          useFactory: (store: WagerStore, ids: IdGenerator, clock: Clock) =>
            new ProcessWagerTransaction(store, ids, clock, {
              maxAttempts: config.USE_CASE_MAX_ATTEMPTS,
              deadlineMs: config.USE_CASE_DEADLINE_MS,
              jitterMinMs: config.RETRY_JITTER_MIN_MS,
              jitterMaxMs: config.RETRY_JITTER_MAX_MS,
              random: Math.random,
            }),
        },
        { provide: SQS_PRODUCER_CLIENT, useFactory: () => createProducerClient(config) },
        {
          provide: EventSender,
          inject: [SQS_PRODUCER_CLIENT],
          useFactory: (client: SQSClient) => SqsEventSender.forConfig(client, config),
        },
        {
          provide: OutboxStore,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new PostgresOutboxStore(orm, config),
        },
        {
          provide: OutboxPublisher,
          inject: [OutboxStore, EventSender, Clock],
          useFactory: (store: OutboxStore, sender: EventSender, clock: Clock) =>
            new OutboxPublisher(store, sender, clock, {
              batchSize: config.OUTBOX_BATCH_SIZE,
              intervalMs: config.OUTBOX_INTERVAL_MS,
            }),
        },
        OutboxRunner,
        {
          provide: WagerMessageHandler,
          inject: [ProcessWagerTransaction],
          useFactory: (useCase: ProcessWagerTransaction) => new WagerMessageHandler(useCase),
        },
        {
          provide: SqsConsumer,
          inject: [SQS_CLIENT, WagerMessageHandler, Clock],
          useFactory: (sqs: SQSClient, handler: WagerMessageHandler, clock: Clock) =>
            new SqsConsumer(sqs, handler, config, clock, consumerLogger()),
        },
        ConsumerRunner,
        {
          provide: READINESS_CHECKS,
          inject: [MikroORM, SQS_CLIENT],
          useFactory: (orm: MikroORM, sqs: SQSClient): ReadinessCheck[] => [
            {
              name: "postgres",
              timeoutMs: config.READY_DB_TIMEOUT_MS,
              run: () => orm.em.fork().execute("select 1"),
            },
            {
              name: "sqs",
              timeoutMs: config.READY_SQS_TIMEOUT_MS,
              run: queueReachable(sqs, config.WAGER_QUEUE_NAME),
            },
          ],
        },
        ResourceCloser,
      ],
    };
  }
}
