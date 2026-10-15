import { beforeAll, describe, expect, test } from "bun:test";
import { Logger, ServiceUnavailableException, type ArgumentsHost } from "@nestjs/common";
import {
  ExternalTransactionIdConflictError,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
  InsufficientFundsError,
  InvalidWagerTransactionError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../src/domain/errors";
import { MissingIdempotencyKeyError } from "../../src/infra/http/schemas";
import { ProblemDetailsFilter } from "../../src/infra/http/problem-details.filter";

beforeAll(() => Logger.overrideLogger(false));

function run(error: unknown) {
  const sent: { status?: number; headers: Record<string, string>; type?: string; body?: unknown } = { headers: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      sent.headers[name] = value;
    },
    type(contentType: string) {
      sent.type = contentType;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ header: () => undefined }), getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(error, host);
  return sent;
}

describe("ProblemDetailsFilter", () => {
  test("an unexpected error is a 500 problem that hides the cause", () => {
    const sent = run(new Error("password=hunter2 failed at db"));
    expect(sent.status).toBe(500);
    expect(sent.type).toBe("application/problem+json");
    expect(sent.body).toMatchObject({ code: "INTERNAL_ERROR", status: 500, retryable: true });
    expect(JSON.stringify(sent.body)).not.toContain("hunter2");
  });

  test("a domain error without a mapping is also a 500 problem", () => {
    expect(run(new InsufficientFundsError("x")).status).toBe(500);
  });

  test("an HttpException with its own body passes through unchanged", () => {
    const body = { status: "unavailable", checks: { postgres: "down", sqs: "up" } };
    const sent = run(new ServiceUnavailableException(body));
    expect(sent.status).toBe(503);
    expect(sent.type).toBeUndefined();
    expect(sent.body).toEqual(body);
  });

  test("every problem carries a correlation id header and body field", () => {
    const sent = run(new Error("boom"));
    const id = sent.headers["x-correlation-id"];
    expect(id).toBeTruthy();
    expect(sent.body).toMatchObject({ correlationId: id });
  });

  test.each([
    [new IdempotencyKeyConflictError("x"), 409, "IDEMPOTENCY_KEY_CONFLICT", false],
    [new ExternalTransactionIdConflictError("x"), 409, "EXTERNAL_TRANSACTION_ID_CONFLICT", false],
    [new ForbiddenProviderError("x"), 403, "FORBIDDEN_PROVIDER", false],
    [new WalletNotFoundError("x"), 422, "WALLET_NOT_FOUND", false],
    [new MissingIdempotencyKeyError(), 400, "MISSING_IDEMPOTENCY_KEY", false],
    [new InvalidWagerTransactionError("x"), 400, "VALIDATION_ERROR", false],
    [new TransientInfrastructureError("x"), 503, "TRANSIENT_FAILURE", true],
  ])("%p maps to %p %p", (error, status, code, retryable) => {
    const sent = run(error);
    expect(sent.status).toBe(status);
    expect(sent.body).toMatchObject({ code, retryable });
  });

  test("a transient failure tells the client when to retry", () => {
    expect(run(new TransientInfrastructureError("x")).headers["retry-after"]).toBe("1");
  });
});
