import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import type { AppConfig } from "../../src/config";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { PostgresWalletStore } from "../../src/infra/db/postgres-wallet-store";
import { SqsConsumer, WagerMessageHandler } from "../../src/infra/sqs/consumer";
import { createQueues, type QueueUrls } from "../../src/infra/sqs/queues";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { openingRecord } from "../helpers/fakes";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

let db: TestDatabase;
let config: AppConfig;
let sqs: SQSClient;
let urls: QueueUrls;

beforeAll(async () => {
  db = await createTestDatabase();
  const id = crypto.randomUUID().slice(0, 8);
  config = {
    ...db.config,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    WAGER_QUEUE_NAME: `crash-${id}.fifo`,
    WAGER_DLQ_NAME: `crash-${id}-dlq.fifo`,
    EVENTS_QUEUE_NAME: `crash-${id}-events.fifo`,
    SQS_VISIBILITY_TIMEOUT_S: 3,
    SQS_VISIBILITY_SAFETY_MARGIN_S: 1,
    SQS_WAIT_TIME_S: 1,
  };
  sqs = new SQSClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL, maxAttempts: 1 });
  urls = await createQueues(
    sqs,
    { main: config.WAGER_QUEUE_NAME, dlq: config.WAGER_DLQ_NAME, events: config.EVENTS_QUEUE_NAME },
    { visibilityTimeoutS: 3, maxReceiveCount: 5 },
  );
}, 60_000);

afterAll(async () => {
  for (const QueueUrl of Object.values(urls ?? {})) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
  sqs.destroy();
  await db.drop();
});

const query = (sql: string, params?: unknown[]) => db.owner.em.fork().execute(sql, params);

async function depth() {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.main, AttributeNames: ["All"] }));
  return {
    visible: Number(Attributes!.ApproximateNumberOfMessages),
    inFlight: Number(Attributes!.ApproximateNumberOfMessagesNotVisible),
  };
}

describe("a consumer process killed after the commit and before the ack", () => {
  test("the redelivery is absorbed by the inbox: one debit, one inbox row, one set of events", async () => {
    const { wallet, openingEntry } = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingEntryId: crypto.randomUUID(),
      at: new Date(),
    });
    await new PostgresWalletStore(db.app, db.config).create(wallet, openingRecord(wallet, openingEntry));
    const messageId = "crash-1";
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: urls.main,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: "2026-07-29T15:00:00.000Z",
          data: {
            providerId: "provider-a",
            externalTransactionId: "ext-crash",
            idempotencyKey: "provider-a:ext-crash",
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        }),
      }),
    );

    const child = Bun.spawn(["bun", "test/helpers/crash-consumer.ts"], {
      env: {
        ...process.env,
        DB_NAME: config.DB_NAME,
        WAGER_QUEUE_NAME: config.WAGER_QUEUE_NAME,
        WAGER_DLQ_NAME: config.WAGER_DLQ_NAME,
        AWS_ENDPOINT_URL: config.AWS_ENDPOINT_URL,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");

    const balance = async () => ((await query("select balance from wallets where id = ?", [wallet.id]))[0] as { balance: string }).balance;
    expect(await balance()).toBe("90.00");
    expect(await depth()).toEqual({ visible: 0, inFlight: 1 });

    const survivor = new SqsConsumer(
      sqs,
      new WagerMessageHandler(
        new ProcessWagerTransaction(new PostgresWagerStore(db.app, db.config), new UuidV7Generator(), new SystemClock(), {
          maxAttempts: 3,
          deadlineMs: 5000,
          jitterMinMs: 5,
          jitterMaxMs: 25,
          random: Math.random,
        }),
      ),
      config,
      new SystemClock(),
      () => {},
    );
    const deadline = Date.now() + 15_000;
    let redelivered = 0;
    while (redelivered === 0 && Date.now() < deadline) redelivered = await survivor.pollOnce(new AbortController().signal);

    expect(redelivered).toBe(1);
    expect(await balance()).toBe("90.00");
    expect(await depth()).toEqual({ visible: 0, inFlight: 0 });
    expect(await query("select count(*)::int as n from wallet_ledger_entries where wallet_id = ?", [wallet.id])).toEqual([{ n: 2 }]);
    expect(await query("select count(*)::int as n from inbox_messages where message_id = ?", [messageId])).toEqual([{ n: 1 }]);
    expect(await query("select count(*)::int as n from outbox_messages where partition_key = ?", [wallet.id])).toEqual([{ n: 2 }]);
  }, 60_000);
});
