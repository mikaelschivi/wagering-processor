import { createHash } from "node:crypto";
import { FailureCode, InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import type { Money, MoneyProps } from "./money";
import { LedgerDirection, type Wallet } from "./wallet";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface ResultSnapshot {
  balance: Money;
  walletVersion: number;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  result?: ResultSnapshot;
  processedAt?: Date;
}

export interface MarkProcessedProps {
  referenceTransactionId?: string;
  result: ResultSnapshot;
  at: Date;
}

const REQUIRES_REFERENCE = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];
const TERMINAL = [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed];

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _result: ResultSnapshot | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._result = state.result;
    this._processedAt = state.processedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    const amountOk = props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountOk) throw new InvalidWagerTransactionError("amount must be positive");

    const reference = props.referenceExternalTransactionId;
    if (REQUIRES_REFERENCE.includes(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError("BET cannot reference another transaction");
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("a transaction cannot reference itself");
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get result(): ResultSnapshot | undefined {
    return this._result;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(props: MarkProcessedProps): void {
    this.assertOpen();
    if (this.requiresReference() && props.referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._result = props.result;
    this._processedAt = props.at;
  }

  markPendingReference(result: ResultSnapshot): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`cannot wait for a reference from ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._result = result;
  }

  reject(code: FailureCode, result: ResultSnapshot): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._result = result;
  }

  fail(code: FailureCode): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError("ROLLBACK needs its reference to know the direction");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not move balance");
    }
  }

  private assertOpen(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`transaction is already ${this._status}`);
  }
}

export interface PayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(fields: PayloadFields): string {
  const normalized = {
    ...fields,
    playerId: fields.playerId.toLowerCase(),
    walletId: fields.walletId.toLowerCase(),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export type Outcome =
  | { type: "processed"; direction?: LedgerDirection }
  | { type: "rejected"; code: FailureCode }
  | { type: "pending-reference" };

export interface DecideInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference?: WagerTransaction | undefined;
  reversalExists: boolean;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const reject = (code: FailureCode): Outcome => ({ type: "rejected", code });

export function decide({ wallet, transaction: tx, reference, reversalExists }: DecideInput): Outcome {
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerWalletMismatch);

  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) return { type: "pending-reference" };

    const sameContext =
      reference.walletId === tx.walletId &&
      reference.playerId === tx.playerId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) return reject(FailureCode.ReferenceMismatch);

    if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }

    if (reference.status === WagerTransactionStatus.PendingReference) return { type: "pending-reference" };
    if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);

    if (reversalExists) return reject(FailureCode.ReferenceAlreadyReversed);

    if (tx.requiresReference() && !tx.money.equals(reference.money)) {
      return reject(FailureCode.ReferenceAmountMismatch);
    }
  }

  if (!tx.affectsBalance()) return { type: "processed" };

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    const isReversal = tx.kind === WagerTransactionKind.Rollback;
    return reject(isReversal ? FailureCode.InsufficientFundsForReversal : FailureCode.InsufficientFunds);
  }
  return { type: "processed", direction };
}
