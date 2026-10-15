import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { loadConfig } from "../../src/config";
import { createOrm } from "../../src/infra/db/mikro-orm.config";
import { PostgresWagerStore } from "../../src/infra/db/postgres-wager-store";
import { createSqsClient } from "../../src/infra/sqs/client";
import { SqsConsumer, WagerMessageHandler } from "../../src/infra/sqs/consumer";
import { SystemClock, UuidV7Generator } from "../../src/infra/system";

const config = {
  ...loadConfig(process.env),
  SQS_VISIBILITY_TIMEOUT_S: 3,
  SQS_VISIBILITY_SAFETY_MARGIN_S: 1,
  SQS_WAIT_TIME_S: 1,
};

const useCase = new ProcessWagerTransaction(
  new PostgresWagerStore(createOrm(config), config),
  new UuidV7Generator(),
  new SystemClock(),
  { maxAttempts: 3, deadlineMs: 5000, jitterMinMs: 5, jitterMaxMs: 25, random: Math.random },
);
const real = new WagerMessageHandler(useCase);

const diesAfterCommit = {
  handle: async (body: string) => {
    const disposition = await real.handle(body);
    process.kill(process.pid, "SIGKILL");
    return disposition;
  },
};

const consumer = new SqsConsumer(createSqsClient(config), diesAfterCommit as WagerMessageHandler, config, new SystemClock(), console.error);
await consumer.pollOnce(new AbortController().signal);
console.log("the process survived, which it must not");
process.exit(3);
