import type { Subprocess } from "bun";
import type { AppConfig } from "../../src/config";

export interface Instance {
  port: number;
  url: string;
  process: Subprocess;
  logs(): string;
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<number | null>;
}

export interface SpawnOptions {
  config: AppConfig;
  roles?: string;
  env?: Record<string, string>;
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, everyMs = 50, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await Bun.sleep(everyMs);
  }
  throw new Error(`${what} was not met within ${timeoutMs}ms`);
}

export async function spawnInstance({ config, roles = "api,consumer,outbox,reference-worker", env = {} }: SpawnOptions): Promise<Instance> {
  const port = freePort();
  const output: string[] = [];
  const child = Bun.spawn(["bun", "src/main.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      APP_ROLES: roles,
      DB_HOST: config.DB_HOST,
      DB_PORT: String(config.DB_PORT),
      DB_NAME: config.DB_NAME,
      DB_APP_USER: config.DB_APP_USER,
      DB_APP_PASSWORD: config.DB_APP_PASSWORD,
      AWS_ENDPOINT_URL: config.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      WAGER_QUEUE_NAME: config.WAGER_QUEUE_NAME,
      WAGER_DLQ_NAME: config.WAGER_DLQ_NAME,
      EVENTS_QUEUE_NAME: config.EVENTS_QUEUE_NAME,
      METRICS_LOG_INTERVAL_S: "0",
      ...env,
    },
  });
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output.push(decoder.decode(chunk));
    })();
  }

  const instance: Instance = {
    port,
    url: `http://127.0.0.1:${port}`,
    process: child,
    logs: () => output.join(""),
    async stop(signal = "SIGTERM") {
      child.kill(signal);
      return child.exited;
    },
  };

  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`instance exited early with ${child.exitCode}\n${instance.logs()}`);
        return (await fetch(`${instance.url}/health/ready`).catch(() => undefined))?.ok;
      },
      { timeoutMs: 30_000, what: `instance on port ${port} to become ready` },
    );
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return instance;
}

export const spawnInstances = (count: number, options: SpawnOptions): Promise<Instance[]> =>
  Promise.all(Array.from({ length: count }, () => spawnInstance(options)));

export const stopAll = (instances: Instance[], signal: "SIGTERM" | "SIGKILL" = "SIGTERM") =>
  Promise.all(instances.map((instance) => instance.stop(signal)));
