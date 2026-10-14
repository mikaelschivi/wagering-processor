import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { DomainError, InvalidMoneyError, NotFoundError, WalletAlreadyExistsError } from "../../domain/errors";
import { RequestValidationError } from "./schemas";

interface HttpRequest {
  header(name: string): string | undefined;
}

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  type(contentType: string): HttpResponse;
  json(body: unknown): unknown;
}

interface Problem {
  status: number;
  code: string;
  title: string;
  detail: string;
  retryable: boolean;
  extra?: Record<string, unknown>;
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function toProblem(error: unknown): Problem {
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      title: "Invalid request",
      detail: error.message,
      retryable: false,
      extra: { errors: error.issues },
    };
  }
  if (error instanceof HttpException && error.getStatus() === 400) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      title: "Invalid request",
      detail: "request body is not valid JSON",
      retryable: false,
    };
  }
  if (isPayloadTooLarge(error)) {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      title: "Payload too large",
      detail: "request body is too large",
      retryable: false,
    };
  }
  if (error instanceof InvalidMoneyError) {
    return { status: 400, code: "VALIDATION_ERROR", title: "Invalid request", detail: error.message, retryable: false };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return {
      status: 409,
      code: error.code,
      title: "Wallet already exists",
      detail: error.message,
      retryable: false,
      extra: { existingWalletId: error.existingWalletId },
    };
  }
  if (error instanceof NotFoundError || (error instanceof HttpException && error.getStatus() === 404)) {
    return { status: 404, code: "NOT_FOUND", title: "Not found", detail: "resource not found", retryable: false };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal error",
    detail: "unexpected error",
    retryable: true,
  };
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    (error instanceof HttpException && error.getStatus() === 413) ||
    (error as { type?: string } | null)?.type === "entity.too.large"
  );
}

function isMapped(error: HttpException): boolean {
  return [400, 404, 413].includes(error.getStatus());
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();

    const header = request.header("x-correlation-id");
    const correlationId = header && CORRELATION_ID.test(header) ? header : Bun.randomUUIDv7();
    if (error instanceof HttpException && !isMapped(error)) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(
        typeof body === "string" ? { statusCode: error.getStatus(), message: body } : body,
      );
      return;
    }
    const { status, code, title, detail, retryable, extra } = toProblem(error);
    if (status >= 500) this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));

    response
      .status(status)
      .setHeader("x-correlation-id", correlationId);
    response.type("application/problem+json").json({
      type: `urn:wagering:error:${code}`,
      title,
      status,
      code,
      detail,
      retryable,
      correlationId,
      ...extra,
    });
  }
}
