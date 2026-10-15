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
const hash = "a".repeat(64);

async function fail(attempt: () => Promise<unknown>) {
  try {
    await attempt();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected the statement to fail");
}

function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return app(`insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`, Object.values(row));
}

async function wallet() {
  const row = { id: crypto.randomUUID(), player_id: crypto.randomUUID(), currency: "BRL", balance: "0.00", version: 1, created_at: now, updated_at: now };
  await insert("wallets", row);
  return row;
}

const base = (w: { id: string; player_id: string }, overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  provider_id: "provider-a",
  external_transaction_id: crypto.randomUUID(),
  idempotency_key: crypto.randomUUID(),
  payload_hash: hash,
  wallet_id: w.id,
  player_id: w.player_id,
  round_id: "r",
  game_id: "g",
  kind: "WIN",
  amount: "10.00",
  currency: "BRL",
  reference_external_transaction_id: "bet-x",
  status: "PENDING_REFERENCE",
  result_balance: "0.00",
  result_currency: "BRL",
  result_wallet_version: 1,
  correlation_id: "c",
  next_reference_attempt_at: now,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const pending = async () => {
  const w = await wallet();
  const row = base(w);
  await insert("wager_transactions", row);
  return { w, row };
};

const processedBet = (w: { id: string; player_id: string }) =>
  base(w, {
    kind: "BET",
    reference_external_transaction_id: null,
    status: "PROCESSED",
    processed_at: now,
    next_reference_attempt_at: null,
  });

describe("wager_transactions_guard", () => {
  test.each([
    ["id", `id = '${crypto.randomUUID()}'`],
    ["provider_id", "provider_id = 'other'"],
    ["external_transaction_id", "external_transaction_id = 'other'"],
    ["idempotency_key", "idempotency_key = 'other'"],
    ["payload_hash", `payload_hash = '${"b".repeat(64)}'`],
    ["player_id", `player_id = '${crypto.randomUUID()}'`],
    ["round_id", "round_id = 'other'"],
    ["game_id", "game_id = 'other'"],
    ["kind", "kind = 'REFUND'"],
    ["amount", "amount = 11.00"],
    ["currency", "currency = 'USD'"],
    ["reference_external_transaction_id", "reference_external_transaction_id = 'other'"],
    ["correlation_id", "correlation_id = 'other'"],
    ["created_at", "created_at = created_at + interval '1 day'"],
  ])("the %s of a pending transaction cannot change", async (_column, assignment) => {
    const { row } = await pending();
    expect(await fail(() => owner(`update wager_transactions set ${assignment} where id = ?`, [row.id]))).toBe("WG001");
  });

  test("the wallet of a transaction cannot change", async () => {
    const { row } = await pending();
    const other = await wallet();
    expect(await fail(() => owner("update wager_transactions set wallet_id = ? where id = ?", [other.id, row.id]))).toBe("WG001");
  });

  test("scheduling and bookkeeping columns can change while pending, for the app role too", async () => {
    const { row } = await pending();
    await app(
      `update wager_transactions
          set reference_attempts = 3, consecutive_failures = 1,
              next_reference_attempt_at = now() + interval '1 minute', updated_at = now()
        where id = ?`,
      [row.id],
    );
    const [stored] = await app("select reference_attempts, consecutive_failures, status from wager_transactions where id = ?", [row.id]);
    expect(stored).toEqual({ reference_attempts: 3, consecutive_failures: 1, status: "PENDING_REFERENCE" });
  });

  test("a pending transaction can be processed against its reference", async () => {
    const { w, row } = await pending();
    const bet = processedBet(w);
    await insert("wager_transactions", bet);
    await app(
      `update wager_transactions
          set status = 'PROCESSED', reference_transaction_id = ?, processed_at = now(),
              next_reference_attempt_at = null, updated_at = now()
        where id = ?`,
      [bet.id, row.id],
    );
    const [stored] = await app("select status, reference_transaction_id from wager_transactions where id = ?", [row.id]);
    expect(stored).toEqual({ status: "PROCESSED", reference_transaction_id: bet.id });
  });

  test("a pending transaction can be rejected or failed", async () => {
    const rejected = await pending();
    await app(
      "update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_reference_attempt_at = null where id = ?",
      [rejected.row.id],
    );
    const failed = await pending();
    await app(
      "update wager_transactions set status = 'FAILED', failure_code = 'PROCESSING_FAILED', next_reference_attempt_at = null where id = ?",
      [failed.row.id],
    );
    const statusOf = async (id: unknown) => ((await app("select status from wager_transactions where id = ?", [id]))[0] as { status: string }).status;
    expect([await statusOf(rejected.row.id), await statusOf(failed.row.id)]).toEqual(["REJECTED", "FAILED"]);
  });

  test("the reference cannot be set while the transaction stays pending", async () => {
    const { w, row } = await pending();
    const bet = processedBet(w);
    await insert("wager_transactions", bet);
    expect(await fail(() => app("update wager_transactions set reference_transaction_id = ? where id = ?", [bet.id, row.id]))).toBe("WG001");
  });

  test("a stored transaction cannot go back to PENDING", async () => {
    const { row } = await pending();
    expect(
      await fail(() => owner("update wager_transactions set status = 'PENDING', next_reference_attempt_at = null where id = ?", [row.id])),
    ).toBeDefined();
  });

  test.each([
    ["PROCESSED", { status: "PROCESSED", processed_at: now, next_reference_attempt_at: null, reference_external_transaction_id: null, kind: "BET" }],
    ["REJECTED", { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", next_reference_attempt_at: null, kind: "BET", reference_external_transaction_id: null }],
    ["FAILED", { status: "FAILED", failure_code: "PROCESSING_FAILED", next_reference_attempt_at: null }],
  ])("a %s transaction cannot be updated at all", async (_status, overrides) => {
    const w = await wallet();
    const row = base(w, overrides);
    await insert("wager_transactions", row);
    expect(await fail(() => app("update wager_transactions set updated_at = now() where id = ?", [row.id]))).toBe("WG001");
    expect(await fail(() => owner("update wager_transactions set status = 'PENDING_REFERENCE', next_reference_attempt_at = now() where id = ?", [row.id]))).toBe("WG001");
    expect(await fail(() => owner("update wager_transactions set failure_code = null where id = ?", [row.id]))).toBe("WG001");
  });
});
