import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { OutboxPublisher } from "../../src/application/outbox-publisher";
import { EventSender, type OutboxMessage, type SendFailure } from "../../src/application/ports";
import { PostgresOutboxStore } from "../../src/infra/db/postgres-outbox-store";
import { SystemClock } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let store: PostgresOutboxStore;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new PostgresOutboxStore(db.app, db.config);
}, 30_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.owner.em.fork().transactional(async (em) => {
    await em.execute("alter table outbox_messages disable trigger outbox_no_delete");
    await em.execute("delete from outbox_messages");
    await em.execute("alter table outbox_messages enable trigger outbox_no_delete");
  });
});

const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

async function seed(count: number, overrides: { published?: boolean; delaySeconds?: number } = {}) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await db.app.em.fork().execute(
      `insert into outbox_messages
         (id, aggregate_id, partition_key, event_type, event_version, payload, occurred_at, next_attempt_at, published_at)
       values (?, ?, ?, 'WalletBalanceChanged', 1, ?, now(), now() + make_interval(secs => ?),
               case when ? then now() else null end)`,
      [
        id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({ eventId: id }),
        overrides.delaySeconds ?? 0,
        overrides.published ?? false,
      ],
    );
  }
  return ids;
}

class RecordingSender extends EventSender {
  readonly sent: string[] = [];
  constructor(
    private readonly options: { failIds?: (id: string) => boolean; holdMs?: number } = {},
  ) {
    super();
  }

  async send(messages: OutboxMessage[]): Promise<SendFailure[]> {
    if (this.options.holdMs) await new Promise((resolve) => setTimeout(resolve, this.options.holdMs));
    const failures: SendFailure[] = [];
    for (const message of messages) {
      if (this.options.failIds?.(message.id)) failures.push({ id: message.id, error: "Throttled" });
      else this.sent.push(message.id);
    }
    return failures;
  }
}

const publisher = (sender: EventSender, batchSize = 10) =>
  new OutboxPublisher(store, sender, new SystemClock(), { batchSize, intervalMs: 50 });

const row = async (id: string) =>
  (await query("select attempts, last_error, published_at, next_attempt_at > now() as waiting from outbox_messages where id = ?", [id]))[0]!;

describe("outbox publishing on Postgres", () => {
  test("publishes unpublished due rows in sequence order and ignores published and future ones", async () => {
    const due = await seed(6);
    await seed(1, { published: true });
    await seed(1, { delaySeconds: 3600 });
    const sender = new RecordingSender();

    expect(await publisher(sender).publishBatch()).toEqual({ claimed: 6, published: 6, failed: 0 });
    expect(sender.sent).toEqual(due);
    expect((await row(due[0]!)).published_at).not.toBeNull();
    expect(await publisher(sender).publishBatch()).toMatchObject({ claimed: 0 });
  });

  test("the payload is sent as the stored JSON text", async () => {
    const [id] = await seed(1);
    let body = "";
    await publisher(
      new (class extends EventSender {
        async send(messages: OutboxMessage[]) {
          body = messages[0]!.payload;
          return [];
        }
      })(),
    ).publishBatch();
    expect(JSON.parse(body)).toEqual({ eventId: id });
  });

  test("respects the batch size", async () => {
    await seed(5);
    expect(await publisher(new RecordingSender(), 2).publishBatch()).toMatchObject({ claimed: 2 });
  });

  test("a failed send backs off from two seconds, doubles, and keeps the error", async () => {
    const [id] = await seed(1);
    const failing = new RecordingSender({ failIds: () => true });

    expect(await publisher(failing).publishBatch()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(await row(id!)).toMatchObject({ attempts: 1, last_error: "Throttled", published_at: null, waiting: true });
    const [first] = await query("select extract(epoch from next_attempt_at - now()) as seconds from outbox_messages where id = ?", [id]);
    expect(Number(first!.seconds)).toBeGreaterThan(1);
    expect(Number(first!.seconds)).toBeLessThanOrEqual(2);
    expect(await publisher(failing).publishBatch()).toMatchObject({ claimed: 0 });

    await query("update outbox_messages set next_attempt_at = now() where id = ?", [id]);
    await publisher(failing).publishBatch();
    const [second] = await query("select attempts, extract(epoch from next_attempt_at - now()) as seconds from outbox_messages where id = ?", [id]);
    expect(second!.attempts).toBe(2);
    expect(Number(second!.seconds)).toBeGreaterThan(3);
    expect(Number(second!.seconds)).toBeLessThanOrEqual(4);
  });

  test("a message that fails later is still delivered once it is due and the sender recovers", async () => {
    const [id] = await seed(1);
    await publisher(new RecordingSender({ failIds: () => true })).publishBatch();
    await query("update outbox_messages set next_attempt_at = now() where id = ?", [id]);
    const healthy = new RecordingSender();
    await publisher(healthy).publishBatch();
    expect(healthy.sent).toEqual([id!]);
    expect((await row(id!)).published_at).not.toBeNull();
  });

  test("a crash after sending but before the commit leaves the event pending, and another publisher resends the same id", async () => {
    const [id] = await seed(1);
    const first = new RecordingSender();
    await expect(
      store.withBatch(10, async (batch) => {
        await first.send(batch.messages);
        await batch.markPublished(batch.messages.map((message) => message.id));
        throw new Error("process died before commit");
      }),
    ).rejects.toThrow("process died");
    expect((await row(id!)).published_at).toBeNull();

    const second = new RecordingSender();
    await publisher(second).publishBatch();
    expect(first.sent).toEqual([id!]);
    expect(second.sent).toEqual([id!]);
    expect((await row(id!)).published_at).not.toBeNull();
  });

  test("two publishers working at the same time claim different rows and send each event once", async () => {
    const ids = await seed(20);
    const sender = new RecordingSender({ holdMs: 300 });
    const [a, b] = await Promise.all([publisher(sender).publishBatch(), publisher(sender).publishBatch()]);

    expect(a.claimed).toBe(10);
    expect(b.claimed).toBe(10);
    expect([...sender.sent].sort()).toEqual([...ids].sort());
    expect(new Set(sender.sent).size).toBe(20);
  });

  test("a locked row is skipped, not waited for", async () => {
    const [locked, free] = await seed(2);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const holding = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const holder = store.withBatch(1, async (batch) => {
      expect(batch.messages.map((message) => message.id)).toEqual([locked!]);
      claimed();
      await hold;
    });
    await holding;

    const sender = new RecordingSender();
    expect(await publisher(sender).publishBatch()).toMatchObject({ claimed: 1 });
    expect(sender.sent).toEqual([free!]);
    release();
    await holder;
  });

  test("three publishers draining a flaky sender publish every event, and each is marked once", async () => {
    const ids = await seed(60);
    const flaky = new RecordingSender({ failIds: () => Math.random() < 0.3 });
    const publishers = [publisher(flaky, 7), publisher(flaky, 7), publisher(flaky, 7)];

    for (let round = 0; round < 40; round++) {
      const [{ pending }] = (await query("select count(*)::int as pending from outbox_messages where published_at is null")) as [{ pending: number }];
      if (pending === 0) break;
      await query("update outbox_messages set next_attempt_at = now() where published_at is null");
      await Promise.all(publishers.map((each) => each.publishBatch()));
    }

    const published = await query("select count(*)::int as n from outbox_messages where published_at is not null");
    expect(published[0]).toEqual({ n: 60 });
    expect(new Set(flaky.sent)).toEqual(new Set(ids));
  }, 60_000);
});
