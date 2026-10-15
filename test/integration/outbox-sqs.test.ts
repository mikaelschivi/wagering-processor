import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import type { OutboxMessage } from "../../src/application/ports";
import { type AppConfig } from "../../src/config";
import { createProducerClient, SqsEventSender } from "../../src/infra/sqs/producer";
import { createQueues, type QueueUrls } from "../../src/infra/sqs/queues";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const suffix = crypto.randomUUID().slice(0, 8);
let db: TestDatabase;
let config: AppConfig;
let app: INestApplication;
let baseUrl: string;
let client: SQSClient;
let urls: QueueUrls;

beforeAll(async () => {
  db = await createTestDatabase();
  config = {
    ...db.config,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    WAGER_QUEUE_NAME: `ob-${suffix}.fifo`,
    WAGER_DLQ_NAME: `ob-${suffix}-dlq.fifo`,
    EVENTS_QUEUE_NAME: `ob-${suffix}-events.fifo`,
    APP_ROLES: ["api", "outbox"],
    OUTBOX_INTERVAL_MS: 50,
  };
  client = new SQSClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL, maxAttempts: 1 });
  urls = await createQueues(
    client,
    { main: config.WAGER_QUEUE_NAME, dlq: config.WAGER_DLQ_NAME, events: config.EVENTS_QUEUE_NAME },
    { visibilityTimeoutS: 30, maxReceiveCount: 5 },
  );
  app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const QueueUrl of Object.values(urls ?? {})) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
  await db.drop();
});

const json = { "content-type": "application/json" };
const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

async function receive(count: number, timeoutMs = 15_000): Promise<Message[]> {
  const received: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.events,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
      }),
    );
    received.push(...(Messages ?? []));
  }
  return received;
}

async function waitUntilPublished(walletId: string, expected: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await query(
      "select count(*) filter (where published_at is not null)::int as done from outbox_messages where partition_key = ?",
      [walletId],
    );
    if ((row as { done: number }).done >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("events were not published in time");
}

describe("outbox publishing to SQS", () => {
  test("a wallet and a bet over HTTP end up as four ordered events on the queue", async () => {
    const playerId = crypto.randomUUID();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
    });
    const { id: walletId } = (await created.json()) as { id: string };
    const bet = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { ...json, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: crypto.randomUUID(),
        playerId,
        walletId,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      }),
    });
    expect(bet.status).toBe(200);

    const messages = await receive(4);
    expect(messages).toHaveLength(4);
    const bodies = messages.map((message) => JSON.parse(message.Body!));
    expect(bodies.map((body) => body.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const [index, message] of messages.entries()) {
      expect(message.Attributes?.MessageGroupId).toBe(walletId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(bodies[index].eventId);
    }
    expect(bodies[3].data).toMatchObject({ walletId, walletVersion: 2, direction: "DEBIT" });
    await waitUntilPublished(walletId, 4);
  });

  test("sending the same event id twice delivers it once", async () => {
    const sender = SqsEventSender.forConfig(createProducerClient(config), config);
    const message: OutboxMessage = {
      id: crypto.randomUUID(),
      partitionKey: crypto.randomUUID(),
      eventType: "WalletBalanceChanged",
      payload: JSON.stringify({ eventId: "dup" }),
      attempts: 0,
    };
    expect(await sender.send([message])).toEqual([]);
    expect(await sender.send([message])).toEqual([]);
    const received = (await receive(2, 3000)).filter((item) => JSON.parse(item.Body!).eventId === "dup");
    expect(received).toHaveLength(1);
  });

  test("a missing queue makes the send throw so the publisher can back off", async () => {
    const sender = new SqsEventSender(createProducerClient(config), `missing-${suffix}.fifo`, 3500);
    await expect(
      sender.send([{ id: crypto.randomUUID(), partitionKey: crypto.randomUUID(), eventType: "X", payload: "{}", attempts: 0 }]),
    ).rejects.toBeDefined();
  });

  test("an unreachable endpoint fails within the send timeout", async () => {
    const dead = { ...config, AWS_ENDPOINT_URL: "http://127.0.0.1:1" };
    const sender = SqsEventSender.forConfig(createProducerClient(dead), dead);
    const startedAt = Date.now();
    await expect(
      sender.send([{ id: crypto.randomUUID(), partitionKey: crypto.randomUUID(), eventType: "X", payload: "{}", attempts: 0 }]),
    ).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(config.OUTBOX_SQS_REQUEST_TIMEOUT_MS + 1000);
  });

  test("a publisher that cannot reach the queue leaves the event pending with a backoff", async () => {
    const dead = { ...db.config, AWS_ENDPOINT_URL: "http://127.0.0.1:1", APP_ROLES: ["api" as const, "outbox" as const], OUTBOX_INTERVAL_MS: 50 };
    const other = await createTestDatabase();
    const failing = await NestFactory.create(AppModule.forRoot({ ...dead, DB_NAME: other.config.DB_NAME }), { logger: false });
    await failing.listen(0);
    try {
      const url = await failing.getUrl();
      const playerId = crypto.randomUUID();
      const response = await fetch(`${url}/wallets`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ playerId, initialBalance: { amount: "5.00", currency: "BRL" } }),
      });
      const { id } = (await response.json()) as { id: string };
      await new Promise((resolve) => setTimeout(resolve, 800));
      const rows = await other.owner.em
        .fork()
        .execute("select attempts, last_error, published_at from outbox_messages where partition_key = ?", [id]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ published_at: null });
        expect((row as { attempts: number }).attempts).toBeGreaterThanOrEqual(1);
        expect(String((row as { last_error: string }).last_error).length).toBeGreaterThan(0);
      }
    } finally {
      await failing.close();
      await other.drop();
    }
  }, 30_000);

  test("an instance without the outbox role never publishes", async () => {
    const other = await createTestDatabase();
    const apiOnly = await NestFactory.create(
      AppModule.forRoot({ ...config, DB_NAME: other.config.DB_NAME, APP_ROLES: ["api"] }),
      { logger: false },
    );
    await apiOnly.listen(0);
    try {
      await fetch(`${await apiOnly.getUrl()}/wallets`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: "5.00", currency: "BRL" } }),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const [row] = await other.owner.em.fork().execute("select count(*)::int as pending from outbox_messages where published_at is null");
      expect(row).toEqual({ pending: 2 });
    } finally {
      await apiOnly.close();
      await other.drop();
    }
  }, 30_000);

  test("after shutdown the runner no longer publishes", async () => {
    const other = await createTestDatabase();
    const local = await NestFactory.create(AppModule.forRoot({ ...config, DB_NAME: other.config.DB_NAME }), {
      logger: false,
    });
    await local.listen(0);
    await local.close();
    await other.app.em.fork().execute(
      `insert into outbox_messages (id, aggregate_id, partition_key, event_type, event_version, payload, occurred_at, next_attempt_at)
       values (?, ?, ?, 'X', 1, '{}', now(), now())`,
      [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [row] = await other.owner.em.fork().execute("select count(*)::int as pending from outbox_messages where published_at is null");
    expect(row).toEqual({ pending: 1 });
    await other.drop();
  }, 30_000);
});
