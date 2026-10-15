import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { balanceOf, createWallet, submitUntilFinal, tally } from "../helpers/client";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { assertAllWalletsConsistent, count } from "../helpers/invariant";
import { createQueuesFor, deleteQueues, type TestQueues } from "../helpers/queues";
import { type Instance, spawnInstance, stopAll, waitFor } from "../helpers/spawn-instances";

let db: TestDatabase;
let queues: TestQueues;
const started: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createQueuesFor(db.config, "reference");
}, 60_000);

afterAll(async () => {
  await stopAll(started, "SIGKILL");
  await deleteQueues(queues);
  await db.drop();
});

const start = async (roles: string, env: Record<string, string> = {}) => {
  const instance = await spawnInstance({ config: queues.config, roles, env });
  started.push(instance);
  return instance;
};

const pending = () => count(db, "select 1 from wager_transactions where status = 'PENDING_REFERENCE'");
const run = crypto.randomUUID().slice(0, 8);

describe("out-of-order transactions across real processes", () => {
  test("C7: a ROLLBACK and a REFUND that arrive before their BET are applied by a worker in another process", async () => {
    const a = await start("api");
    const b = await start("api");
    await start("reference-worker", { REFERENCE_WORKER_INTERVAL_MS: "100" });

    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(a.url, "100.00")));
    const early = await Promise.all(
      wallets.flatMap((wallet, index) => [
        submitUntilFinal([a.url], { wallet, external: `${run}-rb-${index}`, kind: "ROLLBACK", amount: "10.00", reference: `${run}-bet1-${index}` }),
        submitUntilFinal([b.url], { wallet, external: `${run}-rf-${index}`, kind: "REFUND", amount: "10.00", reference: `${run}-bet2-${index}` }),
      ]),
    );
    expect(await tally(early)).toEqual({ "202 PENDING_REFERENCE": 40 });

    const bets = await Promise.all(
      wallets.flatMap((wallet, index) => [
        submitUntilFinal([b.url], { wallet, external: `${run}-bet1-${index}`, amount: "10.00" }),
        submitUntilFinal([a.url], { wallet, external: `${run}-bet2-${index}`, amount: "10.00" }),
      ]),
    );
    expect(await tally(bets)).toEqual({ "200 PROCESSED": 40 });

    await waitFor(async () => (await pending()) === 0, { timeoutMs: 20_000, what: "all pending references to resolve" });
    for (const wallet of wallets) expect(await balanceOf(a.url, wallet)).toBe("100.00");
    expect(await count(db, "select 1 from wager_transactions where kind in ('ROLLBACK','REFUND') and status = 'PROCESSED'")).toBe(40);
    await assertAllWalletsConsistent(db);
  }, 90_000);

  test("a WIN delivered before its BET is credited exactly once even with two workers racing for it", async () => {
    const api = await start("api");
    await start("reference-worker", { REFERENCE_WORKER_INTERVAL_MS: "50" });
    await start("reference-worker", { REFERENCE_WORKER_INTERVAL_MS: "50" });
    const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet(api.url, "100.00")));
    await Promise.all(
      wallets.map((wallet, index) =>
        submitUntilFinal([api.url], { wallet, external: `${run}-win-${index}`, kind: "WIN", amount: "30.00", reference: `${run}-wbet-${index}` }),
      ),
    );
    await Promise.all(wallets.map((wallet, index) => submitUntilFinal([api.url], { wallet, external: `${run}-wbet-${index}`, amount: "10.00" })));

    await waitFor(async () => (await pending()) === 0, { timeoutMs: 20_000, what: "all pending references to resolve" });
    for (const wallet of wallets) expect(await balanceOf(api.url, wallet)).toBe("120.00");
    expect(await count(db, "select 1 from wager_transactions where kind = 'WIN' and status = 'PROCESSED'")).toBeGreaterThanOrEqual(15);
    await assertAllWalletsConsistent(db);
  }, 90_000);

  test("a reference that never arrives is rejected after the time limit by a worker process", async () => {
    await stopAll(started.splice(0), "SIGKILL");
    const api = await start("api");
    await start("reference-worker", { REFERENCE_WORKER_INTERVAL_MS: "100", REFERENCE_TTL_MS: "300" });
    const wallet = await createWallet(api.url, "100.00");
    const reply = await submitUntilFinal([api.url], { wallet, external: `${run}-orphan`, kind: "WIN", amount: "10.00", reference: `${run}-never` });
    expect(reply.status).toBe(202);

    await waitFor(
      async () =>
        (await count(db, "select 1 from wager_transactions where external_transaction_id = ? and status = 'REJECTED' and failure_code = 'REFERENCE_NOT_FOUND'", [`${run}-orphan`])) === 1,
      { timeoutMs: 25_000, what: "the orphan to be rejected" },
    );
    expect(await balanceOf(api.url, wallet)).toBe("100.00");
    expect(await count(db, "select 1 from outbox_messages where event_type = 'WagerTransactionRejected' and payload->'data'->>'externalTransactionId' = ?", [`${run}-orphan`])).toBe(1);
    await assertAllWalletsConsistent(db);
  }, 60_000);
});
