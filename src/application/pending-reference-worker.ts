import { FailureCode } from "../domain/errors";
import {
  type EventContext,
  WagerTransactionFailed,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { decide, type ResultSnapshot, type WagerTransaction } from "../domain/wager-transaction";
import { REFERENCE_BACKOFF_CAP_S } from "../globals";
import { applyMovement } from "./process-wager-transaction";
import {
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type PendingReferenceItem,
  TransientDbError,
  UniqueRaceError,
  UnknownCommitOutcomeError,
  type WagerStore,
  type WagerStoreTx,
} from "./ports";

const BACKOFF_JITTER = 0.2;

export interface PendingReferenceOptions {
  batch: number;
  concurrency: number;
  leaseS: number;
  intervalMs: number;
  ttlMs: number;
  maxFailures: number;
  budgetMs: number;
}

export type ItemOutcome = "resolved" | "rescheduled" | "expired" | "skipped" | "deferred" | "counted" | "failed";

export interface WorkerReport {
  claimed: number;
  outcomes: Record<ItemOutcome, number>;
}

export const referenceBackoffMs = (attempts: number, random: () => number): number => {
  const base = Math.min(2 ** attempts, REFERENCE_BACKOFF_CAP_S) * 1000;
  return Math.round(base * (1 + random() * BACKOFF_JITTER));
};

const isTransient = (error: unknown) =>
  error instanceof TransientDbError || error instanceof UniqueRaceError || error instanceof UnknownCommitOutcomeError;

export class PendingReferenceWorker {
  constructor(
    private readonly store: WagerStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly options: PendingReferenceOptions,
    private readonly random: () => number = Math.random,
  ) {}

  async runOnce(): Promise<WorkerReport> {
    const items = await this.store.claimDueReferences(this.options.batch, this.options.leaseS);
    const outcomes: Record<ItemOutcome, number> = {
      resolved: 0,
      rescheduled: 0,
      expired: 0,
      skipped: 0,
      deferred: 0,
      counted: 0,
      failed: 0,
    };
    const queue = [...items];
    const workers = Array.from({ length: Math.min(this.options.concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) outcomes[await this.process(item)]++;
    });
    await Promise.all(workers);
    return { claimed: items.length, outcomes };
  }

  async run(signal: AbortSignal, onError: (error: unknown) => void): Promise<void> {
    while (!signal.aborted) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
      } catch (error) {
        onError(error);
      }
      if (claimed >= this.options.batch) continue;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        this.clock.sleep(this.options.intervalMs).then(resolve);
      });
    }
  }

  private async process(item: PendingReferenceItem): Promise<ItemOutcome> {
    const lock = { budgetMs: this.options.budgetMs };
    try {
      return await this.store.runLocked(item.walletId, lock, (tx) => this.reprocess(tx, item.transactionId));
    } catch (error) {
      if (isTransient(error)) return "deferred";
      if (!(error instanceof Error)) throw error;
      return this.store.runLocked(item.walletId, lock, (tx) => this.countFailure(tx, item.transactionId));
    }
  }

  private async reprocess(tx: WagerStoreTx, transactionId: string): Promise<ItemOutcome> {
    const wallet = await tx.loadWallet();
    const locked = await tx.lockPending(transactionId, this.options.ttlMs);
    if (!wallet || !locked) return "skipped";

    const { transaction, expired, attempts } = locked;
    const at = this.clock.now();
    const snapshot = (): ResultSnapshot => ({ balance: wallet.balance, walletVersion: wallet.version });
    const reference = await tx.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId as string,
    );
    const reversalExists = reference ? await tx.reversalExists(reference.id) : false;
    const outcome = decide({ wallet, transaction, reference, reversalExists });

    if (outcome.type === "pending-reference") {
      if (!expired) {
        await tx.reschedule(transaction.id, referenceBackoffMs(attempts + 1, this.random));
        return "rescheduled";
      }
      transaction.reject(FailureCode.ReferenceNotFound, snapshot());
      await tx.saveResolved({ transaction, events: [this.rejected(transaction, at)] }, at);
      return "expired";
    }

    if (outcome.type === "rejected") {
      transaction.reject(outcome.code, snapshot());
      await tx.saveResolved({ transaction, events: [this.rejected(transaction, at)] }, at);
      return "resolved";
    }

    const entry = outcome.direction
      ? applyMovement(wallet, transaction, outcome.direction, this.ids.next(), at)
      : undefined;
    transaction.markProcessed({ ...(reference && { referenceTransactionId: reference.id }), result: snapshot(), at });
    const events: DomainEvent[] = [WagerTransactionProcessed.from(transaction, this.context(transaction, at))];
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, this.context(transaction, at)));
    await tx.saveResolved({ transaction, events, ...(entry && { wallet, entry }) }, at);
    return "resolved";
  }

  private async countFailure(tx: WagerStoreTx, transactionId: string): Promise<ItemOutcome> {
    await tx.loadWallet();
    const failures = await tx.recordFailure(transactionId);
    if (failures < this.options.maxFailures) return "counted";

    const locked = await tx.lockPending(transactionId, this.options.ttlMs);
    if (!locked) return "skipped";
    const at = this.clock.now();
    locked.transaction.fail(FailureCode.ProcessingFailed);
    await tx.saveResolved(
      { transaction: locked.transaction, events: [WagerTransactionFailed.from(locked.transaction, this.context(locked.transaction, at))] },
      at,
    );
    return "failed";
  }

  private rejected(transaction: WagerTransaction, at: Date): DomainEvent {
    return WagerTransactionRejected.from(transaction, this.context(transaction, at));
  }

  private context(transaction: WagerTransaction, at: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: transaction.correlationId,
      causationId: transaction.id,
      occurredAt: at,
    };
  }
}

