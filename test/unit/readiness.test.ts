import { describe, expect, test } from "bun:test";
import { runChecks, type ReadinessCheck } from "../../src/infra/http/health.controller";

const up = (name: string): ReadinessCheck => ({ name, timeoutMs: 100, run: async () => {} });
const failing = (name: string): ReadinessCheck => ({
  name,
  timeoutMs: 100,
  run: async () => {
    throw new Error("boom");
  },
});
const hanging = (name: string): ReadinessCheck => ({ name, timeoutMs: 50, run: () => new Promise(() => {}) });

describe("runChecks", () => {
  test("is ok when every check passes", async () => {
    expect(await runChecks([up("postgres"), up("sqs")])).toEqual({
      ok: true,
      checks: { postgres: "up", sqs: "up" },
    });
  });

  test("reports which check is down", async () => {
    expect(await runChecks([up("postgres"), failing("sqs")])).toEqual({
      ok: false,
      checks: { postgres: "up", sqs: "down" },
    });
  });

  test("treats a check that exceeds its timeout as down", async () => {
    const started = Date.now();
    const report = await runChecks([hanging("postgres")]);
    expect(report).toEqual({ ok: false, checks: { postgres: "down" } });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("runs checks concurrently", async () => {
    const started = Date.now();
    await runChecks([hanging("a"), hanging("b"), hanging("c")]);
    expect(Date.now() - started).toBeLessThan(120);
  });

  test("is ok with no checks", async () => {
    expect(await runChecks([])).toEqual({ ok: true, checks: {} });
  });
});
