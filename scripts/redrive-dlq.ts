import { loadConfig } from "../src/config";
import { createSqsClient } from "../src/infra/sqs/client";
import { redriveDlq } from "../src/infra/sqs/queues";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";

const max = process.argv[2] ? Number(process.argv[2]) : undefined;
if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
  console.error("usage: bun scripts/redrive-dlq.ts [maxMessages]");
  process.exit(1);
}

const config = loadConfig(process.env);
const client = createSqsClient(config);
const url = async (name: string) => (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;

const moved = await redriveDlq(client, { main: await url(config.WAGER_QUEUE_NAME), dlq: await url(config.WAGER_DLQ_NAME) }, max ? { max } : {});
console.log(`moved ${moved} message(s) from ${config.WAGER_DLQ_NAME} to ${config.WAGER_QUEUE_NAME}`);
client.destroy();
