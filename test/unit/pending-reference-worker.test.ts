import { describe, expect, test } from "bun:test";
import {
  PendingReferenceWorker,
  type PendingReferenceOptions,
  referenceBackoffMs,
} from "../../src/application/pending-reference-worker";
import { InvariantDbError, TransientDbError } from "../../src/application/ports";
import { ProcessWagerTransaction, type WagerRequest } from "../../src/application/process-wager-transaction";
import { FailureCode } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { FixedClock, SequentialIds } from "../helpers/fakes";
import { InMemoryWagerStore } from "../helpers/in-memory-wager-store";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-02-03T04:05:06.000Z");

const options: PendingReferenceOptions = {
  batch: 10,
  concurrency: 1,
  leaseS: 30,
  intervalMs: 1000,
  ttlMs: 600_000,
  maxFailures: 3,
  budgetMs: 5000,
};

function setup(balance = "100.00") {
  const store = new InMemoryWagerStore();
  for (const id of ["w1", "w2"]) {
    store.seedWallet(
      Wallet.rehydrate({ id, playerId: "p1", currency: "BRL", balance: brl(balance), version: 1, createdAt: t0, updatedAt: t0 }),
    );
  }
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const useCase = new ProcessWagerTransaction(store, ids, clock, {
    maxAttempts: 1,
    deadlineMs: 10_000,
    jitterMinMs: 1,
    jitterMaxMs: 1,
    random: () => 0,
  });
  const worker = new PendingReferenceWorker(store, ids, clock, options, () => 0);
  return { store, clock, useCase, worker };
}

const request = (external: string, kind: Kind, amount: string, extra: Partial<WagerRequest> = {}): WagerRequest => ({
  providerId: "prov",
  externalTransactionId: external,
  playerId: "p1",
  walletId: "w1",
  roundId: "r1",
  gameId: "g1",
  kind,
  money: brl(amount),
  ...extra,
});

const submit = (useCase: ProcessWagerTransaction, req: WagerRequest) =>
  useCase.execute({ request: req, actor: { kind: "anonymous-dev" }, idempotencyKey: `k-${req.externalTransactionId}`, correlationId: `corr-${req.externalTransactionId}` });

const statusOf = (store: InMemoryWagerStore, id: string) => store.transactions.get(id)!.status;

describe("PendingReferenceWorker: waiting", () => {
  test("a reference that is still missing reschedules with backoff and changes nothing else", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));

    const report = await worker.runOnce();
    expect(report).toMatchObject({ claimed: 1, outcomes: { rescheduled: 1 } });
    expect(statusOf(store, win.transactionId)).toBe(Status.PendingReference);
    expect(store.references.get(win.transactionId)).toMatchObject({ attempts: 1, lastDelayMs: 2000 });
    expect(store.balanceOf("w1")).toBe("100.00");
    expect(store.events.map((event) => event.eventType)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("backoff grows with each attempt", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));
    const delays: number[] = [];
    for (let run = 0; run < 3; run++) {
      await worker.runOnce();
      delays.push(store.references.get(win.transactionId)!.lastDelayMs!);
    }
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  test("a reference that is itself pending keeps the dependent pending", async () => {
    const { store, useCase, worker } = setup();
    await submit(useCase, request("refund-1", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" }));
    const rollback = await submit(useCase, request("rb-1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "refund-1" }));

    const report = await worker.runOnce();
    expect(report.outcomes.rescheduled).toBe(2);
    expect(statusOf(store, rollback.transactionId)).toBe(Status.PendingReference);
  });
});

describe("PendingReferenceWorker: resolving", () => {
  test("a WIN is credited once its BET arrives, with the original correlation id and the tx as cause", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "30.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    store.events.length = 0;

    const report = await worker.runOnce();
    expect(report.outcomes.resolved).toBe(1);
    const stored = store.transactions.get(win.transactionId)!;
    expect(stored.status).toBe(Status.Processed);
    expect(stored.referenceTransactionId).toBeDefined();
    expect(stored.result?.balance.toString()).toBe("120.00");
    expect(store.balanceOf("w1")).toBe("120.00");
    expect(store.wallets.get("w1")!.version).toBe(3);
    expect(store.entries).toHaveLength(2);
    expect(store.events.map((event) => event.toJSON())).toMatchObject([
      { eventType: "WagerTransactionProcessed", aggregateId: win.transactionId, correlationId: "corr-win-1", causationId: win.transactionId },
      { eventType: "WalletBalanceChanged", aggregateId: "w1", data: { direction: "CREDIT", walletVersion: 3 } },
    ]);
  });

  test("a REFUND that arrived before its BET is applied after it", async () => {
    const { store, useCase, worker } = setup();
    await submit(useCase, request("refund-1", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(store.balanceOf("w1")).toBe("100.00");
    expect(store.entries.map((entry) => String(entry.direction))).toEqual(["DEBIT", "CREDIT"]);
  });

  test("a ROLLBACK that arrived before its BET is applied after it", async () => {
    const { store, useCase, worker } = setup();
    await submit(useCase, request("rb-1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(store.balanceOf("w1")).toBe("100.00");
  });

  test("a LOSS waiting for its BET is processed without moving the balance", async () => {
    const { store, useCase, worker } = setup();
    const loss = await submit(useCase, request("loss-1", Kind.Loss, "0.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(statusOf(store, loss.transactionId)).toBe(Status.Processed);
    expect(store.balanceOf("w1")).toBe("90.00");
    expect(store.entries).toHaveLength(1);
  });

  test("a chain resolves in one pass when the order of claims allows it", async () => {
    const { store, useCase, worker } = setup();
    await submit(useCase, request("refund-1", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" }));
    const rollback = await submit(useCase, request("rb-1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "refund-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(statusOf(store, rollback.transactionId)).toBe(Status.Processed);
    expect(store.balanceOf("w1")).toBe("90.00");
  });

  test("a reference that was rejected makes the dependent a rejection with a stable code", async () => {
    const { store, useCase, worker } = setup("5.00");
    const refund = await submit(useCase, request("refund-1", Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(store.transactions.get(refund.transactionId)).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(store.balanceOf("w1")).toBe("5.00");
    expect(store.events.at(-1)!.eventType).toBe("WagerTransactionRejected");
  });

  test("a reference on another wallet is a mismatch rejection", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00", { walletId: "w2" }));
    await worker.runOnce();
    expect(store.transactions.get(win.transactionId)).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test("a reversal that would make the balance negative is rejected with its own code", async () => {
    const { store, useCase, worker } = setup("100.00");
    const rollback = await submit(useCase, request("rb-1", Kind.Rollback, "50.00", { referenceExternalTransactionId: "win-2" }));
    await submit(useCase, request("win-2", Kind.Win, "50.00"));
    await submit(useCase, request("bet-1", Kind.Bet, "140.00"));
    expect(store.balanceOf("w1")).toBe("10.00");

    await worker.runOnce();
    expect(store.transactions.get(rollback.transactionId)).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFundsForReversal,
    });
    expect(store.balanceOf("w1")).toBe("10.00");
  });
});

describe("PendingReferenceWorker: expiry", () => {
  test("a transaction past its TTL is rejected as reference-not-found with an event", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));
    store.expired.add(win.transactionId);
    store.events.length = 0;

    const report = await worker.runOnce();
    expect(report.outcomes.expired).toBe(1);
    expect(store.transactions.get(win.transactionId)).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(store.balanceOf("w1")).toBe("100.00");
    expect(store.events.map((event) => event.eventType)).toEqual(["WagerTransactionRejected"]);
  });

  test("a reference that arrives in time wins over an expiry flag", async () => {
    const { store, useCase, worker } = setup();
    const win = await submit(useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    store.expired.add(win.transactionId);
    await worker.runOnce();
    expect(statusOf(store, win.transactionId)).toBe(Status.Processed);
  });
});

describe("PendingReferenceWorker: failures", () => {
  async function pending() {
    const ctx = setup();
    const win = await submit(ctx.useCase, request("win-1", Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }));
    return { ...ctx, id: win.transactionId };
  }

  test("a transient database error defers the item without counting a failure", async () => {
    const { store, worker, id } = await pending();
    store.failNext(new TransientDbError("deadlock"));
    expect((await worker.runOnce()).outcomes.deferred).toBe(1);
    expect(store.references.get(id)?.failures ?? 0).toBe(0);
    expect(statusOf(store, id)).toBe(Status.PendingReference);
  });

  test("a non-transient error is counted, and the third one marks the transaction FAILED with an event", async () => {
    const { store, worker, id } = await pending();
    store.events.length = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      store.failNext(new InvariantDbError("23514", "ck_x"));
      expect((await worker.runOnce()).outcomes.counted).toBe(1);
      expect(statusOf(store, id)).toBe(Status.PendingReference);
    }
    store.failNext(new InvariantDbError("23514", "ck_x"));
    expect((await worker.runOnce()).outcomes.failed).toBe(1);
    expect(store.transactions.get(id)).toMatchObject({ status: Status.Failed, failureCode: FailureCode.ProcessingFailed });
    expect(store.events.map((event) => event.eventType)).toEqual(["WagerTransactionFailed"]);
    expect(store.balanceOf("w1")).toBe("100.00");
  });

  test("a stale claim for an already resolved transaction is skipped", async () => {
    const { store, useCase, worker, id } = await pending();
    await submit(useCase, request("bet-1", Kind.Bet, "10.00"));
    await worker.runOnce();
    const outcome = await (worker as unknown as { process(item: { transactionId: string; walletId: string }): Promise<string> }).process({
      transactionId: id,
      walletId: "w1",
    });
    expect(outcome).toBe("skipped");
    expect(store.balanceOf("w1")).toBe("100.00");
  });
});

describe("PendingReferenceWorker.run and backoff", () => {
  test("pauses for the interval when the batch was not full and stops on abort", async () => {
    const { store, clock, worker } = setup();
    const controller = new AbortController();
    const original = store.claimDueReferences.bind(store);
    store.claimDueReferences = async (limit: number) => {
      if (store.claims === 1) controller.abort();
      return original(limit);
    };
    await worker.run(controller.signal, () => {});
    expect(store.claims).toBe(2);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  test("reports an error from a claim and keeps going", async () => {
    const { store, worker } = setup();
    const controller = new AbortController();
    const errors: unknown[] = [];
    let calls = 0;
    store.claimDueReferences = async () => {
      calls++;
      if (calls === 1) throw new Error("db down");
      controller.abort();
      return [];
    };
    await worker.run(controller.signal, (error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("backoff doubles from two seconds, caps at one minute, and adds at most 20% jitter", () => {
    expect([1, 2, 3, 4, 5].map((attempts) => referenceBackoffMs(attempts, () => 0))).toEqual([2000, 4000, 8000, 16000, 32000]);
    expect(referenceBackoffMs(6, () => 0)).toBe(60_000);
    expect(referenceBackoffMs(30, () => 0)).toBe(60_000);
    expect(referenceBackoffMs(1, () => 0.999)).toBeLessThanOrEqual(2400);
    expect(referenceBackoffMs(1, () => 0.999)).toBeGreaterThan(2300);
  });
});
