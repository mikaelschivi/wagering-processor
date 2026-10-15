import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type BootedApp, bootApp } from "../helpers/app";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let booted: BootedApp;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  booted = await bootApp(db.config);
  baseUrl = booted.baseUrl;
}, 30_000);

afterAll(async () => {
  await booted.close();
  await db.drop();
});

const json = { "content-type": "application/json" };

async function createWallet(amount = "1000.00", currency = "BRL") {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  const wallet = (await response.json()) as { id: string };
  return { playerId, walletId: wallet.id };
}

type Wallet = Awaited<ReturnType<typeof createWallet>>;

const payload = (wallet: Wallet, overrides: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: crypto.randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.walletId,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

const submit = (body: unknown, key: string | null = crypto.randomUUID(), headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { ...json, ...(key === null ? {} : { "idempotency-key": key }), ...headers },
    body: JSON.stringify(body),
  });

const balanceOf = async (wallet: Wallet) =>
  ((await (await fetch(`${baseUrl}/wallets/${wallet.walletId}`)).json()) as { balance: { amount: string } }).balance.amount;

describe("POST /wagering/transactions", () => {
  test("processes a bet, returns the contract shape and echoes the correlation id", async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet), crypto.randomUUID(), { "x-correlation-id": "corr-123" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBe("corr-123");
    expect(await response.json()).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toBe("975.00");
  });

  test("a repeated request replays the same result and moves money once", async () => {
    const wallet = await createWallet();
    const body = payload(wallet);
    const key = crypto.randomUUID();
    const first = (await (await submit(body, key)).json()) as { transactionId: string };
    const second = await submit(body, key);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ transactionId: first.transactionId, idempotentReplay: true });
    expect(await balanceOf(wallet)).toBe("975.00");
  });

  test("a win and a loss follow the bet", async () => {
    const wallet = await createWallet();
    const bet = payload(wallet, { externalTransactionId: "bet-1" });
    await submit(bet);
    const win = await submit(
      payload(wallet, { kind: "WIN", externalTransactionId: "win-1", referenceExternalTransactionId: "bet-1", money: { amount: "50.00", currency: "BRL" } }),
    );
    expect(win.status).toBe(200);
    expect(await balanceOf(wallet)).toBe("1025.00");
    const loss = await submit(
      payload(wallet, { kind: "LOSS", externalTransactionId: "loss-1", referenceExternalTransactionId: "bet-1", money: { amount: "0.00", currency: "BRL" } }),
    );
    expect(loss.status).toBe(200);
    expect(await balanceOf(wallet)).toBe("1025.00");
  });

  test("a missing Idempotency-Key is a 400 with its own code", async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet), null);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "MISSING_IDEMPOTENCY_KEY", retryable: false });
  });

  test("a malformed Idempotency-Key is a validation error", async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet), "has a space");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test.each([
    ["an unknown field", { extra: true }],
    ["a bad wallet id", { walletId: "nope" }],
    ["the internal OPENING kind", { kind: "OPENING" }],
    ["an unsupported kind", { kind: "TIP" }],
    ["an amount without two decimals", { money: { amount: "25", currency: "BRL" } }],
    ["a negative amount", { money: { amount: "-1.00", currency: "BRL" } }],
    ["a zero bet", { money: { amount: "0.00", currency: "BRL" } }],
    ["a bad provider id", { providerId: "Provider A" }],
    ["a refund without a reference", { kind: "REFUND" }],
    ["a bet with a reference", { referenceExternalTransactionId: "other" }],
    ["a reference to itself", { kind: "WIN", externalTransactionId: "same", referenceExternalTransactionId: "same" }],
  ])("%s is a 400 validation error that never echoes the input", async (_name, overrides) => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet, overrides));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
  });

  test("a body that is not JSON is a 400", async () => {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { ...json, "idempotency-key": "k" },
      body: "{broken",
    });
    expect(response.status).toBe(400);
  });

  test("the same key with a different payload is a 409 conflict, not a replay", async () => {
    const wallet = await createWallet();
    const key = crypto.randomUUID();
    const body = payload(wallet);
    await submit(body, key);
    const response = await submit({ ...body, money: { amount: "26.00", currency: "BRL" } }, key);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", retryable: false });
    expect(await balanceOf(wallet)).toBe("975.00");
  });

  test("an external id reused under a new key is a 409 conflict", async () => {
    const wallet = await createWallet();
    const body = payload(wallet);
    await submit(body);
    const response = await submit(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "EXTERNAL_TRANSACTION_ID_CONFLICT" });
  });

  test("a bet above the balance is a 422 result with the stored failure code, and replays as the same 422", async () => {
    const wallet = await createWallet("10.00");
    const key = crypto.randomUUID();
    const body = payload(wallet);
    const first = await submit(body, key);
    expect(first.status).toBe(422);
    expect(first.headers.get("content-type")).toContain("application/json");
    expect(first.headers.get("content-type")).not.toContain("problem");
    expect(await first.json()).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00" },
      idempotentReplay: false,
    });
    const replay = await submit(body, key);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ status: "REJECTED", idempotentReplay: true });
  });

  test("a currency that differs from the wallet is a rejected result", async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet, { money: { amount: "5.00", currency: "USD" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
  });

  test("a win whose bet is unknown is accepted as 202 pending", async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet, { kind: "WIN", referenceExternalTransactionId: "not-yet" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: false });
    expect(await balanceOf(wallet)).toBe("1000.00");
  });

  test("an unknown wallet is a 422 problem, not a stored result", async () => {
    const wallet = await createWallet();
    const response = await submit(payload({ ...wallet, walletId: crypto.randomUUID() }));
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "WALLET_NOT_FOUND", retryable: false });
  });

  test("two concurrent bets of 80 on a balance of 100 give one 200 and one 422", async () => {
    const wallet = await createWallet("100.00");
    const money = { amount: "80.00", currency: "BRL" };
    const responses = await Promise.all([1, 2].map(() => submit(payload(wallet, { money }))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await balanceOf(wallet)).toBe("20.00");
  });

  test("50 concurrent identical requests process once", async () => {
    const wallet = await createWallet();
    const body = payload(wallet);
    const key = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body, key)));
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
      transactionId: string;
      idempotentReplay: boolean;
    }[];
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(bodies.map((item) => item.transactionId)).size).toBe(1);
    expect(bodies.filter((item) => !item.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(wallet)).toBe("975.00");
  });
});

describe("transaction lookups", () => {
  test("a stored transaction is readable by id and by provider and external id", async () => {
    const wallet = await createWallet();
    const body = payload(wallet, { externalTransactionId: "lookup-1" });
    const { transactionId } = (await (await submit(body)).json()) as { transactionId: string };

    const expected = {
      transactionId,
      providerId: "provider-a",
      externalTransactionId: "lookup-1",
      walletId: wallet.walletId,
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
    };
    const byId = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject(expected);
    const byExternal = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/lookup-1`);
    expect(byExternal.status).toBe(200);
    expect(await byExternal.json()).toMatchObject(expected);
  });

  test("a rejected transaction shows its failure code", async () => {
    const wallet = await createWallet("1.00");
    const { transactionId } = (await (await submit(payload(wallet))).json()) as { transactionId: string };
    const response = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`);
    expect(await response.json()).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  });

  test("unknown transactions are 404 and malformed ids are 400", async () => {
    expect((await fetch(`${baseUrl}/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/missing`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/wagering/transactions/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/providers/Bad Provider/wagering/transactions/x`)).status).toBe(400);
  });
});
