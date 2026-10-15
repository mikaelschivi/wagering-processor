import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
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
const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

async function wallet(headers: Record<string, string> = {}) {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { ...json, ...headers },
    body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  return { playerId, response, body: (await response.clone().json()) as { id: string } };
}

const wager = (w: { playerId: string; body: { id: string } }, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { ...json, "idempotency-key": crypto.randomUUID(), ...headers },
    body: JSON.stringify({
      providerId: "provider-a",
      externalTransactionId: crypto.randomUUID(),
      playerId: w.playerId,
      walletId: w.body.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    }),
  });

const accessLines = () => lines.filter((line) => line.message === "request completed");

describe("correlation id", () => {
  test("a valid header is echoed on success and on error", async () => {
    const ok = await fetch(`${baseUrl}/wallets/${crypto.randomUUID()}`, { headers: { "x-correlation-id": "corr-42" } });
    expect(ok.status).toBe(404);
    expect(ok.headers.get("x-correlation-id")).toBe("corr-42");
    expect(await ok.json()).toMatchObject({ correlationId: "corr-42" });

    const created = await wallet({ "x-correlation-id": "corr-43" });
    expect(created.response.headers.get("x-correlation-id")).toBe("corr-43");
  });

  test("a missing or invalid header gets one generated id, the same in header and error body", async () => {
    for (const header of [undefined, "has space"]) {
      const response = await fetch(`${baseUrl}/wallets/not-a-uuid`, { headers: header ? { "x-correlation-id": header } : {} });
      const id = response.headers.get("x-correlation-id");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await response.json()).toMatchObject({ correlationId: id });
    }
  });

  test("the id reaches the stored transaction, the outbox events and the access log", async () => {
    const w = await wallet();
    const response = await wager(w, { "x-correlation-id": "corr-77" });
    const { transactionId } = (await response.json()) as { transactionId: string };

    const [tx] = await query("select correlation_id from wager_transactions where id = ?", [transactionId]);
    expect(tx).toEqual({ correlation_id: "corr-77" });
    const events = await query("select payload->>'correlationId' as id from outbox_messages where payload->'data'->>'transactionId' = ?", [transactionId]);
    expect(events).toEqual([{ id: "corr-77" }, { id: "corr-77" }]);
    expect(accessLines().find((line) => line.correlationId === "corr-77")).toBeDefined();
  });

  test("the opening events of a wallet carry the request's id", async () => {
    const w = await wallet({ "x-correlation-id": "corr-open" });
    const rows = await query("select payload->>'correlationId' as id from outbox_messages where partition_key = ?", [w.body.id]);
    expect(rows).toEqual([{ id: "corr-open" }, { id: "corr-open" }]);
  });
});

describe("access log", () => {
  test("one line per request with route, status, duration and the correlation fields", async () => {
    const w = await wallet();
    lines.length = 0;
    const response = await wager(w, { "x-correlation-id": "corr-log" });
    const { transactionId } = (await response.json()) as { transactionId: string };
    const [line, ...rest] = accessLines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: "info",
      context: "http",
      method: "POST",
      route: "/wagering/transactions",
      status: 200,
      correlationId: "corr-log",
      walletId: w.body.id,
      providerId: "provider-a",
      transactionId,
    });
    expect(typeof line!.durationMs).toBe("number");
  });

  test("no log line carries amounts, balances, bodies or the idempotency key", async () => {
    const w = await wallet();
    const key = `secret-key-${crypto.randomUUID()}`;
    await wager(w, { "idempotency-key": key });
    await fetch(`${baseUrl}/wallets/${w.body.id}`);
    const text = JSON.stringify(lines);
    for (const forbidden of ["25.00", "75.00", "100.00", key, w.playerId]) expect(text).not.toContain(forbidden);
  });

  test("failed requests are logged with their status", async () => {
    await fetch(`${baseUrl}/wallets/not-a-uuid`);
    expect(accessLines().at(-1)).toMatchObject({ status: 400, method: "GET" });
  });

  test("health checks and metrics visits are not logged", async () => {
    await fetch(`${baseUrl}/health/live`);
    await fetch(`${baseUrl}/metrics`);
    expect(accessLines()).toEqual([]);
  });
});

describe("body size limit", () => {
  const post = (path: string, size: number, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...json, ...headers },
      body: JSON.stringify({ filler: "x".repeat(size) }),
    });

  test("a body over 16 KiB is a 413 problem on every write route", async () => {
    for (const path of ["/wallets", "/wagering/transactions"]) {
      const response = await post(path, 20_000, { "idempotency-key": "k" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
    }
  });

  test("a body just under the limit is read and judged on its content", async () => {
    const response = await post("/wagering/transactions", 15_000, { "idempotency-key": "k" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
