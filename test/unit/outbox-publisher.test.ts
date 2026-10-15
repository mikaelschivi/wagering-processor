import { describe, expect, test } from "bun:test";
import {
  EventSender,
  type OutboxBatch,
  type OutboxFailure,
  type OutboxMessage,
  OutboxStore,
  type SendFailure,
} from "../../src/application/ports";
import { OutboxPublisher, retryDelayMs } from "../../src/application/outbox-publisher";
import { FixedClock } from "../helpers/fakes";

const message = (id: string, attempts = 0): OutboxMessage => ({
  id,
  partitionKey: "wallet-1",
  eventType: "WalletBalanceChanged",
  payload: "{}",
  attempts,
});

class FakeStore extends OutboxStore {
  readonly published: string[] = [];
  readonly failed: OutboxFailure[] = [];
  batches = 0;
  constructor(private readonly pending: OutboxMessage[][]) {
    super();
  }

  async withBatch<T>(_limit: number, work: (batch: OutboxBatch) => Promise<T>): Promise<T> {
    this.batches++;
    const batch: OutboxBatch = {
      messages: this.pending.shift() ?? [],
      markPublished: async (ids) => void this.published.push(...ids),
      markFailed: async (failures) => void this.failed.push(...failures),
    };
    return work(batch);
  }
}

class FakeSender extends EventSender {
  readonly sent: string[][] = [];
  constructor(private readonly behaviour: (messages: OutboxMessage[]) => SendFailure[] = () => []) {
    super();
  }

  async send(messages: OutboxMessage[]): Promise<SendFailure[]> {
    this.sent.push(messages.map((item) => item.id));
    return this.behaviour(messages);
  }
}

const publisher = (store: FakeStore, sender: EventSender, clock = new FixedClock()) =>
  new OutboxPublisher(store, sender, clock, { batchSize: 3, intervalMs: 500 });

describe("OutboxPublisher.publishBatch", () => {
  test("sends a batch and marks every message published", async () => {
    const store = new FakeStore([[message("a"), message("b")]]);
    const sender = new FakeSender();
    expect(await publisher(store, sender).publishBatch()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(sender.sent).toEqual([["a", "b"]]);
    expect(store.published).toEqual(["a", "b"]);
    expect(store.failed).toEqual([]);
  });

  test("an empty batch sends nothing", async () => {
    const store = new FakeStore([]);
    const sender = new FakeSender();
    expect(await publisher(store, sender).publishBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(sender.sent).toEqual([]);
  });

  test("a partial failure publishes the rest and schedules only the failures for retry", async () => {
    const store = new FakeStore([[message("a", 0), message("b", 2), message("c", 0)]]);
    const sender = new FakeSender(() => [{ id: "b", error: "Throttled" }]);
    expect(await publisher(store, sender).publishBatch()).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(store.published).toEqual(["a", "c"]);
    expect(store.failed).toEqual([{ id: "b", error: "Throttled", retryInMs: 8000 }]);
  });

  test("a sender that throws fails the whole batch with the error class and code only", async () => {
    const store = new FakeStore([[message("a"), message("b")]]);
    const boom = Object.assign(new Error("secret payload {amount: 1}"), { name: "TimeoutError", code: "ETIMEDOUT" });
    const sender = new FakeSender(() => {
      throw boom;
    });
    const report = await publisher(store, sender).publishBatch();
    expect(report).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(store.published).toEqual([]);
    expect(store.failed.map((failure) => failure.error)).toEqual(["TimeoutError:ETIMEDOUT", "TimeoutError:ETIMEDOUT"]);
    expect(JSON.stringify(store.failed)).not.toContain("secret");
  });

  test("an error text over 500 characters is truncated", async () => {
    const store = new FakeStore([[message("a")]]);
    const sender = new FakeSender(() => [{ id: "a", error: "x".repeat(900) }]);
    await publisher(store, sender).publishBatch();
    expect(store.failed[0]!.error).toHaveLength(500);
  });

  test("a failure while marking propagates so the batch transaction rolls back", async () => {
    const store = new FakeStore([[message("a")]]);
    store.withBatch = async (_limit, work) =>
      work({
        messages: [message("a")],
        markPublished: async () => {
          throw new Error("db down");
        },
        markFailed: async () => {},
      });
    await expect(publisher(store, new FakeSender()).publishBatch()).rejects.toThrow("db down");
  });
});

describe("retryDelayMs", () => {
  test("doubles from two seconds and stops at five minutes", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000]);
    expect(retryDelayMs(8)).toBe(256_000);
    expect(retryDelayMs(9)).toBe(300_000);
    expect(retryDelayMs(40)).toBe(300_000);
  });
});

describe("OutboxPublisher.run", () => {
  test("keeps going without a pause while batches are full, then waits when it runs dry", async () => {
    const full = () => [message("a"), message("b"), message("c")];
    const store = new FakeStore([full(), full(), [message("d")]]);
    const clock = new FixedClock();
    const controller = new AbortController();
    const original = store.withBatch.bind(store);
    store.withBatch = async (limit, work) => {
      if (store.batches === 2) controller.abort();
      return original(limit, work);
    };
    await publisher(store, new FakeSender(), clock).run(controller.signal, () => {});
    expect(store.batches).toBe(3);
    expect(clock.sleeps).toEqual([500]);
  });

  test("pauses for the interval after a short batch", async () => {
    const store = new FakeStore([[message("a")]]);
    const clock = new FixedClock();
    const controller = new AbortController();
    const original = store.withBatch.bind(store);
    store.withBatch = async (limit, work) => {
      if (store.batches === 0) controller.abort();
      return original(limit, work);
    };
    await publisher(store, new FakeSender(), clock).run(controller.signal, () => {});
    expect(clock.sleeps).toEqual([500]);
  });

  test("reports an error, pauses and carries on", async () => {
    const store = new FakeStore([[message("a")]]);
    const clock = new FixedClock();
    const controller = new AbortController();
    const errors: unknown[] = [];
    let calls = 0;
    const original = store.withBatch.bind(store);
    store.withBatch = async (limit, work) => {
      calls++;
      if (calls === 1) throw new Error("db down");
      if (calls === 2) controller.abort();
      return original(limit, work);
    };
    await publisher(store, new FakeSender(), clock).run(controller.signal, (error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(store.published).toEqual(["a"]);
    expect(clock.sleeps).toEqual([500, 500]);
  });

  test("returns immediately when already aborted", async () => {
    const store = new FakeStore([[message("a")]]);
    const controller = new AbortController();
    controller.abort();
    await publisher(store, new FakeSender()).run(controller.signal, () => {});
    expect(store.batches).toBe(0);
  });
});
