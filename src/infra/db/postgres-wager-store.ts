import type { MikroORM } from "@mikro-orm/postgresql";
import {
  type DomainEvent,
  InvariantDbError,
  type LockOptions,
  TransientDbError,
  UniqueRaceError,
  UnknownCommitOutcomeError,
  type WagerChange,
  WagerStore,
  type WagerStoreTx,
} from "../../application/ports";
import type { AppConfig } from "../../config";
import { DomainError, type FailureCode } from "../../domain/errors";
import { Money } from "../../domain/money";
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet, type WalletLedgerEntry } from "../../domain/wallet";
import { REFERENCE_FIRST_ATTEMPT_DELAY_MS } from "../../globals";
import { type Exec, inTransaction, insert, isoUtc } from "./transaction";

const RACE_CONSTRAINTS = new Set(["ux_tx_provider_idem", "ux_tx_provider_external"]);
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014", "25P03", "53200", "53300", "53400"]);
const CONNECTION_SQLSTATE = /^(08|57P0[123])/;
const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const CONNECTION_MESSAGE = /timeout acquiring a connection|connection terminated|connection timeout/i;

const isPortError = (error: unknown) =>
  error instanceof TransientDbError ||
  error instanceof UniqueRaceError ||
  error instanceof UnknownCommitOutcomeError ||
  error instanceof InvariantDbError;

export function translateDbError(error: unknown, committing: boolean): unknown {
  if (error instanceof DomainError || isPortError(error)) return error;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  const sqlstate = typeof code === "string" ? code : "";
  const message = error instanceof Error ? error.message : "";
  const cause = { cause: error };

  if (CONNECTION_SQLSTATE.test(sqlstate) || CONNECTION_CODES.has(sqlstate) || CONNECTION_MESSAGE.test(message)) {
    return committing ? new UnknownCommitOutcomeError(cause) : new TransientDbError("connection", cause);
  }
  if (TRANSIENT_SQLSTATES.has(sqlstate)) return new TransientDbError(sqlstate, cause);
  if (sqlstate === "23505" && typeof constraint === "string" && RACE_CONSTRAINTS.has(constraint)) {
    return new UniqueRaceError(constraint);
  }
  if (sqlstate === "WG001" || sqlstate.startsWith("23")) {
    return new InvariantDbError(sqlstate, typeof constraint === "string" ? constraint : undefined, cause);
  }
  return error;
}

const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, result_balance, result_currency, result_wallet_version,
  correlation_id, ${isoUtc("created_at")}, ${isoUtc("processed_at")}`;

const WALLET_COLUMNS = `id, player_id, currency, balance, version, ${isoUtc("created_at")}, ${isoUtc("updated_at")}`;

const text = (value: unknown) => (value === null || value === undefined ? undefined : (value as string));

function toTransaction(row: Record<string, unknown>): WagerTransaction {
  const currency = row.currency as string;
  const reference = text(row.reference_external_transaction_id);
  const referenceId = text(row.reference_transaction_id);
  const failureCode = text(row.failure_code);
  const processedAt = text(row.processed_at);
  return WagerTransaction.rehydrate({
    id: row.id as string,
    providerId: row.provider_id as string,
    externalTransactionId: row.external_transaction_id as string,
    idempotencyKey: row.idempotency_key as string,
    payloadHash: row.payload_hash as string,
    walletId: row.wallet_id as string,
    playerId: row.player_id as string,
    roundId: row.round_id as string,
    gameId: row.game_id as string,
    kind: row.kind as WagerTransactionKind,
    money: Money.fromDb(row.amount as string, currency),
    ...(reference && { referenceExternalTransactionId: reference }),
    correlationId: row.correlation_id as string,
    createdAt: new Date(row.created_at as string),
    status: row.status as WagerTransactionStatus,
    ...(referenceId && { referenceTransactionId: referenceId }),
    ...(failureCode && { failureCode: failureCode as FailureCode }),
    ...(row.result_balance !== null && {
      result: {
        balance: Money.fromDb(row.result_balance as string, row.result_currency as string),
        walletVersion: row.result_wallet_version as number,
      },
    }),
    ...(processedAt && { processedAt: new Date(processedAt) }),
  });
}

function toWallet(row: Record<string, unknown>): Wallet {
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

async function findOne(exec: Exec, column: string, providerId: string, value: string) {
  const [row] = await exec(
    `select ${TRANSACTION_COLUMNS} from wager_transactions where provider_id = ? and ${column} = ?`,
    [providerId, value],
  );
  return row && toTransaction(row);
}

async function findInternalId(exec: Exec, id: string) {
  const [row] = await exec(`select ${TRANSACTION_COLUMNS} from wager_transactions where id = ?`, [id]);
  return row && toTransaction(row);
}

export function transactionRow(transaction: WagerTransaction) {
  const status = transaction.status;
  return {
    id: transaction.id,
    provider_id: transaction.providerId,
    external_transaction_id: transaction.externalTransactionId,
    idempotency_key: transaction.idempotencyKey,
    payload_hash: transaction.payloadHash,
    wallet_id: transaction.walletId,
    player_id: transaction.playerId,
    round_id: transaction.roundId,
    game_id: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    reference_external_transaction_id: transaction.referenceExternalTransactionId ?? null,
    reference_transaction_id: transaction.referenceTransactionId ?? null,
    status,
    failure_code: transaction.failureCode ?? null,
    result_balance: transaction.result?.balance.toString() ?? null,
    result_currency: transaction.result?.balance.currency ?? null,
    result_wallet_version: transaction.result?.walletVersion ?? null,
    correlation_id: transaction.correlationId,
    next_reference_attempt_at:
      status === WagerTransactionStatus.PendingReference
        ? new Date(transaction.createdAt.getTime() + REFERENCE_FIRST_ATTEMPT_DELAY_MS)
        : null,
    created_at: transaction.createdAt,
    updated_at: transaction.processedAt ?? transaction.createdAt,
    processed_at: transaction.processedAt ?? null,
  };
}

export function ledgerRow(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    wallet_id: entry.walletId,
    transaction_id: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balance_before: entry.balanceBefore.toString(),
    balance_after: entry.balanceAfter.toString(),
    wallet_version: entry.walletVersion,
    created_at: entry.createdAt,
  };
}

export async function writeEvents(exec: Exec, events: DomainEvent[] = []): Promise<void> {
  for (const event of events) {
    await insert(exec, "outbox_messages", {
      id: event.eventId,
      aggregate_id: event.aggregateId,
      partition_key: event.partitionKey,
      event_type: event.eventType,
      event_version: event.version,
      payload: JSON.stringify(event.toJSON()),
      occurred_at: event.occurredAt,
      next_attempt_at: event.occurredAt,
    });
  }
}

async function writeChange(exec: Exec, { transaction, wallet, entry, events }: WagerChange): Promise<void> {
  await insert(exec, "wager_transactions", transactionRow(transaction));
  if (entry && wallet) {
    await insert(exec, "wallet_ledger_entries", ledgerRow(entry));
    const updated = await exec(
      "update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ? returning id",
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, wallet.version - 1],
    );
    if (updated.length !== 1) throw new InvariantDbError("CONCURRENT_WALLET_UPDATE");
  }
  await writeEvents(exec, events);
}

export class PostgresWagerStore extends WagerStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined> {
    return this.read(() => findOne(this.exec, "idempotency_key", providerId, key));
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.read(() => findInternalId(this.exec, id));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.read(() => findOne(this.exec, "external_transaction_id", providerId, externalTransactionId));
  }

  private async read<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      throw translateDbError(error, false);
    }
  }

  async runLocked<T>(walletId: string, options: LockOptions, work: (tx: WagerStoreTx) => Promise<T>): Promise<T> {
    let committing = false;
    try {
      return await inTransaction(
        this.orm,
        this.config,
        async (exec) => {
          const [walletRow] = await exec(`select ${WALLET_COLUMNS} from wallets where id = ? for update`, [walletId]);
          const result = await work({
            loadWallet: async () => walletRow && toWallet(walletRow),
            findByIdempotencyKey: (providerId, key) => findOne(exec, "idempotency_key", providerId, key),
            findByExternalId: (providerId, externalId) => findOne(exec, "external_transaction_id", providerId, externalId),
            reversalExists: async (referenceId) =>
              (
                await exec(
                  `select 1 from wager_transactions
                    where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
                    limit 1`,
                  [referenceId],
                )
              ).length > 0,
            save: (change) => writeChange(exec, change),
          });
          committing = true;
          return result;
        },
        options.budgetMs,
      );
    } catch (error) {
      throw translateDbError(error, committing);
    }
  }

  private readonly exec: Exec = (sql, params) => this.orm.em.fork().execute(sql, params);
}
