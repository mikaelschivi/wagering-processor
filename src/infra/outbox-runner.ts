import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { OutboxPublisher } from "../application/outbox-publisher";
import { APP_CONFIG, type AppConfig } from "../config";

@Injectable()
export class OutboxRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRunner.name);
  private readonly stop = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly publisher: OutboxPublisher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.APP_ROLES.includes("outbox")) return;
    this.loop = this.publisher.run(this.stop.signal, (error) => {
      this.logger.error(`outbox batch failed: ${error instanceof Error ? error.name : "unknown error"}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.loop;
  }
}
