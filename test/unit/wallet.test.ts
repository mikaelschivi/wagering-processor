import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { LedgerDirection, Wallet, WalletLedgerEntry } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-01T00:00:01.000Z");

function openWallet(initial = "100.00") {
  const { wallet, openingEntry } = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: t0,
  });
  return { wallet, openingEntry };
}

let sequence = 0;
const move = (amount: string, at = t1) => ({
  money: brl(amount),
  transactionId: `tx-${++sequence}`,
  entryId: `entry-${sequence}`,
  at,
});

describe("Wallet.open", () => {
  test("starts at version 1 with the initial balance and an opening credit", () => {
    const { wallet, openingEntry } = openWallet("1000.00");
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt).toEqual(t0);
    expect(wallet.updatedAt).toEqual(t0);
    expect(openingEntry).toMatchObject({
      id: "entry-opening",
      walletId: "wallet-1",
      transactionId: "tx-opening",
      direction: LedgerDirection.Credit,
      walletVersion: 1,
      createdAt: t0,
    });
    expect(openingEntry!.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry!.balanceAfter.toString()).toBe("1000.00");
    expect(openingEntry!.isBalanced()).toBe(true);
  });

  test("a zero balance opens at version 1 with no ledger entry", () => {
    const { wallet, openingEntry } = openWallet("0.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test("rejects a negative initial balance", () => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: Money.fromMinor(-1n, "BRL"),
        openingTransactionId: "t",
        openingEntryId: "e",
        at: t0,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("credit and debit", () => {
  test("credit adds to the balance, bumps the version and returns the entry", () => {
    const { wallet } = openWallet();
    const entry = wallet.credit(move("25.50"));
    expect(wallet.balance.toString()).toBe("125.50");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry).toMatchObject({ direction: LedgerDirection.Credit, walletId: "wallet-1", walletVersion: 2 });
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("125.50");
    expect(entry.money.toString()).toBe("25.50");
  });

  test("debit subtracts from the balance, bumps the version and returns the entry", () => {
    const { wallet } = openWallet();
    const entry = wallet.debit(move("25.00"));
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("75.00");
  });

  test("debiting the exact balance is allowed and leaves zero", () => {
    const { wallet } = openWallet("40.00");
    wallet.debit(move("40.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("the entry records the transaction it belongs to", () => {
    const { wallet } = openWallet();
    const entry = wallet.debit({ money: brl("1.00"), transactionId: "tx-abc", entryId: "entry-abc", at: t1 });
    expect(entry.transactionId).toBe("tx-abc");
    expect(entry.id).toBe("entry-abc");
  });

  test("consecutive entries chain: each before equals the previous after", () => {
    const { wallet, openingEntry } = openWallet();
    const entries = [openingEntry!, wallet.debit(move("30.00")), wallet.credit(move("5.00")), wallet.debit(move("10.00"))];
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
      expect(entries[i]!.walletVersion).toBe(entries[i - 1]!.walletVersion + 1);
    }
    expect(wallet.balance.equals(entries.at(-1)!.balanceAfter)).toBe(true);
  });
});

describe("failed operations leave the wallet untouched", () => {
  function snapshot(wallet: Wallet) {
    return [wallet.balance.toString(), wallet.version, wallet.updatedAt];
  }

  test("insufficient funds", () => {
    const { wallet } = openWallet("10.00");
    const before = snapshot(wallet);
    expect(() => wallet.debit(move("10.01"))).toThrow(InsufficientFundsError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("currency mismatch on debit, credit and canDebit", () => {
    const { wallet } = openWallet();
    const before = snapshot(wallet);
    const foreign = { money: usd("1.00"), transactionId: "t", entryId: "e", at: t1 };
    expect(() => wallet.debit(foreign)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(foreign)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("zero and negative amounts", () => {
    const { wallet } = openWallet();
    const before = snapshot(wallet);
    for (const money of [brl("0.00"), Money.fromMinor(-100n, "BRL")]) {
      const props = { money, transactionId: "t", entryId: "e", at: t1 };
      expect(() => wallet.debit(props)).toThrow(InvalidMoneyError);
      expect(() => wallet.credit(props)).toThrow(InvalidMoneyError);
    }
    expect(snapshot(wallet)).toEqual(before);
  });
});

describe("canDebit", () => {
  test("is true up to and including the balance", () => {
    const { wallet } = openWallet("50.00");
    expect(wallet.canDebit(brl("49.99"))).toBe(true);
    expect(wallet.canDebit(brl("50.00"))).toBe(true);
    expect(wallet.canDebit(brl("50.01"))).toBe(false);
  });
});

describe("two 80.00 bets on 100.00", () => {
  test("only one can be debited and the balance ends at 20.00", () => {
    const { wallet } = openWallet("100.00");
    wallet.debit(move("80.00"));
    expect(wallet.canDebit(brl("80.00"))).toBe(false);
    expect(() => wallet.debit(move("80.00"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("Wallet.rehydrate", () => {
  test("restores state as given and continues from it", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("500.00"),
      version: 7,
      createdAt: t0,
      updatedAt: t0,
    });
    expect(wallet.version).toBe(7);
    const entry = wallet.debit(move("100.00"));
    expect(entry.walletVersion).toBe(8);
    expect(wallet.balance.toString()).toBe("400.00");
  });
});

describe("WalletLedgerEntry", () => {
  const valid = {
    id: "e1",
    walletId: "w1",
    transactionId: "t1",
    direction: LedgerDirection.Credit,
    money: brl("10.00"),
    balanceBefore: brl("5.00"),
    balanceAfter: brl("15.00"),
    walletVersion: 2,
    createdAt: t0,
  };

  test("accepts a balanced credit and debit", () => {
    expect(WalletLedgerEntry.create(valid).isBalanced()).toBe(true);
    const debit = WalletLedgerEntry.create({
      ...valid,
      direction: LedgerDirection.Debit,
      balanceBefore: brl("15.00"),
      balanceAfter: brl("5.00"),
    });
    expect(debit.isBalanced()).toBe(true);
  });

  test("rejects arithmetic that does not balance", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, balanceAfter: brl("16.00") })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...valid, direction: LedgerDirection.Debit })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects a zero or negative amount", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, money: brl("0.00"), balanceAfter: brl("5.00") })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects negative balances", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...valid,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: Money.fromMinor(-500n, "BRL"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects mixed currencies", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, balanceBefore: usd("5.00"), balanceAfter: usd("15.00") })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rehydrate does not validate, but isBalanced exposes a bad row", () => {
    const tampered = WalletLedgerEntry.rehydrate({ ...valid, balanceAfter: brl("99.00") });
    expect(tampered.isBalanced()).toBe(false);
  });

  test("is immutable", () => {
    const entry = WalletLedgerEntry.create(valid);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { walletVersion: number }).walletVersion = 99;
    }).toThrow(TypeError);
    expect(entry.walletVersion).toBe(2);
  });
});
