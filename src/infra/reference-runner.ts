import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PendingReferenceWorker } from "../application/pending-reference-worker";
import { APP_CONFIG, type AppConfig } from "../config";

@Injectable()
export class ReferenceRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReferenceRunner.name);
  private readonly stopSignal = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly worker: PendingReferenceWorker,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.APP_ROLES.includes("reference-worker")) return;
    this.loop = this.worker.run(this.stopSignal.signal, (error) => {
      this.logger.error(`reference batch failed: ${error instanceof Error ? error.name : "unknown error"}`);
    });
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.loop;
  }
}
