import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WalletAlreadyExistsError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { LedgerDirection, Wallet, WalletLedgerEntry } from "../../src/domain/wallet";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { inTransaction } from "../../src/infra/db/transaction";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let store: PostgresWalletStore;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new PostgresWalletStore(db.app, db.config);
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-03-04T05:06:07.000Z");
const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

function open(balance: string, playerId: string = crypto.randomUUID()) {
  return Wallet.open({
    id: crypto.randomUUID(),
    playerId,
    initialBalance: brl(balance),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at,
  });
}

const count = async (table: string) => Number(((await query(`select count(*) as n from ${table}`))[0] as { n: string }).n);

describe("PostgresWalletStore", () => {
  test("a stored wallet reads back with the same state", async () => {
    const { wallet, openingEntry } = open("123.45");
    await store.create(wallet, openingEntry);
    const loaded = (await store.findById(wallet.id))!;
    expect(loaded.id).toBe(wallet.id);
    expect(loaded.playerId).toBe(wallet.playerId);
    expect(loaded.currency).toBe("BRL");
    expect(loaded.balance.toString()).toBe("123.45");
    expect(loaded.version).toBe(1);
    expect(loaded.createdAt).toEqual(at);
    expect(loaded.updatedAt).toEqual(at);
  });

  test("an unknown wallet reads back as undefined", async () => {
    expect(await store.findById(crypto.randomUUID())).toBeUndefined();
  });

  test("the opening entry is stored with its transaction and ties out to the balance", async () => {
    const { wallet, openingEntry } = open("50.00");
    await store.create(wallet, openingEntry);
    const [row] = await query(
      `select t.kind, t.provider_id, t.status, t.result_balance, l.direction, l.balance_before, l.balance_after, l.wallet_version
         from wager_transactions t join wallet_ledger_entries l on l.transaction_id = t.id where t.wallet_id = ?`,
      [wallet.id],
    );
    expect(row).toEqual({
      kind: "OPENING",
      provider_id: "__internal__",
      status: "PROCESSED",
      result_balance: "50.00",
      direction: "CREDIT",
      balance_before: "0.00",
      balance_after: "50.00",
      wallet_version: 1,
    });
    const [sum] = await query(
      "select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0) as total from wallet_ledger_entries where wallet_id = ?",
      [wallet.id],
    );
    expect(sum).toEqual({ total: "50.00" });
  });

  test("a wallet with no opening entry stores only the wallet", async () => {
    const { wallet, openingEntry } = open("0.00");
    expect(openingEntry).toBeUndefined();
    await store.create(wallet);
    expect(await store.findById(wallet.id)).toBeDefined();
    const [row] = await query("select count(*) as n from wager_transactions where wallet_id = ?", [wallet.id]);
    expect(row).toEqual({ n: "0" });
  });

  test("a duplicate player and currency names the existing wallet and writes nothing", async () => {
    const first = open("10.00");
    await store.create(first.wallet, first.openingEntry);
    const before = [await count("wallets"), await count("wager_transactions"), await count("wallet_ledger_entries")];

    const second = open("20.00", first.wallet.playerId);
    const error = await store.create(second.wallet, second.openingEntry).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect((error as WalletAlreadyExistsError).existingWalletId).toBe(first.wallet.id);
    expect([await count("wallets"), await count("wager_transactions"), await count("wallet_ledger_entries")]).toEqual(before);
  });

  test("a failure while saving the ledger entry rolls the wallet back too", async () => {
    const { wallet } = open("100.00");
    const inconsistent = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Credit,
      money: brl("90.00"),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: brl("90.00"),
      walletVersion: 1,
      createdAt: at,
    });
    const error = (await store.create(wallet, inconsistent).catch((e: unknown) => e)) as { code?: string };
    expect(error.code).toBe("WG001");
    expect(await store.findById(wallet.id)).toBeUndefined();
    const [row] = await query("select count(*) as n from wager_transactions where wallet_id = ?", [wallet.id]);
    expect(row).toEqual({ n: "0" });
  });
});

describe("inTransaction", () => {
  test("applies the configured lock, statement and idle timeouts", async () => {
    const config = { ...db.config, TX_LOCK_TIMEOUT_MS: 1500, TX_STATEMENT_TIMEOUT_MS: 4000, TX_IDLE_IN_TX_TIMEOUT_MS: 9000 };
    const settings = await inTransaction(db.app, config, async (exec) => {
      const [row] = await exec(
        "select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt, current_setting('idle_in_transaction_session_timeout') as idle",
      );
      return row;
    });
    expect(settings).toEqual({ lock: "1500ms", stmt: "4s", idle: "9s" });
  });

  test("the settings do not leak to the next transaction", async () => {
    const [row] = await db.app.em.fork().execute("select current_setting('lock_timeout') as lock");
    expect(row).toEqual({ lock: "0" });
  });

  test("rolls back when the work throws", async () => {
    const id = crypto.randomUUID();
    await inTransaction(db.app, db.config, async (exec) => {
      await exec(
        "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', 0, 1, now(), now())",
        [id, crypto.randomUUID()],
      );
      throw new Error("abort");
    }).catch(() => undefined);
    expect(await store.findById(id)).toBeUndefined();
  });
});
