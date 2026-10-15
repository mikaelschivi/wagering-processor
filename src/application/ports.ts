import type { Money } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet, WalletLedgerEntry } from "../domain/wallet";

export abstract class Clock {
  abstract now(): Date;
  abstract sleep(ms: number): Promise<void>;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export type Principal =
  | { kind: "provider"; providerId: string }
  | { kind: "admin" }
  | { kind: "trusted-internal" }
  | { kind: "anonymous-dev" };

export abstract class ProviderIdentityPort {
  abstract resolve(request: { header(name: string): string | undefined }): Principal;
}

export interface LedgerPageQuery {
  beforeVersion?: number;
  limit: number;
}

export interface ReconciliationSnapshot {
  wallet: Wallet;
  calculated: Money;
  entryCount: number;
  maxVersion?: number;
  tailBalance?: Money;
}

export abstract class WalletStore {
  abstract create(wallet: Wallet, openingEntry?: WalletLedgerEntry): Promise<void>;
  abstract findById(id: string): Promise<Wallet | undefined>;
  abstract reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
  abstract ledgerPage(walletId: string, query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
}

export interface WagerChange {
  transaction: WagerTransaction;
  wallet?: Wallet;
  entry?: WalletLedgerEntry;
}

export interface WagerStoreTx {
  loadWallet(): Promise<Wallet | undefined>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  reversalExists(referenceTransactionId: string): Promise<boolean>;
  save(change: WagerChange): Promise<void>;
}

export interface LockOptions {
  budgetMs: number;
}

export abstract class WagerStore {
  abstract findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  abstract findById(id: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  abstract runLocked<T>(walletId: string, options: LockOptions, work: (tx: WagerStoreTx) => Promise<T>): Promise<T>;
}

export class TransientDbError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`transient database failure: ${reason}`, options);
    this.name = "TransientDbError";
  }
}

export class UniqueRaceError extends Error {
  constructor(readonly constraint: string) {
    super(`unique constraint hit by a concurrent request: ${constraint}`);
    this.name = "UniqueRaceError";
  }
}

export class UnknownCommitOutcomeError extends Error {
  constructor(options?: ErrorOptions) {
    super("the commit outcome is unknown", options);
    this.name = "UnknownCommitOutcomeError";
  }
}

export class InvariantDbError extends Error {
  constructor(
    readonly sqlstate: string,
    readonly constraint?: string,
    options?: ErrorOptions,
  ) {
    super(`database invariant violated: ${sqlstate}`, options);
    this.name = "InvariantDbError";
  }
}
