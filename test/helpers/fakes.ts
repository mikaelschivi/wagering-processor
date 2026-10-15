import { Clock, IdGenerator } from "../../src/application/ports";
import { WagerTransaction } from "../../src/domain/wager-transaction";
import type { Wallet, WalletLedgerEntry } from "../../src/domain/wallet";

export class FixedClock extends Clock {
  readonly sleeps: number[] = [];

  constructor(private current = new Date("2026-02-03T04:05:06.000Z")) {
    super();
  }

  now(): Date {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds extends IdGenerator {
  private n = 0;

  next(): string {
    return `id-${++this.n}`;
  }
}

export const openingRecord = (wallet: Wallet, entry: WalletLedgerEntry | undefined) =>
  entry && { entry, transaction: WagerTransaction.opening(wallet, entry, "corr-test") };
