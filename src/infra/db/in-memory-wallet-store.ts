import { WalletStore } from "../../application/ports";
import { WalletAlreadyExistsError } from "../../domain/errors";
import { Wallet } from "../../domain/wallet";

export class InMemoryWalletStore extends WalletStore {
  private readonly wallets = new Map<string, Wallet>();
  private readonly byPlayerCurrency = new Map<string, string>();

  async create(wallet: Wallet): Promise<void> {
    const key = `${wallet.playerId}:${wallet.currency}`;
    const existing = this.byPlayerCurrency.get(key);
    if (existing) throw new WalletAlreadyExistsError(existing);
    this.byPlayerCurrency.set(key, wallet.id);
    this.wallets.set(wallet.id, this.copy(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const wallet = this.wallets.get(id);
    return wallet && this.copy(wallet);
  }

  private copy(wallet: Wallet): Wallet {
    return Wallet.rehydrate({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }
}
