import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from "./errors";
import { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    const sameCurrency = [state.balanceBefore, state.balanceAfter].every(
      (balance) => balance.currency === state.money.currency,
    );
    if (!sameCurrency) throw new InvalidLedgerEntryError("ledger entry mixes currencies");
    if (!state.money.isPositive()) throw new InvalidLedgerEntryError("ledger amount must be positive");
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("ledger balances cannot be negative");
    }
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError("ledger entry arithmetic does not balance");
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) throw new InvalidMoneyError("initial balance cannot be negative");
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (!this.canDebit(props.money)) throw new InsufficientFundsError("balance is lower than the debit");
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(direction: LedgerDirection, balanceAfter: Money, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidMoneyError("movement amount must be positive");
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError("currency differs from the wallet");
  }
}
