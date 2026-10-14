import { Money, type MoneyProps } from "../domain/money";
import { Wallet } from "../domain/wallet";
import type { Clock, IdGenerator, WalletStore } from "./ports";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export class CreateWallet {
  constructor(
    private readonly store: WalletStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at: this.clock.now(),
    });
    await this.store.create(wallet, openingEntry);
    return wallet;
  }
}
