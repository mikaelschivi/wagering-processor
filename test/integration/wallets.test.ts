import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({
    PORT: "0",
    DB_APP_PASSWORD: "unused",
    DB_HOST: "127.0.0.1",
    DB_PORT: "1",
    AWS_ENDPOINT_URL: "http://127.0.0.1:1",
  });
  app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const newPlayer = (): string => crypto.randomUUID();
const payload = (amount = "1000.00", playerId: string = newPlayer(), currency = "BRL") => ({
  playerId,
  initialBalance: { amount, currency },
});

describe("POST /wallets", () => {
  test("creates a wallet and returns the contract shape", async () => {
    const body = payload("1000.00");
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId: body.playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
  });

  test("accepts a zero initial balance", async () => {
    const response = await post(payload("0.00"));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ balance: { amount: "0.00" }, version: 1 });
  });

  test("lowercases the player id", async () => {
    const playerId = newPlayer();
    const response = await post(payload("1.00", playerId.toUpperCase()));
    expect(((await response.json()) as { playerId: string }).playerId).toBe(playerId);
  });

  test("a duplicate player and currency is a 409 naming the existing wallet", async () => {
    const body = payload("10.00");
    const first = (await (await post(body)).json()) as { id: string };
    const second = await post(body);
    expect(second.status).toBe(409);
    expect(second.headers.get("content-type")).toContain("application/problem+json");
    expect(await second.json()).toMatchObject({
      type: "urn:wagering:error:WALLET_ALREADY_EXISTS",
      status: 409,
      code: "WALLET_ALREADY_EXISTS",
      retryable: false,
      existingWalletId: first.id,
    });
  });

  test("the same player can hold a wallet per currency", async () => {
    const playerId = newPlayer();
    expect((await post(payload("1.00", playerId, "BRL"))).status).toBe(201);
    expect((await post(payload("1.00", playerId, "USD"))).status).toBe(201);
  });

  test("parallel duplicate creates yield exactly one 201", async () => {
    const body = payload("5.00");
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  });

  test.each([
    ["amount without decimals", payload("25")],
    ["amount with 3 decimals", payload("25.001")],
    ["negative amount", payload("-1.00")],
    ["scientific notation", payload("1e2")],
    ["amount as a number", { playerId: newPlayer(), initialBalance: { amount: 25, currency: "BRL" } }],
    ["unsupported currency", payload("1.00", newPlayer(), "EUR")],
    ["lowercase currency", payload("1.00", newPlayer(), "brl")],
    ["missing player", { initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["player not a uuid", payload("1.00", "player-1")],
    ["missing balance", { playerId: newPlayer() }],
    ["unknown top-level field", { ...payload("1.00"), extra: 1 }],
    ["unknown balance field", { playerId: newPlayer(), initialBalance: { amount: "1.00", currency: "BRL", x: 1 } }],
    ["null body", null],
  ])("rejects %s with a 400 problem", async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({
      type: "urn:wagering:error:VALIDATION_ERROR",
      status: 400,
      code: "VALIDATION_ERROR",
      retryable: false,
    });
  });

  test.each([
    ["malformed JSON", "{bad json"],
    ["a bare null", "null"],
    ["a bare string", '"text"'],
    ["an empty body", ""],
  ])("%s is a 400 problem that does not echo the input", async (_name, raw) => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as { code: string; detail: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.detail).not.toContain("bad");
  });

  test("an oversize body is a 413 problem", async () => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(200_000) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
  });

  test("validation errors list field paths but never echo values", async () => {
    const response = await post(payload("12345.678", newPlayer(), "BRL"));
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toContain("12345");
  });

  test("bad input creates nothing", async () => {
    const playerId = newPlayer();
    await post(payload("25", playerId));
    expect((await post(payload("25.00", playerId))).status).toBe(201);
  });
});

describe("GET /wallets/:walletId", () => {
  test("returns the wallet that was created", async () => {
    const created = (await (await post(payload("42.00"))).json()) as { id: string };
    const response = await fetch(`${baseUrl}/wallets/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: created.id, balance: { amount: "42.00" }, version: 1 });
  });

  test("an unknown wallet is a 404 problem", async () => {
    const response = await fetch(`${baseUrl}/wallets/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND", status: 404, retryable: false });
  });

  test("a malformed id is a 400, not a 404", async () => {
    const response = await fetch(`${baseUrl}/wallets/not-a-uuid`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("problem details", () => {
  test("echoes a valid correlation id", async () => {
    const response = await fetch(`${baseUrl}/wallets/bad`, { headers: { "x-correlation-id": "req-123.abc" } });
    expect(response.headers.get("x-correlation-id")).toBe("req-123.abc");
    expect(await response.json()).toMatchObject({ correlationId: "req-123.abc" });
  });

  test("replaces an invalid correlation id", async () => {
    const response = await fetch(`${baseUrl}/wallets/bad`, { headers: { "x-correlation-id": "bad id!" } });
    const body = (await response.json()) as { correlationId: string };
    expect(body.correlationId).not.toBe("bad id!");
    expect(body.correlationId.length).toBeGreaterThan(10);
  });
});
