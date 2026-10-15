import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/domain/errors";
import {
  type EventContext,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/domain/events";
import { Money } from "../../src/domain/money";
import { WagerTransaction, WagerTransactionKind as Kind } from "../../src/domain/wager-transaction";
import { LedgerDirection, Wallet } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00.000Z");
const ctx: EventContext = { eventId: "evt-1", correlationId: "corr-1", causationId: "cause-1", occurredAt: at };

const transaction = (overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "k-1",
    payloadHash: "h",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "r",
    gameId: "g",
    kind: Kind.Bet,
    money: brl("10.00"),
    correlationId: "corr-1",
    createdAt: at,
    ...overrides,
  });

const wallet = () =>
  Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: brl("100.00"),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });

describe("WalletBalanceChanged", () => {
  test("serializes to a stable envelope with money as strings", () => {
    const w = wallet();
    const entry = w.debit({ money: brl("10.00"), transactionId: "tx-1", entryId: "e-1", at });
    const event = WalletBalanceChanged.from(w, entry, ctx);

    expect(event.toJSON()).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      causationId: "cause-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "10.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "90.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(event.partitionKey).toBe("wallet-1");
  });

  test("survives a JSON round trip unchanged", () => {
    const w = wallet();
    const event = WalletBalanceChanged.from(w, w.credit({ money: brl("5.00"), transactionId: "tx-2", entryId: "e-2", at }), ctx);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });
});

describe("transaction events", () => {
  test("Processed carries the result snapshot and the aggregate id of the transaction", () => {
    const tx = transaction();
    tx.markProcessed({ result: { balance: brl("90.00"), walletVersion: 2 }, at });
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json).toMatchObject({
      eventType: "WagerTransactionProcessed",
      aggregateId: "tx-1",
      version: 1,
      data: {
        transactionId: "tx-1",
        walletId: "wallet-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        status: "PROCESSED",
        balance: { amount: "90.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("Processed for a LOSS keeps its reference and the unchanged balance snapshot", () => {
    const tx = transaction({ kind: Kind.Loss, money: brl("0.00"), referenceExternalTransactionId: "bet-1" });
    tx.markProcessed({ referenceTransactionId: "tx-0", result: { balance: brl("100.00"), walletVersion: 1 }, at });
    const { data } = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(data).toMatchObject({ kind: "LOSS", referenceTransactionId: "tx-0", walletVersion: 1 });
  });

  test("Rejected carries the failure code", () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds, { balance: brl("5.00"), walletVersion: 1 });
    expect(WagerTransactionRejected.from(tx, ctx).toJSON()).toMatchObject({
      eventType: "WagerTransactionRejected",
      aggregateId: "tx-1",
      data: { failureCode: "INSUFFICIENT_FUNDS" },
    });
  });

  test("transaction events are partitioned by wallet, not by transaction", () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds, { balance: brl("5.00"), walletVersion: 1 });
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(event.aggregateId).toBe("tx-1");
    expect(event.partitionKey).toBe("wallet-1");
  });

  test("PendingReference carries the awaited reference", () => {
    const tx = transaction({ kind: Kind.Win, referenceExternalTransactionId: "bet-9" });
    tx.markPendingReference({ balance: brl("100.00"), walletVersion: 1 });
    expect(WagerTransactionPendingReference.from(tx, ctx).toJSON()).toMatchObject({
      eventType: "WagerTransactionPendingReference",
      data: { referenceExternalTransactionId: "bet-9", kind: "WIN" },
    });
  });

  test("Failed carries the failure code", () => {
    const tx = transaction();
    tx.fail(FailureCode.ProcessingFailed);
    expect(WagerTransactionFailed.from(tx, ctx).toJSON()).toMatchObject({
      eventType: "WagerTransactionFailed",
      data: { failureCode: "PROCESSING_FAILED" },
    });
  });
});

describe("envelope", () => {
  test("omits causationId when none is given", () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds, { balance: brl("5.00"), walletVersion: 1 });
    const { causationId: _omit, ...withoutCause } = ctx;
    const json = WagerTransactionRejected.from(tx, withoutCause).toJSON();
    expect("causationId" in json).toBe(false);
  });

  test("data cannot be modified after creation", () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds, { balance: brl("5.00"), walletVersion: 1 });
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(() => {
      (event.data as { failureCode: string }).failureCode = "OTHER";
    }).toThrow();
  });
});
