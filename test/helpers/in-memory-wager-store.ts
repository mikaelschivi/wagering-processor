import {
  type DomainEvent,
  type InboxEntry,
  type InboxRecord,
  type LockOptions,
  UniqueRaceError,
  type WagerChange,
  WagerStore,
  type WagerStoreTx,
} from "../../src/application/ports";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { Wallet, type WalletLedgerEntry } from "../../src/domain/wallet";

const pendingInboxes = new WeakMap<WagerChange[], Map<string, string>>();
const pendingOps = new WeakMap<WagerChange[], (() => void)[]>();

const cloneTransaction = (tx: WagerTransaction) =>
  WagerTransaction.rehydrate({
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    ...(tx.referenceExternalTransactionId && { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    correlationId: tx.correlationId,
    createdAt: tx.createdAt,
    status: tx.status,
    ...(tx.referenceTransactionId && { referenceTransactionId: tx.referenceTransactionId }),
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    ...(tx.result && { result: tx.result }),
    ...(tx.processedAt && { processedAt: tx.processedAt }),
  });

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
  readonly events: DomainEvent[] = [];
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

  readonly inbox = new Map<string, string>();
  readonly references = new Map<string, { attempts: number; failures: number; lastDelayMs?: number }>();
  readonly expired = new Set<string>();
  claims = 0;
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

  async pendingReferenceCount() {
    return [...this.transactions.values()].filter((tx) => tx.status === WagerTransactionStatus.PendingReference).length;
  }

  async claimDueReferences(limit: number) {
    this.claims++;
    return [...this.transactions.values()]
      .filter((tx) => tx.status === WagerTransactionStatus.PendingReference)
      .slice(0, limit)
      .map((tx) => ({ transactionId: tx.id, walletId: tx.walletId }));
  }

  async findById(id: string) {
    return this.transactions.get(id);
  }

  async findByExternalId(providerId: string, externalId: string) {
    return this.transactions.get(this.byExternal.get(`${providerId}:${externalId}`) ?? "");
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
    const pendingInbox = new Map<string, string>();
    pendingInboxes.set(pending, pendingInbox);
    const ops: (() => void)[] = [];
    pendingOps.set(pending, ops);
    const meta = (id: string) => {
      const existing = this.references.get(id) ?? { attempts: 0, failures: 0 };
      this.references.set(id, existing);
      return existing;
    };
    return {
      lockPending: async (transactionId: string) => {
        const stored = this.transactions.get(transactionId);
        if (!stored || stored.status !== WagerTransactionStatus.PendingReference) return undefined;
        return {
          transaction: cloneTransaction(stored),
          expired: this.expired.has(transactionId),
          attempts: meta(transactionId).attempts,
        };
      },
      saveResolved: async (change: WagerChange) => {
        if (this.failNextSave) {
          const error = this.failNextSave;
          this.failNextSave = undefined;
          throw error;
        }
        ops.push(() => {
          this.transactions.set(change.transaction.id, change.transaction);
          if (change.events) this.events.push(...change.events);
          if (change.wallet) this.wallets.set(change.wallet.id, copyWallet(change.wallet));
          if (change.entry) this.entries.push(change.entry);
        });
      },
      reschedule: async (transactionId: string, delayMs: number) => {
        ops.push(() => {
          const record = meta(transactionId);
          record.attempts++;
          record.lastDelayMs = delayMs;
        });
      },
      recordFailure: async (transactionId: string) => {
        const next = meta(transactionId).failures + 1;
        ops.push(() => {
          meta(transactionId).failures = next;
        });
        return next;
      },
      recordInbox: async (entry: InboxEntry, _at: Date): Promise<InboxRecord> => {
        const key = `${entry.consumerName}:${entry.messageId}`;
        const existing = this.inbox.get(key) ?? pendingInbox.get(key);
        if (existing !== undefined) return { status: "duplicate", messageHash: existing };
        pendingInbox.set(key, entry.messageHash);
        return { status: "recorded" };
      },
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
    for (const [key, hash] of pendingInboxes.get(pending) ?? []) this.inbox.set(key, hash);
    for (const op of pendingOps.get(pending) ?? []) op();
    for (const { transaction, wallet, entry, events } of pending) {
      if (events) this.events.push(...events);
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
