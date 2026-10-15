import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import {
  PendingReferenceWorker,
  type PendingReferenceOptions,
} from "../../src/application/pending-reference-worker";
import { ProcessWagerTransaction, type WagerRequest } from "../../src/application/process-wager-transaction";
import { Reconciliation } from "../../src/application/reconciliation";
import { Money } from "../../src/domain/money";
import { WagerTransactionKind as Kind } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { openingRecord } from "../helpers/fakes";

let db: TestDatabase;
let wallets: PostgresWalletStore;
let store: PostgresWagerStore;
let useCase: ProcessWagerTransaction;

const options: PendingReferenceOptions = {
  batch: 50,
  concurrency: 5,
  leaseS: 30,
  intervalMs: 50,
  ttlMs: 600_000,
  maxFailures: 3,
  budgetMs: 5000,
};

const makeWorker = (overrides: Partial<PendingReferenceOptions> = {}) =>
  new PendingReferenceWorker(store, new UuidV7Generator(), new SystemClock(), { ...options, ...overrides }, () => 0);

beforeAll(async () => {
  db = await createTestDatabase();
  wallets = new PostgresWalletStore(db.app, db.config);
  store = new PostgresWagerStore(db.app, db.config);
  useCase = new ProcessWagerTransaction(store, new UuidV7Generator(), new SystemClock(), {
    maxAttempts: 5,
    deadlineMs: db.config.USE_CASE_DEADLINE_MS,
    jitterMinMs: 5,
    jitterMaxMs: 25,
    random: Math.random,
  });
}, 30_000);

afterAll(async () => {
  await db.drop();
});

const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

async function openWallet(balance = "100.00") {
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl(balance),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at: new Date(),
  });
  await wallets.create(wallet, openingRecord(wallet, openingEntry));
  return wallet;
}

const submit = (wallet: Wallet, external: string, kind: Kind, amount: string, extra: Partial<WagerRequest> = {}) =>
  useCase.execute({
    request: {
      providerId: "provider-a",
      externalTransactionId: `${wallet.id}-${external}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind,
      money: brl(amount),
      ...(extra.referenceExternalTransactionId && {
        referenceExternalTransactionId: `${extra.walletId ?? wallet.id}-${extra.referenceExternalTransactionId}`,
      }),
      ...(extra.walletId && { walletId: extra.walletId }),
    },
    actor: { kind: "anonymous-dev" },
    idempotencyKey: `k-${wallet.id}-${external}`,
    correlationId: `corr-${external}`,
  });

const makeDue = (walletId: string) =>
  query("update wager_transactions set next_reference_attempt_at = now() where wallet_id = ? and status = 'PENDING_REFERENCE'", [walletId]);
const balance = async (wallet: Wallet) =>
  ((await query("select balance from wallets where id = ?", [wallet.id]))[0] as { balance: string }).balance;
const row = async (transactionId: string) => (await query("select * from wager_transactions where id = ?", [transactionId]))[0] as Record<string, unknown>;
const reconcile = (wallet: Wallet) => new Reconciliation(wallets).execute(wallet.id);

describe("claiming due references", () => {
  test("a freshly pending transaction is not due, a due one is claimed once and then leased", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "10.00", { referenceExternalTransactionId: "bet" });
    expect(await store.claimDueReferences(50, 30)).toEqual([]);

    await makeDue(wallet.id);
    expect(await store.claimDueReferences(50, 30)).toEqual([{ transactionId: win.transactionId, walletId: wallet.id }]);
    expect(await store.claimDueReferences(50, 30)).toEqual([]);
    const [lease] = await query(
      "select extract(epoch from next_reference_attempt_at - now()) as seconds from wager_transactions where id = ?",
      [win.transactionId],
    );
    expect(Number((lease as { seconds: string }).seconds)).toBeGreaterThan(25);
  });

  test("two workers claiming at once never receive the same transaction", async () => {
    const wallet = await openWallet();
    const ids = new Set<string>();
    for (let n = 0; n < 20; n++) {
      ids.add((await submit(wallet, `w${n}`, Kind.Win, "1.00", { referenceExternalTransactionId: `missing-${n}` })).transactionId);
    }
    await makeDue(wallet.id);
    const [first, second] = await Promise.all([store.claimDueReferences(20, 30), store.claimDueReferences(20, 30)]);
    const claimed = [...first, ...second].map((item) => item.transactionId);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed)).toEqual(ids);
  });

  test("a transaction another worker is processing right now is skipped, not waited for", async () => {
    const wallet = await openWallet();
    const busy = await submit(wallet, "busy", Kind.Win, "1.00", { referenceExternalTransactionId: "x-busy" });
    const free = await submit(wallet, "free", Kind.Win, "1.00", { referenceExternalTransactionId: "x-free" });
    await makeDue(wallet.id);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.owner.em.fork().transactional(async (em) => {
      await em.execute("select id from wager_transactions where id = ? for update", [busy.transactionId]);
      locked();
      await hold;
    });
    await holding;

    const claimed = await Promise.race([store.claimDueReferences(50, 30), Bun.sleep(2000).then(() => "blocked" as const)]);
    release();
    await holder;
    expect(claimed).toEqual([{ transactionId: free.transactionId, walletId: wallet.id }]);
  });

  test("the claim limit is respected and the oldest due come first", async () => {
    const wallet = await openWallet();
    for (let n = 0; n < 5; n++) await submit(wallet, `o${n}`, Kind.Win, "1.00", { referenceExternalTransactionId: `x-${n}` });
    await makeDue(wallet.id);
    expect(await store.claimDueReferences(2, 30)).toHaveLength(2);
  });
});

describe("resolving out-of-order transactions", () => {
  test("a WIN is credited after its BET arrives, with ledger, events and a consistent balance", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "30.00", { referenceExternalTransactionId: "bet" });
    const bet = await submit(wallet, "bet", Kind.Bet, "10.00");
    await makeDue(wallet.id);

    const report = await makeWorker().runOnce();
    expect(report.outcomes.resolved).toBe(1);
    expect(await row(win.transactionId)).toMatchObject({
      status: "PROCESSED",
      reference_transaction_id: bet.transactionId,
      next_reference_attempt_at: null,
      result_balance: "120.00",
      result_wallet_version: 3,
    });
    expect(await balance(wallet)).toBe("120.00");
    expect(await reconcile(wallet)).toMatchObject({ consistent: true, checkedEntries: 3 });

    const events = await query(
      "select event_type, payload->>'correlationId' as corr, payload->>'causationId' as cause from outbox_messages where aggregate_id in (?, ?) order by seq",
      [win.transactionId, wallet.id],
    );
    expect(events.filter((event) => (event as { cause: string }).cause === win.transactionId).map((event) => (event as { event_type: string }).event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events.at(-1)).toMatchObject({ corr: "corr-win" });
  });

  test("the arrival of the BET makes its waiting dependents due at once", async () => {
    const wallet = await openWallet();
    const refund = await submit(wallet, "refund", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet" });
    expect(await store.claimDueReferences(50, 30)).toEqual([]);

    await submit(wallet, "bet", Kind.Bet, "10.00");
    const [state] = await query("select next_reference_attempt_at <= now() as due from wager_transactions where id = ?", [refund.transactionId]);
    expect(state).toEqual({ due: true });
    expect(await store.claimDueReferences(50, 30)).toEqual([{ transactionId: refund.transactionId, walletId: wallet.id }]);
  });

  test("a ROLLBACK delivered before its BET is applied after it and the wallet reconciles", async () => {
    const wallet = await openWallet();
    const rollback = await submit(wallet, "rb", Kind.Rollback, "10.00", { referenceExternalTransactionId: "bet" });
    expect(String(rollback.status)).toBe("PENDING_REFERENCE");
    await submit(wallet, "bet", Kind.Bet, "10.00");
    expect(await balance(wallet)).toBe("90.00");

    await makeWorker().runOnce();
    expect(await balance(wallet)).toBe("100.00");
    expect(await row(rollback.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await reconcile(wallet)).toMatchObject({ consistent: true, checkedEntries: 3 });
  });

  test("a chain of out-of-order reversals resolves across passes", async () => {
    const wallet = await openWallet();
    const rollback = await submit(wallet, "rb", Kind.Rollback, "10.00", { referenceExternalTransactionId: "refund" });
    const refund = await submit(wallet, "refund", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet" });
    await submit(wallet, "bet", Kind.Bet, "10.00");
    const worker = makeWorker();
    for (let pass = 0; pass < 4; pass++) {
      await makeDue(wallet.id);
      await worker.runOnce();
    }
    expect(await row(refund.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await row(rollback.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await balance(wallet)).toBe("90.00");
    expect(await reconcile(wallet)).toMatchObject({ consistent: true });
  });

  test("a second reversal of the same BET waiting in line is rejected, not applied twice", async () => {
    const wallet = await openWallet();
    const first = await submit(wallet, "refund-1", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet" });
    const second = await submit(wallet, "refund-2", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet" });
    await submit(wallet, "bet", Kind.Bet, "10.00");
    await makeDue(wallet.id);
    await makeWorker({ concurrency: 1 }).runOnce();

    const statuses = [await row(first.transactionId), await row(second.transactionId)].map((tx) => tx.status);
    expect(statuses.sort()).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = [await row(first.transactionId), await row(second.transactionId)].find((tx) => tx.status === "REJECTED")!;
    expect(rejected.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balance(wallet)).toBe("100.00");
  });

  test("a dependent whose reference lives in another wallet is not nudged and resolves as a mismatch", async () => {
    const a = await openWallet();
    const b = await openWallet();
    const sharedBet = `shared-${crypto.randomUUID()}`;
    const command = (wallet: Wallet, external: string, kind: Kind, extra: Partial<WagerRequest> = {}) => ({
      request: {
        providerId: "provider-a",
        externalTransactionId: external,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind,
        money: brl("10.00"),
        ...extra,
      },
      actor: { kind: "anonymous-dev" as const },
      idempotencyKey: `k-${external}`,
      correlationId: `corr-${external}`,
    });
    const win = await useCase.execute(command(b, `win-${sharedBet}`, Kind.Win, { referenceExternalTransactionId: sharedBet }));
    await useCase.execute(command(a, sharedBet, Kind.Bet));
    expect(await store.claimDueReferences(50, 30)).toEqual([]);

    await makeDue(b.id);
    await makeWorker().runOnce();
    expect(await row(win.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_MISMATCH" });
    expect(await balance(b)).toBe("100.00");
  });
});

describe("expiry and rescheduling", () => {
  test("a reference that never arrives is rejected after the TTL with an event", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "10.00", { referenceExternalTransactionId: "never" });
    await makeDue(wallet.id);
    await Bun.sleep(30);

    const report = await makeWorker({ ttlMs: 10 }).runOnce();
    expect(report.outcomes.expired).toBe(1);
    expect(await row(win.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      next_reference_attempt_at: null,
    });
    expect(await balance(wallet)).toBe("100.00");
    const events = await query("select event_type from outbox_messages where aggregate_id = ? order by seq", [win.transactionId]);
    expect(events.map((event) => (event as { event_type: string }).event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
  });

  test("a reference that has not arrived yet backs off and stays pending", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "10.00", { referenceExternalTransactionId: "later" });
    await makeDue(wallet.id);
    await makeWorker().runOnce();

    const [state] = await query(
      "select status, reference_attempts, extract(epoch from next_reference_attempt_at - now()) as seconds from wager_transactions where id = ?",
      [win.transactionId],
    );
    expect(state).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 1 });
    expect(Number((state as { seconds: string }).seconds)).toBeGreaterThan(1);
    expect(Number((state as { seconds: string }).seconds)).toBeLessThanOrEqual(2);
  });

  test("two workers processing the same claimed item credit once", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "30.00", { referenceExternalTransactionId: "bet" });
    await submit(wallet, "bet", Kind.Bet, "10.00");
    const item = { transactionId: win.transactionId, walletId: wallet.id };
    type Processor = { process(item: { transactionId: string; walletId: string }): Promise<string> };
    const outcomes = await Promise.all([makeWorker(), makeWorker(), makeWorker()].map((worker) => (worker as unknown as Processor).process(item)));

    expect(outcomes.filter((outcome) => outcome === "resolved")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(2);
    expect(await balance(wallet)).toBe("120.00");
    expect(await reconcile(wallet)).toMatchObject({ consistent: true });
  });

  test("failure counting is stored on the row", async () => {
    const wallet = await openWallet();
    const win = await submit(wallet, "win", Kind.Win, "10.00", { referenceExternalTransactionId: "x" });
    const counts: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      counts.push(await store.runLocked(wallet.id, { budgetMs: 5000 }, async (tx) => (await tx.loadWallet(), tx.recordFailure(win.transactionId))));
    }
    expect(counts).toEqual([1, 2]);
    expect(await row(win.transactionId)).toMatchObject({ consecutive_failures: 2 });
  });
});

describe("the reference-worker role", () => {
  const post = (baseUrl: string, path: string, body: unknown, key?: string) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key && { "idempotency-key": key }) },
      body: JSON.stringify(body),
    });

  async function scenario(roles: ("api" | "reference-worker")[]) {
    const app = await NestFactory.create(
      AppModule.forRoot({ ...db.config, APP_ROLES: roles, REFERENCE_WORKER_INTERVAL_MS: 50, AWS_ENDPOINT_URL: "http://127.0.0.1:1" }),
      { logger: false },
    );
    await app.listen(0);
    try {
      const baseUrl = await app.getUrl();
      const playerId = crypto.randomUUID();
      const created = await post(baseUrl, "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
      const { id: walletId } = (await created.json()) as { id: string };
      const wager = (external: string, kind: string, extra: Record<string, unknown> = {}) => ({
        providerId: "provider-a",
        externalTransactionId: external,
        playerId,
        walletId,
        roundId: "r",
        gameId: "g",
        kind,
        money: { amount: "10.00", currency: "BRL" },
        ...extra,
      });
      const refund = `refund-${walletId}`;
      const bet = `bet-${walletId}`;
      const pending = await post(baseUrl, "/wagering/transactions", wager(refund, "REFUND", { referenceExternalTransactionId: bet }), refund);
      expect(pending.status).toBe(202);
      await post(baseUrl, "/wagering/transactions", wager(bet, "BET"), bet);
      const deadline = Date.now() + 5000;
      let status = "";
      while (Date.now() < deadline) {
        const lookup = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/${refund}`);
        status = ((await lookup.json()) as { status: string }).status;
        if (status !== "PENDING_REFERENCE") break;
        await Bun.sleep(100);
      }
      return status;
    } finally {
      await app.close();
    }
  }

  test("an instance with the role resolves a waiting REFUND on its own", async () => {
    expect(await scenario(["api", "reference-worker"])).toBe("PROCESSED");
  }, 30_000);

  test("an instance without the role leaves it pending", async () => {
    expect(await scenario(["api"])).toBe("PENDING_REFERENCE");
  }, 30_000);
});
