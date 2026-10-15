import { expect } from "bun:test";
import type { TestDatabase } from "./db";

type Row = Record<string, unknown>;

export async function walletsOutOfBalance(db: TestDatabase): Promise<Row[]> {
  return db.owner.em.fork().execute(
    `select w.id, w.balance, coalesce(l.total, 0.00) as ledger_total
       from wallets w
       left join (
         select wallet_id, sum(case when direction = 'CREDIT' then amount else -amount end) as total
           from wallet_ledger_entries group by wallet_id
       ) l on l.wallet_id = w.id
      where w.balance <> coalesce(l.total, 0.00)`,
  );
}

export async function assertAllWalletsConsistent(db: TestDatabase): Promise<void> {
  expect(await walletsOutOfBalance(db)).toEqual([]);
  const [negative] = await db.owner.em.fork().execute("select count(*)::int as n from wallets where balance < 0");
  expect(negative).toEqual({ n: 0 });
}

export async function count(db: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.owner.em.fork().execute(`select count(*)::int as n from (${sql}) q`, params);
  return (row as { n: number }).n;
}
