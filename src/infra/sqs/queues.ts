import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

const DAY_S = 24 * 60 * 60;

export interface QueueNames {
  main: string;
  dlq: string;
  events: string;
}

export interface QueueSettings {
  visibilityTimeoutS: number;
  maxReceiveCount: number;
}

export type QueueUrls = QueueNames;

async function createFifoQueue(client: SQSClient, name: string, attributes: Record<string, string>) {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes },
    }),
  );
  if (!QueueUrl) throw new Error(`SQS returned no url for queue ${name}`);
  return QueueUrl;
}

async function queueArn(client: SQSClient, queueUrl: string) {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`SQS returned no arn for ${queueUrl}`);
  return arn;
}

export async function createQueues(client: SQSClient, names: QueueNames, settings: QueueSettings): Promise<QueueUrls> {
  const dlq = await createFifoQueue(client, names.dlq, { MessageRetentionPeriod: String(14 * DAY_S) });
  const main = await createFifoQueue(client, names.main, {
    VisibilityTimeout: String(settings.visibilityTimeoutS),
    MessageRetentionPeriod: String(4 * DAY_S),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: await queueArn(client, dlq),
      maxReceiveCount: settings.maxReceiveCount,
    }),
  });
  const events = await createFifoQueue(client, names.events, { MessageRetentionPeriod: String(4 * DAY_S) });
  return { main, dlq, events };
}

export interface RedriveOptions {
  max?: number;
  waitTimeS?: number;
}

export async function redriveDlq(
  client: SQSClient,
  urls: Pick<QueueUrls, "main" | "dlq">,
  { max = Number.POSITIVE_INFINITY, waitTimeS = 1 }: RedriveOptions = {},
): Promise<number> {
  let moved = 0;
  while (moved < max) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.dlq,
        MaxNumberOfMessages: Math.min(10, max - moved),
        WaitTimeSeconds: waitTimeS,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    if (!Messages?.length) break;
    for (const message of Messages) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: urls.main,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "redrive",
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
      await client.send(new DeleteMessageCommand({ QueueUrl: urls.dlq, ReceiptHandle: message.ReceiptHandle }));
      moved++;
    }
  }
  return moved;
}
