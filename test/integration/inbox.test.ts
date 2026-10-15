import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { CONSUMER_NAME, WagerMessageHandler } from "../../src/infra/sqs/consumer";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { openingRecord } from "../helpers/fakes";

let db: TestDatabase;
let wallets: PostgresWalletStore;
let handler: WagerMessageHandler;

beforeAll(async () => {
  db = await createTestDatabase();
  wallets = new PostgresWalletStore(db.app, db.config);
  const useCase = new ProcessWagerTransaction(new PostgresWagerStore(db.app, db.config), new UuidV7Generator(), new SystemClock(), {
    maxAttempts: 5,
    deadlineMs: db.config.USE_CASE_DEADLINE_MS,
    jitterMinMs: 5,
    jitterMaxMs: 25,
    random: Math.random,
  });
  handler = new WagerMessageHandler(useCase);
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);
const at = new Date("2026-03-04T05:06:07.000Z");

async function openWallet(balance = "100.00") {
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at,
  });
  await wallets.create(wallet, openingRecord(wallet, openingEntry));
  return wallet;
}

const body = (wallet: Wallet, messageId: string, overrides: Record<string, unknown> = {}, suffix = "1") => {
  const externalId = `${wallet.id}-${suffix}`;
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...overrides,
    },
  });
};

const count = async (sql: string, params: unknown[]) => Number(((await query(sql, params))[0] as { n: string }).n);
const inboxRows = (messageId: string) =>
  count("select count(*) as n from inbox_messages where consumer_name = ? and message_id = ?", [CONSUMER_NAME, messageId]);
const balance = async (wallet: Wallet) =>
  ((await query("select balance from wallets where id = ?", [wallet.id]))[0] as { balance: string }).balance;

describe("inbox on Postgres", () => {
  test("a processed message commits its inbox row with the transaction and ledger entry", async () => {
    const wallet = await openWallet();
    const id = crypto.randomUUID();
    expect(await handler.handle(body(wallet, id))).toEqual({ action: "ack" });

    const [row] = await query(
      "select payload_hash, received_at, processed_at from inbox_messages where consumer_name = ? and message_id = ?",
      [CONSUMER_NAME, id],
    );
    expect(row).toMatchObject({ payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((row as { processed_at: unknown }).processed_at).not.toBeNull();
    expect(await balance(wallet)).toBe("75.00");
  });

  test("redelivery of the same message adds nothing", async () => {
    const wallet = await openWallet();
    const id = crypto.randomUUID();
    await handler.handle(body(wallet, id));
    const events = await count("select count(*) as n from outbox_messages where partition_key = ?", [wallet.id]);

    expect(await handler.handle(body(wallet, id))).toEqual({ action: "ack" });
    expect(await balance(wallet)).toBe("75.00");
    expect(await inboxRows(id)).toBe(1);
    expect(await count("select count(*) as n from outbox_messages where partition_key = ?", [wallet.id])).toBe(events);
  });

  test("the same message id with different content is sent to the DLQ and changes nothing", async () => {
    const wallet = await openWallet();
    const id = crypto.randomUUID();
    await handler.handle(body(wallet, id));
    const changed = body(wallet, id, { money: { amount: "26.00", currency: "BRL" } });
    expect(await handler.handle(changed)).toEqual({ action: "dlq", code: "INBOX_PAYLOAD_MISMATCH" });
    expect(await balance(wallet)).toBe("75.00");
  });

  test("a conflict rolls the inbox row back", async () => {
    const wallet = await openWallet();
    await handler.handle(body(wallet, crypto.randomUUID()));
    const id = crypto.randomUUID();
    const conflicting = body(wallet, id, { money: { amount: "30.00", currency: "BRL" } });
    expect(await handler.handle(conflicting)).toEqual({ action: "dlq", code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await inboxRows(id)).toBe(0);
  });

  test("an unknown wallet leaves no inbox row", async () => {
    const wallet = await openWallet();
    const id = crypto.randomUUID();
    const ghost = body(wallet, id, { walletId: crypto.randomUUID() });
    expect(await handler.handle(ghost)).toEqual({ action: "dlq", code: "WALLET_NOT_FOUND" });
    expect(await inboxRows(id)).toBe(0);
  });

  test("a new message id for an already processed transaction is a replay with its own inbox row", async () => {
    const wallet = await openWallet();
    await handler.handle(body(wallet, crypto.randomUUID()));
    const second = crypto.randomUUID();
    expect(await handler.handle(body(wallet, second))).toEqual({ action: "ack" });
    expect(await balance(wallet)).toBe("75.00");
    expect(await inboxRows(second)).toBe(1);
  });

  test("a rejected message is acked, stored, and still recorded in the inbox", async () => {
    const wallet = await openWallet("10.00");
    const id = crypto.randomUUID();
    expect(await handler.handle(body(wallet, id))).toEqual({ action: "ack" });
    expect(await inboxRows(id)).toBe(1);
    expect(await count("select count(*) as n from wager_transactions where wallet_id = ? and status = 'REJECTED'", [wallet.id])).toBe(1);
  });

  test("30 concurrent deliveries of the same message debit once and record one inbox row", async () => {
    const wallet = await openWallet();
    const id = crypto.randomUUID();
    const dispositions = await Promise.all(Array.from({ length: 30 }, () => handler.handle(body(wallet, id))));

    expect(dispositions.every((disposition) => disposition.action === "ack")).toBe(true);
    expect(await balance(wallet)).toBe("75.00");
    expect(await inboxRows(id)).toBe(1);
    expect(await count("select count(*) as n from wallet_ledger_entries where wallet_id = ?", [wallet.id])).toBe(2);
  });

  test("30 different messages for the same wallet process each exactly once", async () => {
    const wallet = await openWallet("1000.00");
    const dispositions = await Promise.all(
      Array.from({ length: 30 }, (_, n) => handler.handle(body(wallet, crypto.randomUUID(), {}, `n${n}`))),
    );
    expect(dispositions.every((disposition) => disposition.action === "ack")).toBe(true);
    expect(await balance(wallet)).toBe("250.00");
  });
});
