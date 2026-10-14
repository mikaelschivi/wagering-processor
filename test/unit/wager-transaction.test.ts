import { describe, expect, test } from "bun:test";
import { FailureCode, InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  decide,
  hashPayload,
  type Outcome,
  type PayloadFields,
  type ResultSnapshot,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction";
import { LedgerDirection, Wallet } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-01T00:00:05.000Z");
const snapshot: ResultSnapshot = { balance: brl("90.00"), walletVersion: 2 };

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-a:ext-1",
  payloadHash: "hash-1",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: Kind.Bet,
  money: brl("10.00"),
  correlationId: "corr-1",
  createdAt: t0,
  ...overrides,
});

const make = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

const reversal = (kind: Kind.Refund | Kind.Rollback, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind, referenceExternalTransactionId: "ext-ref", externalTransactionId: "ext-2", ...overrides });

function stored(status: Status, overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.rehydrate({
    ...props({ id: "ref-1", externalTransactionId: "ext-ref", idempotencyKey: "provider-a:ext-ref", ...overrides }),
    status,
    ...(status === Status.Processed ? { result: snapshot, processedAt: t0 } : {}),
    ...(status === Status.Rejected ? { result: snapshot, failureCode: FailureCode.InsufficientFunds } : {}),
    ...(status === Status.PendingReference ? { result: snapshot } : {}),
    ...(status === Status.Failed ? { failureCode: FailureCode.ProcessingFailed } : {}),
  });
}

const wallet = (balance = "100.00") =>
  Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: brl(balance),
    version: 3,
    createdAt: t0,
    updatedAt: t0,
  });

describe("WagerTransaction.create", () => {
  test("starts pending with the given fields", () => {
    const tx = make();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx).toMatchObject({ id: "tx-1", providerId: "provider-a", kind: Kind.Bet, createdAt: t0 });
    expect(tx.result).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test("OPENING cannot be submitted", () => {
    expect(() => make({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])("%s needs a positive amount", (kind) => {
    const extra = kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: "ext-ref" } : {};
    expect(() => make({ kind, money: brl("0.00"), ...extra })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ kind, money: Money.fromMinor(-100n, "BRL"), ...extra })).toThrow(InvalidWagerTransactionError);
  });

  test("a LOSS may have a zero amount but not a negative one", () => {
    expect(make({ kind: Kind.Loss, money: brl("0.00") }).kind).toBe(Kind.Loss);
    expect(() => make({ kind: Kind.Loss, money: Money.fromMinor(-1n, "BRL") })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expect(() => make({ kind })).toThrow(InvalidWagerTransactionError);
  });

  test("a BET cannot carry a reference", () => {
    expect(() => make({ kind: Kind.Bet, referenceExternalTransactionId: "ext-ref" })).toThrow(InvalidWagerTransactionError);
  });

  test("WIN and LOSS may carry an optional reference", () => {
    expect(make({ kind: Kind.Win, referenceExternalTransactionId: "ext-ref" }).referenceExternalTransactionId).toBe("ext-ref");
    expect(make({ kind: Kind.Loss, referenceExternalTransactionId: "ext-ref" }).referenceExternalTransactionId).toBe("ext-ref");
  });

  test("a transaction cannot reference itself", () => {
    expect(() => reversal(Kind.Refund, { referenceExternalTransactionId: "ext-2" })).toThrow(InvalidWagerTransactionError);
  });
});

describe("state machine", () => {
  const processed = { result: snapshot, at: t1 };

  test("pending can become processed and records the result", () => {
    const tx = make();
    tx.markProcessed(processed);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(t1);
    expect(tx.result).toEqual(snapshot);
    expect(tx.failureCode).toBeUndefined();
  });

  test("a processed reversal must name its resolved reference", () => {
    expect(() => reversal(Kind.Refund).markProcessed(processed)).toThrow(InvalidWagerTransactionError);
    const tx = reversal(Kind.Refund);
    tx.markProcessed({ ...processed, referenceTransactionId: "ref-1" });
    expect(tx.referenceTransactionId).toBe("ref-1");
  });

  test("pending can be rejected with a code and result, without a processed time", () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds, snapshot);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.result).toEqual(snapshot);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test("pending can wait for its reference and is not terminal", () => {
    const tx = reversal(Kind.Rollback);
    tx.markPendingReference(snapshot);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.result).toEqual(snapshot);
  });

  test("pending can fail with a code and no result", () => {
    const tx = make();
    tx.fail(FailureCode.ProcessingFailed);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(tx.result).toBeUndefined();
  });

  describe("from pending-reference", () => {
    const waiting = () => stored(Status.PendingReference, { kind: Kind.Refund, referenceExternalTransactionId: "ext-b" });

    test("can be processed", () => {
      const tx = waiting();
      tx.markProcessed({ ...processed, referenceTransactionId: "bet-1" });
      expect(tx.status).toBe(Status.Processed);
    });

    test("can be rejected", () => {
      const tx = waiting();
      tx.reject(FailureCode.ReferenceNotFound, snapshot);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    test("can fail", () => {
      const tx = waiting();
      tx.fail(FailureCode.ProcessingFailed);
      expect(tx.status).toBe(Status.Failed);
    });

    test("cannot wait for a reference again through markPendingReference", () => {
      expect(() => waiting().markPendingReference(snapshot)).toThrow(InvalidTransactionStateError);
    });
  });

  describe.each([Status.Processed, Status.Rejected, Status.Failed])("terminal state %s", (status) => {
    const actions: [string, (tx: WagerTransaction) => void][] = [
      ["markProcessed", (tx) => tx.markProcessed({ ...processed, referenceTransactionId: "r" })],
      ["markPendingReference", (tx) => tx.markPendingReference(snapshot)],
      ["reject", (tx) => tx.reject(FailureCode.InsufficientFunds, snapshot)],
      ["fail", (tx) => tx.fail(FailureCode.ProcessingFailed)],
    ];

    test.each(actions)("rejects %s", (_name, act) => {
      const tx = stored(status);
      const before = [tx.status, tx.failureCode, tx.processedAt];
      expect(() => act(tx)).toThrow(InvalidTransactionStateError);
      expect([tx.status, tx.failureCode, tx.processedAt]).toEqual(before);
    });

    test("is reported terminal", () => {
      expect(stored(status).isTerminal()).toBe(true);
    });
  });
});

describe("queries", () => {
  test("only LOSS leaves the balance alone", () => {
    expect(make({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const tx of [make(), make({ kind: Kind.Win }), reversal(Kind.Refund), reversal(Kind.Rollback)]) {
      expect(tx.affectsBalance()).toBe(true);
    }
  });

  test("only REFUND and ROLLBACK require a reference", () => {
    expect([make(), make({ kind: Kind.Win }), make({ kind: Kind.Loss })].map((tx) => tx.requiresReference())).toEqual([
      false,
      false,
      false,
    ]);
    expect([reversal(Kind.Refund), reversal(Kind.Rollback)].map((tx) => tx.requiresReference())).toEqual([true, true]);
  });

  test("matchesPayload compares the stored hash", () => {
    const tx = make({ payloadHash: "abc" });
    expect(tx.matchesPayload("abc")).toBe(true);
    expect(tx.matchesPayload("abd")).toBe(false);
  });
});

describe("ledgerDirectionFor", () => {
  const ref = (kind: Kind) => stored(Status.Processed, { kind, referenceExternalTransactionId: kind === Kind.Refund ? "x" : undefined });

  test("BET debits and WIN and REFUND credit", () => {
    expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(reversal(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])("ROLLBACK of a %s goes the other way", (referenceKind, expected) => {
    expect(reversal(Kind.Rollback).ledgerDirectionFor(ref(referenceKind))).toBe(expected);
  });

  test("ROLLBACK without its reference cannot say", () => {
    expect(() => reversal(Kind.Rollback).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS has no direction", () => {
    expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe("rehydrate", () => {
  test("restores a stored state without re-validating it", () => {
    const tx = stored(Status.Rejected, { kind: Kind.Refund, referenceExternalTransactionId: "x", money: brl("0.00") });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.result).toEqual(snapshot);
  });
});

describe("hashPayload", () => {
  const fields: PayloadFields = {
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    playerId: "0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: { amount: "25.00", currency: "BRL" },
  };

  test("is a 64-character lowercase hex digest", () => {
    expect(hashPayload(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("does not depend on key order", () => {
    const reordered = Object.fromEntries(Object.entries(fields).reverse()) as unknown as PayloadFields;
    const nested = { ...fields, money: { currency: "BRL", amount: "25.00" } };
    expect(hashPayload(reordered)).toBe(hashPayload(fields));
    expect(hashPayload(nested)).toBe(hashPayload(fields));
  });

  test("treats uuid case as irrelevant", () => {
    const lower = { ...fields, playerId: fields.playerId.toLowerCase(), walletId: fields.walletId.toUpperCase() };
    expect(hashPayload(lower)).toBe(hashPayload(fields));
  });

  test("an absent reference and an undefined one hash the same", () => {
    expect(hashPayload({ ...fields, referenceExternalTransactionId: undefined })).toBe(hashPayload(fields));
  });

  test.each<[string, Partial<PayloadFields>]>([
    ["provider", { providerId: "provider-b" }],
    ["external id", { externalTransactionId: "ext-2" }],
    ["player", { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" }],
    ["wallet", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["round", { roundId: "round-2" }],
    ["game", { gameId: "game-2" }],
    ["kind", { kind: Kind.Win }],
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["reference", { referenceExternalTransactionId: "ext-0" }],
  ])("changes when the %s changes", (_name, change) => {
    expect(hashPayload({ ...fields, ...change })).not.toBe(hashPayload(fields));
  });

  test("is stable across calls", () => {
    expect(hashPayload(fields)).toBe(hashPayload({ ...fields }));
  });
});

describe("decide", () => {
  const bet = (amount = "10.00") => make({ money: brl(amount) });
  const processedBet = (overrides: Partial<CreateWagerTransactionProps> = {}) => stored(Status.Processed, { kind: Kind.Bet, ...overrides });
  const run = (
    transaction: WagerTransaction,
    options: { wallet?: Wallet; reference?: WagerTransaction; reversalExists?: boolean } = {},
  ): Outcome =>
    decide({
      wallet: options.wallet ?? wallet(),
      transaction,
      reference: options.reference,
      reversalExists: options.reversalExists ?? false,
    });
  const rejected = (code: FailureCode): Outcome => ({ type: "rejected", code });
  const debit: Outcome = { type: "processed", direction: LedgerDirection.Debit };
  const credit: Outcome = { type: "processed", direction: LedgerDirection.Credit };

  describe("BET", () => {
    test("debits when the balance covers it", () => {
      expect(run(bet("40.00"))).toEqual(debit);
    });

    test("debits an amount equal to the balance", () => {
      expect(run(bet("100.00"))).toEqual(debit);
    });

    test("is rejected when the balance is one cent short", () => {
      expect(run(bet("100.01"))).toEqual(rejected(FailureCode.InsufficientFunds));
    });

    test("a zero-balance wallet rejects any bet", () => {
      expect(run(bet("0.01"), { wallet: wallet("0.00") })).toEqual(rejected(FailureCode.InsufficientFunds));
    });
  });

  describe("WIN and LOSS", () => {
    test("a WIN credits, with or without a reference", () => {
      expect(run(make({ kind: Kind.Win }))).toEqual(credit);
      expect(
        run(make({ kind: Kind.Win, referenceExternalTransactionId: "ext-ref" }), { reference: processedBet() }),
      ).toEqual(credit);
    });

    test("a LOSS is processed with no ledger direction, even on an empty wallet", () => {
      expect(run(make({ kind: Kind.Loss, money: brl("500.00") }), { wallet: wallet("0.00") })).toEqual({ type: "processed" });
    });

    test("a WIN that names a missing BET waits for it", () => {
      expect(run(make({ kind: Kind.Win, referenceExternalTransactionId: "ext-ref" }))).toEqual({ type: "pending-reference" });
    });

    test("a WIN on a BET that was already reversed is rejected", () => {
      const win = make({ kind: Kind.Win, referenceExternalTransactionId: "ext-ref" });
      expect(run(win, { reference: processedBet(), reversalExists: true })).toEqual(rejected(FailureCode.ReferenceAlreadyReversed));
    });

    test("a WIN that references another WIN is not allowed", () => {
      const win = make({ kind: Kind.Win, referenceExternalTransactionId: "ext-ref" });
      expect(run(win, { reference: stored(Status.Processed, { kind: Kind.Win }) })).toEqual(
        rejected(FailureCode.ReferenceKindNotAllowed),
      );
    });
  });

  describe("REFUND", () => {
    test("credits back a processed BET of the same amount", () => {
      expect(run(reversal(Kind.Refund), { reference: processedBet() })).toEqual(credit);
    });

    test("waits when the BET has not arrived", () => {
      expect(run(reversal(Kind.Refund))).toEqual({ type: "pending-reference" });
    });

    test("waits when the BET is itself waiting", () => {
      expect(run(reversal(Kind.Refund), { reference: stored(Status.PendingReference) })).toEqual({ type: "pending-reference" });
    });

    test.each([Status.Rejected, Status.Failed])("is rejected when the BET ended %s", (status) => {
      expect(run(reversal(Kind.Refund), { reference: stored(status) })).toEqual(rejected(FailureCode.ReferenceNotProcessed));
    });

    test.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])("cannot reference a %s", (kind) => {
      expect(run(reversal(Kind.Refund), { reference: stored(Status.Processed, { kind }) })).toEqual(
        rejected(FailureCode.ReferenceKindNotAllowed),
      );
    });

    test("is rejected when the amount differs from the BET", () => {
      expect(run(reversal(Kind.Refund, { money: brl("9.99") }), { reference: processedBet() })).toEqual(
        rejected(FailureCode.ReferenceAmountMismatch),
      );
    });

    test("is rejected when the BET was already reversed", () => {
      expect(run(reversal(Kind.Refund), { reference: processedBet(), reversalExists: true })).toEqual(
        rejected(FailureCode.ReferenceAlreadyReversed),
      );
    });
  });

  describe("ROLLBACK", () => {
    test("of a BET credits the stake back", () => {
      expect(run(reversal(Kind.Rollback), { reference: processedBet() })).toEqual(credit);
    });

    test("of a WIN debits it when the balance covers it", () => {
      const win = stored(Status.Processed, { kind: Kind.Win });
      expect(run(reversal(Kind.Rollback), { reference: win, wallet: wallet("10.00") })).toEqual(debit);
    });

    test("of a WIN is rejected with its own code when the balance is short", () => {
      const win = stored(Status.Processed, { kind: Kind.Win });
      expect(run(reversal(Kind.Rollback), { reference: win, wallet: wallet("9.99") })).toEqual(
        rejected(FailureCode.InsufficientFundsForReversal),
      );
    });

    test("of a REFUND debits the refund back", () => {
      const refund = stored(Status.Processed, { kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" });
      expect(run(reversal(Kind.Rollback), { reference: refund })).toEqual(debit);
    });

    test("cannot reference a LOSS or another ROLLBACK", () => {
      for (const kind of [Kind.Loss, Kind.Rollback]) {
        expect(run(reversal(Kind.Rollback), { reference: stored(Status.Processed, { kind }) })).toEqual(
          rejected(FailureCode.ReferenceKindNotAllowed),
        );
      }
    });

    test("is rejected when the target was already reversed", () => {
      expect(run(reversal(Kind.Rollback), { reference: processedBet(), reversalExists: true })).toEqual(
        rejected(FailureCode.ReferenceAlreadyReversed),
      );
    });
  });

  describe("context checks", () => {
    test("a currency other than the wallet's is rejected", () => {
      expect(run(make({ money: usd("10.00") }))).toEqual(rejected(FailureCode.CurrencyMismatch));
    });

    test("a player other than the wallet's is rejected", () => {
      expect(run(make({ playerId: "player-2" }))).toEqual(rejected(FailureCode.PlayerWalletMismatch));
    });

    test.each<[string, Partial<CreateWagerTransactionProps>]>([
      ["wallet", { walletId: "wallet-2" }],
      ["player", { playerId: "player-2" }],
      ["round", { roundId: "round-2" }],
      ["currency", { money: usd("10.00") }],
    ])("a reference in another %s is a mismatch", (_name, referenceOverrides) => {
      expect(run(reversal(Kind.Refund), { reference: processedBet(referenceOverrides) })).toEqual(
        rejected(FailureCode.ReferenceMismatch),
      );
    });
  });

  describe("precedence", () => {
    test("currency is checked before player", () => {
      expect(run(make({ money: usd("10.00"), playerId: "player-2" }))).toEqual(rejected(FailureCode.CurrencyMismatch));
    });

    test("a missing reference waits even when the funds are short", () => {
      expect(run(reversal(Kind.Rollback), { wallet: wallet("0.00") })).toEqual({ type: "pending-reference" });
    });

    test("a mismatched reference is rejected before its status is considered", () => {
      const waitingElsewhere = stored(Status.PendingReference, { roundId: "round-2" });
      expect(run(reversal(Kind.Refund), { reference: waitingElsewhere })).toEqual(rejected(FailureCode.ReferenceMismatch));
    });

    test("a wrong kind is rejected before its status is considered", () => {
      expect(run(reversal(Kind.Refund), { reference: stored(Status.PendingReference, { kind: Kind.Win }) })).toEqual(
        rejected(FailureCode.ReferenceKindNotAllowed),
      );
    });

    test("status is checked before the reversal flag", () => {
      expect(run(reversal(Kind.Refund), { reference: stored(Status.Rejected), reversalExists: true })).toEqual(
        rejected(FailureCode.ReferenceNotProcessed),
      );
    });

    test("already-reversed is checked before the amount", () => {
      expect(
        run(reversal(Kind.Refund, { money: brl("1.00") }), { reference: processedBet(), reversalExists: true }),
      ).toEqual(rejected(FailureCode.ReferenceAlreadyReversed));
    });

    test("the amount is checked before the funds", () => {
      const win = stored(Status.Processed, { kind: Kind.Win });
      expect(run(reversal(Kind.Rollback, { money: brl("1.00") }), { reference: win, wallet: wallet("0.00") })).toEqual(
        rejected(FailureCode.ReferenceAmountMismatch),
      );
    });
  });

  test("decide does not change the wallet or the transaction", () => {
    const w = wallet();
    const tx = bet("40.00");
    run(tx, { wallet: w });
    expect([w.balance.toString(), w.version, tx.status]).toEqual(["100.00", 3, Status.Pending]);
  });
});
