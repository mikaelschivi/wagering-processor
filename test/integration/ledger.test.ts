import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type BootedApp, bootApp } from "../helpers/app";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { encodeCursor } from "../../src/infra/http/schemas";

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

async function walletWithMovements(movements: number) {
  const playerId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }),
  });
  const { id: walletId } = (await created.json()) as { id: string };
  for (let n = 1; n <= movements; n++) {
    await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { ...json, "idempotency-key": `k-${walletId}-${n}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `t-${walletId}-${n}`,
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

interface Page {
  items: ({ walletVersion: number } & Record<string, unknown>)[];
  nextCursor: string | null;
}

const ledger = async (walletId: string, query = ""): Promise<{ status: number; body: Page }> => {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger${query}`);
  return { status: response.status, body: (await response.json()) as Page };
};

describe("GET /wallets/:id/ledger", () => {
  test("lists entries newest first with the full entry shape", async () => {
    const walletId = await walletWithMovements(2);
    const { status, body } = await ledger(walletId);
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.walletVersion)).toEqual([3, 2, 1]);
    expect(body.items[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      direction: "DEBIT",
      amount: { amount: "10.00", currency: "BRL" },
      balanceBefore: { amount: "990.00", currency: "BRL" },
      balanceAfter: { amount: "980.00", currency: "BRL" },
      walletVersion: 3,
      createdAt: expect.stringMatching(/Z$/),
    });
    expect(body.items[2]).toMatchObject({ direction: "CREDIT", amount: { amount: "1000.00" } });
  });

  test("pages through all entries once, with no gaps or repeats", async () => {
    const walletId = await walletWithMovements(6);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await ledger(walletId, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.items.map((item) => item.walletVersion));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  test("an exact multiple of the limit ends without a dangling cursor", async () => {
    const walletId = await walletWithMovements(3);
    const first = await ledger(walletId, "?limit=2");
    const second = await ledger(walletId, `?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((item) => item.walletVersion)).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();
  });

  test("the cursor stays valid when new entries arrive", async () => {
    const walletId = await walletWithMovements(3);
    const first = await ledger(walletId, "?limit=2");
    await walletWithMovementsOn(walletId);
    const next = await ledger(walletId, `?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map((item) => item.walletVersion)).toEqual([2, 1]);
  });

  test("an empty ledger is an empty page", async () => {
    const created = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" } }),
    });
    const { id } = (await created.json()) as { id: string };
    expect((await ledger(id)).body).toEqual({ items: [], nextCursor: null });
  });

  test.each([
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a non-numeric limit", "?limit=abc"],
    ["a negative limit", "?limit=-1"],
    ["garbage cursor", "?cursor=not-a-cursor"],
    ["a cursor of the wrong shape", `?cursor=${Buffer.from('{"v":2,"w":3}').toString("base64url")}`],
    ["a zero cursor", `?cursor=${encodeCursor(0)}`],
    ["an unknown query field", "?sort=asc"],
  ])("%s is a 400", async (_name, query) => {
    const walletId = await walletWithMovements(0);
    expect((await ledger(walletId, query)).status).toBe(400);
  });

  test("an unknown wallet is 404 and a malformed id is 400", async () => {
    expect((await ledger(crypto.randomUUID())).status).toBe(404);
    expect((await ledger("nope")).status).toBe(400);
  });
});

async function walletWithMovementsOn(walletId: string) {
  const wallet = (await (await fetch(`${baseUrl}/wallets/${walletId}`)).json()) as { playerId: string };
  await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { ...json, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      providerId: "provider-a",
      externalTransactionId: crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    }),
  });
}
