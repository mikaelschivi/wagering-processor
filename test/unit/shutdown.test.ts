import { beforeAll, describe, expect, test } from "bun:test";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import type { AppConfig } from "../../src/config";
import { HealthController } from "../../src/infra/http/health.controller";
import type { OutboxRunner } from "../../src/infra/outbox-runner";
import type { ReferenceRunner } from "../../src/infra/reference-runner";
import { LifecycleState, ShutdownCoordinator } from "../../src/infra/shutdown";
import type { ConsumerRunner } from "../../src/infra/sqs/consumer";

beforeAll(() => Logger.overrideLogger(false));

const config = (drainMs: number) => ({ SHUTDOWN_DRAIN_MS: drainMs }) as AppConfig;

function runners(stopConsumer: () => Promise<void>, stopOutbox: () => Promise<void>) {
  return {
    consumer: { stop: stopConsumer } as ConsumerRunner,
    outbox: { stop: stopOutbox } as OutboxRunner,
    references: { stop: async () => {} } as ReferenceRunner,
  };
}

describe("ShutdownCoordinator", () => {
  test("marks the instance as draining before it stops any work", async () => {
    const state = new LifecycleState();
    const seen: boolean[] = [];
    const { consumer, outbox, references } = runners(
      async () => void seen.push(state.draining),
      async () => void seen.push(state.draining),
    );
    await new ShutdownCoordinator(config(1000), state, consumer, outbox, references).beforeApplicationShutdown();
    expect(seen).toEqual([true, true]);
  });

  test("waits for both the consumer and the outbox to finish", async () => {
    let consumerDone = false;
    let outboxDone = false;
    const { consumer, outbox, references } = runners(
      async () => {
        await Bun.sleep(50);
        consumerDone = true;
      },
      async () => {
        await Bun.sleep(100);
        outboxDone = true;
      },
    );
    await new ShutdownCoordinator(config(2000), new LifecycleState(), consumer, outbox, references).beforeApplicationShutdown();
    expect([consumerDone, outboxDone]).toEqual([true, true]);
  });

  test("also waits for the reference worker", async () => {
    let done = false;
    const { consumer, outbox } = runners(async () => {}, async () => {});
    const references = {
      stop: async () => {
        await Bun.sleep(80);
        done = true;
      },
    } as ReferenceRunner;
    await new ShutdownCoordinator(config(2000), new LifecycleState(), consumer, outbox, references).beforeApplicationShutdown();
    expect(done).toBe(true);
  });

  test("leaves no timer behind, so the process can exit as soon as the work is done", async () => {
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      const timer = realSet(handler, ms);
      pending.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(timer);
      realClear(timer);
    }) as typeof clearTimeout;
    try {
      const { consumer, outbox, references } = runners(async () => {}, async () => {});
      await new ShutdownCoordinator(config(20_000), new LifecycleState(), consumer, outbox, references).beforeApplicationShutdown();
      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("gives up after the drain time when in-flight work does not finish", async () => {
    const { consumer, outbox, references } = runners(
      () => new Promise(() => {}),
      async () => {},
    );
    const startedAt = Date.now();
    await new ShutdownCoordinator(config(150), new LifecycleState(), consumer, outbox, references).beforeApplicationShutdown();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("readiness while draining", () => {
  test("returns 503 without running the dependency checks", async () => {
    const state = new LifecycleState();
    let checked = false;
    const controller = new HealthController(
      [{ name: "postgres", timeoutMs: 100, run: async () => void (checked = true) }],
      state,
    );
    expect(await controller.ready()).toMatchObject({ status: "ok" });

    state.draining = true;
    checked = false;
    const error = await controller.ready().catch((caught) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toEqual({ status: "unavailable", draining: true });
    expect(checked).toBe(false);
  });

  test("liveness stays up while draining", () => {
    const state = new LifecycleState();
    state.draining = true;
    expect(new HealthController([], state).live()).toEqual({ status: "ok" });
  });
});
