import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProcessWagerTransaction, type WagerRequest } from "../../src/application/process-wager-transaction";
import { InvariantDbError, TransientDbError, UniqueRaceError } from "../../src/application/ports";
import { FailureCode, IdempotencyKeyConflictError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let wallets: PostgresWalletStore;
let store: PostgresWagerStore;
let useCase: ProcessWagerTransaction;

beforeAll(async () => {
  db = await createTestDatabase();
  wallets = new PostgresWalletStore(db.app, db.config);
  store = new PostgresWagerStore(db.app, db.config);
  useCase = new ProcessWagerTransaction(store, new UuidV7Generator(), new SystemClock(), {
    maxAttempts: 5,
    deadlineMs: db.config.USE_CASE_DEADLINE_MS,
    jitterMinMs: 5,
    jitterMaxMs: 25,
    random: Math.random,
  });
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-03-04T05:06:07.000Z");
const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

async function openWallet(balance: string) {
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl(balance),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at,
  });
  await wallets.create(wallet, openingEntry);
  return wallet;
}

const request = (wallet: Wallet, overrides: Partial<WagerRequest> = {}): WagerRequest => ({
  providerId: "provider-1",
  externalTransactionId: crypto.randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: brl("10.00"),
  ...overrides,
});

const command = (req: WagerRequest, idempotencyKey: string = crypto.randomUUID()) => ({
  request: req,
  idempotencyKey,
  correlationId: crypto.randomUUID(),
});

function newTransaction(wallet: Wallet, overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-1",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "a".repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("10.00"),
    correlationId: "corr-1",
    createdAt: at,
    ...overrides,
  });
}

const walletRow = async (id: string) =>
  (await query("select balance, version from wallets where id = ?", [id]))[0] as { balance: string; version: number };
const countWhere = async (table: string, column: string, value: string) =>
  Number(((await query(`select count(*) as n from ${table} where ${column} = ?`, [value]))[0] as { n: string }).n);

describe("PostgresWagerStore", () => {
  test("a processed bet is stored with its ledger entry and wallet change, and reads back", async () => {
    const wallet = await openWallet("100.00");
    const tx = newTransaction(wallet);
    await store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
      const loaded = (await scope.loadWallet())!;
      const entry = loaded.debit({ money: tx.money, transactionId: tx.id, entryId: crypto.randomUUID(), at });
      tx.markProcessed({ result: { balance: loaded.balance, walletVersion: loaded.version }, at });
      await scope.save({ transaction: tx, wallet: loaded, entry });
    });

    const stored = (await store.findByIdempotencyKey(tx.providerId, tx.idempotencyKey))!;
    expect(stored.id).toBe(tx.id);
    expect(stored.status).toBe(WagerTransactionStatus.Processed);
    expect(stored.money.toString()).toBe("10.00");
    expect(stored.result?.balance.toString()).toBe("90.00");
    expect(stored.result?.walletVersion).toBe(2);
    expect(stored.processedAt).toEqual(at);
    expect(stored.createdAt).toEqual(at);
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "90.00", version: 2 });
    expect(await countWhere("wallet_ledger_entries", "transaction_id", tx.id)).toBe(1);
  });

  test("a rejected transaction is stored without touching the wallet or the ledger", async () => {
    const wallet = await openWallet("5.00");
    const tx = newTransaction(wallet);
    await store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
      const loaded = (await scope.loadWallet())!;
      tx.reject(FailureCode.InsufficientFunds, { balance: loaded.balance, walletVersion: loaded.version });
      await scope.save({ transaction: tx });
    });

    const stored = (await store.findByIdempotencyKey(tx.providerId, tx.idempotencyKey))!;
    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "5.00", version: 1 });
    expect(await countWhere("wallet_ledger_entries", "transaction_id", tx.id)).toBe(0);
  });

  test("a transaction waiting for its reference is stored with a due time", async () => {
    const wallet = await openWallet("5.00");
    const tx = newTransaction(wallet, {
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: "missing-bet",
    });
    await store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
      const loaded = (await scope.loadWallet())!;
      tx.markPendingReference({ balance: loaded.balance, walletVersion: loaded.version });
      await scope.save({ transaction: tx });
    });
    const [row] = await query(
      "select status, next_reference_attempt_at > created_at as due from wager_transactions where id = ?",
      [tx.id],
    );
    expect(row).toMatchObject({ status: "PENDING_REFERENCE", due: true });
  });

  test("lookups by external id and reversal checks see committed rows", async () => {
    const wallet = await openWallet("100.00");
    const bet = await useCase.execute(command(request(wallet, { externalTransactionId: "bet-1" })));
    const refund = await useCase.execute(
      command(request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1" })),
    );
    expect(refund.status).toBe(WagerTransactionStatus.Processed);

    await store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
      expect((await scope.findByExternalId("provider-1", "bet-1"))?.id).toBe(bet.transactionId);
      expect(await scope.findByExternalId("provider-1", "nope")).toBeUndefined();
      expect(await scope.reversalExists(bet.transactionId)).toBe(true);
      expect(await scope.reversalExists(crypto.randomUUID())).toBe(false);
    });
  });

  test("an unknown wallet loads as undefined", async () => {
    const loaded = await store.runLocked(crypto.randomUUID(), { budgetMs: 5000 }, (scope) => scope.loadWallet());
    expect(loaded).toBeUndefined();
  });

  test("work that throws leaves nothing behind", async () => {
    const wallet = await openWallet("100.00");
    const tx = newTransaction(wallet);
    await expect(
      store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
        const loaded = (await scope.loadWallet())!;
        const entry = loaded.debit({ money: tx.money, transactionId: tx.id, entryId: crypto.randomUUID(), at });
        tx.markProcessed({ result: { balance: loaded.balance, walletVersion: loaded.version }, at });
        await scope.save({ transaction: tx, wallet: loaded, entry });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.findByIdempotencyKey(tx.providerId, tx.idempotencyKey)).toBeUndefined();
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "100.00", version: 1 });
  });

  test("a duplicate idempotency key or external id surfaces as a unique race", async () => {
    const wallet = await openWallet("100.00");
    const first = newTransaction(wallet);
    const save = (tx: WagerTransaction) =>
      store.runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
        tx.reject(FailureCode.InsufficientFunds, { balance: wallet.balance, walletVersion: 1 });
        await scope.save({ transaction: tx });
      });
    await save(first);

    const sameKey = newTransaction(wallet, { idempotencyKey: first.idempotencyKey });
    const sameKeyError = await save(sameKey).catch((error) => error);
    expect(sameKeyError).toBeInstanceOf(UniqueRaceError);
    expect(sameKeyError.constraint).toBe("ux_tx_provider_idem");

    const sameExternal = newTransaction(wallet, { externalTransactionId: first.externalTransactionId });
    const sameExternalError = await save(sameExternal).catch((error) => error);
    expect(sameExternalError).toBeInstanceOf(UniqueRaceError);
    expect(sameExternalError.constraint).toBe("ux_tx_provider_external");
  });

  test("a wallet changed since it was loaded is reported as an invariant violation", async () => {
    const wallet = await openWallet("100.00");
    const tx = newTransaction(wallet);
    const error = await store
      .runLocked(wallet.id, { budgetMs: 5000 }, async (scope) => {
        const loaded = (await scope.loadWallet())!;
        const entry = loaded.debit({ money: tx.money, transactionId: tx.id, entryId: crypto.randomUUID(), at });
        tx.markProcessed({ result: { balance: loaded.balance, walletVersion: loaded.version }, at });
        const stale = Wallet.rehydrate({
          id: loaded.id,
          playerId: loaded.playerId,
          currency: loaded.currency,
          balance: loaded.balance,
          version: loaded.version + 5,
          createdAt: loaded.createdAt,
          updatedAt: loaded.updatedAt,
        });
        await scope.save({ transaction: tx, wallet: stale, entry });
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(InvariantDbError);
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "100.00", version: 1 });
  });

  test("waiting for a held wallet lock gives up inside the budget as a transient error", async () => {
    const wallet = await openWallet("100.00");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = store.runLocked(wallet.id, { budgetMs: 5000 }, async () => {
      locked();
      await held;
    });
    await holding;

    const startedAt = Date.now();
    const error = await store.runLocked(wallet.id, { budgetMs: 200 }, async () => "never").catch((caught) => caught);
    const waitedMs = Date.now() - startedAt;
    release();
    await holder;
    expect(error).toBeInstanceOf(TransientDbError);
    expect(waitedMs).toBeLessThan(db.config.TX_LOCK_TIMEOUT_MS);
    expect(await store.runLocked(wallet.id, { budgetMs: 5000 }, async () => "free again")).toBe("free again");
  });
});

describe("ProcessWagerTransaction on Postgres", () => {
  test("a repeated key replays the stored result and moves money once", async () => {
    const wallet = await openWallet("100.00");
    const cmd = command(request(wallet));
    const first = await useCase.execute(cmd);
    const second = await useCase.execute(cmd);

    expect(first).toMatchObject({ status: "PROCESSED", idempotentReplay: false, balance: { amount: "90.00" } });
    expect(second).toMatchObject({ transactionId: first.transactionId, idempotentReplay: true });
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "90.00", version: 2 });
    expect(await countWhere("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(2);
  });

  test("the same key with a different payload is a conflict", async () => {
    const wallet = await openWallet("100.00");
    const key = crypto.randomUUID();
    await useCase.execute(command(request(wallet), key));
    await expect(useCase.execute(command(request(wallet, { money: brl("11.00") }), key))).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError,
    );
  });

  test("two concurrent bets of 80 on a balance of 100: one processed, one rejected, balance 20", async () => {
    const wallet = await openWallet("100.00");
    const results = await Promise.all(
      [1, 2].map(() => useCase.execute(command(request(wallet, { money: brl("80.00") })))),
    );

    expect(results.map((result) => String(result.status)).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((result) => result.status === "REJECTED")?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "20.00", version: 2 });
    expect(await countWhere("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(2);
  });

  test("50 concurrent requests with the same key create one transaction and one debit", async () => {
    const wallet = await openWallet("100.00");
    const cmd = command(request(wallet));
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(cmd)));

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(await walletRow(wallet.id)).toMatchObject({ balance: "90.00", version: 2 });
    expect(await countWhere("wager_transactions", "wallet_id", wallet.id)).toBe(2);
  });

  test("40 concurrent distinct bets keep the balance and ledger exact", async () => {
    const wallet = await openWallet("1000.00");
    await Promise.all(Array.from({ length: 40 }, () => useCase.execute(command(request(wallet)))));

    expect(await walletRow(wallet.id)).toMatchObject({ balance: "600.00", version: 41 });
    expect(await countWhere("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(41);
  });
});
