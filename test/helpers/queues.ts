import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../src/config";
import { createQueues, type QueueUrls } from "../../src/infra/sqs/queues";
import type { WalletRef } from "./client";

export interface TestQueues {
  config: AppConfig;
  client: SQSClient;
  urls: QueueUrls;
}

export async function createQueuesFor(
  base: AppConfig,
  label: string,
  settings = { visibilityTimeoutS: 30, maxReceiveCount: 5 },
): Promise<TestQueues> {
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  const id = crypto.randomUUID().slice(0, 8);
  const config: AppConfig = {
    ...base,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    WAGER_QUEUE_NAME: `${label}-${id}.fifo`,
    WAGER_DLQ_NAME: `${label}-${id}-dlq.fifo`,
    EVENTS_QUEUE_NAME: `${label}-${id}-events.fifo`,
  };
  const client = new SQSClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL, maxAttempts: 1 });
  const urls = await createQueues(
    client,
    { main: config.WAGER_QUEUE_NAME, dlq: config.WAGER_DLQ_NAME, events: config.EVENTS_QUEUE_NAME },
    settings,
  );
  return { config, client, urls };
}

export async function deleteQueues({ client, urls }: TestQueues): Promise<void> {
  for (const QueueUrl of Object.values(urls)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
}

export async function sendWagerMessage(
  { client, urls }: TestQueues,
  wallet: WalletRef,
  messageId: string,
  amount = "5.00",
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: urls.main,
      MessageGroupId: wallet.walletId,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-a",
          externalTransactionId: `ext-${messageId}`,
          idempotencyKey: `provider-a:ext-${messageId}`,
          playerId: wallet.playerId,
          walletId: wallet.walletId,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: { amount, currency: "BRL" },
        },
      }),
    }),
  );
}

export async function queueDepth({ client }: TestQueues, QueueUrl: string) {
  const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }));
  return {
    visible: Number(Attributes!.ApproximateNumberOfMessages),
    inFlight: Number(Attributes!.ApproximateNumberOfMessagesNotVisible),
  };
}

export async function drainEvents({ client, urls }: TestQueues, expected: number, timeoutMs = 30_000): Promise<string[]> {
  const bodies: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (bodies.length < expected && Date.now() < deadline) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({ QueueUrl: urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 120 }),
    );
    for (const message of Messages ?? []) {
      bodies.push(message.Body ?? "");
      await client.send(new DeleteMessageCommand({ QueueUrl: urls.events, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return bodies;
}
