import { describe, expect, test } from "bun:test";
import { OutboxPublisher } from "../../src/application/outbox-publisher";
import { PendingReferenceWorker } from "../../src/application/pending-reference-worker";
import {
  EventSender,
  type OutboxBatch,
  type OutboxMessage,
  OutboxStore,
  type ReconciliationSnapshot,
  TransientDbError,
  UniqueRaceError,
  WalletStore,
} from "../../src/application/ports";
import { ProcessWagerTransaction, type WagerRequest } from "../../src/application/process-wager-transaction";
import { Reconciliation } from "../../src/application/reconciliation";
import { Money } from "../../src/domain/money";
import { WagerTransactionKind as Kind } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { InMemoryMetrics } from "../../src/observability";
import { FixedClock, SequentialIds } from "../helpers/fakes";
import { InMemoryWagerStore } from "../helpers/in-memory-wager-store";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-02-03T04:05:06.000Z");

function setup(balance = "100.00", maxAttempts = 3) {
  const store = new InMemoryWagerStore();
  store.seedWallet(Wallet.rehydrate({ id: "w1", playerId: "p1", currency: "BRL", balance: brl(balance), version: 1, createdAt: t0, updatedAt: t0 }));
  const metrics = new InMemoryMetrics();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const useCase = new ProcessWagerTransaction(
    store,
    ids,
    clock,
    { maxAttempts, deadlineMs: 10_000, jitterMinMs: 1, jitterMaxMs: 1, random: () => 0 },
    metrics,
  );
  return { store, metrics, clock, ids, useCase };
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

const run = (useCase: ProcessWagerTransaction, req: WagerRequest, key = `k-${req.externalTransactionId}`, inbox?: { consumerName: string; messageId: string; messageHash: string }) =>
  useCase.execute({ request: req, actor: { kind: "anonymous-dev" }, idempotencyKey: key, correlationId: "c", ...(inbox && { inbox }) });

describe("InMemoryMetrics", () => {
  test("counts, sets gauges and records histograms per label set", () => {
    const metrics = new InMemoryMetrics();
    metrics.count("hits", { route: "a" });
    metrics.count("hits", { route: "a" }, 2);
    metrics.count("hits", { route: "b" });
    metrics.gauge("depth", 5);
    metrics.gauge("depth", 3);
    metrics.observe("latency", 0.02);
    metrics.observe("latency", 0.3);

    expect(metrics.counter("hits", { route: "a" })).toBe(3);
    expect(metrics.counter("hits", { route: "b" })).toBe(1);
    expect(metrics.counter("hits", { route: "c" })).toBe(0);
    expect(metrics.gaugeValue("depth")).toBe(3);
    expect(metrics.samples("latency")).toBe(2);
    expect(metrics.snapshot()).toEqual({
      counters: { "hits{route=a}": 3, "hits{route=b}": 1 },
      gauges: { depth: 3 },
      histograms: {
        latency: {
          count: 2,
          sum: 0.32,
          max: 0.3,
          buckets: { "0.005": 0, "0.01": 0, "0.025": 1, "0.05": 1, "0.1": 1, "0.25": 1, "0.5": 2, "1": 2, "2.5": 2, "5": 2, "10": 2 },
        },
      },
    });
  });

  test("label order does not create a second series", () => {
    const metrics = new InMemoryMetrics();
    metrics.count("x", { a: "1", b: "2" });
    metrics.count("x", { b: "2", a: "1" });
    expect(metrics.counter("x", { a: "1", b: "2" })).toBe(2);
  });
});

describe("use case metrics", () => {
  test("transactions are counted by status and kind, replays separately", async () => {
    const { useCase, metrics } = setup("30.00");
    await run(useCase, request("b1", Kind.Bet, "10.00"));
    await run(useCase, request("b1", Kind.Bet, "10.00"));
    await run(useCase, request("b2", Kind.Bet, "50.00"));
    await run(useCase, request("w1", Kind.Win, "5.00", { referenceExternalTransactionId: "missing" }));

    expect(metrics.counter("wager_transactions_total", { status: "PROCESSED", kind: "BET" })).toBe(1);
    expect(metrics.counter("wager_transactions_total", { status: "REJECTED", kind: "BET" })).toBe(1);
    expect(metrics.counter("wager_transactions_total", { status: "PENDING_REFERENCE", kind: "WIN" })).toBe(1);
    expect(metrics.counter("idempotent_replays_total")).toBe(1);
  });

  test("business errors are counted by code", async () => {
    const { useCase, metrics } = setup();
    await run(useCase, request("b1", Kind.Bet, "10.00"), "same-key");
    await run(useCase, request("b1", Kind.Bet, "11.00"), "same-key").catch(() => {});
    await run(useCase, request("b1", Kind.Bet, "10.00"), "other-key").catch(() => {});
    await run(useCase, request("b9", Kind.Bet, "10.00", { walletId: "nope" })).catch(() => {});

    expect(metrics.counter("request_errors_total", { code: "IDEMPOTENCY_KEY_CONFLICT" })).toBe(1);
    expect(metrics.counter("request_errors_total", { code: "EXTERNAL_TRANSACTION_ID_CONFLICT" })).toBe(1);
    expect(metrics.counter("request_errors_total", { code: "WALLET_NOT_FOUND" })).toBe(1);
  });

  test("retries are counted by reason and lock conflicts separately", async () => {
    const { useCase, metrics, store } = setup();
    store.failNext(new TransientDbError("40P01"));
    store.failNext(new TransientDbError("57014"));
    store.failNext(new UniqueRaceError("ux_tx_provider_idem"));
    await run(useCase, request("b1", Kind.Bet, "10.00"), "k", undefined).catch(() => {});

    expect(metrics.counter("use_case_retries_total", { reason: "40P01" })).toBe(1);
    expect(metrics.counter("use_case_retries_total", { reason: "57014" })).toBe(1);
    expect(metrics.counter("lock_conflicts_total", { reason: "40P01" })).toBe(1);
    expect(metrics.counter("lock_conflicts_total", { reason: "57014" })).toBe(0);
  });

  test("an inbox duplicate is counted once and only for queue input", async () => {
    const { useCase, metrics } = setup();
    const inbox = { consumerName: "c", messageId: "m1", messageHash: "h" };
    await run(useCase, request("b1", Kind.Bet, "10.00"), "k1", inbox);
    expect(metrics.counter("inbox_duplicates_total")).toBe(0);
    await run(useCase, request("b1", Kind.Bet, "10.00"), "k1", inbox);
    expect(metrics.counter("inbox_duplicates_total")).toBe(1);
  });

  test("processing time is recorded per source, including failed attempts", async () => {
    const { useCase, metrics } = setup();
    await run(useCase, request("b1", Kind.Bet, "10.00"));
    await run(useCase, request("b2", Kind.Bet, "10.00"), "k2", { consumerName: "c", messageId: "m", messageHash: "h" });
    await run(useCase, request("b3", Kind.Bet, "10.00", { walletId: "nope" })).catch(() => {});
    expect(metrics.samples("processing_seconds", { source: "http" })).toBe(2);
    expect(metrics.samples("processing_seconds", { source: "sqs" })).toBe(1);
  });
});

describe("worker, publisher and reconciliation metrics", () => {
  test("the reference worker counts each outcome", async () => {
    const { useCase, store, ids, clock, metrics } = setup();
    await run(useCase, request("w1", Kind.Win, "5.00", { referenceExternalTransactionId: "b1" }));
    const worker = new PendingReferenceWorker(
      store,
      ids,
      clock,
      { batch: 10, concurrency: 1, leaseS: 30, intervalMs: 1000, ttlMs: 1000, maxFailures: 3, budgetMs: 5000 },
      () => 0,
      metrics,
    );
    await worker.runOnce();
    expect(metrics.counter("reference_worker_total", { outcome: "rescheduled" })).toBe(1);
    await run(useCase, request("b1", Kind.Bet, "10.00"));
    await worker.runOnce();
    expect(metrics.counter("reference_worker_total", { outcome: "resolved" })).toBe(1);
  });

  test("the outbox publisher counts published and failed events", async () => {
    const messages: OutboxMessage[] = ["a", "b", "c"].map((id) => ({ id, partitionKey: "w", eventType: "X", payload: "{}", attempts: 0 }));
    const store = new (class extends OutboxStore {
      async stats() {
        return { pending: 0, oldestAgeSeconds: 0 };
      }
      async withBatch<T>(_limit: number, work: (batch: OutboxBatch) => Promise<T>) {
        return work({ messages, markPublished: async () => {}, markFailed: async () => {} });
      }
    })();
    const sender = new (class extends EventSender {
      async send() {
        return [{ id: "b", error: "Throttled" }];
      }
    })();
    const metrics = new InMemoryMetrics();
    await new OutboxPublisher(store, sender, new FixedClock(), { batchSize: 10, intervalMs: 500 }, metrics).publishBatch();
    expect(metrics.counter("outbox_publish_total", { result: "published" })).toBe(2);
    expect(metrics.counter("outbox_publish_total", { result: "failed" })).toBe(1);
  });

  test("reconciliation counts a mismatch and stays silent for a consistent wallet", async () => {
    const wallet = (balance: string) =>
      Wallet.rehydrate({ id: "w", playerId: "p", currency: "BRL", balance: brl(balance), version: 2, createdAt: t0, updatedAt: t0 });
    const store = (snapshot: ReconciliationSnapshot) =>
      new (class extends WalletStore {
        async reconciliationSnapshot() {
          return snapshot;
        }
        async create() {}
        async findById(): Promise<undefined> {}
        async ledgerPage(): Promise<[]> {
          return [];
        }
      })();
    const metrics = new InMemoryMetrics();
    const consistent = { wallet: wallet("90.00"), calculated: brl("90.00"), entryCount: 2, maxVersion: 2, tailBalance: brl("90.00") };
    await new Reconciliation(store(consistent), metrics).execute("w");
    expect(metrics.counter("reconciliation_mismatches_total")).toBe(0);
    await new Reconciliation(store({ ...consistent, calculated: brl("80.00") }), metrics).execute("w");
    expect(metrics.counter("reconciliation_mismatches_total")).toBe(1);
  });
});
