import type { MikroORM, SqlEntityManager } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../config";

export type Exec = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export function inTransaction<T>(orm: MikroORM, config: AppConfig, work: (exec: Exec) => Promise<T>): Promise<T> {
  return orm.em.fork().transactional(async (em) => {
    const exec: Exec = (sql, params) => (em as SqlEntityManager).execute(sql, params);
    await exec(
      `select set_config('lock_timeout', ?, true),
              set_config('statement_timeout', ?, true),
              set_config('idle_in_transaction_session_timeout', ?, true)`,
      [
        `${config.TX_LOCK_TIMEOUT_MS}ms`,
        `${config.TX_STATEMENT_TIMEOUT_MS}ms`,
        `${config.TX_IDLE_IN_TX_TIMEOUT_MS}ms`,
      ],
    );
    return work(exec);
  });
}
