import { describe, expect, test } from "bun:test";
import { type ReconciliationSnapshot, WalletStore } from "../../src/application/ports";
import { Reconciliation } from "../../src/application/reconciliation";
import { NotFoundError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00.000Z");

class StubStore extends WalletStore {
  constructor(private readonly snapshot: ReconciliationSnapshot | undefined) {
    super();
  }
  async reconciliationSnapshot() {
    return this.snapshot;
  }
  async create(): Promise<void> {}
  async findById(): Promise<undefined> {
    return undefined;
  }
  async ledgerPage(): Promise<[]> {
    return [];
  }
}

function report(stored: string, version: number, parts: Partial<Omit<ReconciliationSnapshot, "wallet">>) {
  const wallet = Wallet.rehydrate({
    id: "w1",
    playerId: "p1",
    currency: "BRL",
    balance: brl(stored),
    version,
    createdAt: at,
    updatedAt: at,
  });
  const snapshot: ReconciliationSnapshot = { wallet, calculated: brl(stored), entryCount: 0, ...parts };
  return new Reconciliation(new StubStore(snapshot)).execute("w1");
}

describe("Reconciliation", () => {
  test("a wallet that matches its ledger is consistent", async () => {
    expect(await report("90.00", 2, { entryCount: 2, maxVersion: 2, tailBalance: brl("90.00") })).toEqual({
      walletId: "w1",
      storedBalance: { amount: "90.00", currency: "BRL" },
      calculatedBalance: { amount: "90.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
  });

  test("a wallet opened at zero with no entries is consistent at version 1", async () => {
    expect(await report("0.00", 1, { calculated: brl("0.00") })).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  test("no entries but a later version is a version mismatch", async () => {
    expect((await report("0.00", 3, { calculated: brl("0.00") })).issues).toEqual(["VERSION_MISMATCH"]);
  });

  test("a stored balance above the ledger gives a positive difference", async () => {
    const result = await report("95.00", 2, {
      calculated: brl("90.00"),
      entryCount: 2,
      maxVersion: 2,
      tailBalance: brl("90.00"),
    });
    expect(result).toMatchObject({ consistent: false, difference: { amount: "5.00" } });
    expect(result.issues).toEqual(["BALANCE_MISMATCH", "CHAIN_TAIL_MISMATCH"]);
  });

  test("a stored balance below the ledger gives a negative difference", async () => {
    const result = await report("85.00", 2, {
      calculated: brl("90.00"),
      entryCount: 2,
      maxVersion: 2,
      tailBalance: brl("85.00"),
    });
    expect(result.difference).toEqual({ amount: "-5.00", currency: "BRL" });
    expect(result.issues).toEqual(["BALANCE_MISMATCH"]);
  });

  test("a wallet version that differs from the last entry is flagged alone", async () => {
    const result = await report("90.00", 5, { entryCount: 2, maxVersion: 2, tailBalance: brl("90.00") });
    expect(result.issues).toEqual(["VERSION_MISMATCH"]);
  });

  test("an unknown wallet is not found", async () => {
    await expect(new Reconciliation(new StubStore(undefined)).execute("x")).rejects.toBeInstanceOf(NotFoundError);
  });
});
