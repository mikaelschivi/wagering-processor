import { describe, expect, test } from "bun:test";
import { formatCents, percentile, seededRandom, summarize } from "../../scripts/load-stats";

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, n) => n + 1);

  test("picks the value at the rank, not an interpolation", () => {
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.95)).toBe(95);
    expect(percentile(hundred, 0.99)).toBe(99);
    expect(percentile(hundred, 1)).toBe(100);
  });

  test("handles tiny and empty inputs", () => {
    expect(percentile([], 0.99)).toBe(0);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([1, 2], 0.5)).toBe(1);
    expect(percentile([1, 2], 0.99)).toBe(2);
    expect(percentile(hundred, 0)).toBe(1);
  });
});

describe("summarize", () => {
  test("sorts the samples itself and reports the tail", () => {
    const shuffled = [...Array.from({ length: 100 }, (_, n) => n + 1)].reverse();
    expect(summarize(shuffled)).toEqual({ count: 100, mean: 50.5, p50: 50, p90: 90, p95: 95, p99: 99, max: 100 });
  });

  test("one slow request shows up in the tail and the max, not in the median", () => {
    const samples = [...Array.from({ length: 99 }, () => 10), 5000];
    const result = summarize(samples);
    expect(result.p50).toBe(10);
    expect(result.p99).toBe(10);
    expect(result.max).toBe(5000);
  });

  test("does not change its input", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test("an empty run is all zeros", () => {
    expect(summarize([])).toEqual({ count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe("seededRandom", () => {
  test("the same seed gives the same sequence and stays in [0, 1)", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = Array.from({ length: 50 }, () => a());
    expect(first).toEqual(Array.from({ length: 50 }, () => b()));
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test("different seeds give different sequences", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });
});

describe("formatCents", () => {
  test("always shows two decimals and handles negatives", () => {
    expect(formatCents(0n)).toBe("0.00");
    expect(formatCents(5n)).toBe("0.05");
    expect(formatCents(12345n)).toBe("123.45");
    expect(formatCents(-250n)).toBe("-2.50");
  });
});
