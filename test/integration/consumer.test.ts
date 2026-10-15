import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SendMessageCommand as Send,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import type { AppConfig } from "../../src/config";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { type Disposition, SqsConsumer, WagerMessageHandler } from "../../src/infra/sqs/consumer";
import { createQueues, type QueueUrls } from "../../src/infra/sqs/queues";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { openingRecord } from "../helpers/fakes";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const suffix = crypto.randomUUID().slice(0, 8);
let db: TestDatabase;
let config: AppConfig;
let sqs: SQSClient;
let urls: QueueUrls;
let wallets: PostgresWalletStore;
let realHandler: WagerMessageHandler;

const queueSettings = { visibilityTimeoutS: 3, maxReceiveCount: 3 };

beforeAll(async () => {
  db = await createTestDatabase();
  config = {
    ...db.config,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    WAGER_QUEUE_NAME: "",
    WAGER_DLQ_NAME: "",
    EVENTS_QUEUE_NAME: "",
    SQS_VISIBILITY_TIMEOUT_S: 3,
    SQS_VISIBILITY_SAFETY_MARGIN_S: 1,
    SQS_RETRY_BACKOFF_CAP_S: 1,
    SQS_WAIT_TIME_S: 1,
  };
  sqs = new SQSClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL, maxAttempts: 1 });
  wallets = new PostgresWalletStore(db.app, db.config);
  const useCase = new ProcessWagerTransaction(new PostgresWagerStore(db.app, db.config), new UuidV7Generator(), new SystemClock(), {
    maxAttempts: 5,
    deadlineMs: config.USE_CASE_DEADLINE_MS,
    jitterMinMs: 5,
    jitterMaxMs: 25,
    random: Math.random,
  });
  realHandler = new WagerMessageHandler(useCase);
}, 60_000);

beforeEach(async () => {
  const id = crypto.randomUUID().slice(0, 8);
  config.WAGER_QUEUE_NAME = `cs-${id}.fifo`;
  config.WAGER_DLQ_NAME = `cs-${id}-dlq.fifo`;
  config.EVENTS_QUEUE_NAME = `cs-${id}-events.fifo`;
  urls = await createQueues(
    sqs,
    { main: config.WAGER_QUEUE_NAME, dlq: config.WAGER_DLQ_NAME, events: config.EVENTS_QUEUE_NAME },
    queueSettings,
  );
});

afterEach(async () => {
  for (const QueueUrl of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
});

afterAll(async () => {
  sqs.destroy();
  await db.drop();
});

const at = new Date("2026-03-04T05:06:07.000Z");
const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openWallet(balance = "100.00") {
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at,
  });
  await wallets.create(wallet, openingRecord(wallet, openingEntry));
  return wallet;
}

const messageFor = (wallet: Wallet, messageId: string, overrides: Record<string, unknown> = {}) => {
  const externalId = `ext-${messageId}`;
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      ...overrides,
    },
  });
};

const enqueue = (groupId: string, body: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: urls.main,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );

const balance = async (wallet: Wallet) =>
  ((await query("select balance from wallets where id = ?", [wallet.id]))[0] as { balance: string }).balance;

async function depth(QueueUrl: string) {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }));
  return {
    visible: Number(Attributes!.ApproximateNumberOfMessages),
    inFlight: Number(Attributes!.ApproximateNumberOfMessagesNotVisible),
  };
}

async function receiveFrom(QueueUrl: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    if (Messages?.[0]) return Messages[0];
  }
  return undefined;
}

const consumerWith = (handler: Pick<WagerMessageHandler, "handle">, client: SQSClient = sqs, cfg = config) =>
  new SqsConsumer(client, handler as WagerMessageHandler, cfg, new SystemClock(), () => {}, () => 0);

const never = new AbortController().signal;

describe("SqsConsumer against LocalStack and Postgres", () => {
  test("a valid message is processed, then deleted only after the commit", async () => {
    const wallet = await openWallet();
    await enqueue(wallet.id, messageFor(wallet, "m-ack"));
    const consumer = consumerWith(realHandler);

    expect(await consumer.pollOnce(never)).toBe(1);
    expect(await balance(wallet)).toBe("90.00");
    expect(await depth(urls.main)).toEqual({ visible: 0, inFlight: 0 });
  });

  test("a business rejection is acked, not dead-lettered", async () => {
    const wallet = await openWallet("5.00");
    await enqueue(wallet.id, messageFor(wallet, "m-reject"));
    await consumerWith(realHandler).pollOnce(never);
    expect(await balance(wallet)).toBe("5.00");
    expect(await depth(urls.main)).toEqual({ visible: 0, inFlight: 0 });
    const [row] = await query("select status from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.id]);
    expect(row).toEqual({ status: "REJECTED" });
  });

  test("an invalid message is copied to the DLQ with its error code and then deleted", async () => {
    const wallet = await openWallet();
    const bad = messageFor(wallet, "m-bad", { money: { amount: "10", currency: "BRL" } });
    await enqueue(wallet.id, bad);
    await consumerWith(realHandler).pollOnce(never);

    const dead = await receiveFrom(urls.dlq);
    expect(dead?.Body).toBe(bad);
    expect(dead?.MessageAttributes?.errorCode?.StringValue).toBe("VALIDATION_ERROR");
    expect(dead?.MessageAttributes?.consumer?.StringValue).toBe("wager-consumer");
    expect(dead?.MessageAttributes?.receiveCount?.StringValue).toBe("1");
    expect(dead?.Attributes?.MessageGroupId).toBe(wallet.id);
    expect(await depth(urls.main)).toEqual({ visible: 0, inFlight: 0 });
    expect(await balance(wallet)).toBe("100.00");
  });

  test("a message that fails transiently stays on the queue and comes back with a higher receive count", async () => {
    const wallet = await openWallet();
    await enqueue(wallet.id, messageFor(wallet, "m-retry"));
    const seen: number[] = [];
    const flaky = {
      handle: async (): Promise<Disposition> => {
        seen.push(seen.length + 1);
        return seen.length < 2 ? { action: "retry", code: "TRANSIENT_FAILURE" } : { action: "ack" };
      },
    };
    const consumer = consumerWith(flaky);

    expect(await consumer.pollOnce(never)).toBe(1);
    expect(await consumer.pollOnce(never)).toBe(0);
    const deadline = Date.now() + 8000;
    while (seen.length < 2 && Date.now() < deadline) await consumer.pollOnce(never);
    expect(seen).toHaveLength(2);
    expect(await depth(urls.main)).toEqual({ visible: 0, inFlight: 0 });
  }, 20_000);

  test("a message that keeps failing is moved to the DLQ by the redrive policy after the max receives", async () => {
    const wallet = await openWallet();
    const body = messageFor(wallet, "m-poison");
    await enqueue(wallet.id, body);
    let calls = 0;
    const broken = {
      handle: async (): Promise<Disposition> => {
        calls++;
        return { action: "retry", code: "INTERNAL_ERROR" };
      },
    };
    const consumer = consumerWith(broken);
    const deadline = Date.now() + 15_000;
    let dead: Awaited<ReturnType<typeof receiveFrom>>;
    while (!dead && Date.now() < deadline) {
      await consumer.pollOnce(never);
      dead = await receiveFrom(urls.dlq, 500);
    }
    expect(dead?.Body).toBe(body);
    expect(calls).toBe(3);
  }, 30_000);

  test("when a message fails, later messages of the same wallet are not processed or deleted in that poll", async () => {
    const wallet = await openWallet();
    for (const id of ["o-1", "o-2", "o-3"]) await enqueue(wallet.id, messageFor(wallet, id));
    const handled: string[] = [];
    const handler = {
      handle: async (body: string): Promise<Disposition> => {
        handled.push(JSON.parse(body).messageId);
        return { action: "retry", code: "TRANSIENT_FAILURE" };
      },
    };

    expect(await consumerWith(handler).pollOnce(never)).toBe(3);
    expect(handled).toEqual(["o-1"]);
    const { visible, inFlight } = await depth(urls.main);
    expect(visible + inFlight).toBe(3);
  });

  test("a failing wallet does not block another wallet in the same batch", async () => {
    const stuck = await openWallet();
    const free = await openWallet();
    await enqueue(stuck.id, messageFor(stuck, "p-stuck"));
    await enqueue(free.id, messageFor(free, "p-free"));
    const handler = {
      handle: async (body: string): Promise<Disposition> =>
        JSON.parse(body).messageId === "p-stuck" ? { action: "retry", code: "TRANSIENT_FAILURE" } : realHandler.handle(body),
    };
    const consumer = consumerWith(handler);
    let polled = 0;
    while ((await balance(free)) !== "90.00" && polled++ < 10) await consumer.pollOnce(never);
    expect(await balance(free)).toBe("90.00");
    expect(await balance(stuck)).toBe("100.00");
  }, 30_000);

  test("a message that waited too long in a slow batch is released unprocessed and picked up on the next poll", async () => {
    const wallet = await openWallet();
    for (const id of ["g-1", "g-2"]) await enqueue(wallet.id, messageFor(wallet, id));
    const handled: string[] = [];
    const slow = {
      handle: async (body: string): Promise<Disposition> => {
        handled.push(JSON.parse(body).messageId);
        if (handled.length === 1) await sleep(2200);
        return { action: "ack" };
      },
    };
    const consumer = consumerWith(slow);

    expect(await consumer.pollOnce(never)).toBe(2);
    expect(handled).toEqual(["g-1"]);
    expect(await consumer.pollOnce(never)).toBe(1);
    expect(handled).toEqual(["g-1", "g-2"]);
  }, 20_000);

  test("a crash between commit and delete: the redelivery is absorbed by the inbox and debits once", async () => {
    const wallet = await openWallet();
    await enqueue(wallet.id, messageFor(wallet, "c-1"));
    let failDelete = true;
    const dropDelete = new Proxy(sqs, {
      get(target, property) {
        if (property !== "send") return Reflect.get(target, property);
        return (command: unknown, options?: unknown) => {
          if (command instanceof DeleteMessageCommand && failDelete) {
            failDelete = false;
            return Promise.reject(new Error("process died before ack"));
          }
          return (target.send as (...args: unknown[]) => unknown)(command, options);
        };
      },
    }) as SQSClient;
    const consumer = consumerWith(realHandler, dropDelete);

    await consumer.pollOnce(never);
    expect(await balance(wallet)).toBe("90.00");
    const deadline = Date.now() + 10_000;
    while ((await depth(urls.main)).visible + (await depth(urls.main)).inFlight > 0 && Date.now() < deadline) {
      await consumer.pollOnce(never);
    }
    expect(await balance(wallet)).toBe("90.00");
    expect(await depth(urls.main)).toEqual({ visible: 0, inFlight: 0 });
    const [count] = await query("select count(*)::int as n from wallet_ledger_entries where wallet_id = ?", [wallet.id]);
    expect(count).toEqual({ n: 2 });
  }, 30_000);

  test("if the DLQ send fails the message is not deleted and is dead-lettered on a later poll", async () => {
    const wallet = await openWallet();
    await enqueue(wallet.id, messageFor(wallet, "d-1", { kind: "OPENING" }));
    let failOnce = true;
    const flakyDlq = new Proxy(sqs, {
      get(target, property) {
        if (property !== "send") return Reflect.get(target, property);
        return (command: unknown, options?: unknown) => {
          if (command instanceof Send && (command.input as { QueueUrl?: string }).QueueUrl === urls.dlq && failOnce) {
            failOnce = false;
            return Promise.reject(new Error("dlq unavailable"));
          }
          return (target.send as (...args: unknown[]) => unknown)(command, options);
        };
      },
    }) as SQSClient;
    const consumer = consumerWith(realHandler, flakyDlq);

    await consumer.pollOnce(never);
    expect(failOnce).toBe(false);
    expect((await depth(urls.main)).inFlight).toBe(1);
    const dead = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await consumer.pollOnce(never);
        const message = await receiveFrom(urls.dlq, 500);
        if (message) return message;
      }
    })();
    expect(dead?.MessageAttributes?.errorCode?.StringValue).toBe("VALIDATION_ERROR");
  }, 40_000);

  test("a shutdown signal during a batch stops the group before its next message", async () => {
    const wallet = await openWallet();
    for (const id of ["s-1", "s-2"]) await enqueue(wallet.id, messageFor(wallet, id));
    const controller = new AbortController();
    const handled: string[] = [];
    const handler = {
      handle: async (body: string): Promise<Disposition> => {
        handled.push(JSON.parse(body).messageId);
        controller.abort();
        return { action: "ack" };
      },
    };
    expect(await consumerWith(handler).pollOnce(controller.signal)).toBe(2);
    expect(handled).toEqual(["s-1"]);
    expect(await depth(urls.main)).toEqual({ visible: 1, inFlight: 0 });
  });

  test("an aborted signal stops the loop quickly and leaves received messages unstarted", async () => {
    const wallet = await openWallet();
    await enqueue(wallet.id, messageFor(wallet, "a-1"));
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const consumer = consumerWith({ handle: async (body) => (calls.push(body), { action: "ack" }) });
    expect(await consumer.pollOnce(controller.signal).catch(() => -1)).toBe(-1);
    expect(calls).toEqual([]);
    expect(await balance(wallet)).toBe("100.00");
  });

  test("run() returns promptly when aborted during a long poll", async () => {
    const quiet = { ...config, SQS_WAIT_TIME_S: 20 };
    const controller = new AbortController();
    const consumer = consumerWith(realHandler, sqs, quiet);
    const loop = consumer.run(controller.signal);
    await sleep(300);
    const startedAt = Date.now();
    controller.abort();
    await loop;
    expect(Date.now() - startedAt).toBeLessThan(2000);
  }, 20_000);

  test("an app with the consumer role processes queued messages end to end", async () => {
    const wallet = await openWallet();
    const app = await NestFactory.create(
      AppModule.forRoot({ ...config, APP_ROLES: ["api", "consumer"], DB_NAME: db.config.DB_NAME }),
      { logger: false },
    );
    await app.listen(0);
    try {
      await enqueue(wallet.id, messageFor(wallet, "e2e-1"));
      const deadline = Date.now() + 15_000;
      while ((await balance(wallet)) !== "90.00" && Date.now() < deadline) await sleep(100);
      expect(await balance(wallet)).toBe("90.00");
    } finally {
      await app.close();
    }
  }, 30_000);
});
