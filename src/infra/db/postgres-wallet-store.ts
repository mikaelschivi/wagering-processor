import { createHash } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletStore } from "../../application/ports";
import type { AppConfig } from "../../config";
import { WalletAlreadyExistsError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { Wallet, type WalletLedgerEntry } from "../../domain/wallet";
import { type Exec, inTransaction } from "./transaction";

const INTERNAL_PROVIDER_ID = "__internal__";
const WALLET_UNIQUE = "ux_wallet_player_currency";

const isoUtc = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`;

function insert(exec: Exec, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return exec(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

export class PostgresWalletStore extends WalletStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async create(wallet: Wallet, openingEntry?: WalletLedgerEntry): Promise<void> {
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
        if (openingEntry) {
          await insert(exec, "wager_transactions", this.openingTransaction(wallet, openingEntry));
          await insert(exec, "wallet_ledger_entries", {
            id: openingEntry.id,
            wallet_id: openingEntry.walletId,
            transaction_id: openingEntry.transactionId,
            direction: openingEntry.direction,
            amount: openingEntry.money.toString(),
            currency: openingEntry.money.currency,
            balance_before: openingEntry.balanceBefore.toString(),
            balance_after: openingEntry.balanceAfter.toString(),
            wallet_version: openingEntry.walletVersion,
            created_at: openingEntry.createdAt,
          });
        }
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

  private async existingWalletId(wallet: Wallet): Promise<string> {
    const [row] = await this.orm.em
      .fork()
      .execute("select id from wallets where player_id = ? and currency = ?", [wallet.playerId, wallet.currency]);
    return row!.id as string;
  }

  private openingTransaction(wallet: Wallet, entry: WalletLedgerEntry) {
    const key = `opening:${wallet.id}`;
    return {
      id: entry.transactionId,
      provider_id: INTERNAL_PROVIDER_ID,
      external_transaction_id: key,
      idempotency_key: key,
      payload_hash: createHash("sha256")
        .update(`OPENING:${wallet.id}:${wallet.playerId}:${entry.money.toString()}:${entry.money.currency}`)
        .digest("hex"),
      wallet_id: wallet.id,
      player_id: wallet.playerId,
      round_id: "opening",
      game_id: "opening",
      kind: "OPENING",
      amount: entry.money.toString(),
      currency: entry.money.currency,
      status: "PROCESSED",
      result_balance: entry.balanceAfter.toString(),
      result_currency: entry.balanceAfter.currency,
      result_wallet_version: entry.walletVersion,
      correlation_id: entry.transactionId,
      created_at: entry.createdAt,
      updated_at: entry.createdAt,
      processed_at: entry.createdAt,
    };
  }
}
