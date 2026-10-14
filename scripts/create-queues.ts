import { loadConfig } from "../src/config";
import { createSqsClient } from "../src/infra/sqs/client";
import { createQueues } from "../src/infra/sqs/queues";

const config = loadConfig(process.env);
const client = createSqsClient(config);

const urls = await createQueues(
  client,
  { main: config.WAGER_QUEUE_NAME, dlq: config.WAGER_DLQ_NAME, events: config.EVENTS_QUEUE_NAME },
  { visibilityTimeoutS: config.SQS_VISIBILITY_TIMEOUT_S, maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT },
);

console.log(JSON.stringify(urls, null, 2));
client.destroy();
