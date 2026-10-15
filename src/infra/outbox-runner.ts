import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { OutboxPublisher } from "../application/outbox-publisher";
import { APP_CONFIG, type AppConfig } from "../config";

@Injectable()
export class OutboxRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxRunner.name);
  private readonly stopSignal = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly publisher: OutboxPublisher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.APP_ROLES.includes("outbox")) return;
    this.loop = this.publisher.run(this.stopSignal.signal, (error) => {
      this.logger.error(`outbox batch failed: ${error instanceof Error ? error.name : "unknown error"}`);
    });
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.loop;
  }
}
