import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWallet, type WalletRef } from "../helpers/client";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { assertAllWalletsConsistent, count } from "../helpers/invariant";
import { createQueuesFor, deleteQueues, drainEvents, queueDepth, sendWagerMessage, type TestQueues } from "../helpers/queues";
import { type Instance, spawnInstances, stopAll, waitFor } from "../helpers/spawn-instances";

const SHORT_TIMEOUTS = {
  SQS_VISIBILITY_TIMEOUT_S: "4",
  SQS_VISIBILITY_SAFETY_MARGIN_S: "3",
  USE_CASE_DEADLINE_MS: "1500",
  TX_LOCK_TIMEOUT_MS: "300",
  TX_STATEMENT_TIMEOUT_MS: "600",
  SQS_WAIT_TIME_S: "1",
  SQS_RETRY_BACKOFF_CAP_S: "1",
};

const WALLETS = 30;
const PER_WALLET = 20;
const TOTAL = WALLETS * PER_WALLET;

let db: TestDatabase;
let queues: TestQueues;
let running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createQueuesFor(db.config, "restart", { visibilityTimeoutS: 4, maxReceiveCount: 10 });
}, 60_000);

afterAll(async () => {
  await stopAll(running, "SIGKILL");
  await deleteQueues(queues);
  await db.drop();
});

const processed = () => count(db, "select 1 from wager_transactions where kind = 'BET'");

describe("restarting every instance in the middle of the work", () => {
  test("C8: all processes are killed mid-flight, new ones finish the job, and every message has exactly one effect", async () => {
    running = await spawnInstances(3, { config: queues.config, env: SHORT_TIMEOUTS });
    const wallets: WalletRef[] = await Promise.all(Array.from({ length: WALLETS }, () => createWallet(running[0]!.url, "1000.00")));
    await Promise.all(
      wallets.flatMap((wallet, index) =>
        Array.from({ length: PER_WALLET }, (_, n) => sendWagerMessage(queues, wallet, `c8-${index}-${n}`)),
      ),
    );

    await waitFor(async () => (await processed()) >= 20, { timeoutMs: 30_000, what: "some messages to be processed" });
    await stopAll(running, "SIGKILL");
    const before = await processed();
    expect(before).toBeLessThan(TOTAL);

    running = await spawnInstances(3, { config: queues.config, env: SHORT_TIMEOUTS });
    await waitFor(async () => (await processed()) === TOTAL, { timeoutMs: 90_000, what: "every message to be processed" });
    await waitFor(
      async () => {
        const { visible, inFlight } = await queueDepth(queues, queues.urls.main);
        return visible + inFlight === 0;
      },
      { timeoutMs: 30_000, what: "the queue to be empty" },
    );

    for (const wallet of wallets) {
      const [row] = await db.owner.em.fork().execute("select balance from wallets where id = ?", [wallet.walletId]);
      expect(row).toEqual({ balance: "900.00" });
    }
    expect(await count(db, "select 1 from wallet_ledger_entries where direction = 'DEBIT'")).toBe(TOTAL);
    expect(await count(db, "select 1 from inbox_messages")).toBe(TOTAL);
    expect(await count(db, "select external_transaction_id from wager_transactions where kind = 'BET' group by external_transaction_id having count(*) > 1")).toBe(0);
    expect(await queueDepth(queues, queues.urls.dlq)).toEqual({ visible: 0, inFlight: 0 });
    await assertAllWalletsConsistent(db);
  }, 180_000);

  test("after the restart the outbox drains and every event reaches the queue exactly once", async () => {
    await waitFor(async () => (await count(db, "select 1 from outbox_messages where published_at is null")) === 0, {
      timeoutMs: 40_000,
      what: "the outbox to drain",
    });
    const rows = await count(db, "select 1 from outbox_messages");
    expect(rows).toBe(WALLETS * 2 + TOTAL * 2);

    const ids = (await drainEvents(queues, rows, 60_000)).map((body) => (JSON.parse(body) as { eventId: string }).eventId);
    expect(ids).toHaveLength(rows);
    expect(new Set(ids).size).toBe(rows);
  }, 120_000);

  test("a graceful restart (SIGTERM) in the middle of new work loses nothing either", async () => {
    const wallet = await createWallet(running[0]!.url, "1000.00");
    await Promise.all(Array.from({ length: 40 }, (_, n) => sendWagerMessage(queues, wallet, `c8-term-${n}`)));
    await waitFor(async () => (await count(db, "select 1 from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.walletId])) >= 5, {
      timeoutMs: 30_000,
      what: "work to start",
    });
    await stopAll(running, "SIGTERM");
    running = await spawnInstances(3, { config: queues.config, env: SHORT_TIMEOUTS });

    await waitFor(async () => (await count(db, "select 1 from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.walletId])) === 40, {
      timeoutMs: 30_000,
      what: "all 40 messages to be processed",
    });
    const [row] = await db.owner.em.fork().execute("select balance from wallets where id = ?", [wallet.walletId]);
    expect(row).toEqual({ balance: "800.00" });
    await assertAllWalletsConsistent(db);
  }, 120_000);

  test("killed while stuck inside the transaction, before anything is committed: the messages come back and each takes effect once", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(running[0]!.url, "100.00")));
    await stopAll(running, "SIGKILL");
    running = await spawnInstances(3, { config: queues.config, env: SHORT_TIMEOUTS });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const lockHolder = db.owner.em.fork().transactional(async (em) => {
      for (const wallet of wallets) await em.execute("select id from wallets where id = ? for update", [wallet.walletId]);
      locked();
      await held;
    });
    await holding;

    await Promise.all(wallets.flatMap((wallet, index) => Array.from({ length: 5 }, (_, n) => sendWagerMessage(queues, wallet, `c8-stuck-${index}-${n}`))));
    await waitFor(async () => (await queueDepth(queues, queues.urls.main)).inFlight >= wallets.length, {
      timeoutMs: 20_000,
      what: "the instances to receive the messages",
    });
    await stopAll(running, "SIGKILL");
    release();
    await lockHolder;
    expect(await count(db, "select 1 from wager_transactions where kind = 'BET' and external_transaction_id like 'ext-c8-stuck-%'")).toBe(0);

    running = await spawnInstances(3, { config: queues.config, env: SHORT_TIMEOUTS });
    await waitFor(async () => (await count(db, "select 1 from wager_transactions where kind = 'BET' and external_transaction_id like 'ext-c8-stuck-%'")) === 25, {
      timeoutMs: 60_000,
      what: "all 25 stuck messages to be processed",
    });
    for (const wallet of wallets) {
      const [row] = await db.owner.em.fork().execute("select balance from wallets where id = ?", [wallet.walletId]);
      expect(row).toEqual({ balance: "75.00" });
    }
    await assertAllWalletsConsistent(db);
  }, 120_000);
});
