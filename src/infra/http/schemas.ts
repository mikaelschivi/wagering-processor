import { z } from "zod";
import { WagerTransactionKind } from "../../domain/wager-transaction";

export class RequestValidationError extends Error {
  constructor(readonly issues: { path: string; reason: string }[]) {
    super("request validation failed");
  }
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdFrom(header: string | undefined): string {
  return header && CORRELATION_ID.test(header) ? header : Bun.randomUUIDv7();
}

export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super("Idempotency-Key header is required");
  }
}

export function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new RequestValidationError(
    parsed.error.issues.map((issue) => ({ path: issue.path.join("."), reason: issue.code })),
  );
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const walletParams = z.object({ walletId: uuid }).strict();

export function createWalletBody(currencies: string[]) {
  return z
    .object({
      playerId: uuid,
      initialBalance: z
        .object({
          amount: z.string(),
          currency: z.string().refine((currency) => currencies.includes(currency)),
        })
        .strict(),
    })
    .strict();
}

const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

export const idempotencyKey = z.string().regex(/^[\x21-\x7E]{1,200}$/);

export function requireIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === "") throw new MissingIdempotencyKeyError();
  return validate(idempotencyKey, header);
}

export const wagerBody = z
  .object({
    providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    externalTransactionId: identifier,
    playerId: uuid,
    walletId: uuid,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z.object({ amount: z.string(), currency: z.string() }).strict(),
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict();

export const transactionParams = z.object({ transactionId: uuid }).strict();

export const providerTransactionParams = z
  .object({ providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), externalTransactionId: identifier })
  .strict();

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 100;

export const encodeCursor = (walletVersion: number): string =>
  Buffer.from(JSON.stringify({ v: 1, w: walletVersion })).toString("base64url");

function decodeCursor(cursor: string): number {
  try {
    const parsed = z
      .object({ v: z.literal(1), w: z.number().int().min(1) })
      .strict()
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.w;
  } catch {
    throw new RequestValidationError([{ path: "cursor", reason: "invalid_cursor" }]);
  }
}

export const ledgerQuery = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_LEDGER_LIMIT))
      .default(String(DEFAULT_LEDGER_LIMIT)),
  })
  .strict()
  .transform(({ cursor, limit }) => ({ limit, ...(cursor !== undefined && { beforeVersion: decodeCursor(cursor) }) }));
