import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    maxAttempts: 1,
    useQueueUrlAsEndpoint: false,
  });
}

export function queueReachable(client: SQSClient, queueName: string) {
  let queueUrl: string | undefined;
  return async (signal: AbortSignal) => {
    queueUrl ??= (await client.send(new GetQueueUrlCommand({ QueueName: queueName }), { abortSignal: signal })).QueueUrl;
    await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }), {
      abortSignal: signal,
    });
  };
}
