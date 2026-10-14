import { Module, type DynamicModule } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { APP_CONFIG, type AppConfig } from "./config";
import { createOrm } from "./infra/db/mikro-orm.config";
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from "./infra/http/health.controller";
import { ResourceCloser } from "./infra/shutdown";
import { createSqsClient, queueReachable, SQS_CLIENT } from "./infra/sqs/client";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MikroORM, useFactory: () => createOrm(config) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
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
