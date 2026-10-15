import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationShutdown } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { APP_CONFIG, type AppConfig } from "../config";
import { OutboxRunner } from "./outbox-runner";
import { SQS_CLIENT } from "./sqs/client";
import { ConsumerRunner } from "./sqs/consumer";
import { SQS_PRODUCER_CLIENT } from "./sqs/producer";

@Injectable()
export class LifecycleState {
  draining = false;
}

@Injectable()
export class ShutdownCoordinator implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinator.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly state: LifecycleState,
    private readonly consumer: ConsumerRunner,
    private readonly outbox: OutboxRunner,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    this.state.draining = true;
    const stopped = Promise.all([this.consumer.stop(), this.outbox.stop()]).then(() => true);
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), this.config.SHUTDOWN_DRAIN_MS));
    if (!(await Promise.race([stopped, timedOut]))) {
      this.logger.error(`in-flight work did not finish within ${this.config.SHUTDOWN_DRAIN_MS}ms`);
    }
  }
}

@Injectable()
export class ResourceCloser implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_PRODUCER_CLIENT) private readonly producer: SQSClient,
  ) {}

  async onApplicationShutdown() {
    this.sqs.destroy();
    this.producer.destroy();
    await this.orm.close();
  }
}
