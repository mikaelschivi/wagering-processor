import { beforeAll, describe, expect, test } from "bun:test";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import type { AppConfig } from "../../src/config";
import { HealthController } from "../../src/infra/http/health.controller";
import type { OutboxRunner } from "../../src/infra/outbox-runner";
import { LifecycleState, ShutdownCoordinator } from "../../src/infra/shutdown";
import type { ConsumerRunner } from "../../src/infra/sqs/consumer";

beforeAll(() => Logger.overrideLogger(false));

const config = (drainMs: number) => ({ SHUTDOWN_DRAIN_MS: drainMs }) as AppConfig;

function runners(stopConsumer: () => Promise<void>, stopOutbox: () => Promise<void>) {
  return { consumer: { stop: stopConsumer } as ConsumerRunner, outbox: { stop: stopOutbox } as OutboxRunner };
}

describe("ShutdownCoordinator", () => {
  test("marks the instance as draining before it stops any work", async () => {
    const state = new LifecycleState();
    const seen: boolean[] = [];
    const { consumer, outbox } = runners(
      async () => void seen.push(state.draining),
      async () => void seen.push(state.draining),
    );
    await new ShutdownCoordinator(config(1000), state, consumer, outbox).beforeApplicationShutdown();
    expect(seen).toEqual([true, true]);
  });

  test("waits for both the consumer and the outbox to finish", async () => {
    let consumerDone = false;
    let outboxDone = false;
    const { consumer, outbox } = runners(
      async () => {
        await Bun.sleep(50);
        consumerDone = true;
      },
      async () => {
        await Bun.sleep(100);
        outboxDone = true;
      },
    );
    await new ShutdownCoordinator(config(2000), new LifecycleState(), consumer, outbox).beforeApplicationShutdown();
    expect([consumerDone, outboxDone]).toEqual([true, true]);
  });

  test("gives up after the drain time when in-flight work does not finish", async () => {
    const { consumer, outbox } = runners(
      () => new Promise(() => {}),
      async () => {},
    );
    const startedAt = Date.now();
    await new ShutdownCoordinator(config(150), new LifecycleState(), consumer, outbox).beforeApplicationShutdown();
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
