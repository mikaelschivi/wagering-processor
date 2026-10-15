import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IsolationLevel } from "@mikro-orm/core";
import { inTransaction } from "../../src/infra/db/transaction";
import { type BootedApp, bootApp } from "../helpers/app";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let db: TestDatabase;
let booted: BootedApp;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  booted = await bootApp(db.config);
  baseUrl = booted.baseUrl;
}, 30_000);

afterAll(async () => {
  await booted.close();
  await db.drop();
});

const json = { "content-type": "application/json" };

async function wallet(initial = "1000.00", bets = 0) {
  const playerId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ playerId, initialBalance: { amount: initial, currency: "BRL" } }),
  });
  const { id: walletId } = (await created.json()) as { id: string };
  for (let n = 0; n < bets; n++) {
    await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { ...json, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: crypto.randomUUID(),
        playerId,
        walletId,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      }),
    });
  }
  return walletId;
}

const reconcile = (walletId: string) => fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: "POST" });

async function tamper(table: string, triggers: string[], statement: string, params: unknown[]) {
  await db.owner.em.fork().transactional(async (em) => {
    for (const trigger of triggers) await em.execute(`alter table ${table} disable trigger ${trigger}`);
    await em.execute(statement, params);
    for (const trigger of triggers) await em.execute(`alter table ${table} enable trigger ${trigger}`);
  });
}

describe("POST /wallets/:id/reconciliation", () => {
  test("a wallet with history is consistent", async () => {
    const walletId = await wallet("1000.00", 3);
    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId,
      storedBalance: { amount: "970.00", currency: "BRL" },
      calculatedBalance: { amount: "970.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 4,
      issues: [],
    });
  });

  test("a wallet opened at zero without entries is consistent", async () => {
    const walletId = await wallet("0.00");
    expect(await (await reconcile(walletId)).json()).toMatchObject({ consistent: true, checkedEntries: 0, issues: [] });
  });

  test("a balance changed behind the ledger is reported with the difference and not corrected", async () => {
    const walletId = await wallet("1000.00", 1);
    await tamper(
      "wallets",
      ["wallets_guard", "wallets_ledger_consistency"],
      "update wallets set balance = balance + 5.00 where id = ?",
      [walletId],
    );
    const body = await (await reconcile(walletId)).json();
    expect(body).toMatchObject({
      consistent: false,
      storedBalance: { amount: "995.00" },
      calculatedBalance: { amount: "990.00" },
      difference: { amount: "5.00" },
      issues: ["BALANCE_MISMATCH", "CHAIN_TAIL_MISMATCH"],
    });
    expect(await (await fetch(`${baseUrl}/wallets/${walletId}`)).json()).toMatchObject({ balance: { amount: "995.00" } });
  });

  test("a missing ledger entry gives a negative difference and all three issues", async () => {
    const walletId = await wallet("1000.00", 1);
    await tamper(
      "wallet_ledger_entries",
      ["ledger_immutable"],
      "delete from wallet_ledger_entries where wallet_id = ? and wallet_version = 2",
      [walletId],
    );
    const body = await (await reconcile(walletId)).json();
    expect(body).toMatchObject({
      consistent: false,
      checkedEntries: 1,
      difference: { amount: "-10.00" },
      issues: ["BALANCE_MISMATCH", "VERSION_MISMATCH", "CHAIN_TAIL_MISMATCH"],
    });
  });

  test("a wallet version out of step with the ledger is flagged by itself", async () => {
    const walletId = await wallet("1000.00", 1);
    await tamper(
      "wallets",
      ["wallets_guard", "wallets_ledger_consistency"],
      "update wallets set version = version + 4 where id = ?",
      [walletId],
    );
    expect(await (await reconcile(walletId)).json()).toMatchObject({ issues: ["VERSION_MISMATCH"] });
  });

  test("an unknown wallet is 404 and a malformed id is 400", async () => {
    expect((await reconcile(crypto.randomUUID())).status).toBe(404);
    expect((await reconcile("nope")).status).toBe(400);
  });

  test("the snapshot runs read-only at repeatable read", async () => {
    const seen = await inTransaction(
      db.app,
      db.config,
      async (exec) => ({
        isolation: (await exec("show transaction_isolation"))[0],
        readOnly: (await exec("show transaction_read_only"))[0],
      }),
      undefined,
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
    expect(seen.isolation).toEqual({ transaction_isolation: "repeatable read" });
    expect(seen.readOnly).toEqual({ transaction_read_only: "on" });
  });
});
