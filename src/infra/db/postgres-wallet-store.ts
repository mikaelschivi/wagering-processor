import type { MikroORM } from "@mikro-orm/postgresql";
import { IsolationLevel } from "@mikro-orm/core";
import {
  type DomainEvent,
  type LedgerPageQuery,
  type OpeningRecord,
  type ReconciliationSnapshot,
  WalletStore,
} from "../../application/ports";
import type { AppConfig } from "../../config";
import { WalletAlreadyExistsError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { type LedgerDirection, Wallet, WalletLedgerEntry } from "../../domain/wallet";
import { ledgerRow, transactionRow, writeEvents } from "./postgres-wager-store";
import { inTransaction, insert, isoUtc } from "./transaction";

const WALLET_UNIQUE = "ux_wallet_player_currency";

export class PostgresWalletStore extends WalletStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async create(wallet: Wallet, opening?: OpeningRecord, events?: DomainEvent[]): Promise<void> {
    try {
      await inTransaction(this.orm, this.config, async (exec) => {
        await insert(exec, "wallets", {
          id: wallet.id,
          player_id: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          created_at: wallet.createdAt,
          updated_at: wallet.updatedAt,
        });
        if (opening) {
          await insert(exec, "wager_transactions", transactionRow(opening.transaction));
          await insert(exec, "wallet_ledger_entries", ledgerRow(opening.entry));
        }
        await writeEvents(exec, events);
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === WALLET_UNIQUE) {
        throw new WalletAlreadyExistsError(await this.existingWalletId(wallet));
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const [row] = await this.orm.em
      .fork()
      .execute(
        `select id, player_id, currency, balance, version, ${isoUtc("created_at")}, ${isoUtc("updated_at")}
           from wallets where id = ?`,
        [id],
      );
    if (!row) return undefined;
    return Wallet.rehydrate({
      id: row.id as string,
      playerId: row.player_id as string,
      currency: row.currency as string,
      balance: Money.fromDb(row.balance as string, row.currency as string),
      version: row.version as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    return inTransaction(
      this.orm,
      this.config,
      async (exec) => {
        const [row] = await exec(
          `select id, player_id, currency, balance, version, ${isoUtc("created_at")}, ${isoUtc("updated_at")}
             from wallets where id = ?`,
          [walletId],
        );
        if (!row) return undefined;
        const currency = row.currency as string;
        const [totals] = await exec(
          `select count(*) as entries, max(wallet_version) as max_version,
                  coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0.00) as calculated
             from wallet_ledger_entries where wallet_id = ?`,
          [walletId],
        );
        const [tail] = await exec(
          "select balance_after from wallet_ledger_entries where wallet_id = ? order by wallet_version desc limit 1",
          [walletId],
        );
        const maxVersion = totals!.max_version as number | null;
        return {
          wallet: Wallet.rehydrate({
            id: row.id as string,
            playerId: row.player_id as string,
            currency,
            balance: Money.fromDb(row.balance as string, currency),
            version: row.version as number,
            createdAt: new Date(row.created_at as string),
            updatedAt: new Date(row.updated_at as string),
          }),
          calculated: Money.fromDb(totals!.calculated as string, currency),
          entryCount: Number(totals!.entries),
          ...(maxVersion !== null && { maxVersion }),
          ...(tail && { tailBalance: Money.fromDb(tail.balance_after as string, currency) }),
        };
      },
      undefined,
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }

  async ledgerPage(walletId: string, { beforeVersion, limit }: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const rows = await this.orm.em.fork().execute(
      `select id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
              wallet_version, ${isoUtc("created_at")}
         from wallet_ledger_entries
        where wallet_id = ? and (?::int is null or wallet_version < ?::int)
        order by wallet_version desc
        limit ?`,
      [walletId, beforeVersion ?? null, beforeVersion ?? null, limit],
    );
    return rows.map((row) => {
      const currency = row.currency as string;
      return WalletLedgerEntry.rehydrate({
        id: row.id as string,
        walletId: row.wallet_id as string,
        transactionId: row.transaction_id as string,
        direction: row.direction as LedgerDirection,
        money: Money.fromDb(row.amount as string, currency),
        balanceBefore: Money.fromDb(row.balance_before as string, currency),
        balanceAfter: Money.fromDb(row.balance_after as string, currency),
        walletVersion: row.wallet_version as number,
        createdAt: new Date(row.created_at as string),
      });
    });
  }

  private async existingWalletId(wallet: Wallet): Promise<string> {
    const [row] = await this.orm.em
      .fork()
      .execute("select id from wallets where player_id = ? and currency = ?", [wallet.playerId, wallet.currency]);
    return row!.id as string;
  }
}
