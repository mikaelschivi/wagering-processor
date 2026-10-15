import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { correlationMiddleware, InMemoryMetrics } from "./observability";
import { OutboxPublisher } from "./application/outbox-publisher";
import { PendingReferenceWorker } from "./application/pending-reference-worker";
import { Clock, EventSender, IdGenerator, Metrics, OutboxStore, ProviderIdentityPort, WagerStore, WalletStore } from "./application/ports";
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
import { MetricsReporter } from "./infra/metrics-reporter";
import { OutboxRunner } from "./infra/outbox-runner";
import { ReferenceRunner } from "./infra/reference-runner";
import { LifecycleState, ResourceCloser, ShutdownCoordinator } from "./infra/shutdown";
import { ConsumerRunner, consumerLogger, SqsConsumer, WagerMessageHandler } from "./infra/sqs/consumer";
import { createSqsClient, queueReachable, SQS_CLIENT } from "./infra/sqs/client";
import { createProducerClient, SQS_PRODUCER_CLIENT, SqsEventSender } from "./infra/sqs/producer";
import { SystemClock, UuidV7Generator } from "./infra/system";

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware()).forRoutes("*");
  }

  static forRoot(config: AppConfig, identity: ProviderIdentityPort = new AnonymousDevIdentity()): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WagerTransactionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: ProviderIdentityPort, useValue: identity },
        { provide: APP_GUARD, useClass: AuthGuard },
        InMemoryMetrics,
        { provide: Metrics, useExisting: InMemoryMetrics },
        { provide: Clock, useClass: SystemClock },
        { provide: IdGenerator, useClass: UuidV7Generator },
        {
          provide: CreateWallet,
          inject: [WalletStore, IdGenerator, Clock],
          useFactory: (store: WalletStore, ids: IdGenerator, clock: Clock) => new CreateWallet(store, ids, clock),
        },
        {
          provide: Reconciliation,
          inject: [WalletStore, Metrics],
          useFactory: (store: WalletStore, metrics: Metrics) => new Reconciliation(store, metrics),
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
          inject: [MikroORM, Metrics],
          useFactory: (orm: MikroORM, metrics: Metrics) => new PostgresWagerStore(orm, config, metrics),
        },
        {
          provide: ProcessWagerTransaction,
          inject: [WagerStore, IdGenerator, Clock, Metrics],
          useFactory: (store: WagerStore, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
            new ProcessWagerTransaction(
              store,
              ids,
              clock,
              {
                maxAttempts: config.USE_CASE_MAX_ATTEMPTS,
                deadlineMs: config.USE_CASE_DEADLINE_MS,
                jitterMinMs: config.RETRY_JITTER_MIN_MS,
                jitterMaxMs: config.RETRY_JITTER_MAX_MS,
                random: Math.random,
              },
              metrics,
            ),
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
          inject: [OutboxStore, EventSender, Clock, Metrics],
          useFactory: (store: OutboxStore, sender: EventSender, clock: Clock, metrics: Metrics) =>
            new OutboxPublisher(
              store,
              sender,
              clock,
              { batchSize: config.OUTBOX_BATCH_SIZE, intervalMs: config.OUTBOX_INTERVAL_MS },
              metrics,
            ),
        },
        OutboxRunner,
        {
          provide: PendingReferenceWorker,
          inject: [WagerStore, IdGenerator, Clock, Metrics],
          useFactory: (store: WagerStore, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
            new PendingReferenceWorker(
              store,
              ids,
              clock,
              {
                batch: config.REFERENCE_CLAIM_BATCH,
                concurrency: config.REFERENCE_PROCESS_CONCURRENCY,
                leaseS: config.REFERENCE_CLAIM_LEASE_S,
                intervalMs: config.REFERENCE_WORKER_INTERVAL_MS,
                ttlMs: config.REFERENCE_TTL_MS,
                maxFailures: config.REFERENCE_MAX_FAILURES,
                budgetMs: config.USE_CASE_DEADLINE_MS,
              },
              Math.random,
              metrics,
            ),
        },
        ReferenceRunner,
        {
          provide: WagerMessageHandler,
          inject: [ProcessWagerTransaction],
          useFactory: (useCase: ProcessWagerTransaction) => new WagerMessageHandler(useCase),
        },
        {
          provide: SqsConsumer,
          inject: [SQS_CLIENT, WagerMessageHandler, Clock, Metrics],
          useFactory: (sqs: SQSClient, handler: WagerMessageHandler, clock: Clock, metrics: Metrics) =>
            new SqsConsumer(sqs, handler, config, clock, consumerLogger(), Math.random, metrics),
        },
        ConsumerRunner,
        {
          provide: MetricsReporter,
          inject: [InMemoryMetrics, OutboxStore, WagerStore, SQS_CLIENT],
          useFactory: (metrics: InMemoryMetrics, outbox: OutboxStore, wagers: WagerStore, sqs: SQSClient) =>
            new MetricsReporter(config, metrics, outbox, wagers, sqs),
        },
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
        LifecycleState,
        ShutdownCoordinator,
        ResourceCloser,
      ],
    };
  }
}
