import { NotFoundError } from "../domain/errors";
import type { MoneyProps } from "../domain/money";
import type { WalletStore } from "./ports";

export type ReconciliationIssue = "BALANCE_MISMATCH" | "VERSION_MISMATCH" | "CHAIN_TAIL_MISMATCH";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  issues: ReconciliationIssue[];
}

export class Reconciliation {
  constructor(private readonly store: WalletStore) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.store.reconciliationSnapshot(walletId);
    if (!snapshot) throw new NotFoundError("wallet not found");
    const { wallet, calculated, entryCount, maxVersion, tailBalance } = snapshot;

    const issues: ReconciliationIssue[] = [];
    if (!wallet.balance.equals(calculated)) issues.push("BALANCE_MISMATCH");
    const expectedVersion = entryCount > 0 ? maxVersion : 1;
    if (wallet.version !== expectedVersion) issues.push("VERSION_MISMATCH");
    if (entryCount > 0 && !tailBalance?.equals(wallet.balance)) issues.push("CHAIN_TAIL_MISMATCH");

    return {
      walletId: wallet.id,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: wallet.balance.subtract(calculated).toJSON(),
      consistent: issues.length === 0,
      checkedEntries: entryCount,
      issues,
    };
  }
}
