import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events";
import { Money, type MoneyProps } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import type { Clock, IdGenerator, WalletStore } from "./ports";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export class CreateWallet {
  constructor(
    private readonly store: WalletStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at,
    });
    if (!openingEntry) {
      await this.store.create(wallet);
      return wallet;
    }

    const transaction = WagerTransaction.opening(wallet, openingEntry, command.correlationId);
    const context = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
    await this.store.create(wallet, { transaction, entry: openingEntry }, [
      WagerTransactionProcessed.from(transaction, context()),
      WalletBalanceChanged.from(wallet, openingEntry, context()),
    ]);
    return wallet;
  }
}
