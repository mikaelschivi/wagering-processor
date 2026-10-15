import { describe, expect, test } from "bun:test";
import {
  addLogContext,
  correlationIdFrom,
  correlationMiddleware,
  currentCorrelationId,
  JsonLogger,
  runWithContext,
} from "../../src/observability";

const at = new Date("2026-03-04T05:06:07.000Z");

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger((line) => lines.push(JSON.parse(line)), () => at);
  return { lines, logger };
}

describe("JsonLogger", () => {
  test("writes one JSON object per line with time, level, context and message", () => {
    const { lines, logger } = capture();
    logger.log("started", "Bootstrap");
    expect(lines).toEqual([{ time: "2026-03-04T05:06:07.000Z", level: "info", context: "Bootstrap", message: "started" }]);
  });

  test("maps levels and keeps the stack of an error", () => {
    const { lines, logger } = capture();
    logger.warn("careful");
    logger.debug("detail");
    logger.verbose("more");
    logger.error("failed", "Error: boom\n at x", "Worker");
    expect(lines.map((line) => line.level)).toEqual(["warn", "debug", "debug", "error"]);
    expect(lines[3]).toMatchObject({ message: "failed", stack: "Error: boom\n at x", context: "Worker" });
  });

  test("adds the correlation fields of the current request or message", () => {
    const { lines, logger } = capture();
    runWithContext({ correlationId: "corr-1", walletId: "w-1" }, () => {
      addLogContext({ transactionId: "t-1", providerId: "provider-a", messageId: "m-1" });
      logger.log("processing");
    });
    expect(lines[0]).toMatchObject({
      correlationId: "corr-1",
      walletId: "w-1",
      transactionId: "t-1",
      providerId: "provider-a",
      messageId: "m-1",
    });
  });

  test("context does not leak between concurrent units of work", async () => {
    const { lines, logger } = capture();
    await Promise.all(
      ["a", "b", "c"].map((id) =>
        runWithContext({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 10);
          logger.log("step");
        }),
      ),
    );
    expect(lines.map((line) => line.correlationId).sort()).toEqual(["a", "b", "c"]);
  });

  test("outside any context no correlation fields are added", () => {
    const { lines, logger } = capture();
    logger.log("boot");
    expect(Object.keys(lines[0]!).sort()).toEqual(["level", "message", "time"]);
  });

  test("an object message adds its fields but never financial or secret ones", () => {
    const { lines, logger } = capture();
    logger.log({
      message: "request completed",
      status: 200,
      amount: "25.00",
      balance: "975.00",
      money: { amount: "1.00" },
      payload: "{}",
      requestBody: "x",
      Authorization: "Bearer x",
      password: "p",
    });
    expect(lines[0]).toMatchObject({ message: "request completed", status: 200 });
    for (const key of ["amount", "balance", "money", "payload", "requestBody", "Authorization", "password"]) {
      expect(lines[0]).not.toHaveProperty(key);
    }
  });

  test("an error object is logged by name only", () => {
    const { lines, logger } = capture();
    logger.error(new Error("card 4111 failed"));
    expect(lines[0]!.message).toBe("Error");
    expect(JSON.stringify(lines[0])).not.toContain("4111");
  });
});

describe("correlation ids", () => {
  test("a valid header is kept and anything else is replaced by a new id", () => {
    expect(correlationIdFrom("abc-123.x:y-z")).toBe("abc-123.x:y-z");
    for (const bad of [undefined, "", "has space", "x".repeat(129), "semi;colon"]) {
      const generated = correlationIdFrom(bad);
      expect(generated).not.toBe(bad);
      expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("currentCorrelationId is the context's id, or a fresh one outside a request", () => {
    expect(runWithContext({ correlationId: "known" }, currentCorrelationId)).toBe("known");
    expect(currentCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("correlationMiddleware", () => {
  function run(header: string | undefined) {
    const headers: Record<string, string> = {};
    let finish: () => void = () => {};
    let seen: string | undefined;
    const request = { method: "POST", route: { path: "/wallets" }, header: () => header };
    const response = {
      statusCode: 201,
      setHeader: (name: string, value: string) => void (headers[name] = value),
      on: (_event: "finish", listener: () => void) => void (finish = listener),
    };
    correlationMiddleware()(request, response, () => void (seen = currentCorrelationId()));
    return { headers, seen, finish };
  }

  test("exposes the id to the request and echoes it in the response header", () => {
    const { headers, seen } = run("corr-9");
    expect(seen).toBe("corr-9");
    expect(headers["x-correlation-id"]).toBe("corr-9");
  });

  test("generates an id when the header is missing or invalid", () => {
    for (const header of [undefined, "bad id"]) {
      const { headers, seen } = run(header);
      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers["x-correlation-id"]).toBe(seen as string);
    }
  });
});
