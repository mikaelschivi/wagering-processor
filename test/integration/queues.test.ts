import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/config";
import { createSqsClient } from "../../src/infra/sqs/client";
import { createQueues, type QueueUrls } from "../../src/infra/sqs/queues";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const suffix = crypto.randomUUID().slice(0, 8);
const names = {
  main: `test-${suffix}.fifo`,
  dlq: `test-${suffix}-dlq.fifo`,
  events: `test-${suffix}-events.fifo`,
};
const settings = { visibilityTimeoutS: 1, maxReceiveCount: 2 };

let client: SQSClient;
let urls: QueueUrls;

beforeAll(async () => {
  client = createSqsClient(
    loadConfig({ DB_APP_PASSWORD: "unused", AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566" }),
  );
  urls = await createQueues(client, names, settings);
});

afterAll(async () => {
  for (const QueueUrl of Object.values(urls)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
});

async function waitFor<T>(attempt: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== undefined) return result;
  }
  throw new Error("condition not met in time");
}

async function receive(queueUrl: string) {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      WaitTimeSeconds: 1,
      MaxNumberOfMessages: 1,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return Messages?.[0];
}

test("creating the queues twice returns the same urls", async () => {
  expect(await createQueues(client, names, settings)).toEqual(urls);
});

test("the main queue is FIFO with a redrive policy to the dlq", async () => {
  const [main, dlq] = await Promise.all(
    [urls.main, urls.dlq].map((QueueUrl) =>
      client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] })),
    ),
  );
  const redrive = JSON.parse(main!.Attributes!.RedrivePolicy!);
  expect(main!.Attributes!.FifoQueue).toBe("true");
  expect(main!.Attributes!.VisibilityTimeout).toBe("1");
  expect(redrive.maxReceiveCount).toBe(2);
  expect(redrive.deadLetterTargetArn).toBe(dlq!.Attributes!.QueueArn);
  expect(dlq!.Attributes!.FifoQueue).toBe("true");
});

test("a message that is never deleted moves to the dlq after maxReceiveCount", async () => {
  await client.send(
    new SendMessageCommand({
      QueueUrl: urls.main,
      MessageBody: JSON.stringify({ poison: true }),
      MessageGroupId: "wallet-1",
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );

  const counts: number[] = [];
  await waitFor(async () => {
    const message = await receive(urls.main);
    if (message) counts.push(Number(message.Attributes!.ApproximateReceiveCount));
    return counts.length >= 2 ? true : undefined;
  }, 20_000);
  expect(counts).toEqual([1, 2]);

  const dead = await waitFor(async () => {
    expect(await receive(urls.main)).toBeUndefined();
    return receive(urls.dlq);
  }, 20_000);
  expect(JSON.parse(dead.Body!)).toEqual({ poison: true });
}, 60_000);
