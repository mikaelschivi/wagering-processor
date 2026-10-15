import type { MikroORM } from "@mikro-orm/postgresql";
import { type OutboxBatch, type OutboxFailure, type OutboxMessage, OutboxStore } from "../../application/ports";
import type { AppConfig } from "../../config";
import { type Exec, inTransaction } from "./transaction";

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

export class PostgresOutboxStore extends OutboxStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: AppConfig,
  ) {
    super();
  }

  withBatch<T>(limit: number, work: (batch: OutboxBatch) => Promise<T>): Promise<T> {
    return inTransaction(
      this.orm,
      this.config,
      async (exec) => {
        const rows = await exec(
          `select id, partition_key, event_type, payload::text as payload, attempts
             from outbox_messages
            where published_at is null and next_attempt_at <= now()
            order by seq
            limit ?
              for update skip locked`,
          [limit],
        );
        const messages: OutboxMessage[] = rows.map((row) => ({
          id: row.id as string,
          partitionKey: row.partition_key as string,
          eventType: row.event_type as string,
          payload: row.payload as string,
          attempts: row.attempts as number,
        }));
        return work({
          messages,
          markPublished: (ids) => markPublished(exec, ids),
          markFailed: (failures) => markFailed(exec, failures),
        });
      },
      { idleInTxMs: this.config.OUTBOX_TX_IDLE_TIMEOUT_MS },
    );
  }
}

async function markPublished(exec: Exec, ids: string[]): Promise<void> {
  await exec(`update outbox_messages set published_at = now() where id in (${placeholders(ids.length)})`, ids);
}

async function markFailed(exec: Exec, failures: OutboxFailure[]): Promise<void> {
  for (const { id, error, retryInMs } of failures) {
    await exec(
      `update outbox_messages
          set attempts = attempts + 1,
              next_attempt_at = now() + make_interval(secs => ?),
              last_error = ?
        where id = ?`,
      [retryInMs / 1000, error, id],
    );
  }
}
