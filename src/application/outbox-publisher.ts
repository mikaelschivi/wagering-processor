import { OUTBOX_BACKOFF_CAP_S } from "../globals";
import { type Clock, type EventSender, type Metrics, NullMetrics, type OutboxFailure, type OutboxMessage, type OutboxStore } from "./ports";

const MAX_ERROR_LENGTH = 500;

export interface OutboxPublisherOptions {
  batchSize: number;
  intervalMs: number;
}

export interface PublishReport {
  claimed: number;
  published: number;
  failed: number;
}

export const retryDelayMs = (attempts: number): number => Math.min(2 ** attempts, OUTBOX_BACKOFF_CAP_S) * 1000;

function describe(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${error.name}:${code}` : error.name;
}

export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly sender: EventSender,
    private readonly clock: Clock,
    private readonly options: OutboxPublisherOptions,
    private readonly metrics: Metrics = new NullMetrics(),
  ) {}

  publishBatch(): Promise<PublishReport> {
    return this.store.withBatch(this.options.batchSize, async (batch) => {
      const { messages } = batch;
      if (messages.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const failures = await this.send(messages);
      const failedIds = new Set(failures.map((failure) => failure.id));
      const published = messages.filter((message) => !failedIds.has(message.id)).map((message) => message.id);
      const attempts = new Map(messages.map((message) => [message.id, message.attempts]));
      const retries: OutboxFailure[] = failures.map(({ id, error }) => ({
        id,
        error: error.slice(0, MAX_ERROR_LENGTH),
        retryInMs: retryDelayMs((attempts.get(id) ?? 0) + 1),
      }));

      if (published.length > 0) await batch.markPublished(published);
      if (retries.length > 0) await batch.markFailed(retries);
      this.metrics.count("outbox_publish_total", { result: "published" }, published.length);
      this.metrics.count("outbox_publish_total", { result: "failed" }, retries.length);
      return { claimed: messages.length, published: published.length, failed: retries.length };
    });
  }

  async run(signal: AbortSignal, onError: (error: unknown) => void): Promise<void> {
    while (!signal.aborted) {
      try {
        const report = await this.publishBatch();
        if (report.claimed >= this.options.batchSize) continue;
      } catch (error) {
        onError(error);
      }
      await this.pause(signal);
    }
  }

  private async send(messages: OutboxMessage[]) {
    try {
      return await this.sender.send(messages);
    } catch (error) {
      const reason = describe(error);
      return messages.map((message) => ({ id: message.id, error: reason }));
    }
  }

  private pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      this.clock.sleep(this.options.intervalMs).then(resolve);
    });
  }
}
