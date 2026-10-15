import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import type { Clock } from "../../application/ports";
import { APP_CONFIG, type AppConfig } from "../../config";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import {
  DomainError,
  ExternalTransactionIdConflictError,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
  InboxPayloadMismatchError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  MoneyOverflowError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../domain/errors";
import { Money } from "../../domain/money";
import { canonicalJson } from "../../domain/wager-transaction";
import { idempotencyKey, wagerFields } from "../http/schemas";

export const CONSUMER_NAME = "wager-consumer";
export const MESSAGE_TYPE = "WagerTransactionRequested";
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type Disposition =
  | { action: "ack" }
  | { action: "dlq"; code: string }
  | { action: "retry"; code: string };

const envelope = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal(MESSAGE_TYPE),
    occurredAt: z.string().datetime(),
    data: z.object({ ...wagerFields, idempotencyKey }).strict(),
  })
  .strict();

class InvalidMessageError extends Error {}

function parse(body: string) {
  if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) throw new InvalidMessageError("message is too large");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError("message is not valid JSON");
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) throw new InvalidMessageError("message does not match the envelope");

  const { messageId, type, data } = parsed.data;
  const { idempotencyKey: key, money, ...fields } = data;
  return {
    messageId,
    idempotencyKey: key,
    request: { ...fields, money: Money.from(money) },
    messageHash: createHash("sha256").update(canonicalJson({ type, data })).digest("hex"),
  };
}

const PERMANENT = [
  IdempotencyKeyConflictError,
  ExternalTransactionIdConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
  ForbiddenProviderError,
];

const INVALID = [InvalidMoneyError, MoneyOverflowError, InvalidWagerTransactionError, InvalidMessageError];

export function classify(error: unknown): Disposition {
  if (INVALID.some((type) => error instanceof type)) return { action: "dlq", code: "VALIDATION_ERROR" };
  if (error instanceof DomainError && PERMANENT.some((type) => error instanceof type)) {
    return { action: "dlq", code: error.code };
  }
  if (error instanceof TransientInfrastructureError) return { action: "retry", code: error.code };
  return { action: "retry", code: "INTERNAL_ERROR" };
}

export class WagerMessageHandler {
  constructor(private readonly processWager: ProcessWagerTransaction) {}

  async handle(body: string): Promise<Disposition> {
    try {
      const message = parse(body);
      await this.processWager.execute({
        request: message.request,
        actor: { kind: "trusted-internal" },
        idempotencyKey: message.idempotencyKey,
        correlationId: message.messageId,
        causationId: message.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: message.messageId, messageHash: message.messageHash },
      });
      return { action: "ack" };
    } catch (error) {
      return classify(error);
    }
  }
}

const RECEIVE_RETRY_PAUSE_MS = 1000;
const RETRY_JITTER_S = 3;
const DLQ_FALLBACK_GROUP = "invalid";

interface Received {
  messageId: string;
  receiptHandle: string;
  body: string;
  groupId: string;
  receiveCount: number;
  receivedAt: number;
}

function toReceived(message: Message, receivedAt: number): Received | undefined {
  if (!message.MessageId || !message.ReceiptHandle) return undefined;
  return {
    messageId: message.MessageId,
    receiptHandle: message.ReceiptHandle,
    body: message.Body ?? "",
    groupId: message.Attributes?.MessageGroupId ?? DLQ_FALLBACK_GROUP,
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
    receivedAt,
  };
}

export class SqsConsumer {
  private urls: { main: string; dlq: string } | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly handler: WagerMessageHandler,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly log: (message: string) => void,
    private readonly random: () => number = Math.random,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.log(`receive failed: ${error instanceof Error ? error.name : "unknown error"}`);
        await this.clock.sleep(RECEIVE_RETRY_PAUSE_MS);
      }
    }
  }

  async pollOnce(signal: AbortSignal): Promise<number> {
    const { main } = await this.queueUrls();
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: main,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.SQS_WAIT_TIME_S,
        VisibilityTimeout: this.config.SQS_VISIBILITY_TIMEOUT_S,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: signal },
    );
    const receivedAt = Date.now();
    const messages = (response.Messages ?? []).flatMap((message) => toReceived(message, receivedAt) ?? []);

    const groups = new Map<string, Received[]>();
    for (const message of messages) groups.set(message.groupId, [...(groups.get(message.groupId) ?? []), message]);
    await this.inParallel([...groups.values()], (group) => this.processGroup(group, signal));
    return messages.length;
  }

  private async inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(this.config.SQS_CONSUMER_CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    });
    await Promise.all(workers);
  }

  private async processGroup(group: Received[], signal: AbortSignal): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (signal.aborted || this.tooOld(message)) {
        await this.release(group.slice(index));
        return;
      }
      const disposition = await this.handler.handle(message.body);
      const proceed = await this.settle(message, disposition);
      if (!proceed) {
        await this.release(group.slice(index + 1));
        return;
      }
    }
  }

  private tooOld(message: Received): boolean {
    const budgetMs = (this.config.SQS_VISIBILITY_TIMEOUT_S - this.config.SQS_VISIBILITY_SAFETY_MARGIN_S) * 1000;
    return Date.now() - message.receivedAt > budgetMs;
  }

  private async settle(message: Received, disposition: Disposition): Promise<boolean> {
    if (disposition.action === "ack") {
      await this.delete(message);
      return true;
    }
    if (disposition.action === "dlq" && (await this.sendToDlq(message, disposition.code))) {
      await this.delete(message);
      return true;
    }
    await this.backOff(message);
    return false;
  }

  private async sendToDlq(message: Received, errorCode: string): Promise<boolean> {
    try {
      const { dlq } = await this.queueUrls();
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: dlq,
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.messageId,
          MessageAttributes: {
            errorCode: { DataType: "String", StringValue: errorCode },
            consumer: { DataType: "String", StringValue: CONSUMER_NAME },
            receiveCount: { DataType: "Number", StringValue: String(message.receiveCount) },
          },
        }),
      );
      return true;
    } catch (error) {
      this.log(`dlq send failed: ${error instanceof Error ? error.name : "unknown error"}`);
      return false;
    }
  }

  private delete(message: Received): Promise<void> {
    return this.attempt("delete", async () => {
      const { main } = await this.queueUrls();
      await this.client.send(new DeleteMessageCommand({ QueueUrl: main, ReceiptHandle: message.receiptHandle }));
    });
  }

  private backOff(message: Received): Promise<void> {
    const delayS =
      Math.min(2 ** message.receiveCount, this.config.SQS_RETRY_BACKOFF_CAP_S) +
      Math.floor(this.random() * RETRY_JITTER_S);
    return this.changeVisibility(message, delayS);
  }

  private async release(messages: Received[]): Promise<void> {
    for (const message of messages) await this.changeVisibility(message, 0);
  }

  private changeVisibility(message: Received, seconds: number): Promise<void> {
    return this.attempt("visibility change", async () => {
      const { main } = await this.queueUrls();
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: main,
          ReceiptHandle: message.receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    });
  }

  private async attempt(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.log(`${what} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }

  private async queueUrls(): Promise<{ main: string; dlq: string }> {
    if (!this.urls) {
      const resolve = async (name: string) => {
        const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
        if (!QueueUrl) throw new Error(`SQS returned no url for queue ${name}`);
        return QueueUrl;
      };
      this.urls = { main: await resolve(this.config.WAGER_QUEUE_NAME), dlq: await resolve(this.config.WAGER_DLQ_NAME) };
    }
    return this.urls;
  }
}

@Injectable()
export class ConsumerRunner implements OnApplicationBootstrap {
  private readonly stopSignal = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumer: SqsConsumer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.APP_ROLES.includes("consumer")) this.loop = this.consumer.run(this.stopSignal.signal);
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.loop;
  }
}

export const consumerLogger = (): ((message: string) => void) => {
  const logger = new Logger(SqsConsumer.name);
  return (message) => logger.error(message);
};
