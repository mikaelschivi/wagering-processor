import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { MetricsReporter } from "../../src/infra/metrics-reporter";
import { JsonLogger } from "../../src/observability";
import { type BootedApp, bootApp } from "../helpers/app";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let booted: BootedApp;
let baseUrl: string;
let lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  booted = await bootApp(db.config);
  baseUrl = booted.baseUrl;
}, 30_000);

afterAll(async () => {
  await booted.close();
  await db.drop();
});

beforeEach(() => {
  lines = [];
  Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
});

afterEach(() => Logger.overrideLogger(false));

const json = { "content-type": "application/json" };
const snapshots = () => lines.filter((line) => line.message === "metrics snapshot");

async function traffic() {
  const playerId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  const { id: walletId } = (await created.json()) as { id: string };
  const send = (kind: string, extra: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { ...json, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: crypto.randomUUID(),
        playerId,
        walletId,
        roundId: "r",
        gameId: "g",
        kind,
        money: { amount: "25.00", currency: "BRL" },
        ...extra,
      }),
    });
  return { send };
}

describe("GET /metrics", () => {
  test("shows fresh gauges on every visit, without waiting for the 30 second report", async () => {
    const first = (await (await fetch(`${baseUrl}/metrics`)).json()) as { gauges: Record<string, number> };
    expect(first.gauges).toHaveProperty("outbox_pending");
    expect(first.gauges).toHaveProperty("pending_reference_count");

    const { send } = await traffic();
    await send("WIN", { referenceExternalTransactionId: "never-arrives" });
    const second = (await (await fetch(`${baseUrl}/metrics`)).json()) as { gauges: Record<string, number> };
    expect(second.gauges.pending_reference_count).toBe(first.gauges.pending_reference_count! + 1);
    expect(second.gauges.outbox_pending).toBeGreaterThan(first.gauges.outbox_pending!);
  });

  test("still answers when the queue is down, and counts the failed sample", async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { counters: Record<string, number>; gauges: Record<string, number> };
    expect(body.counters["metric_sampling_failures_total{source=dlq depth}"]).toBeGreaterThanOrEqual(1);
    expect(body.gauges).not.toHaveProperty("sqs_dlq_depth");
  });
});

describe("GET /metrics with a queue that never answers", () => {
  test("gives up on the queue after the readiness timeout instead of hanging", async () => {
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    const other = await createTestDatabase();
    const { createApp } = await import("../../src/infra/http/setup");
    const { AppModule } = await import("../../src/app.module");
    const app = await createApp(
      AppModule.forRoot({
        ...other.config,
        APP_ROLES: ["api"],
        METRICS_LOG_INTERVAL_S: 0,
        READY_SQS_TIMEOUT_MS: 300,
        AWS_ENDPOINT_URL: `http://127.0.0.1:${silent.port}`,
      }),
      { logger: false },
    );
    await app.listen(0);
    try {
      const startedAt = Date.now();
      const response = await fetch(`${await app.getUrl()}/metrics`);
      const body = (await response.json()) as { counters: Record<string, number>; gauges: Record<string, number> };
      expect(response.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(body.counters["metric_sampling_failures_total{source=dlq depth}"]).toBe(1);
      expect(body.gauges).toHaveProperty("outbox_pending");
    } finally {
      await app.close();
      silent.stop(true);
      await other.drop();
    }
  }, 30_000);
});

describe("MetricsReporter", () => {
  test("a snapshot carries the counters, latency histogram and sampled gauges", async () => {
    const { send } = await traffic();
    expect((await send("BET")).status).toBe(200);
    expect((await send("WIN", { referenceExternalTransactionId: "missing" })).status).toBe(202);

    await booted.app.get(MetricsReporter).tick();
    const [snapshot] = snapshots() as unknown as {
      counters: Record<string, number>;
      gauges: Record<string, number>;
      histograms: Record<string, { count: number }>;
    }[];

    expect(snapshot!.counters["wager_transactions_total{kind=BET,status=PROCESSED}"]).toBeGreaterThanOrEqual(1);
    expect(snapshot!.counters["wager_transactions_total{kind=WIN,status=PENDING_REFERENCE}"]).toBeGreaterThanOrEqual(1);
    expect(snapshot!.histograms["processing_seconds{source=http}"]!.count).toBeGreaterThanOrEqual(2);
    expect(snapshot!.histograms.wallet_lock_wait_seconds!.count).toBeGreaterThanOrEqual(2);
    expect(snapshot!.gauges.outbox_pending).toBeGreaterThanOrEqual(5);
    expect(snapshot!.gauges.outbox_lag_seconds).toBeGreaterThanOrEqual(0);
    expect(snapshot!.gauges.pending_reference_count).toBeGreaterThanOrEqual(1);
  });

  test("an unreachable queue is a counted sampling failure, not a crash, and the other gauges still report", async () => {
    await booted.app.get(MetricsReporter).tick();
    const [snapshot] = snapshots() as unknown as { counters: Record<string, number>; gauges: Record<string, number> }[];
    expect(snapshot!.counters["metric_sampling_failures_total{source=dlq depth}"]).toBeGreaterThanOrEqual(1);
    expect(snapshot!.gauges).not.toHaveProperty("sqs_dlq_depth");
    expect(snapshot!.gauges).toHaveProperty("outbox_pending");
    expect(lines.some((line) => line.level === "warn" && String(line.message).startsWith("sampling dlq depth failed"))).toBe(true);
  });

  test("a snapshot never contains amounts, balances or request data", async () => {
    const { send } = await traffic();
    await send("BET");
    await booted.app.get(MetricsReporter).tick();
    const text = JSON.stringify(snapshots());
    for (const forbidden of ["25.00", "75.00", "100.00", "provider-a"]) expect(text).not.toContain(forbidden);
  });

  test("the reporter logs on its own every interval and once more on shutdown", async () => {
    const other = await createTestDatabase();
    const { createApp } = await import("../../src/infra/http/setup");
    const { AppModule } = await import("../../src/app.module");
    const app = await createApp(
      AppModule.forRoot({ ...other.config, APP_ROLES: ["api"], METRICS_LOG_INTERVAL_S: 1, AWS_ENDPOINT_URL: "http://127.0.0.1:1" }),
      { logger: false },
    );
    await app.listen(0);
    Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
    try {
      lines.length = 0;
      await Bun.sleep(1500);
      expect(snapshots().length).toBeGreaterThanOrEqual(1);
      lines.length = 0;
    } finally {
      await app.close();
    }
    expect(snapshots()).toHaveLength(1);
    await other.drop();
  }, 30_000);

  test("an interval of zero turns the periodic report off", async () => {
    const other = await createTestDatabase();
    const { createApp } = await import("../../src/infra/http/setup");
    const { AppModule } = await import("../../src/app.module");
    const app = await createApp(
      AppModule.forRoot({ ...other.config, APP_ROLES: ["api"], METRICS_LOG_INTERVAL_S: 0, AWS_ENDPOINT_URL: "http://127.0.0.1:1" }),
      { logger: false },
    );
    await app.listen(0);
    Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
    try {
      lines.length = 0;
      await Bun.sleep(1300);
      expect(snapshots()).toEqual([]);
    } finally {
      await app.close();
    }
    await other.drop();
  }, 30_000);
});
