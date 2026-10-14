import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// isso rejeita: 25, 25.0, 025.00, -1.00 & 1e2
const UNSIGNED_AMOUNT = /^(0|[1-9][0-9]{0,16})\.[0-9]{2}$/;
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,16})\.[0-9]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
// max number 99999999999999999.99
const MAX_MINOR = 10n ** 19n - 1n;

function parseMinor(amount: unknown, pattern: RegExp): bigint {
  if (typeof amount !== "string" || !pattern.test(amount)) {
    throw new InvalidMoneyError("amount must be a decimal string with exactly 2 decimals");
  }
  return BigInt(amount.replace(".", ""));
}

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError("currency must be a 3-letter uppercase ISO-4217 code");
  }
}

// bigint pra 2 decimais, pra mais eu usaria decimal.js
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) throw new MoneyOverflowError("amount out of range");
  }

  static from(props: MoneyProps): Money {
    assertCurrency(props?.currency);
    return new Money(parseMinor(props.amount, UNSIGNED_AMOUNT), props.currency);
  }

  static fromDb(amount: string, currency: string): Money {
    assertCurrency(currency);
    return new Money(parseMinor(amount, SIGNED_AMOUNT), currency);
  }

  static fromMinor(minor: bigint, currency: string): Money {
    assertCurrency(currency);
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const digits = abs.toString().padStart(3, "0");
    const sign = this.minor < 0n ? "-" : "";
    return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError("operation between different currencies");
    }
  }
}
