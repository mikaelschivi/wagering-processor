import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type WalletRef, balanceOf, createWallet, submitUntilFinal, tally } from "../helpers/client";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { assertAllWalletsConsistent, count } from "../helpers/invariant";
import { createQueuesFor, deleteQueues, type TestQueues } from "../helpers/queues";
import { type Instance, spawnInstance, spawnInstances, stopAll } from "../helpers/spawn-instances";

let db: TestDatabase;
let queues: TestQueues;
let instances: Instance[];
const urls = () => instances.map((instance) => instance.url);
const at = (n: number) => instances[n % instances.length]!.url;
const run = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createQueuesFor(db.config, "multi");
  instances = await spawnInstances(3, { config: queues.config });
}, 90_000);

afterAll(async () => {
  await stopAll(instances);
  await deleteQueues(queues);
  await db.drop();
});

const ledgerRows = (wallet: WalletRef, direction: string) =>
  count(db, "select 1 from wallet_ledger_entries where wallet_id = ? and direction = ?", [wallet.walletId, direction]);

describe("three real app processes against one database", () => {
  test("concurrency_test1: the same bet sent 50 times across 3 processes is debited once", async () => {
    const wallet = await createWallet(at(0), "100.00");
    const replies = await Promise.all(
      Array.from({ length: 50 }, (_, n) => submitUntilFinal(urls().slice(n % 3).concat(urls().slice(0, n % 3)), { wallet, external: `${run}-c1` })),
    );

    const summary = await tally(replies);
    expect(summary["200 PROCESSED"]).toBe(1);
    expect(summary["200 PROCESSED replay"]).toBe(49);
    expect(new Set(replies.map((reply) => reply.body.transactionId)).size).toBe(1);
    expect(await balanceOf(at(1), wallet)).toBe("90.00");
    expect(await ledgerRows(wallet, "DEBIT")).toBe(1);
    await assertAllWalletsConsistent(db);
  }, 60_000);

  test("concurrency_test2: two 80.00 bets on a balance of 100.00 sent to different processes, repeated on 30 wallets at once", async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => createWallet(at(0), "100.00")));
    const replies = await Promise.all(
      wallets.flatMap((wallet, index) =>
        [0, 1].map((side) =>
          submitUntilFinal([at(index + side), at(index + side + 1)], { wallet, external: `${run}-c2-${index}-${side}`, amount: "80.00" }),
        ),
      ),
    );

    expect(await tally(replies)).toEqual({ "200 PROCESSED": 30, "422 REJECTED/INSUFFICIENT_FUNDS": 30 });
    for (const wallet of wallets) {
      expect(await balanceOf(at(2), wallet)).toBe("20.00");
      expect(await ledgerRows(wallet, "DEBIT")).toBe(1);
    }
    await assertAllWalletsConsistent(db);
  }, 90_000);

  test("concurrency_test3: different wallets are processed in parallel by all 3 processes", async () => {
    const wallets = await Promise.all(Array.from({ length: 60 }, () => createWallet(at(0), "500.00")));
    const replies = await Promise.all(
      wallets.flatMap((wallet, index) =>
        Array.from({ length: 5 }, (_, n) => submitUntilFinal(urls(), { wallet, external: `${run}-c3-${index}-${n}`, amount: "10.00" })),
      ),
    );

    expect(await tally(replies)).toEqual({ "200 PROCESSED": 300 });
    for (const wallet of wallets) expect(await balanceOf(at(0), wallet)).toBe("450.00");
    await assertAllWalletsConsistent(db);
  }, 90_000);

  test("concurrency_test4: a hot wallet and many quiet ones at the same time, with every process serving traffic", async () => {
    const hot = await createWallet(at(0), "5000.00");
    const quiet = await Promise.all(Array.from({ length: 20 }, () => createWallet(at(1), "100.00")));
    const jobs = [
      ...Array.from({ length: 200 }, (_, n) => ({ wallet: hot, external: `${run}-c4-hot-${n}`, amount: "5.00" })),
      ...quiet.flatMap((wallet, index) => Array.from({ length: 4 }, (_, n) => ({ wallet, external: `${run}-c4-q${index}-${n}`, amount: "10.00" }))),
    ];
    const replies = await Promise.all(jobs.map((job, n) => submitUntilFinal(urls().slice(n % 3).concat(urls().slice(0, n % 3)), job)));

    expect(await tally(replies)).toEqual({ "200 PROCESSED": 280 });
    expect(await balanceOf(at(2), hot)).toBe("4000.00");
    for (const wallet of quiet) expect(await balanceOf(at(2), wallet)).toBe("60.00");
    await assertAllWalletsConsistent(db);

    for (const instance of instances) {
      const metrics = (await (await fetch(`${instance.url}/metrics`)).json()) as { counters: Record<string, number> };
      const served = metrics.counters["wager_transactions_total{kind=BET,status=PROCESSED}"] ?? 0;
      expect(served).toBeGreaterThan(20);
    }
  }, 120_000);

  test("a SIGTERM to one process lets in-flight work finish and the others keep serving", async () => {
    const victim = await spawnInstance({ config: queues.config });
    const others = instances;
    const wallet = await createWallet(others[0]!.url, "100.00");
    const inFlight = Array.from({ length: 20 }, (_, n) =>
      submitUntilFinal([victim.url, others[1]!.url], { wallet, external: `${run}-term-${n}`, amount: "1.00" }),
    );
    await Bun.sleep(30);
    const exitCode = await victim.stop("SIGTERM");

    const replies = await Promise.all(inFlight);
    expect(await tally(replies)).toEqual({ "200 PROCESSED": 20 });
    expect([0, 143]).toContain(exitCode as number);
    expect(victim.logs()).toContain("metrics snapshot");
    expect(await balanceOf(others[0]!.url, wallet)).toBe("80.00");
    await assertAllWalletsConsistent(db);
  }, 60_000);

  test("every transaction in the database has its events stored and nothing was written twice", async () => {
    expect(await count(db, "select external_transaction_id from wager_transactions group by provider_id, external_transaction_id having count(*) > 1")).toBe(0);
    expect(await count(db, "select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1")).toBe(0);
    expect(await count(db, "select 1 from wager_transactions t where status = 'PROCESSED' and kind <> 'LOSS' and not exists (select 1 from wallet_ledger_entries l where l.transaction_id = t.id)")).toBe(0);
  });
});
