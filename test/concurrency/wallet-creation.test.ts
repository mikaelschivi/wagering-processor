import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WalletAlreadyExistsError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { createOrm } from "../../src/infra/db/mikro-orm.config";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { type BootedApp, bootApp } from "../helpers/app";
import { openingRecord } from "../helpers/fakes";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

describe("parallel wallet creation", () => {
  test("two instances racing to create the same wallet yield exactly one 201", async () => {
    const first = await bootApp(db.config);
    const second = await bootApp(db.config);
    const instances: BootedApp[] = [first, second];
    try {
      const body = {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "9.00", currency: "BRL" },
      };
      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          fetch(`${instances[i % 2]!.baseUrl}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(39);

      const conflicts = await Promise.all(responses.filter((r) => r.status === 409).map((r) => r.json()));
      const ids = new Set(conflicts.map((c) => (c as { existingWalletId: string }).existingWalletId));
      expect(ids.size).toBe(1);

      const [row] = await query("select count(*) as n from wallets where player_id = ?", [body.playerId]);
      expect(row).toEqual({ n: "1" });
    } finally {
      await Promise.all(instances.map((instance) => instance.close()));
    }
  }, 30_000);

  test("parallel creates for one player on separate connections store exactly one wallet", async () => {
    const otherOrm = createOrm(db.config);
    const stores = [new PostgresWalletStore(db.app, db.config), new PostgresWalletStore(otherOrm, db.config)];
    try {
      const playerId = crypto.randomUUID();
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) => {
          const { wallet, openingEntry } = Wallet.open({
            id: crypto.randomUUID(),
            playerId,
            initialBalance: Money.from({ amount: "5.00", currency: "BRL" }),
            openingTransactionId: crypto.randomUUID(),
            openingEntryId: crypto.randomUUID(),
            at: new Date(),
          });
          return stores[i % 2]!.create(wallet, openingRecord(wallet, openingEntry));
        }),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(rejected.every((r) => r.reason instanceof WalletAlreadyExistsError)).toBe(true);
      expect(new Set(rejected.map((r) => r.reason.existingWalletId)).size).toBe(1);

      const [wallets] = await query("select count(*) as n from wallets where player_id = ?", [playerId]);
      const [entries] = await query(
        "select count(*) as n from wallet_ledger_entries l join wallets w on w.id = l.wallet_id where w.player_id = ?",
        [playerId],
      );
      expect([wallets, entries]).toEqual([{ n: "1" }, { n: "1" }]);
    } finally {
      await otherOrm.close();
    }
  }, 30_000);
});
