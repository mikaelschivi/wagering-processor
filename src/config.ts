import { z } from "zod";
import * as defaults from "./globals";
import { nestingViolations } from "./globals";

export const APP_CONFIG = Symbol("APP_CONFIG");

const APP_ROLES = ["api", "consumer", "outbox", "reference-worker"] as const;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ROLES: z
    .string()
    .default(APP_ROLES.join(","))
    .transform((value) => value.split(",").map((role) => role.trim()).filter(Boolean))
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),
  TX_LOCK_TIMEOUT_MS: positiveInt(defaults.TX_LOCK_TIMEOUT_MS),
  TX_STATEMENT_TIMEOUT_MS: positiveInt(defaults.TX_STATEMENT_TIMEOUT_MS),
  TX_IDLE_IN_TX_TIMEOUT_MS: positiveInt(defaults.TX_IDLE_IN_TX_TIMEOUT_MS),
  USE_CASE_DEADLINE_MS: positiveInt(defaults.USE_CASE_DEADLINE_MS),
  SQS_VISIBILITY_TIMEOUT_S: positiveInt(defaults.SQS_VISIBILITY_TIMEOUT_S),
  SQS_VISIBILITY_SAFETY_MARGIN_S: positiveInt(defaults.SQS_VISIBILITY_SAFETY_MARGIN_S),
  SQS_RETRY_BACKOFF_CAP_S: positiveInt(defaults.SQS_RETRY_BACKOFF_CAP_S),
  REFERENCE_CLAIM_BATCH: positiveInt(defaults.REFERENCE_CLAIM_BATCH),
  REFERENCE_PROCESS_CONCURRENCY: positiveInt(defaults.REFERENCE_PROCESS_CONCURRENCY),
  REFERENCE_CLAIM_LEASE_S: positiveInt(defaults.REFERENCE_CLAIM_LEASE_S),
  OUTBOX_SQS_REQUEST_TIMEOUT_MS: positiveInt(defaults.OUTBOX_SQS_REQUEST_TIMEOUT_MS),
  OUTBOX_TX_IDLE_TIMEOUT_MS: positiveInt(defaults.OUTBOX_TX_IDLE_TIMEOUT_MS),
  SHUTDOWN_DRAIN_MS: positiveInt(defaults.SHUTDOWN_DRAIN_MS),
});

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${issues.join("; ")}`);
  }
  const violations = nestingViolations(parsed.data);
  if (violations.length > 0) {
    throw new ConfigError(`Timeout nesting violated: ${violations.join("; ")}`);
  }
  return parsed.data;
}
