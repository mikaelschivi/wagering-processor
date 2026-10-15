import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SqlEntityManager } from "@mikro-orm/postgresql";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

type Exec = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
type Orm = { em: SqlEntityManager };

const uuid = (): string => crypto.randomUUID();
const now = new Date();
const hash = "a".repeat(64);

const run =
  (orm: Orm): Exec =>
  (sql, params) =>
    orm.em.fork().execute(sql, params);

const inTx = (orm: Orm, work: (exec: Exec) => Promise<void>) =>
  orm.em.fork().transactional((em) => work((sql, params) => (em as SqlEntityManager).execute(sql, params)));

async function fail(attempt: () => Promise<unknown>) {
  try {
    await attempt();
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error("expected the statement to fail");
}

function insert(exec: Exec, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return exec(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

const walletRow = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(),
  player_id: uuid(),
  currency: "BRL",
  balance: "0.00",
  version: 1,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const txRow = (wallet: { id: string; player_id: string }, overrides: Record<string, unknown> = {}) => ({
  id: uuid(),
  provider_id: "provider-a",
  external_transaction_id: uuid(),
  idempotency_key: uuid(),
  payload_hash: hash,
  wallet_id: wallet.id,
  player_id: wallet.player_id,
  round_id: "round-1",
  game_id: "game-1",
  kind: "BET",
  amount: "10.00",
  currency: "BRL",
  status: "PROCESSED",
  result_balance: "0.00",
  result_currency: "BRL",
  result_wallet_version: 1,
  correlation_id: "corr-1",
  created_at: now,
  updated_at: now,
  processed_at: now,
  ...overrides,
});

const ledgerRow = (
  wallet: { id: string },
  tx: { id: string; amount?: unknown },
  overrides: Record<string, unknown> = {},
) => ({
  id: uuid(),
  wallet_id: wallet.id,
  transaction_id: tx.id,
  direction: "CREDIT",
  amount: tx.amount ?? "10.00",
  currency: "BRL",
  balance_before: "0.00",
  balance_after: "10.00",
  wallet_version: 1,
  created_at: now,
  ...overrides,
});

async function openWallet(exec: Exec, balance: string) {
  const wallet = walletRow({ balance });
  await insert(exec, "wallets", wallet);
  const opening = txRow(wallet, {
    provider_id: "__internal__",
    kind: "OPENING",
    external_transaction_id: `opening:${wallet.id}`,
    idempotency_key: `opening:${wallet.id}`,
    amount: balance,
    result_balance: balance,
  });
  await insert(exec, "wager_transactions", opening);
  await insert(exec, "wallet_ledger_entries", ledgerRow(wallet, opening, { balance_after: balance }));
  return { wallet, opening };
}


async function fundedInTx(db: TestDatabase, balance = "100.00") {
  let result!: Awaited<ReturnType<typeof openWallet>>;
  await inTx(db.owner, async (exec) => {
    result = await openWallet(exec, balance);
  });
  return result;
}

describe("migrations", () => {
  test("up creates the schema, down removes it, and up works again", async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      const tables = async () =>
        (await run(db.owner)("select tablename from pg_tables where schemaname = 'public' order by 1")).map(
          (row) => row.tablename,
        );
      const objects = async () => {
        const functions = await run(db.owner)(
          "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
        );
        const types = await run(db.owner)(
          "select typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'",
        );
        return functions.length + types.length;
      };

      await db.owner.migrator.up();
      expect(await tables()).toEqual(["inbox_messages", "mikro_orm_migrations", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"]);
      expect(await objects()).toBe(10);

      await db.owner.migrator.down({ to: 0 });
      expect(await tables()).toEqual(["mikro_orm_migrations"]);
      expect(await objects()).toBe(0);

      await db.owner.migrator.up();
      expect(await tables()).toContain("wallets");
      expect(await objects()).toBe(10);
    } finally {
      await db.drop();
    }
  }, 30_000);
});

describe("schema guarantees", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db.drop();
  });

  describe("wallets", () => {
    test("a negative balance is rejected", async () => {
      const error = await fail(() => insert(run(db.owner), "wallets", walletRow({ balance: "-0.01" })));
      expect(error.code).toBe("23514");
    });

    test.each([
      ["version 0", { version: 0 }],
      ["a lowercase currency", { currency: "brl" }],
    ])("%s is rejected", async (_name, overrides) => {
      const error = await fail(() => insert(run(db.owner), "wallets", walletRow(overrides)));
      expect(error.code).toBe("23514");
    });

    test("one wallet per player and currency", async () => {
      const first = walletRow();
      await insert(run(db.owner), "wallets", first);
      const duplicate = await fail(() => insert(run(db.owner), "wallets", walletRow({ player_id: first.player_id })));
      expect(duplicate).toEqual({ code: "23505", constraint: "ux_wallet_player_currency" });
      await insert(run(db.owner), "wallets", walletRow({ player_id: first.player_id, currency: "USD" }));
    });

    test("an empty wallet at version 1 needs no ledger entry", async () => {
      await inTx(db.owner, async (exec) => {
        await insert(exec, "wallets", walletRow());
      });
    });

    test("a funded wallet without a ledger entry fails at commit", async () => {
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          await insert(exec, "wallets", walletRow({ balance: "5.00" }));
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test("a funded wallet with its opening entry commits", async () => {
      const { wallet } = await fundedInTx(db, "250.00");
      const [row] = await run(db.owner)("select balance, version from wallets where id = ?", [wallet.id]);
      expect(row).toEqual({ balance: "250.00", version: 1 });
    });

    test("identity columns cannot change", async () => {
      const { wallet } = await fundedInTx(db);
      const error = await fail(() => run(db.owner)("update wallets set player_id = ? where id = ?", [uuid(), wallet.id]));
      expect(error.code).toBe("WG001");
    });

    test("a balance change must bump the version by one", async () => {
      const { wallet } = await fundedInTx(db);
      const noBump = await fail(() => run(db.owner)("update wallets set balance = 90.00 where id = ?", [wallet.id]));
      const bigBump = await fail(() =>
        run(db.owner)("update wallets set balance = 90.00, version = 3 where id = ?", [wallet.id]),
      );
      expect([noBump.code, bigBump.code]).toEqual(["WG001", "WG001"]);
    });

    test("the version cannot change without the balance", async () => {
      const { wallet } = await fundedInTx(db);
      const error = await fail(() => run(db.owner)("update wallets set version = 2 where id = ?", [wallet.id]));
      expect(error.code).toBe("WG001");
    });

    describe("wallets_guard on its own", () => {
      const alone = (wallet: { id: string }, statement: string) =>
        fail(() =>
          inTx(db.owner, async (exec) => {
            await exec("alter table wallets disable trigger wallets_ledger_consistency");
            await exec(statement, [wallet.id]);
          }),
        );

      test("a balance change must bump the version by exactly one", async () => {
        const { wallet } = await fundedInTx(db);
        expect((await alone(wallet, "update wallets set balance = 90.00 where id = ?")).code).toBe("WG001");
        expect((await alone(wallet, "update wallets set balance = 90.00, version = 3 where id = ?")).code).toBe("WG001");
      });

      test("the version cannot change without the balance", async () => {
        const { wallet } = await fundedInTx(db);
        expect((await alone(wallet, "update wallets set version = 2 where id = ?")).code).toBe("WG001");
      });

      test("a correct balance and version change passes", async () => {
        const { wallet } = await fundedInTx(db);
        await inTx(db.owner, async (exec) => {
          await exec("alter table wallets disable trigger wallets_ledger_consistency");
          await exec("update wallets set balance = 90.00, version = 2 where id = ?", [wallet.id]);
          await exec("alter table wallets enable trigger wallets_ledger_consistency");
        });
      });
    });

    test("a balance change without a ledger entry fails at commit", async () => {
      const { wallet } = await fundedInTx(db);
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          await exec("update wallets set balance = 90.00, version = 2 where id = ?", [wallet.id]);
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test("a balance change with its ledger entry commits", async () => {
      const { wallet } = await fundedInTx(db, "100.00");
      await inTx(db.owner, async (exec) => {
        const bet = txRow(wallet, { amount: "10.00", result_balance: "90.00", result_wallet_version: 2 });
        await insert(exec, "wager_transactions", bet);
        await insert(
          exec,
          "wallet_ledger_entries",
          ledgerRow(wallet, bet, {
            direction: "DEBIT",
            balance_before: "100.00",
            balance_after: "90.00",
            wallet_version: 2,
          }),
        );
        await exec("update wallets set balance = 90.00, version = 2 where id = ?", [wallet.id]);
      });
      const [row] = await run(db.owner)("select balance, version from wallets where id = ?", [wallet.id]);
      expect(row).toEqual({ balance: "90.00", version: 2 });
    });

    test("a wallet opened empty takes its first entry at version 2", async () => {
      const wallet = walletRow();
      await inTx(db.owner, async (exec) => {
        await insert(exec, "wallets", wallet);
        const win = txRow(wallet, { kind: "WIN", result_balance: "10.00", result_wallet_version: 2 });
        await insert(exec, "wager_transactions", win);
        await insert(exec, "wallet_ledger_entries", ledgerRow(wallet, win, { wallet_version: 2 }));
        await exec("update wallets set balance = 10.00, version = 2 where id = ?", [wallet.id]);
      });
    });
  });

  describe("ledger", () => {
    test("entries cannot be updated or deleted, even by the owner", async () => {
      const { wallet } = await fundedInTx(db);
      const update = await fail(() => run(db.owner)("update wallet_ledger_entries set amount = 1.00 where wallet_id = ?", [wallet.id]));
      const remove = await fail(() => run(db.owner)("delete from wallet_ledger_entries where wallet_id = ?", [wallet.id]));
      expect([update.code, remove.code]).toEqual(["WG001", "WG001"]);
    });

    test("the table cannot be truncated, even by the owner", async () => {
      const error = await fail(() => run(db.owner)("truncate wallet_ledger_entries"));
      expect(error.code).toBe("WG001");
    });

    test("an entry without a matching wallet change fails at commit", async () => {
      const { wallet } = await fundedInTx(db, "100.00");
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          const bet = txRow(wallet, { result_balance: "90.00", result_wallet_version: 2 });
          await insert(exec, "wager_transactions", bet);
          await insert(
            exec,
            "wallet_ledger_entries",
            ledgerRow(wallet, bet, { direction: "DEBIT", balance_before: "100.00", balance_after: "90.00", wallet_version: 2 }),
          );
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test("rejects an entry that does not continue from the previous balance", async () => {
      const { wallet } = await fundedInTx(db, "100.00");
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          const bet = txRow(wallet);
          await insert(exec, "wager_transactions", bet);
          await insert(
            exec,
            "wallet_ledger_entries",
            ledgerRow(wallet, bet, { direction: "DEBIT", balance_before: "50.00", balance_after: "40.00", wallet_version: 2 }),
          );
          await exec("update wallets set balance = 40.00, version = 2 where id = ?", [wallet.id]);
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test.each([
      [
        "a first entry with a non-zero balance_before",
        { balance: "15.00", version: 1 },
        { balance_before: "5.00", balance_after: "15.00", wallet_version: 1 },
      ],
      ["a first entry at version 3", { balance: "10.00", version: 3 }, { wallet_version: 3 }],
      [
        "a skipped version",
        { balance: "90.00", version: 4 },
        { direction: "DEBIT", balance_before: "100.00", balance_after: "90.00", wallet_version: 4 },
      ],
    ])("rejects %s even when the wallet matches the entry", async (_name, walletOverrides, entryOverrides) => {
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          const wallet = walletRow(walletOverrides);
          await insert(exec, "wallets", wallet);
          const win = txRow(wallet, { kind: "WIN" });
          await insert(exec, "wager_transactions", win);
          await insert(exec, "wallet_ledger_entries", ledgerRow(wallet, win, entryOverrides));
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test.each([
      ["a rejected transaction", { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", processed_at: null }],
      ["a LOSS", { kind: "LOSS" }],
    ])("rejects an entry for %s even when the wallet matches", async (_name, overrides) => {
      const error = await fail(() =>
        inTx(db.owner, async (exec) => {
          const wallet = walletRow({ balance: "10.00" });
          await insert(exec, "wallets", wallet);
          const tx = txRow(wallet, overrides);
          await insert(exec, "wager_transactions", tx);
          await insert(exec, "wallet_ledger_entries", ledgerRow(wallet, tx));
        }),
      );
      expect(error.code).toBe("WG001");
    });

    test("an entry must match its transaction's wallet and amount", async () => {
      const { wallet } = await fundedInTx(db, "100.00");
      const other = await fundedInTx(db, "100.00");
      const bet = txRow(wallet);
      await insert(run(db.owner), "wager_transactions", bet);
      const wrongWallet = await fail(() =>
        insert(run(db.owner), "wallet_ledger_entries", ledgerRow(other.wallet, bet, { direction: "DEBIT", balance_before: "100.00", balance_after: "90.00", wallet_version: 2 })),
      );
      const wrongAmount = await fail(() =>
        insert(run(db.owner), "wallet_ledger_entries", ledgerRow(wallet, bet, { direction: "DEBIT", amount: "11.00", balance_before: "100.00", balance_after: "89.00", wallet_version: 2 })),
      );
      expect([wrongWallet.code, wrongAmount.code]).toEqual(["23503", "23503"]);
    });

    test("a transaction produces at most one entry", async () => {
      const { wallet, opening } = await fundedInTx(db, "100.00");
      const error = await fail(() =>
        insert(run(db.owner), "wallet_ledger_entries", ledgerRow(wallet, opening, { amount: "100.00", balance_before: "100.00", balance_after: "200.00", wallet_version: 2 })),
      );
      expect(error).toEqual({ code: "23505", constraint: "ux_ledger_tx" });
    });

    test.each([
      ["arithmetic that does not balance", { balance_after: "11.00" }],
      ["a negative balance_after", { direction: "DEBIT", balance_before: "0.00", balance_after: "-10.00" }],
    ])("rejects %s", async (_name, overrides) => {
      const wallet = walletRow();
      await insert(run(db.owner), "wallets", wallet);
      const win = txRow(wallet, { kind: "WIN" });
      await insert(run(db.owner), "wager_transactions", win);
      const error = await fail(() => insert(run(db.owner), "wallet_ledger_entries", ledgerRow(wallet, win, overrides)));
      expect(error.code).toBe("23514");
    });
  });

  describe("wager transactions", () => {
    const newWallet = async () => {
      const wallet = walletRow();
      await insert(run(db.owner), "wallets", wallet);
      return wallet;
    };

    test("idempotency key and external id are unique per provider", async () => {
      const wallet = await newWallet();
      const first = txRow(wallet);
      await insert(run(db.owner), "wager_transactions", first);
      const sameKey = await fail(() =>
        insert(run(db.owner), "wager_transactions", txRow(wallet, { idempotency_key: first.idempotency_key })),
      );
      const sameExternal = await fail(() =>
        insert(run(db.owner), "wager_transactions", txRow(wallet, { external_transaction_id: first.external_transaction_id })),
      );
      expect(sameKey).toEqual({ code: "23505", constraint: "ux_tx_provider_idem" });
      expect(sameExternal).toEqual({ code: "23505", constraint: "ux_tx_provider_external" });
      await insert(
        run(db.owner),
        "wager_transactions",
        txRow(wallet, { provider_id: "provider-b", idempotency_key: first.idempotency_key, external_transaction_id: first.external_transaction_id }),
      );
    });

    test.each([
      ["OPENING from a real provider", { kind: "OPENING" }, "ck_tx_internal"],
      ["the internal provider on a BET", { provider_id: "__internal__" }, "ck_tx_internal"],
      ["a REFUND without a reference", { kind: "REFUND", reference_transaction_id: null }, "ck_tx_ref_required"],
      ["a BET with a reference", { reference_external_transaction_id: "x" }, "ck_tx_ref_forbidden"],
      ["a zero-amount BET", { amount: "0.00" }, "ck_tx_amount_positive"],
      ["a rejected row without a failure code", { status: "REJECTED", processed_at: null }, "ck_tx_failure_code"],
      ["a processed row without processed_at", { processed_at: null }, "ck_tx_processed_at"],
      ["a pending-reference row without a schedule", { status: "PENDING_REFERENCE", processed_at: null }, "ck_tx_pending_schedule"],
      ["a processed row without a result snapshot", { result_balance: null }, "ck_tx_result_snapshot"],
    ])("rejects %s", async (_name, overrides, constraint) => {
      const wallet = await newWallet();
      const error = await fail(() => insert(run(db.owner), "wager_transactions", txRow(wallet, overrides)));
      expect(error).toEqual({ code: "23514", constraint });
    });

    test("a persisted PENDING status is rejected", async () => {
      const wallet = await newWallet();
      const error = await fail(() =>
        insert(run(db.owner), "wager_transactions", txRow(wallet, { status: "PENDING", processed_at: null })),
      );
      expect(error.code).toBe("23514");
    });

    test("a zero-amount LOSS is allowed", async () => {
      const wallet = await newWallet();
      await insert(run(db.owner), "wager_transactions", txRow(wallet, { kind: "LOSS", amount: "0.00" }));
    });

    test("transactions cannot be deleted", async () => {
      const wallet = await newWallet();
      const tx = txRow(wallet);
      await insert(run(db.owner), "wager_transactions", tx);
      const error = await fail(() => run(db.owner)("delete from wager_transactions where id = ?", [tx.id]));
      expect(error.code).toBe("WG001");
    });

    test("a reference must be on the same wallet", async () => {
      const wallet = await newWallet();
      const other = await newWallet();
      const bet = txRow(other);
      await insert(run(db.owner), "wager_transactions", bet);
      const error = await fail(() =>
        insert(
          run(db.owner),
          "wager_transactions",
          txRow(wallet, { kind: "REFUND", reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id }),
        ),
      );
      expect(error).toEqual({ code: "23503", constraint: "fk_tx_reference_same_wallet" });
    });

    test("a transaction can be reversed only once", async () => {
      const wallet = await newWallet();
      const bet = txRow(wallet);
      await insert(run(db.owner), "wager_transactions", bet);
      const reversal = (kind: string, overrides: Record<string, unknown> = {}) =>
        txRow(wallet, { kind, reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id, ...overrides });

      await insert(run(db.owner), "wager_transactions", reversal("REFUND"));
      const second = await fail(() => insert(run(db.owner), "wager_transactions", reversal("ROLLBACK")));
      expect(second).toEqual({ code: "23505", constraint: "ux_single_reversal" });

      await insert(
        run(db.owner),
        "wager_transactions",
        reversal("ROLLBACK", { status: "REJECTED", failure_code: "REFERENCE_ALREADY_REVERSED", processed_at: null, reference_transaction_id: null }),
      );
    });
  });

  describe("the app role", () => {
    test("can run the full funded-wallet flow", async () => {
      let walletId = "";
      await inTx(db.app, async (exec) => {
        walletId = (await openWallet(exec, "75.00")).wallet.id;
      });
      const [row] = await run(db.app)("select balance from wallets where id = ?", [walletId]);
      expect(row).toEqual({ balance: "75.00" });
    });

    test("cannot delete or truncate anything", async () => {
      const statements = [
        "delete from wallets",
        "delete from wager_transactions",
        "delete from wallet_ledger_entries",
        "truncate wallets cascade",
        "truncate wallet_ledger_entries",
      ];
      for (const statement of statements) {
        expect((await fail(() => run(db.app)(statement))).code).toBe("42501");
      }
    });

    test("cannot update the ledger", async () => {
      const error = await fail(() => run(db.app)("update wallet_ledger_entries set amount = 1.00"));
      expect(error.code).toBe("42501");
    });

    test("cannot create tables or switch off triggers", async () => {
      const create = await fail(() => run(db.app)("create table sneaky (i int)"));
      const disable = await fail(() => run(db.app)("alter table wallet_ledger_entries disable trigger all"));
      expect([create.code, disable.code]).toEqual(["42501", "42501"]);
    });
  });
});
