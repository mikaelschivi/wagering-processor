import type { Wallet, WalletLedgerEntry } from "../domain/wallet";

export abstract class Clock {
  abstract now(): Date;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export abstract class WalletStore {
  abstract create(wallet: Wallet, openingEntry?: WalletLedgerEntry): Promise<void>;
  abstract findById(id: string): Promise<Wallet | undefined>;
}
