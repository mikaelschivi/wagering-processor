import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each(["0.00", "0.01", "25.00", "1000.50", "99999999999999999.99"])("accepts %p", (amount) => {
    expect(brl(amount).toString()).toBe(amount);
  });

  test.each([
    "25",
    "25.0",
    "25.001",
    "-1.00",
    "+1.00",
    "1e2",
    "1E2",
    "NaN",
    "Infinity",
    "-Infinity",
    "",
    " ",
    " 1.00",
    "1.00 ",
    "025.00",
    "1,00",
    ".50",
    "1.",
    "0x10",
    "100000000000000000.00",
  ])("rejects amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([[25], [null], [undefined], [{}], [["1.00"]]])("rejects non-string amount %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" } as never)).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "", "1RL", "B R", 5, null, undefined])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency } as never)).toThrow(InvalidMoneyError);
  });

  test("rejects a missing props object", () => {
    expect(() => Money.from(undefined as never)).toThrow(InvalidMoneyError);
  });

  test("does not echo the rejected value in the error message", () => {
    expect(() => brl("12345.678")).toThrow(/^(?!.*12345).*$/);
  });
});

describe("arithmetic", () => {
  test("adds exactly where floats would not", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("subtracts and may go negative", () => {
    const result = brl("1.00").subtract(brl("2.50"));
    expect(result.toString()).toBe("-1.50");
    expect(result.isNegative()).toBe(true);
  });

  test("formats small negatives with leading zero", () => {
    expect(brl("0.00").subtract(brl("0.05")).toString()).toBe("-0.05");
  });

  test("negate flips the sign and zero stays zero", () => {
    expect(brl("3.25").negate().toString()).toBe("-3.25");
    expect(brl("0.00").negate().toString()).toBe("0.00");
  });

  test("operations return new instances and leave operands untouched", () => {
    const a = brl("10.00");
    const b = brl("5.00");
    const sum = a.add(b);
    expect(sum).not.toBe(a);
    expect(a.toString()).toBe("10.00");
    expect(b.toString()).toBe("5.00");
  });

  test("adding then subtracting returns to the original", () => {
    const a = brl("123.45");
    expect(a.add(brl("99.99")).subtract(brl("99.99")).equals(a)).toBe(true);
  });

  test("is exact over many additions", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.toString()).toBe("10.00");
  });
});

describe("comparisons", () => {
  test("zero, positive and negative", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").subtract(brl("0.01")).isNegative()).toBe(true);
    expect(brl("0.00").isNegative()).toBe(false);
  });

  test("isLessThan", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
  });

  test("equals compares amount and currency", () => {
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(brl("1.01"))).toBe(false);
    expect(brl("1.00").equals(usd("1.00"))).toBe(false);
  });
});

describe("currency conflicts", () => {
  test("add, subtract and isLessThan throw a domain error", () => {
    expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("the error carries a stable code", () => {
    try {
      brl("1.00").add(usd("1.00"));
    } catch (error) {
      expect((error as CurrencyMismatchError).code).toBe("CURRENCY_MISMATCH");
    }
  });
});

describe("range", () => {
  test("adding past the maximum throws", () => {
    expect(() => brl("99999999999999999.99").add(brl("0.01"))).toThrow(MoneyOverflowError);
  });

  test("subtracting past the negative maximum throws", () => {
    expect(() => brl("0.00").subtract(brl("99999999999999999.99")).subtract(brl("0.01"))).toThrow(
      MoneyOverflowError,
    );
  });

  test("the maximum itself is allowed", () => {
    expect(brl("99999999999999999.98").add(brl("0.01")).toString()).toBe("99999999999999999.99");
  });
});

describe("serialization", () => {
  test("toJSON produces the contract shape", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test("toString then from round-trips", () => {
    for (const amount of ["0.00", "0.07", "10.00", "123456.78"]) {
      expect(brl(amount).toString()).toBe(amount);
    }
  });

  test("zero is 0.00", () => {
    expect(Money.zero("BRL").toString()).toBe("0.00");
  });
});

describe("database values", () => {
  test("fromDb reads what numeric(20,2) returns", () => {
    expect(Money.fromDb("0.00", "BRL").isZero()).toBe(true);
    expect(Money.fromDb("975.00", "BRL").toString()).toBe("975.00");
  });

  test("fromDb tolerates a negative value", () => {
    expect(Money.fromDb("-1.50", "BRL").toString()).toBe("-1.50");
  });

  test("fromDb still rejects malformed values", () => {
    expect(() => Money.fromDb("975", "BRL")).toThrow(InvalidMoneyError);
    expect(() => Money.fromDb("1.0", "BRL")).toThrow(InvalidMoneyError);
  });

  test("fromMinor builds negatives for intermediate math", () => {
    expect(Money.fromMinor(-250n, "BRL").toString()).toBe("-2.50");
  });
});
