import { type LedgerPageQuery, WalletStore } from "../../src/application/ports";
import { WalletAlreadyExistsError } from "../../src/domain/errors";
import { Wallet, type WalletLedgerEntry } from "../../src/domain/wallet";

export class InMemoryWalletStore extends WalletStore {
  private readonly wallets = new Map<string, Wallet>();
  private readonly byPlayerCurrency = new Map<string, string>();

  private readonly entries: WalletLedgerEntry[] = [];

  async create(wallet: Wallet, openingEntry?: WalletLedgerEntry): Promise<void> {
    const key = `${wallet.playerId}:${wallet.currency}`;
    const existing = this.byPlayerCurrency.get(key);
    if (existing) throw new WalletAlreadyExistsError(existing);
    this.byPlayerCurrency.set(key, wallet.id);
    this.wallets.set(wallet.id, this.copy(wallet));
    if (openingEntry) this.entries.push(openingEntry);
  }

  async reconciliationSnapshot(): Promise<undefined> {
    return undefined;
  }

  async ledgerPage(walletId: string, { beforeVersion, limit }: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    return this.entries
      .filter((entry) => entry.walletId === walletId && (beforeVersion === undefined || entry.walletVersion < beforeVersion))
      .sort((a, b) => b.walletVersion - a.walletVersion)
      .slice(0, limit);
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
