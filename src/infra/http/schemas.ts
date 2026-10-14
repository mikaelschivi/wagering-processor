import { z } from "zod";

export class RequestValidationError extends Error {
  constructor(readonly issues: { path: string; reason: string }[]) {
    super("request validation failed");
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
