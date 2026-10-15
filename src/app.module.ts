import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { Clock, IdGenerator, WagerStore, WalletStore } from "./application/ports";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { APP_CONFIG, type AppConfig } from "./config";
import { createOrm } from "./infra/db/mikro-orm.config";
import { PostgresWagerStore } from "./infra/db/postgres-wager-store";
import { PostgresWalletStore } from "./infra/db/postgres-wallet-store";
import { WagerTransactionsController, WalletsController } from "./infra/http/controllers";
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from "./infra/http/health.controller";
import { ProblemDetailsFilter } from "./infra/http/problem-details.filter";
import { ResourceCloser } from "./infra/shutdown";
import { createSqsClient, queueReachable, SQS_CLIENT } from "./infra/sqs/client";
import { SystemClock, UuidV7Generator } from "./infra/system";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WagerTransactionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: Clock, useClass: SystemClock },
        { provide: IdGenerator, useClass: UuidV7Generator },
        {
          provide: CreateWallet,
          inject: [WalletStore, IdGenerator, Clock],
          useFactory: (store: WalletStore, ids: IdGenerator, clock: Clock) => new CreateWallet(store, ids, clock),
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
