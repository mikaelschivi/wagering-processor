export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
}

export class MoneyOverflowError extends DomainError {
  readonly code = "MONEY_OVERFLOW";
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(readonly existingWalletId: string) {
    super("a wallet already exists for this player and currency");
  }
}

export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  InsufficientFundsForReversal = "INSUFFICIENT_FUNDS_FOR_REVERSAL",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ProcessingFailed = "PROCESSING_FAILED",
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_TRANSACTION";
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}
