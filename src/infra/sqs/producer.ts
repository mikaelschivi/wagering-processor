import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EventSender, type OutboxMessage, type SendFailure } from "../../application/ports";
import type { AppConfig } from "../../config";
import { OUTBOX_SEND_MARGIN_MS } from "../../globals";

export const SQS_PRODUCER_CLIENT = Symbol("SQS_PRODUCER_CLIENT");

const SQS_BATCH_LIMIT = 10;
const CONNECTION_TIMEOUT_MS = 1000;

export function createProducerClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    maxAttempts: 1,
    useQueueUrlAsEndpoint: false,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: config.OUTBOX_SQS_REQUEST_TIMEOUT_MS },
  });
}

export class SqsEventSender extends EventSender {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  static forConfig(client: SQSClient, config: AppConfig): SqsEventSender {
    return new SqsEventSender(client, config.EVENTS_QUEUE_NAME, config.OUTBOX_SQS_REQUEST_TIMEOUT_MS + OUTBOX_SEND_MARGIN_MS);
  }

  async send(messages: OutboxMessage[]): Promise<SendFailure[]> {
    const abortSignal = AbortSignal.timeout(this.timeoutMs);
    const queueUrl = await this.resolveQueue(abortSignal);
    const failures: SendFailure[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      failures.push(...(await this.sendChunk(queueUrl, messages.slice(start, start + SQS_BATCH_LIMIT), abortSignal)));
    }
    return failures;
  }

  private async resolveQueue(abortSignal: AbortSignal): Promise<string> {
    if (!this.queueUrl) {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
        abortSignal,
      });
      if (!QueueUrl) throw new Error(`SQS returned no url for queue ${this.queueName}`);
      this.queueUrl = QueueUrl;
    }
    return this.queueUrl;
  }

  private async sendChunk(queueUrl: string, chunk: OutboxMessage[], abortSignal: AbortSignal): Promise<SendFailure[]> {
    const result = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((message, index) => ({
          Id: String(index),
          MessageBody: message.payload,
          MessageGroupId: message.partitionKey,
          MessageDeduplicationId: message.id,
        })),
      }),
      { abortSignal },
    );
    const accepted = new Set(result.Successful?.map((entry) => entry.Id));
    const reasons = new Map(result.Failed?.map((entry) => [entry.Id, entry.Code ?? "SendFailed"]));
    return chunk.flatMap((message, index) =>
      accepted.has(String(index)) ? [] : [{ id: message.id, error: reasons.get(String(index)) ?? "MissingResult" }],
    );
  }
}
