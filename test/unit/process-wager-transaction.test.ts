import { describe, expect, test } from "bun:test";
import {
  ProcessWagerTransaction,
  type RetryPolicy,
  type WagerRequest,
} from "../../src/application/process-wager-transaction";
import {
  InvariantDbError,
  type Principal,
  TransientDbError,
  UnknownCommitOutcomeError,
} from "../../src/application/ports";
import {
  ExternalTransactionIdConflictError,
  FailureCode,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction";
import { LedgerDirection, Wallet } from "../../src/domain/wallet";
import { FixedClock, SequentialIds } from "../helpers/fakes";
import { InMemoryWagerStore } from "../helpers/in-memory-wager-store";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-02-03T04:05:06.000Z");

function wallet(id: string, balance: string, playerId = "p1") {
  return Wallet.rehydrate({
    id,
    playerId,
    currency: "BRL",
    balance: brl(balance),
    version: 1,
    createdAt: t0,
    updatedAt: t0,
  });
}

const policy: RetryPolicy = { maxAttempts: 3, deadlineMs: 10_000, jitterMinMs: 50, jitterMaxMs: 200, random: () => 0.5 };

function setup(balance = "100.00", retry: RetryPolicy = policy) {
  const store = new InMemoryWagerStore();
  store.seedWallet(wallet("w1", balance));
  const clock = new FixedClock();
  const useCase = new ProcessWagerTransaction(store, new SequentialIds(), clock, retry);
  return { store, useCase, clock };
}

const request = (
  externalTransactionId: string,
  kind: Kind,
  amount: string,
  overrides: Partial<WagerRequest> = {},
): WagerRequest => ({
  providerId: "prov",
  externalTransactionId,
  playerId: "p1",
  walletId: "w1",
  roundId: "r1",
  gameId: "g1",
  kind,
  money: brl(amount),
  ...overrides,
});

const submit = (useCase: ProcessWagerTransaction, req: WagerRequest, key = `prov:${req.externalTransactionId}`) =>
  useCase.execute({ request: req, actor: { kind: "anonymous-dev" }, idempotencyKey: key, correlationId: "corr-1" });

const bet = (ext: string, amount = "10.00", overrides: Partial<WagerRequest> = {}) =>
  request(ext, Kind.Bet, amount, overrides);

describe("BET", () => {
  test("is debited, with a ledger entry and a stored result", async () => {
    const { useCase, store } = setup();
    const result = await submit(useCase, bet("b1", "10.00"));

    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: "90.00", currency: "BRL" }, idempotentReplay: false });
    expect(result.failureCode).toBeUndefined();
    expect(store.balanceOf("w1")).toBe("90.00");
    expect(store.wallets.get("w1")!.version).toBe(2);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      direction: LedgerDirection.Debit,
      walletVersion: 2,
      transactionId: result.transactionId,
    });
    expect(store.entries[0]!.balanceBefore.toString()).toBe("100.00");
    expect(store.entries[0]!.balanceAfter.toString()).toBe("90.00");
    const stored = store.transactions.get(result.transactionId)!;
    expect(stored.status).toBe(Status.Processed);
    expect(stored.result).toEqual({ balance: brl("90.00"), walletVersion: 2 });
    expect(stored.correlationId).toBe("corr-1");
  });

  test("a bet equal to the balance leaves zero", async () => {
    const { useCase } = setup("25.00");
    expect((await submit(useCase, bet("b1", "25.00"))).balance?.amount).toBe("0.00");
  });

  test("insufficient funds is rejected, stored, and moves nothing", async () => {
    const { useCase, store } = setup("5.00");
    const result = await submit(useCase, bet("b1", "5.01"));

    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: "5.00" },
      idempotentReplay: false,
    });
    expect(store.balanceOf("w1")).toBe("5.00");
    expect(store.wallets.get("w1")!.version).toBe(1);
    expect(store.entries).toHaveLength(0);
    expect(store.transactions.get(result.transactionId)!.status).toBe(Status.Rejected);
  });
});

describe("WIN and LOSS", () => {
  test("a WIN is credited", async () => {
    const { useCase, store } = setup();
    const result = await submit(useCase, request("w1", Kind.Win, "40.00"));
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: "140.00" } });
    expect(store.entries[0]!.direction).toBe(LedgerDirection.Credit);
  });

  test("a LOSS is processed without touching the balance, version or ledger", async () => {
    const { useCase, store } = setup();
    const result = await submit(useCase, request("l1", Kind.Loss, "10.00"));
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: "100.00" } });
    expect(store.entries).toHaveLength(0);
    expect(store.wallets.get("w1")!.version).toBe(1);
    expect(store.transactions.get(result.transactionId)!.status).toBe(Status.Processed);
  });
});

describe("idempotency", () => {
  test("repeating a request returns the same result flagged as a replay, without a second debit", async () => {
    const { useCase, store } = setup();
    const first = await submit(useCase, bet("b1"));
    const commitsAfterFirst = store.commits;
    const second = await submit(useCase, bet("b1"));

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(store.entries).toHaveLength(1);
    expect(store.balanceOf("w1")).toBe("90.00");
    expect(store.commits).toBe(commitsAfterFirst);
  });

  test("a replay returns the balance seen at the time, not the current one", async () => {
    const { useCase } = setup();
    await submit(useCase, bet("b1", "10.00"));
    await submit(useCase, request("w1", Kind.Win, "50.00"));
    const replay = await submit(useCase, bet("b1", "10.00"));
    expect(replay.balance?.amount).toBe("90.00");
  });

  test("a rejected request stays rejected on replay, even after funds arrive", async () => {
    const { useCase } = setup("5.00");
    const first = await submit(useCase, bet("b1", "20.00"));
    await submit(useCase, request("w1", Kind.Win, "100.00"));
    const replay = await submit(useCase, bet("b1", "20.00"));
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: "5.00" },
      idempotentReplay: true,
    });
  });

  test.each<[string, Partial<WagerRequest>]>([
    ["amount", { money: brl("11.00") }],
    ["round", { roundId: "r2" }],
    ["game", { gameId: "g2" }],
    ["kind", { kind: Kind.Win }],
  ])("the same key with a different %s is a conflict and changes nothing", async (_name, change) => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"));
    const before = [store.balanceOf("w1"), store.entries.length, store.transactions.size];

    const conflict = await submit(useCase, { ...bet("b1"), ...change }, "prov:b1").catch((e: unknown) => e);

    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect([store.balanceOf("w1"), store.entries.length, store.transactions.size]).toEqual(before);
  });

  test("a new key for an external id already used is a conflict", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"), "key-1");
    const conflict = await submit(useCase, bet("b1"), "key-2").catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ExternalTransactionIdConflictError);
    expect(store.transactions.size).toBe(1);
    expect(store.entries).toHaveLength(1);
  });

  test("the same key from another provider is a separate transaction", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"), "shared-key");
    const other = await submit(useCase, bet("b1", "10.00", { providerId: "other" }), "shared-key");
    expect(other.idempotentReplay).toBe(false);
    expect(store.entries).toHaveLength(2);
    expect(store.balanceOf("w1")).toBe("80.00");
  });

  test("two parallel requests with one key but different payloads: one wins, one conflicts", async () => {
    const { useCase, store } = setup();
    const results = await Promise.allSettled([
      submit(useCase, bet("b1", "10.00"), "prov:b1"),
      submit(useCase, bet("b1", "20.00"), "prov:b1"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(store.entries).toHaveLength(1);
  });
});

describe("concurrent requests on one wallet", () => {
  test("two 80.00 bets on 100.00: one processed, one rejected, balance 20.00, one debit", async () => {
    const { useCase, store } = setup("100.00");
    const results = await Promise.all([submit(useCase, bet("b1", "80.00")), submit(useCase, bet("b2", "80.00"))]);

    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(store.balanceOf("w1")).toBe("20.00");
    expect(store.entries).toHaveLength(1);
    expect(store.wallets.get("w1")!.version).toBe(2);
  });

  test("the same bet sent 50 times in parallel debits once", async () => {
    const { useCase, store } = setup("100.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(useCase, bet("b1", "10.00"))));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(store.balanceOf("w1")).toBe("90.00");
    expect(store.entries).toHaveLength(1);
    expect(store.transactions.size).toBe(1);
  });

  test("twenty different 10.00 bets on 100.00: ten processed, ten rejected, balance never negative", async () => {
    const { useCase, store } = setup("100.00");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(useCase, bet(`b${i}`, "10.00"))));

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === Status.Rejected)).toHaveLength(10);
    expect(store.balanceOf("w1")).toBe("0.00");

    const chain = [...store.entries].sort((a, b) => a.walletVersion - b.walletVersion);
    expect(chain.map((entry) => entry.walletVersion)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    chain.forEach((entry, i) => {
      if (i > 0) expect(entry.balanceBefore.equals(chain[i - 1]!.balanceAfter)).toBe(true);
    });
  });

  test("different wallets do not block or affect each other", async () => {
    const { useCase, store } = setup("100.00");
    store.seedWallet(wallet("w2", "50.00", "p2"));
    const [first, second] = await Promise.all([
      submit(useCase, bet("b1", "30.00")),
      submit(useCase, bet("b2", "20.00", { walletId: "w2", playerId: "p2" })),
    ]);
    expect([first.status, second.status]).toEqual([Status.Processed, Status.Processed]);
    expect([store.balanceOf("w1"), store.balanceOf("w2")]).toEqual(["70.00", "30.00"]);
  });
});

describe("wallet and context checks", () => {
  test("an unknown wallet is an error and nothing is stored", async () => {
    const { useCase, store } = setup();
    const error = await submit(useCase, bet("b1", "10.00", { walletId: "missing" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletNotFoundError);
    expect(store.transactions.size).toBe(0);
  });

  test("a player that does not own the wallet is rejected and stored", async () => {
    const { useCase, store } = setup();
    const result = await submit(useCase, bet("b1", "10.00", { playerId: "intruder" }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.PlayerWalletMismatch });
    expect(store.balanceOf("w1")).toBe("100.00");
    expect(store.entries).toHaveLength(0);
  });

  test("a currency other than the wallet's is rejected and stored", async () => {
    const { useCase, store } = setup();
    const result = await submit(
      useCase,
      bet("b1", "10.00", { money: Money.from({ amount: "10.00", currency: "USD" }) }),
    );
    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
      balance: { amount: "100.00", currency: "BRL" },
    });
    expect(store.entries).toHaveLength(0);
  });
});

describe("references", () => {
  test("a REFUND of a processed BET credits it back and links to it", async () => {
    const { useCase, store } = setup();
    const placed = await submit(useCase, bet("b1", "10.00"));
    const refund = await submit(useCase, request("r1", Kind.Refund, "10.00", { referenceExternalTransactionId: "b1" }));

    expect(refund).toMatchObject({ status: Status.Processed, balance: { amount: "100.00" } });
    expect(store.transactions.get(refund.transactionId)!.referenceTransactionId).toBe(placed.transactionId);
    expect(store.entries.map((entry) => entry.direction)).toEqual([LedgerDirection.Debit, LedgerDirection.Credit]);
  });

  test("a second reversal of the same BET is rejected", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1", "10.00"));
    await submit(useCase, request("r1", Kind.Refund, "10.00", { referenceExternalTransactionId: "b1" }));
    const second = await submit(
      useCase,
      request("rb1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "b1" }),
    );
    expect(second).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(store.entries).toHaveLength(2);
    expect(store.balanceOf("w1")).toBe("100.00");
  });

  test("a ROLLBACK that arrives before its BET waits and moves nothing", async () => {
    const { useCase, store } = setup();
    const result = await submit(
      useCase,
      request("rb1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "b1" }),
    );
    expect(result).toMatchObject({ status: Status.PendingReference, balance: { amount: "100.00" } });
    expect(store.entries).toHaveLength(0);
    expect(store.wallets.get("w1")!.version).toBe(1);

    const replay = await submit(useCase, request("rb1", Kind.Rollback, "10.00", { referenceExternalTransactionId: "b1" }));
    expect(replay).toEqual({ ...result, idempotentReplay: true });
  });

  test("a reference from another round is rejected and not linked", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1", "10.00", { roundId: "other-round" }));
    const result = await submit(useCase, request("r1", Kind.Refund, "10.00", { referenceExternalTransactionId: "b1" }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceMismatch });
    expect(store.transactions.get(result.transactionId)!.referenceTransactionId).toBeUndefined();
  });

  test("a refund for a different amount is rejected", async () => {
    const { useCase } = setup();
    await submit(useCase, bet("b1", "10.00"));
    const result = await submit(useCase, request("r1", Kind.Refund, "9.00", { referenceExternalTransactionId: "b1" }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAmountMismatch });
  });

  test("rolling back a WIN the player already spent is rejected with its own code", async () => {
    const { useCase, store } = setup("100.00");
    await submit(useCase, request("w1", Kind.Win, "50.00"));
    await submit(useCase, bet("b1", "140.00"));
    const result = await submit(useCase, request("rb1", Kind.Rollback, "50.00", { referenceExternalTransactionId: "w1" }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFundsForReversal });
    expect(store.balanceOf("w1")).toBe("10.00");
  });

  test("a WIN that names its BET is linked to it", async () => {
    const { useCase, store } = setup();
    const placed = await submit(useCase, bet("b1", "10.00"));
    const win = await submit(useCase, request("w1", Kind.Win, "30.00", { referenceExternalTransactionId: "b1" }));
    expect(store.transactions.get(win.transactionId)!.referenceTransactionId).toBe(placed.transactionId);
    expect(win.balance?.amount).toBe("120.00");
  });
});

describe("failure handling", () => {
  test("a failure while saving rolls everything back and releases the wallet lock", async () => {
    const { useCase, store } = setup();
    store.failNextSave = new Error("disk full");

    await expect(submit(useCase, bet("b1", "10.00"))).rejects.toThrow("disk full");
    expect(store.transactions.size).toBe(0);
    expect(store.entries).toHaveLength(0);
    expect(store.balanceOf("w1")).toBe("100.00");
    expect(store.rollbacks).toBe(1);

    const retry = await submit(useCase, bet("b1", "10.00"));
    expect(retry).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(store.balanceOf("w1")).toBe("90.00");
  });

  test("a replay does not open a transaction", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"));
    const before = store.commits + store.rollbacks;
    await submit(useCase, bet("b1"));
    expect(store.commits + store.rollbacks).toBe(before);
  });
});

describe("retries", () => {
  const deadlock = () => new TransientDbError("deadlock");

  test("a transient failure is retried once and the bet is debited exactly once", async () => {
    const { useCase, store, clock } = setup();
    store.failNext(deadlock());

    const result = await submit(useCase, bet("b1", "10.00"));

    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false, balance: { amount: "90.00" } });
    expect(store.attempts).toBe(2);
    expect(store.entries).toHaveLength(1);
    expect(clock.sleeps).toEqual([125]);
  });

  test("when every attempt fails the caller gets a transient error carrying the cause", async () => {
    const { useCase, store, clock } = setup();
    const last = new TransientDbError("lock timeout");
    store.failNext(deadlock());
    store.failNext(deadlock());
    store.failNext(last);

    const error = (await submit(useCase, bet("b1")).catch((e: unknown) => e)) as TransientInfrastructureError;

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(error.code).toBe("TRANSIENT_FAILURE");
    expect(error.cause).toBe(last);
    expect(store.attempts).toBe(3);
    expect(clock.sleeps).toEqual([125, 125]);
    expect(store.transactions.size).toBe(0);
    expect(store.balanceOf("w1")).toBe("100.00");
  });

  test("a failure on the first lookup, before any lock, is retried too", async () => {
    const { useCase, store } = setup();
    store.failNextLookup(new TransientDbError("connection reset"));
    const result = await submit(useCase, bet("b1"));
    expect(result.status).toBe(Status.Processed);
    expect(store.entries).toHaveLength(1);
  });

  test("with a single allowed attempt nothing is retried", async () => {
    const { useCase, store, clock } = setup("100.00", { ...policy, maxAttempts: 1 });
    store.failNext(deadlock());
    await expect(submit(useCase, bet("b1"))).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(store.attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("an invariant violation is never retried", async () => {
    const { useCase, store, clock } = setup();
    const violation = new InvariantDbError("WG001");
    store.failNext(violation);
    await expect(submit(useCase, bet("b1"))).rejects.toBe(violation);
    expect(store.attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("business errors are never retried", async () => {
    const { useCase, store, clock } = setup();
    await submit(useCase, bet("b1", "10.00"), "prov:b1");
    const before = store.attempts;
    await expect(submit(useCase, bet("b1", "11.00"), "prov:b1")).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(submit(useCase, bet("x", "1.00", { walletId: "missing" }))).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(store.attempts).toBe(before + 1);
    expect(clock.sleeps).toEqual([]);
  });

  test("a commit whose outcome is unknown is resolved by the retry as a replay with one debit", async () => {
    const { useCase, store } = setup();
    store.failAfterNextCommit(new UnknownCommitOutcomeError());

    const result = await submit(useCase, bet("b1", "10.00"));

    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: true, balance: { amount: "90.00" } });
    expect(store.entries).toHaveLength(1);
    expect(store.balanceOf("w1")).toBe("90.00");
    expect(store.attempts).toBe(1);
  });

  test("an unknown outcome where nothing was committed is retried and processed once", async () => {
    const { useCase, store } = setup();
    store.failNext(new UnknownCommitOutcomeError());
    const result = await submit(useCase, bet("b1", "10.00"));
    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(store.entries).toHaveLength(1);
  });

  describe("pause and budget", () => {
    test("the pause stays within the configured jitter bounds", async () => {
      for (const [random, expected] of [
        [0, 50],
        [0.999999, 200],
      ] as const) {
        const { useCase, store, clock } = setup("100.00", { ...policy, random: () => random });
        store.failNext(deadlock());
        await submit(useCase, bet("b1"));
        expect(clock.sleeps).toEqual([expected]);
      }
    });

    test("each attempt is given the time that is left", async () => {
      const { useCase, store } = setup();
      store.failNext(deadlock());
      store.failNext(deadlock());
      await submit(useCase, bet("b1"));
      expect(store.budgets).toEqual([10_000, 9_875, 9_750]);
    });

    test("it stops retrying when the next pause would pass the deadline", async () => {
      const { useCase, store, clock } = setup("100.00", { ...policy, maxAttempts: 10, deadlineMs: 300 });
      for (let i = 0; i < 10; i++) store.failNext(deadlock());

      await expect(submit(useCase, bet("b1"))).rejects.toBeInstanceOf(TransientInfrastructureError);

      expect(store.attempts).toBe(3);
      expect(clock.sleeps).toEqual([125, 125]);
      expect(store.budgets).toEqual([300, 175, 50]);
    });
  });

  describe("unique-key races between wallets", () => {
    test("the same key on two wallets: one wins, the other becomes a conflict, with one debit", async () => {
      const { useCase, store } = setup();
      store.seedWallet(wallet("w2", "100.00", "p2"));

      const results = await Promise.allSettled([
        submit(useCase, bet("b1", "10.00"), "shared-key"),
        submit(useCase, bet("b1", "10.00", { walletId: "w2", playerId: "p2" }), "shared-key"),
      ]);

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyKeyConflictError);
      expect(store.entries).toHaveLength(1);
    });

    test("the same external id under different keys on two wallets ends in a conflict, not an error", async () => {
      const { useCase, store } = setup();
      store.seedWallet(wallet("w2", "100.00", "p2"));

      const results = await Promise.allSettled([
        submit(useCase, bet("b1", "10.00"), "key-1"),
        submit(useCase, bet("b1", "10.00", { walletId: "w2", playerId: "p2" }), "key-2"),
      ]);

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(ExternalTransactionIdConflictError);
      expect(store.entries).toHaveLength(1);
    });
  });
});

describe("a unique violation at commit", () => {
  test("same key and payload: the retry returns the winner as a replay, with one debit", async () => {
    const { useCase, store, clock } = setup();
    const first = await submit(useCase, bet("b1", "10.00"), "prov:b1");
    store.hideLookups("key", 2);
    store.hideLookups("external", 1);

    const second = await submit(useCase, bet("b1", "10.00"), "prov:b1");

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(store.rollbacks).toBe(1);
    expect(clock.sleeps).toEqual([125]);
    expect(store.entries).toHaveLength(1);
    expect(store.balanceOf("w1")).toBe("90.00");
  });

  test("same key, different payload: the retry reports a conflict and changes nothing", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1", "10.00"), "prov:b1");
    store.hideLookups("key", 2);
    store.hideLookups("external", 1);

    await expect(submit(useCase, bet("b1", "20.00"), "prov:b1")).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    expect(store.entries).toHaveLength(1);
    expect(store.balanceOf("w1")).toBe("90.00");
  });

  test("another key but the same external id: the retry reports a conflict and changes nothing", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1", "10.00"), "key-1");
    store.hideLookups("external", 1);

    await expect(submit(useCase, bet("b1", "10.00"), "key-2")).rejects.toBeInstanceOf(
      ExternalTransactionIdConflictError,
    );

    expect(store.entries).toHaveLength(1);
    expect(store.transactions.size).toBe(1);
  });

  test("a persistent unique violation ends as a transient failure instead of looping", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1", "10.00"), "prov:b1");
    store.hideLookups("key", 100);
    store.hideLookups("external", 100);

    await expect(submit(useCase, bet("b1", "10.00"), "prov:b1")).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(store.attempts).toBe(1 + 3);
  });
});

describe("retry policy validation", () => {
  const build = (retry: Partial<RetryPolicy>) =>
    new ProcessWagerTransaction(new InMemoryWagerStore(), new SequentialIds(), new FixedClock(), { ...policy, ...retry });

  test.each<[string, Partial<RetryPolicy>]>([
    ["no attempts", { maxAttempts: 0 }],
    ["a jitter minimum above the maximum", { jitterMinMs: 300, jitterMaxMs: 100 }],
    ["a non-positive deadline", { deadlineMs: 0 }],
  ])("rejects %s", (_name, retry) => {
    expect(() => build(retry)).toThrow("invalid retry policy");
  });

  test("accepts the defaults", () => {
    expect(() => build({})).not.toThrow();
  });
});

describe("authorization", () => {
  const execute = (useCase: ProcessWagerTransaction, actor: Principal) =>
    useCase.execute({ request: bet("a1"), actor, idempotencyKey: "k", correlationId: "c" });

  test("a provider cannot act for another provider and nothing is touched", async () => {
    const { useCase, store } = setup();
    await expect(execute(useCase, { kind: "provider", providerId: "other" })).rejects.toBeInstanceOf(
      ForbiddenProviderError,
    );
    expect(store.attempts).toBe(0);
    expect(store.balanceOf("w1")).toBe("100.00");
  });

  test.each<Principal>([
    { kind: "provider", providerId: "prov" },
    { kind: "admin" },
    { kind: "trusted-internal" },
    { kind: "anonymous-dev" },
  ])("%p may submit", async (actor) => {
    const { useCase } = setup();
    expect((await execute(useCase, actor)).status).toBe(Status.Processed);
  });
});

describe("events", () => {
  const types = (store: InMemoryWagerStore) => store.events.map((event) => event.eventType);

  test("a processed bet emits Processed and BalanceChanged with the request's ids", async () => {
    const { useCase, store } = setup();
    const result = await useCase.execute({
      request: bet("b1"),
      actor: { kind: "anonymous-dev" },
      idempotencyKey: "k",
      correlationId: "corr-9",
      causationId: "msg-1",
    });
    expect(types(store)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(store.events.map((event) => event.toJSON())).toMatchObject([
      { aggregateId: result.transactionId, correlationId: "corr-9", causationId: "msg-1" },
      { aggregateId: "w1", correlationId: "corr-9", causationId: "msg-1", data: { walletVersion: 2, direction: "DEBIT" } },
    ]);
    expect(new Set(store.events.map((event) => event.eventId)).size).toBe(2);
  });

  test("a LOSS emits only Processed because the balance does not move", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"));
    store.events.length = 0;
    await submit(useCase, request("l1", Kind.Loss, "0.00", { referenceExternalTransactionId: "b1" }));
    expect(types(store)).toEqual(["WagerTransactionProcessed"]);
  });

  test("a rejection emits Rejected only", async () => {
    const { useCase, store } = setup("5.00");
    await submit(useCase, bet("b1", "10.00"));
    expect(types(store)).toEqual(["WagerTransactionRejected"]);
    expect(store.events[0]!.toJSON()).toMatchObject({ data: { failureCode: FailureCode.InsufficientFunds } });
  });

  test("a missing reference emits PendingReference only", async () => {
    const { useCase, store } = setup();
    await submit(useCase, request("w1", Kind.Win, "10.00", { referenceExternalTransactionId: "nope" }));
    expect(types(store)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("a replay emits nothing new", async () => {
    const { useCase, store } = setup();
    await submit(useCase, bet("b1"));
    await submit(useCase, bet("b1"));
    expect(types(store)).toHaveLength(2);
  });

  test("a failed attempt that is retried publishes its events once", async () => {
    const { useCase, store } = setup();
    store.failAfterNextCommit(new UnknownCommitOutcomeError());
    await submit(useCase, bet("b1"));
    expect(types(store)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("an attempt rolled back before commit leaves no events", async () => {
    const { useCase, store } = setup();
    store.failNextSave = new TransientDbError("deadlock");
    await submit(useCase, bet("b1"));
    expect(types(store)).toHaveLength(2);
  });
});
