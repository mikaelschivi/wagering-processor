import {
  type LockOptions,
  UniqueRaceError,
  type WagerChange,
  WagerStore,
  type WagerStoreTx,
} from "../../src/application/ports";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { Wallet, type WalletLedgerEntry } from "../../src/domain/wallet";

const copyWallet = (wallet: Wallet) =>
  Wallet.rehydrate({
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });

export class InMemoryWagerStore extends WagerStore {
  readonly wallets = new Map<string, Wallet>();
  readonly transactions = new Map<string, WagerTransaction>();
  readonly entries: WalletLedgerEntry[] = [];
  commits = 0;
  rollbacks = 0;
  attempts = 0;
  readonly budgets: number[] = [];
  failNextSave: Error | undefined;
  private failBeforeWork: Error[] = [];
  private failAfterCommit: Error[] = [];
  private failLookups: Error[] = [];
  private hidden = { key: 0, external: 0 };

  failNext(error: Error): void {
    this.failBeforeWork.push(error);
  }

  failAfterNextCommit(error: Error): void {
    this.failAfterCommit.push(error);
  }

  failNextLookup(error: Error): void {
    this.failLookups.push(error);
  }

  hideLookups(kind: "key" | "external", count: number): void {
    this.hidden[kind] = count;
  }

  private readonly byKey = new Map<string, string>();
  private readonly byExternal = new Map<string, string>();
  private readonly tails = new Map<string, Promise<void>>();

  seedWallet(wallet: Wallet): void {
    this.wallets.set(wallet.id, copyWallet(wallet));
  }

  balanceOf(walletId: string): string {
    return this.wallets.get(walletId)!.balance.toString();
  }

  async findByIdempotencyKey(providerId: string, key: string) {
    const failure = this.failLookups.shift();
    if (failure) throw failure;
    return this.lookup(providerId, key);
  }

  private lookup(providerId: string, key: string) {
    if (this.hidden.key > 0) {
      this.hidden.key--;
      return undefined;
    }
    return this.transactions.get(this.byKey.get(`${providerId}:${key}`) ?? "");
  }

  async runLocked<T>(walletId: string, options: LockOptions, work: (tx: WagerStoreTx) => Promise<T>): Promise<T> {
    this.attempts++;
    this.budgets.push(options.budgetMs);
    const release = await this.acquire(walletId);
    try {
      const failure = this.failBeforeWork.shift();
      if (failure) throw failure;
      const pending: WagerChange[] = [];
      const result = await work(this.transactionFor(walletId, pending));
      this.commit(pending);
      this.commits++;
      const lateFailure = this.failAfterCommit.shift();
      if (lateFailure) throw lateFailure;
      return result;
    } catch (error) {
      this.rollbacks++;
      throw error;
    } finally {
      release();
    }
  }

  private transactionFor(walletId: string, pending: WagerChange[]): WagerStoreTx {
    return {
      loadWallet: async () => {
        const wallet = this.wallets.get(walletId);
        return wallet && copyWallet(wallet);
      },
      findByIdempotencyKey: async (providerId, key) => this.lookup(providerId, key),
      findByExternalId: async (providerId, externalId) => {
        if (this.hidden.external > 0) {
          this.hidden.external--;
          return undefined;
        }
        return this.transactions.get(this.byExternal.get(`${providerId}:${externalId}`) ?? "");
      },
      reversalExists: async (referenceId) =>
        [...this.transactions.values()].some(
          (tx) =>
            tx.referenceTransactionId === referenceId &&
            tx.status === WagerTransactionStatus.Processed &&
            (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback),
        ),
      save: async (change) => {
        if (this.failNextSave) {
          const error = this.failNextSave;
          this.failNextSave = undefined;
          throw error;
        }
        pending.push(change);
      },
    };
  }

  private commit(pending: WagerChange[]): void {
    for (const { transaction } of pending) {
      const key = `${transaction.providerId}:${transaction.idempotencyKey}`;
      const external = `${transaction.providerId}:${transaction.externalTransactionId}`;
      if (this.byKey.has(key)) throw new UniqueRaceError("ux_tx_provider_idem");
      if (this.byExternal.has(external)) throw new UniqueRaceError("ux_tx_provider_external");
    }
    for (const { transaction, wallet, entry } of pending) {
      this.transactions.set(transaction.id, transaction);
      this.byKey.set(`${transaction.providerId}:${transaction.idempotencyKey}`, transaction.id);
      this.byExternal.set(`${transaction.providerId}:${transaction.externalTransactionId}`, transaction.id);
      if (wallet) this.wallets.set(wallet.id, copyWallet(wallet));
      if (entry) this.entries.push(entry);
    }
  }

  private async acquire(walletId: string): Promise<() => void> {
    const previous = this.tails.get(walletId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(walletId, previous.then(() => next));
    await previous;
    return release;
  }
}
