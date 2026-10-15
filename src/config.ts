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
  DB_HOST: z.string().min(1).default("localhost"),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1).default("wagering"),
  DB_APP_USER: z.string().min(1).default("wagering_app"),
  DB_APP_PASSWORD: z.string().min(1),
  DB_OWNER_USER: z.string().min(1).default("wagering_owner"),
  DB_OWNER_PASSWORD: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  SUPPORTED_CURRENCIES: z
    .string()
    .default(defaults.DEFAULT_SUPPORTED_CURRENCIES)
    .transform((value) => value.split(",").map((currency) => currency.trim()))
    .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)),
  WAGER_QUEUE_NAME: z.string().min(1).default("wager-transactions.fifo"),
  WAGER_DLQ_NAME: z.string().min(1).default("wager-transactions-dlq.fifo"),
  EVENTS_QUEUE_NAME: z.string().min(1).default("wagering-events.fifo"),
  SQS_MAX_RECEIVE_COUNT: positiveInt(defaults.SQS_MAX_RECEIVE_COUNT),
  READY_DB_TIMEOUT_MS: positiveInt(defaults.READY_DB_TIMEOUT_MS),
  READY_SQS_TIMEOUT_MS: positiveInt(defaults.READY_SQS_TIMEOUT_MS),
  TX_LOCK_TIMEOUT_MS: positiveInt(defaults.TX_LOCK_TIMEOUT_MS),
  TX_STATEMENT_TIMEOUT_MS: positiveInt(defaults.TX_STATEMENT_TIMEOUT_MS),
  TX_IDLE_IN_TX_TIMEOUT_MS: positiveInt(defaults.TX_IDLE_IN_TX_TIMEOUT_MS),
  USE_CASE_DEADLINE_MS: positiveInt(defaults.USE_CASE_DEADLINE_MS),
  USE_CASE_MAX_ATTEMPTS: positiveInt(defaults.USE_CASE_MAX_ATTEMPTS),
  RETRY_JITTER_MIN_MS: positiveInt(defaults.RETRY_JITTER_MIN_MS),
  RETRY_JITTER_MAX_MS: positiveInt(defaults.RETRY_JITTER_MAX_MS),
  SQS_VISIBILITY_TIMEOUT_S: positiveInt(defaults.SQS_VISIBILITY_TIMEOUT_S),
  SQS_VISIBILITY_SAFETY_MARGIN_S: positiveInt(defaults.SQS_VISIBILITY_SAFETY_MARGIN_S),
  SQS_RETRY_BACKOFF_CAP_S: positiveInt(defaults.SQS_RETRY_BACKOFF_CAP_S),
  REFERENCE_CLAIM_BATCH: positiveInt(defaults.REFERENCE_CLAIM_BATCH),
  REFERENCE_PROCESS_CONCURRENCY: positiveInt(defaults.REFERENCE_PROCESS_CONCURRENCY),
  REFERENCE_CLAIM_LEASE_S: positiveInt(defaults.REFERENCE_CLAIM_LEASE_S),
  REFERENCE_WORKER_INTERVAL_MS: positiveInt(defaults.REFERENCE_WORKER_INTERVAL_MS),
  REFERENCE_TTL_MS: positiveInt(defaults.REFERENCE_TTL_MS),
  REFERENCE_MAX_FAILURES: positiveInt(defaults.REFERENCE_MAX_FAILURES),
  OUTBOX_SQS_REQUEST_TIMEOUT_MS: positiveInt(defaults.OUTBOX_SQS_REQUEST_TIMEOUT_MS),
  METRICS_LOG_INTERVAL_S: z.coerce.number().int().min(0).default(defaults.METRICS_LOG_INTERVAL_S),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(defaults.SQS_WAIT_TIME_S),
  SQS_CONSUMER_CONCURRENCY: positiveInt(defaults.SQS_CONSUMER_CONCURRENCY),
  OUTBOX_INTERVAL_MS: positiveInt(defaults.OUTBOX_INTERVAL_MS),
  OUTBOX_BATCH_SIZE: positiveInt(defaults.OUTBOX_BATCH_SIZE),
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
