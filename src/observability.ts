import { AsyncLocalStorage } from "node:async_hooks";
import { Logger, type LoggerService } from "@nestjs/common";
import { type Labels, Metrics } from "./application/ports";

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SENSITIVE_KEY = /amount|balance|money|payload|body|authorization|password|secret/i;
const storage = new AsyncLocalStorage<LogFields>();

export const runWithContext = <T>(fields: LogFields, work: () => T): T => storage.run(fields, work);

export function addLogContext(fields: LogFields): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export const currentLogContext = (): LogFields => ({ ...storage.getStore() });

export function correlationIdFrom(header: string | undefined): string {
  return header && CORRELATION_ID.test(header) ? header : Bun.randomUUIDv7();
}

export const currentCorrelationId = (): string => storage.getStore()?.correlationId ?? Bun.randomUUIDv7();

type Level = "debug" | "info" | "warn" | "error";

export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(message: unknown, ...rest: unknown[]) {
    this.emit("info", message, rest);
  }

  warn(message: unknown, ...rest: unknown[]) {
    this.emit("warn", message, rest);
  }

  error(message: unknown, ...rest: unknown[]) {
    this.emit("error", message, rest);
  }

  debug(message: unknown, ...rest: unknown[]) {
    this.emit("debug", message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]) {
    this.emit("debug", message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]) {
    const strings = rest.filter((item): item is string => typeof item === "string");
    const context = strings.at(-1);
    const stack = level === "error" && strings.length > 1 ? strings[0] : undefined;
    this.write(
      JSON.stringify({
        time: this.now().toISOString(),
        level,
        ...(context && { context }),
        ...this.describe(message),
        ...currentLogContext(),
        ...(stack && { stack }),
      }),
    );
  }

  private describe(message: unknown): Record<string, unknown> {
    if (typeof message === "string") return { message };
    if (message instanceof Error) return { message: message.name };
    if (message !== null && typeof message === "object") {
      return Object.fromEntries(Object.entries(message).filter(([key]) => !SENSITIVE_KEY.test(key)));
    }
    return { message: String(message) };
  }
}

interface HttpRequest {
  method: string;
  route?: { path?: string };
  header(name: string): string | undefined;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: "finish", listener: () => void): unknown;
}

export function correlationMiddleware() {
  const logger = new Logger("http");
  return (request: HttpRequest, response: HttpResponse, next: () => void) => {
    const fields: LogFields = { correlationId: correlationIdFrom(request.header("x-correlation-id")) };
    response.setHeader("x-correlation-id", fields.correlationId as string);
    const startedAt = performance.now();
    response.on("finish", () => {
      const route = request.route?.path ?? "unmatched";
      if (route.startsWith("/health") || route === "/metrics") return;
      runWithContext(fields, () =>
        logger.log({
          message: "request completed",
          method: request.method,
          route,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    });
    runWithContext(fields, next);
  };
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  count: number;
  sum: number;
  max: number;
  buckets: number[];
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; max: number; p50: number; p95: number; p99: number }>;
}

const percentile = (histogram: Histogram, quantile: number): number => {
  const target = Math.ceil(histogram.count * quantile);
  const index = histogram.buckets.findIndex((cumulative) => cumulative >= target);
  const bound = index === -1 ? histogram.max : (BUCKETS[index] ?? histogram.max);
  return Math.min(bound, histogram.max);
};

const seriesKey = (name: string, labels: Labels = {}): string => {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`);
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
};

export class InMemoryMetrics extends Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  count(name: string, labels?: Labels, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, seconds: number, labels?: Labels): void {
    const key = seriesKey(name, labels);
    const histogram = this.histograms.get(key) ?? { count: 0, sum: 0, max: 0, buckets: BUCKETS.map(() => 0) };
    histogram.count++;
    histogram.sum += seconds;
    histogram.max = Math.max(histogram.max, seconds);
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    });
    this.histograms.set(key, histogram);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  counter(name: string, labels?: Labels): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }

  gaugeValue(name: string, labels?: Labels): number | undefined {
    return this.gauges.get(seriesKey(name, labels));
  }

  samples(name: string, labels?: Labels): number {
    return this.histograms.get(seriesKey(name, labels))?.count ?? 0;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms].map(([key, histogram]) => [
          key,
          {
            count: histogram.count,
            sum: Number(histogram.sum.toFixed(6)),
            max: Number(histogram.max.toFixed(6)),
            p50: percentile(histogram, 0.5),
            p95: percentile(histogram, 0.95),
            p99: percentile(histogram, 0.99),
          },
        ]),
      ),
    };
  }
}
