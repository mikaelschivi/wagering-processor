import {
  ExternalTransactionIdConflictError,
  type FailureCode,
  ForbiddenProviderError,
  IdempotencyKeyConflictError,
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

const isRetryable = (error: unknown) =>
  error instanceof TransientDbError || error instanceof UniqueRaceError || error instanceof UnknownCommitOutcomeError;

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
  ) {
    if (retry.maxAttempts < 1 || retry.jitterMinMs > retry.jitterMaxMs || retry.deadlineMs <= 0) {
      throw new Error("invalid retry policy");
    }
  }

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
    const { request } = command;
    assertCanActAs(command.actor, request.providerId);
    const payloadHash = hashPayload({ ...request, money: request.money.toJSON() });
    const startedAt = this.clock.now().getTime();

    for (let attempt = 1; ; attempt++) {
      const remainingMs = this.retry.deadlineMs - (this.clock.now().getTime() - startedAt);
      try {
        return await this.attempt(command, payloadHash, remainingMs);
      } catch (error) {
        if (!isRetryable(error)) throw error;
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

  private async attempt(command: ProcessWagerCommand, payloadHash: string, budgetMs: number): Promise<WagerResult> {
    const { request, idempotencyKey } = command;
    const known = await this.store.findByIdempotencyKey(request.providerId, idempotencyKey);
    if (known) return this.replay(known, payloadHash);
    return this.store.runLocked(request.walletId, { budgetMs }, (tx) => this.apply(tx, command, payloadHash));
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

  private async apply(tx: WagerStoreTx, command: ProcessWagerCommand, payloadHash: string): Promise<WagerResult> {
    const { request, idempotencyKey } = command;

    const wallet = await tx.loadWallet();
    if (!wallet) throw new WalletNotFoundError("wallet does not exist");

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

  private move(wallet: Wallet, transaction: WagerTransaction, direction: LedgerDirection, at: Date) {
    const movement = { money: transaction.money, transactionId: transaction.id, entryId: this.ids.next(), at };
    return direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  }
}
