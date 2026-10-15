import { describe, expect, test } from "bun:test";
import { InvariantDbError, TransientDbError } from "../../src/application/ports";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { CONSUMER_NAME, MAX_MESSAGE_BYTES, WagerMessageHandler } from "../../src/infra/sqs/consumer";
import { FixedClock, SequentialIds } from "../helpers/fakes";
import { InMemoryWagerStore } from "../helpers/in-memory-wager-store";

const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const t0 = new Date("2026-02-03T04:05:06.000Z");

function setup(balance = "100.00") {
  const store = new InMemoryWagerStore();
  store.seedWallet(
    Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: "BRL",
      balance: Money.from({ amount: balance, currency: "BRL" }),
      version: 1,
      createdAt: t0,
      updatedAt: t0,
    }),
  );
  const useCase = new ProcessWagerTransaction(store, new SequentialIds(), new FixedClock(), {
    maxAttempts: 1,
    deadlineMs: 10_000,
    jitterMinMs: 1,
    jitterMaxMs: 1,
    random: () => 0,
  });
  return { store, handler: new WagerMessageHandler(useCase) };
}

const data = (overrides: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  idempotencyKey: "provider-a:transaction-123",
  playerId,
  walletId,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

const message = (dataOverrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: "msg-1",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: data(dataOverrides),
    ...envelope,
  });

describe("WagerMessageHandler: processing", () => {
  test("a valid bet is applied, recorded in the inbox and acked", async () => {
    const { store, handler } = setup();
    expect(await handler.handle(message())).toEqual({ action: "ack" });
    expect(store.balanceOf(walletId)).toBe("75.00");
    expect(store.inbox.has(`${CONSUMER_NAME}:msg-1`)).toBe(true);
    const [processed] = store.events.map((event) => event.toJSON());
    expect(processed).toMatchObject({ correlationId: "msg-1", causationId: "msg-1" });
  });

  test("a redelivered message is acked without a second debit or second events", async () => {
    const { store, handler } = setup();
    await handler.handle(message());
    expect(await handler.handle(message())).toEqual({ action: "ack" });
    expect(store.balanceOf(walletId)).toBe("75.00");
    expect(store.entries).toHaveLength(1);
    expect(store.events).toHaveLength(2);
  });

  test("occurredAt does not count: a re-serialized duplicate is still a duplicate", async () => {
    const { store, handler } = setup();
    await handler.handle(message());
    const again = message({}, { occurredAt: "2026-07-29T15:00:09.000Z" });
    expect(await handler.handle(again)).toEqual({ action: "ack" });
    expect(store.balanceOf(walletId)).toBe("75.00");
  });

  test("the same transaction under a new message id is a replay, not a second debit", async () => {
    const { store, handler } = setup();
    await handler.handle(message());
    expect(await handler.handle(message({}, { messageId: "msg-2" }))).toEqual({ action: "ack" });
    expect(store.balanceOf(walletId)).toBe("75.00");
    expect(store.inbox.has(`${CONSUMER_NAME}:msg-2`)).toBe(true);
  });

  test("business rejections and pending references are acked", async () => {
    const { handler } = setup("5.00");
    expect(await handler.handle(message())).toEqual({ action: "ack" });
    const win = message(
      { kind: "WIN", externalTransactionId: "w1", idempotencyKey: "k-w1", referenceExternalTransactionId: "later" },
      { messageId: "msg-w1" },
    );
    expect(await handler.handle(win)).toEqual({ action: "ack" });
  });
});

describe("WagerMessageHandler: permanent failures go to the DLQ", () => {
  test("the same message id with a different payload", async () => {
    const { store, handler } = setup();
    await handler.handle(message());
    const changed = message({ money: { amount: "26.00", currency: "BRL" } });
    expect(await handler.handle(changed)).toEqual({ action: "dlq", code: "INBOX_PAYLOAD_MISMATCH" });
    expect(store.balanceOf(walletId)).toBe("75.00");
  });

  test("an idempotency key reused with another payload leaves no inbox row behind", async () => {
    const { store, handler } = setup();
    await handler.handle(message());
    const conflicting = message({ money: { amount: "30.00", currency: "BRL" } }, { messageId: "msg-2" });
    expect(await handler.handle(conflicting)).toEqual({ action: "dlq", code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(store.inbox.has(`${CONSUMER_NAME}:msg-2`)).toBe(false);
  });

  test("an external id reused under another key", async () => {
    const { handler } = setup();
    await handler.handle(message());
    const other = message({ idempotencyKey: "another-key" }, { messageId: "msg-2" });
    expect(await handler.handle(other)).toEqual({ action: "dlq", code: "EXTERNAL_TRANSACTION_ID_CONFLICT" });
  });

  test("an unknown wallet", async () => {
    const { store, handler } = setup();
    const unknown = message({ walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" });
    expect(await handler.handle(unknown)).toEqual({ action: "dlq", code: "WALLET_NOT_FOUND" });
    expect(store.inbox.size).toBe(0);
  });

  test.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["an unknown type", message({}, { type: "SomethingElse" })],
    ["an extra envelope field", message({}, { extra: 1 })],
    ["an extra data field", message({ extra: 1 })],
    ["a missing messageId", message({}, { messageId: undefined })],
    ["a bad occurredAt", message({}, { occurredAt: "yesterday" })],
    ["a malformed wallet id", message({ walletId: "nope" })],
    ["an amount without two decimals", message({ money: { amount: "25", currency: "BRL" } })],
    ["a negative amount", message({ money: { amount: "-25.00", currency: "BRL" } })],
    ["the internal OPENING kind", message({ kind: "OPENING" })],
    ["a refund without a reference", message({ kind: "REFUND" })],
    ["a bad idempotency key", message({ idempotencyKey: "has space" })],
    ["a body over the size limit", message({ gameId: "g".repeat(MAX_MESSAGE_BYTES) })],
  ])("%s is a validation error", async (_name, body) => {
    const { store, handler } = setup();
    expect(await handler.handle(body)).toEqual({ action: "dlq", code: "VALIDATION_ERROR" });
    expect(store.balanceOf(walletId)).toBe("100.00");
    expect(store.inbox.size).toBe(0);
  });
});

describe("WagerMessageHandler: transient and unexpected failures are retried", () => {
  test("a transient database error", async () => {
    const { store, handler } = setup();
    store.failNext(new TransientDbError("deadlock"));
    expect(await handler.handle(message())).toEqual({ action: "retry", code: "TRANSIENT_FAILURE" });
    expect(store.balanceOf(walletId)).toBe("100.00");
    expect(store.inbox.size).toBe(0);
  });

  test("a failure after the inbox insert rolls the inbox row back, so the redelivery is processed", async () => {
    const { store, handler } = setup();
    store.failNextSave = new TransientDbError("lock timeout");
    expect(await handler.handle(message())).toEqual({ action: "retry", code: "TRANSIENT_FAILURE" });
    expect(store.inbox.size).toBe(0);
    expect(await handler.handle(message())).toEqual({ action: "ack" });
    expect(store.balanceOf(walletId)).toBe("75.00");
  });

  test("an invariant violation and an unknown error are retried as internal errors", async () => {
    const { store, handler } = setup();
    store.failNext(new InvariantDbError("23514", "ck_x"));
    expect(await handler.handle(message())).toEqual({ action: "retry", code: "INTERNAL_ERROR" });
    store.failNext(new TypeError("bug"));
    expect(await handler.handle(message())).toEqual({ action: "retry", code: "INTERNAL_ERROR" });
  });
});
