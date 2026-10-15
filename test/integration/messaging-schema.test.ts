import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const owner = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);
const app = (sql: string, params?: unknown[]) => db.app.em.fork().execute(sql, params);
const now = new Date();

async function fail(attempt: () => Promise<unknown>) {
  try {
    await attempt();
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error("expected the statement to fail");
}

function insert(exec: typeof app, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return exec(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

const outboxRow = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  aggregate_id: crypto.randomUUID(),
  partition_key: crypto.randomUUID(),
  event_type: "WalletBalanceChanged",
  event_version: 1,
  payload: JSON.stringify({ eventId: "e" }),
  occurred_at: now,
  next_attempt_at: now,
  ...overrides,
});

const inboxRow = (overrides: Record<string, unknown> = {}) => ({
  consumer_name: "wager-consumer",
  message_id: crypto.randomUUID(),
  payload_hash: "b".repeat(64),
  received_at: now,
  ...overrides,
});

describe("outbox_messages", () => {
  test("the app role can insert, read and mark a message published, with a generated sequence", async () => {
    const row = outboxRow();
    await insert(app, "outbox_messages", row);
    const [stored] = await app("select seq, attempts, published_at, payload from outbox_messages where id = ?", [row.id]);
    expect(Number(stored!.seq)).toBeGreaterThan(0);
    expect(stored).toMatchObject({ attempts: 0, published_at: null, payload: { eventId: "e" } });

    await app("update outbox_messages set published_at = ? where id = ?", [now, row.id]);
    const [done] = await app("select published_at from outbox_messages where id = ?", [row.id]);
    expect(done!.published_at).not.toBeNull();
  });

  test("sequence numbers increase in insert order", async () => {
    const first = outboxRow();
    const second = outboxRow();
    await insert(app, "outbox_messages", first);
    await insert(app, "outbox_messages", second);
    const rows = await app("select id from outbox_messages where id in (?, ?) order by seq", [first.id, second.id]);
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  test("retry bookkeeping can change before publish", async () => {
    const row = outboxRow();
    await insert(app, "outbox_messages", row);
    await app("update outbox_messages set attempts = 2, last_error = 'SQSError', next_attempt_at = ? where id = ?", [
      new Date(now.getTime() + 1000),
      row.id,
    ]);
    const [stored] = await app("select attempts, last_error from outbox_messages where id = ?", [row.id]);
    expect(stored).toMatchObject({ attempts: 2, last_error: "SQSError" });
  });

  test.each([
    ["an empty event type", { event_type: "" }],
    ["a zero version", { event_version: 0 }],
    ["negative attempts", { attempts: -1 }],
    ["a payload that is not an object", { payload: JSON.stringify([1]) }],
    ["a last_error over 500 chars", { last_error: "x".repeat(501) }],
  ])("%s is rejected", async (_name, overrides) => {
    const error = await fail(() => insert(app, "outbox_messages", outboxRow(overrides)));
    expect(error.code).toMatch(/^(23514|22001)$/);
  });

  test.each([
    ["payload", "payload = '{\"x\":1}'::jsonb"],
    ["event type", "event_type = 'Other'"],
    ["partition key", `partition_key = '${crypto.randomUUID()}'`],
    ["sequence", "seq = seq + 1000"],
    ["occurred_at", "occurred_at = occurred_at + interval '1 day'"],
  ])("the %s of an event cannot change", async (_name, assignment) => {
    const row = outboxRow();
    await insert(app, "outbox_messages", row);
    expect((await fail(() => app(`update outbox_messages set ${assignment} where id = ?`, [row.id]))).code).toBe("WG001");
  });

  test("a published event cannot be un-published or re-stamped", async () => {
    const row = outboxRow();
    await insert(app, "outbox_messages", row);
    await app("update outbox_messages set published_at = ? where id = ?", [now, row.id]);
    expect((await fail(() => app("update outbox_messages set published_at = null where id = ?", [row.id]))).code).toBe("WG001");
    expect(
      (await fail(() => app("update outbox_messages set published_at = ? where id = ?", [new Date(0), row.id]))).code,
    ).toBe("WG001");
  });

  test("events cannot be deleted, even by the owner", async () => {
    const row = outboxRow();
    await insert(app, "outbox_messages", row);
    expect((await fail(() => app("delete from outbox_messages where id = ?", [row.id]))).code).toBe("42501");
    expect((await fail(() => owner("delete from outbox_messages where id = ?", [row.id]))).code).toBe("WG001");
  });

  test("the due index only covers unpublished rows", async () => {
    const [index] = await owner("select indexdef from pg_indexes where indexname = 'ix_outbox_due'");
    expect(String(index!.indexdef)).toContain("WHERE (published_at IS NULL)");
  });
});

describe("inbox_messages", () => {
  test("the same consumer and message id cannot be recorded twice", async () => {
    const row = inboxRow();
    await insert(app, "inbox_messages", row);
    const error = await fail(() => insert(app, "inbox_messages", { ...row, payload_hash: "c".repeat(64) }));
    expect(error).toEqual({ code: "23505", constraint: "inbox_messages_pkey" });
  });

  test("another consumer may record the same message id", async () => {
    const row = inboxRow();
    await insert(app, "inbox_messages", row);
    await insert(app, "inbox_messages", { ...row, consumer_name: "other-consumer" });
  });

  test("a row can be marked processed once", async () => {
    const row = inboxRow();
    await insert(app, "inbox_messages", row);
    await app("update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?", [
      now,
      row.consumer_name,
      row.message_id,
    ]);
    const error = await fail(() =>
      app("update inbox_messages set processed_at = null where consumer_name = ? and message_id = ?", [
        row.consumer_name,
        row.message_id,
      ]),
    );
    expect(error.code).toBe("WG001");
  });

  test("the hash and identity cannot change", async () => {
    const row = inboxRow();
    await insert(app, "inbox_messages", row);
    const error = await fail(() =>
      app("update inbox_messages set payload_hash = ? where consumer_name = ? and message_id = ?", [
        "d".repeat(64),
        row.consumer_name,
        row.message_id,
      ]),
    );
    expect(error.code).toBe("WG001");
  });

  test("rows cannot be deleted and blank identities are rejected", async () => {
    const row = inboxRow();
    await insert(app, "inbox_messages", row);
    expect((await fail(() => app("delete from inbox_messages where message_id = ?", [row.message_id]))).code).toBe("42501");
    expect((await fail(() => owner("delete from inbox_messages where message_id = ?", [row.message_id]))).code).toBe("WG001");
    expect((await fail(() => insert(app, "inbox_messages", inboxRow({ message_id: "" })))).code).toBe("23514");
    expect((await fail(() => insert(app, "inbox_messages", inboxRow({ consumer_name: "" })))).code).toBe("23514");
  });

  test("an oversized payload hash is rejected by the column type", async () => {
    const error = await fail(() => insert(app, "inbox_messages", inboxRow({ payload_hash: "x".repeat(65) })));
    expect(error.code).toBe("22001");
  });
});
