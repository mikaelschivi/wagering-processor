import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { type Metrics, type OutboxStore, type WagerStore } from "../application/ports";
import { APP_CONFIG, type AppConfig } from "../config";
import type { InMemoryMetrics } from "../observability";

@Injectable()
export class MetricsReporter implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("metrics");
  private timer: ReturnType<typeof setInterval> | undefined;
  private dlqUrl: string | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: InMemoryMetrics,
    private readonly outbox: OutboxStore,
    private readonly wagers: WagerStore,
    private readonly sqs: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.METRICS_LOG_INTERVAL_S === 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.METRICS_LOG_INTERVAL_S * 1000);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.report();
  }

  async tick(): Promise<void> {
    await this.sample();
    this.report();
  }

  report(): void {
    this.logger.log({ message: "metrics snapshot", ...this.metrics.snapshot() });
  }

  async sample(): Promise<void> {
    await Promise.all([
      this.sampling("outbox", async () => {
        const { pending, oldestAgeSeconds } = await this.outbox.stats();
        this.metrics.gauge("outbox_pending", pending);
        this.metrics.gauge("outbox_lag_seconds", Math.round(oldestAgeSeconds));
      }),
      this.sampling("pending references", async () =>
        this.metrics.gauge("pending_reference_count", await this.wagers.pendingReferenceCount()),
      ),
      this.sampling("dlq depth", async () => this.metrics.gauge("sqs_dlq_depth", await this.dlqDepth())),
    ]);
  }

  private async dlqDepth(): Promise<number> {
    const abortSignal = AbortSignal.timeout(this.config.READY_SQS_TIMEOUT_MS);
    this.dlqUrl ??= (
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.WAGER_DLQ_NAME }), { abortSignal })
    ).QueueUrl;
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
      { abortSignal },
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  private async sampling(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.metrics.count("metric_sampling_failures_total", { source: what });
      this.logger.warn(`sampling ${what} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }
}
