import { Body, Controller, Logger, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { Reconciliation } from "../../application/reconciliation";
import { ProcessWagerTransaction, type WagerResult } from "../../application/process-wager-transaction";
import { type Principal, WagerStore, WalletStore } from "../../application/ports";
import { APP_CONFIG, type AppConfig } from "../../config";
import { NotFoundError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { WagerTransactionStatus, type WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet, WalletLedgerEntry } from "../../domain/wallet";
import { addLogContext, currentCorrelationId } from "../../observability";
import { AdminRoute, CurrentPrincipal, ProviderRoute } from "./auth";
import {
  createWalletBody,
  encodeCursor,
  ledgerQuery,
  providerTransactionParams,
  requireIdempotencyKey,
  transactionParams,
  validate,
  wagerBody,
  walletParams,
} from "./schemas";

function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function ledgerEntryView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly createWallet: CreateWallet,
    private readonly store: WalletStore,
    private readonly reconciliation: Reconciliation,
  ) {}

  private readonly logger = new Logger(WalletsController.name);

  @Post()
  @AdminRoute()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const command = validate(createWalletBody(this.config.SUPPORTED_CURRENCIES), body);
    const wallet = await this.createWallet.execute({ ...command, correlationId: currentCorrelationId() });
    addLogContext({ walletId: wallet.id });
    return walletView(wallet);
  }

  @Get(":walletId")
  @ProviderRoute()
  async get(@Param() params: unknown) {
    const { walletId } = validate(walletParams, params);
    addLogContext({ walletId });
    const wallet = await this.store.findById(walletId);
    if (!wallet) throw new NotFoundError("wallet not found");
    return walletView(wallet);
  }

  @Post(":walletId/reconciliation")
  @AdminRoute()
  @HttpCode(200)
  async reconcile(@Param() params: unknown) {
    const { walletId } = validate(walletParams, params);
    addLogContext({ walletId });
    const report = await this.reconciliation.execute(walletId);
    if (!report.consistent) {
      this.logger.error(`reconciliation mismatch walletId=${walletId} issues=${report.issues.join(",")}`);
    }
    return report;
  }

  @Get(":walletId/ledger")
  @ProviderRoute()
  async ledger(@Param() params: unknown, @Query() query: unknown) {
    const { walletId } = validate(walletParams, params);
    addLogContext({ walletId });
    const { limit, beforeVersion } = validate(ledgerQuery, query);
    if (!(await this.store.findById(walletId))) throw new NotFoundError("wallet not found");
    const rows = await this.store.ledgerPage(walletId, { limit: limit + 1, ...(beforeVersion && { beforeVersion }) });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(ledgerEntryView),
      nextCursor: rows.length > limit && last ? encodeCursor(last.walletVersion) : null,
    };
  }
}

const SUBMIT_STATUS: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 422,
  [WagerTransactionStatus.Pending]: 202,
};

interface ResponseHeaders {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

function transactionView(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId && { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    ...(tx.result && { balance: tx.result.balance.toJSON() }),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt && { processedAt: tx.processedAt.toISOString() }),
  };
}

@Controller()
@ProviderRoute()
export class WagerTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly store: WagerStore,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentPrincipal() actor: Principal,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ): Promise<WagerResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { money, ...fields } = validate(wagerBody, body);
    const correlationId = currentCorrelationId();
    addLogContext({ walletId: fields.walletId, providerId: fields.providerId });
    const result = await this.processWager.execute({
      request: { ...fields, money: Money.from(money) },
      actor,
      idempotencyKey: key,
      correlationId,
    });
    addLogContext({ transactionId: result.transactionId });
    response.status(SUBMIT_STATUS[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param() params: unknown, @CurrentPrincipal() actor: Principal) {
    const { transactionId } = validate(transactionParams, params);
    return transactionView(this.visibleTo(actor, await this.store.findById(transactionId)));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(@Param() params: unknown, @CurrentPrincipal() actor: Principal) {
    const { providerId, externalTransactionId } = validate(providerTransactionParams, params);
    return transactionView(
      this.visibleTo(actor, await this.store.findByExternalId(providerId, externalTransactionId)),
    );
  }

  private visibleTo(actor: Principal, tx: WagerTransaction | undefined): WagerTransaction {
    if (!tx || (actor.kind === "provider" && actor.providerId !== tx.providerId)) {
      throw new NotFoundError("transaction not found");
    }
    return tx;
  }
}
