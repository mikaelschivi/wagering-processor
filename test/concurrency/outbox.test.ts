import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWallet, submitUntilFinal } from "../helpers/client";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { assertAllWalletsConsistent, count } from "../helpers/invariant";
import { createQueuesFor, deleteQueues, drainEvents, type TestQueues } from "../helpers/queues";
import { type Instance, spawnInstance, stopAll, waitFor } from "../helpers/spawn-instances";

let db: TestDatabase;
let queues: TestQueues;
const started: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createQueuesFor(db.config, "outbox");
}, 60_000);

afterAll(async () => {
  await stopAll(started, "SIGKILL");
  await deleteQueues(queues);
  await db.drop();
});

const start = async (roles: string) => {
  const instance = await spawnInstance({ config: queues.config, roles });
  started.push(instance);
  return instance;
};

const unpublished = () => count(db, "select 1 from outbox_messages where published_at is null");
const total = () => count(db, "select 1 from outbox_messages");

describe("outbox with several real publisher processes", () => {
  test("C6: three publishers on one outbox deliver every event, one of them is killed on the way, and nothing is lost or doubled", async () => {
    const api = await start("api");
    const publishers = [await start("outbox"), await start("outbox"), await start("outbox")];

    const wallets = await Promise.all(Array.from({ length: 40 }, () => createWallet(api.url, "500.00")));
    const traffic = Promise.all(
      wallets.flatMap((wallet, index) =>
        Array.from({ length: 5 }, (_, n) => submitUntilFinal([api.url], { wallet, external: `c6-${index}-${n}`, amount: "5.00" })),
      ),
    );
    await Bun.sleep(150);
    await publishers[0]!.stop("SIGKILL");
    await traffic;

    await waitFor(async () => (await unpublished()) === 0, { timeoutMs: 40_000, what: "the outbox to drain" });
    const rows = await total();
    expect(rows).toBe(40 * 2 + 40 * 5 * 2);

    const bodies = await drainEvents(queues, rows);
    const ids = bodies.map((body) => (JSON.parse(body) as { eventId: string }).eventId);
    expect(ids).toHaveLength(rows);
    expect(new Set(ids).size).toBe(rows);
    await assertAllWalletsConsistent(db);
  }, 120_000);

  test("with a single publisher the events of one wallet reach the queue in the order they were written", async () => {
    await stopAll(started.splice(0), "SIGKILL");
    const api = await start("api");
    await start("outbox");
    const wallet = await createWallet(api.url, "1000.00");
    for (let n = 0; n < 15; n++) await submitUntilFinal([api.url], { wallet, external: `order-${n}`, amount: "1.00" });
    await waitFor(async () => (await unpublished()) === 0, { timeoutMs: 30_000, what: "the outbox to drain" });

    const bodies = await drainEvents(queues, 16 * 2 + 0, 30_000);
    const versions = bodies
      .map((body) => JSON.parse(body) as { eventType: string; data: { walletId?: string; walletVersion?: number } })
      .filter((event) => event.eventType === "WalletBalanceChanged" && event.data.walletId === wallet.walletId)
      .map((event) => event.data.walletVersion as number);
    expect(versions).toHaveLength(16);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  }, 90_000);
});
