import { describe, expect, test } from "bun:test";
import * as globals from "../../src/globals";

describe("nesting rules", () => {
  const defaults = globals as unknown as globals.NestingInput;

  test("hold for the defaults", () => {
    expect(globals.nestingViolations(defaults)).toEqual([]);
  });

  test("flag a visibility margin shorter than the use-case budget", () => {
    const shortMargin = { ...defaults, SQS_VISIBILITY_SAFETY_MARGIN_S: 5 };
    expect(globals.nestingViolations(shortMargin)).toEqual([
      "USE_CASE_DEADLINE_MS + TX_LOCK_TIMEOUT_MS + TX_STATEMENT_TIMEOUT_MS < SQS_VISIBILITY_SAFETY_MARGIN_S",
    ]);
  });

  test("flag a margin that is not below the visibility timeout", () => {
    const longMargin = { ...defaults, SQS_VISIBILITY_SAFETY_MARGIN_S: 60 };
    expect(globals.nestingViolations(longMargin)).toEqual([
      "SQS_VISIBILITY_SAFETY_MARGIN_S < SQS_VISIBILITY_TIMEOUT_S",
    ]);
  });

  test("flag an outbox send that can outlive the idle timeout", () => {
    const slowSend = { ...defaults, OUTBOX_SQS_REQUEST_TIMEOUT_MS: 9800 };
    expect(globals.nestingViolations(slowSend)).toEqual([
      "OUTBOX_SQS_REQUEST_TIMEOUT_MS + 500 < OUTBOX_TX_IDLE_TIMEOUT_MS",
    ]);
  });

  test("flag a reference batch that outlives its lease", () => {
    const bigBatch = { ...defaults, REFERENCE_CLAIM_BATCH: 40 };
    expect(globals.nestingViolations(bigBatch)).toEqual([
      "ceil(REFERENCE_CLAIM_BATCH / REFERENCE_PROCESS_CONCURRENCY) * USE_CASE_DEADLINE_MS <= REFERENCE_CLAIM_LEASE_S",
    ]);
  });

  test("flag a drain longer than the compose grace period", () => {
    const longDrain = { ...defaults, SHUTDOWN_DRAIN_MS: 30000 };
    expect(globals.nestingViolations(longDrain)).toEqual(["SHUTDOWN_DRAIN_MS < 30000"]);
  });

  test("flag lock, statement and idle timeouts out of order", () => {
    const unordered = { ...defaults, TX_STATEMENT_TIMEOUT_MS: 1000 };
    expect(globals.nestingViolations(unordered)).toContain(
      "TX_LOCK_TIMEOUT_MS < TX_STATEMENT_TIMEOUT_MS < TX_IDLE_IN_TX_TIMEOUT_MS",
    );
  });
});
