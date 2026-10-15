import type { MikroORM, SqlEntityManager } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../config";

export type Exec = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export const isoUtc = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`;

export function insert(exec: Exec, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return exec(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

export function inTransaction<T>(
  orm: MikroORM,
  config: AppConfig,
  work: (exec: Exec) => Promise<T>,
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<T> {
  const within = (limitMs: number) => Math.max(1, Math.min(limitMs, Math.floor(budgetMs)));
  return orm.em.fork().transactional(async (em) => {
    const exec: Exec = (sql, params) => (em as SqlEntityManager).execute(sql, params);
    await exec(
      `select set_config('lock_timeout', ?, true),
              set_config('statement_timeout', ?, true),
              set_config('idle_in_transaction_session_timeout', ?, true)`,
      [
        `${within(config.TX_LOCK_TIMEOUT_MS)}ms`,
        `${within(config.TX_STATEMENT_TIMEOUT_MS)}ms`,
        `${config.TX_IDLE_IN_TX_TIMEOUT_MS}ms`,
      ],
    );
    return work(exec);
  });
}
