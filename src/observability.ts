import { AsyncLocalStorage } from "node:async_hooks";
import { Logger, type LoggerService } from "@nestjs/common";

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
      if (route.startsWith("/health")) return;
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
