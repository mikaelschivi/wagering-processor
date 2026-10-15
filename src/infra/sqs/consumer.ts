import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import {
  DomainError,
  ExternalTransactionIdConflictError,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
  InboxPayloadMismatchError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  MoneyOverflowError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../domain/errors";
import { Money } from "../../domain/money";
import { canonicalJson } from "../../domain/wager-transaction";
import { idempotencyKey, wagerFields } from "../http/schemas";

export const CONSUMER_NAME = "wager-consumer";
export const MESSAGE_TYPE = "WagerTransactionRequested";
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type Disposition =
  | { action: "ack" }
  | { action: "dlq"; code: string }
  | { action: "retry"; code: string };

const envelope = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal(MESSAGE_TYPE),
    occurredAt: z.string().datetime(),
    data: z.object({ ...wagerFields, idempotencyKey }).strict(),
  })
  .strict();

class InvalidMessageError extends Error {}

function parse(body: string) {
  if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) throw new InvalidMessageError("message is too large");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError("message is not valid JSON");
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) throw new InvalidMessageError("message does not match the envelope");

  const { messageId, type, data } = parsed.data;
  const { idempotencyKey: key, money, ...fields } = data;
  return {
    messageId,
    idempotencyKey: key,
    request: { ...fields, money: Money.from(money) },
    messageHash: createHash("sha256").update(canonicalJson({ type, data })).digest("hex"),
  };
}

const PERMANENT = [
  IdempotencyKeyConflictError,
  ExternalTransactionIdConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
  ForbiddenProviderError,
];

const INVALID = [InvalidMoneyError, MoneyOverflowError, InvalidWagerTransactionError, InvalidMessageError];

export function classify(error: unknown): Disposition {
  if (INVALID.some((type) => error instanceof type)) return { action: "dlq", code: "VALIDATION_ERROR" };
  if (error instanceof DomainError && PERMANENT.some((type) => error instanceof type)) {
    return { action: "dlq", code: error.code };
  }
  if (error instanceof TransientInfrastructureError) return { action: "retry", code: error.code };
  return { action: "retry", code: "INTERNAL_ERROR" };
}

export class WagerMessageHandler {
  constructor(private readonly processWager: ProcessWagerTransaction) {}

  async handle(body: string): Promise<Disposition> {
    try {
      const message = parse(body);
      await this.processWager.execute({
        request: message.request,
        actor: { kind: "trusted-internal" },
        idempotencyKey: message.idempotencyKey,
        correlationId: message.messageId,
        causationId: message.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: message.messageId, messageHash: message.messageHash },
      });
      return { action: "ack" };
    } catch (error) {
      return classify(error);
    }
  }
}
