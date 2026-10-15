import {
  DomainError,
  ExternalTransactionIdConflictError,
  type FailureCode,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
  InboxPayloadMismatchError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../domain/errors";
import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import type { Money, MoneyProps } from "../domain/money";
import {
  decide,
  hashPayload,
  type ResultSnapshot,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import { LedgerDirection, type Wallet } from "../domain/wallet";
import {
  type Clock,
  type IdGenerator,
  type InboxEntry,
  type Metrics,
  NullMetrics,
  type Principal,
  TransientDbError,
  UniqueRaceError,
  UnknownCommitOutcomeError,
  type WagerStore,
  type WagerStoreTx,
} from "./ports";

export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  deadlineMs: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  random: () => number;
}

const LOCK_CONFLICTS = ["40P01", "55P03", "40001"];

const isRetryable = (error: unknown) =>
  error instanceof TransientDbError || error instanceof UniqueRaceError || error instanceof UnknownCommitOutcomeError;

export function applyMovement(
  wallet: Wallet,
  transaction: WagerTransaction,
  direction: LedgerDirection,
  entryId: string,
  at: Date,
) {
  const movement = { money: transaction.money, transactionId: transaction.id, entryId, at };
  return direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
}

export function assertCanActAs(actor: Principal, providerId: string): void {
  if (actor.kind === "provider" && actor.providerId !== providerId) {
    throw new ForbiddenProviderError("the caller cannot act for this provider");
  }
}

export interface ProcessWagerCommand {
  request: WagerRequest;
  actor: Principal;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  inbox?: InboxEntry;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    ...(transaction.result && { balance: transaction.result.balance.toJSON() }),
    idempotentReplay,
  };
}

export class ProcessWagerTransaction {
  constructor(
    private readonly store: WagerStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly retry: RetryPolicy,
    private readonly metrics: Metrics = new NullMetrics(),
  ) {
    if (retry.maxAttempts < 1 || retry.jitterMinMs > retry.jitterMaxMs || retry.deadlineMs <= 0) {
      throw new Error("invalid retry policy");
    }
  }

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
    const startedAt = performance.now();
    const observed = { inboxDuplicate: false };
    try {
      const result = await this.run(command, observed);
      if (result.idempotentReplay) this.metrics.count("idempotent_replays_total");
      else this.metrics.count("wager_transactions_total", { status: result.status, kind: command.request.kind });
      if (observed.inboxDuplicate) this.metrics.count("inbox_duplicates_total");
      return result;
    } catch (error) {
      if (error instanceof DomainError) this.metrics.count("request_errors_total", { code: error.code });
      throw error;
    } finally {
      this.metrics.observe("processing_seconds", (performance.now() - startedAt) / 1000, {
        source: command.inbox ? "sqs" : "http",
      });
    }
  }

  private async run(command: ProcessWagerCommand, observed: { inboxDuplicate: boolean }): Promise<WagerResult> {
    const { request } = command;
    assertCanActAs(command.actor, request.providerId);
    const payloadHash = hashPayload({ ...request, money: request.money.toJSON() });
    const startedAt = this.clock.now().getTime();

    for (let attempt = 1; ; attempt++) {
      const remainingMs = this.retry.deadlineMs - (this.clock.now().getTime() - startedAt);
      try {
        return await this.attempt(command, payloadHash, remainingMs, observed);
      } catch (error) {
        if (!isRetryable(error)) throw error;
        this.countRetry(error);
        const pauseMs = this.pause();
        if (attempt >= this.retry.maxAttempts || remainingMs - pauseMs <= 0) {
          throw new TransientInfrastructureError("the request could not be completed, retry with the same key", {
            cause: error,
          });
        }
        await this.clock.sleep(pauseMs);
      }
    }
  }

  private countRetry(error: unknown): void {
    const reason = error instanceof TransientDbError ? error.reason : error instanceof UniqueRaceError ? "unique_race" : "unknown_commit";
    this.metrics.count("use_case_retries_total", { reason });
    if (error instanceof TransientDbError && LOCK_CONFLICTS.includes(error.reason)) {
      this.metrics.count("lock_conflicts_total", { reason });
    }
  }

  private async attempt(
    command: ProcessWagerCommand,
    payloadHash: string,
    budgetMs: number,
    observed: { inboxDuplicate: boolean },
  ): Promise<WagerResult> {
    const { request, idempotencyKey } = command;
    if (!command.inbox) {
      const known = await this.store.findByIdempotencyKey(request.providerId, idempotencyKey);
      if (known) return this.replay(known, payloadHash);
    }
    return this.store.runLocked(request.walletId, { budgetMs }, (tx) => this.apply(tx, command, payloadHash, observed));
  }

  private pause(): number {
    const { jitterMinMs, jitterMaxMs, random } = this.retry;
    return jitterMinMs + Math.floor(random() * (jitterMaxMs - jitterMinMs + 1));
  }

  private replay(known: WagerTransaction, payloadHash: string): WagerResult {
    if (!known.matchesPayload(payloadHash)) {
      throw new IdempotencyKeyConflictError("idempotency key was used with a different payload");
    }
    return toResult(known, true);
  }

  private async apply(
    tx: WagerStoreTx,
    command: ProcessWagerCommand,
    payloadHash: string,
    observed: { inboxDuplicate: boolean },
  ): Promise<WagerResult> {
    const { request, idempotencyKey } = command;

    const wallet = await tx.loadWallet();
    if (!wallet) throw new WalletNotFoundError("wallet does not exist");

    if (command.inbox) await this.recordInbox(tx, command.inbox, observed);

    const known = await tx.findByIdempotencyKey(request.providerId, idempotencyKey);
    if (known) return this.replay(known, payloadHash);
    if (await tx.findByExternalId(request.providerId, request.externalTransactionId)) {
      throw new ExternalTransactionIdConflictError("external transaction id was used with another idempotency key");
    }

    const at = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      ...request,
      idempotencyKey,
      payloadHash,
      correlationId: command.correlationId,
      createdAt: at,
    });

    const reference = request.referenceExternalTransactionId
      ? await tx.findByExternalId(request.providerId, request.referenceExternalTransactionId)
      : undefined;
    const reversalExists = reference ? await tx.reversalExists(reference.id) : false;

    const outcome = decide({ wallet, transaction, reference, reversalExists });
    const snapshot = (): ResultSnapshot => ({ balance: wallet.balance, walletVersion: wallet.version });

    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      ...(command.causationId !== undefined && { causationId: command.causationId }),
      occurredAt: at,
    });

    switch (outcome.type) {
      case "rejected":
        transaction.reject(outcome.code, snapshot());
        await tx.save({ transaction, events: [WagerTransactionRejected.from(transaction, context())] });
        break;
      case "pending-reference":
        transaction.markPendingReference(snapshot());
        await tx.save({
          transaction,
          events: [WagerTransactionPendingReference.from(transaction, context())],
        });
        break;
      case "processed": {
        const entry = outcome.direction && this.move(wallet, transaction, outcome.direction, at);
        transaction.markProcessed({
          ...(reference && { referenceTransactionId: reference.id }),
          result: snapshot(),
          at,
        });
        const events = [
          WagerTransactionProcessed.from(transaction, context()),
          ...(entry ? [WalletBalanceChanged.from(wallet, entry, context())] : []),
        ];
        await tx.save({ transaction, events, ...(entry && { wallet, entry }) });
        break;
      }
    }
    return toResult(transaction, false);
  }

  private async recordInbox(tx: WagerStoreTx, inbox: InboxEntry, observed: { inboxDuplicate: boolean }): Promise<void> {
    const record = await tx.recordInbox(inbox, this.clock.now());
    if (record.status === "duplicate") observed.inboxDuplicate = true;
    if (record.status === "duplicate" && record.messageHash !== inbox.messageHash) {
      throw new InboxPayloadMismatchError("message id was already received with a different payload");
    }
  }

  private move(wallet: Wallet, transaction: WagerTransaction, direction: LedgerDirection, at: Date) {
    return applyMovement(wallet, transaction, direction, this.ids.next(), at);
  }
}
