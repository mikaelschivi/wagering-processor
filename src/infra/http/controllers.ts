import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { ProcessWagerTransaction, type WagerResult } from "../../application/process-wager-transaction";
import { type Principal, WagerStore, WalletStore } from "../../application/ports";
import { APP_CONFIG, type AppConfig } from "../../config";
import { NotFoundError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { WagerTransactionStatus, type WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import { AdminRoute, CurrentPrincipal, ProviderRoute } from "./auth";
import {
  correlationIdFrom,
  createWalletBody,
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

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly createWallet: CreateWallet,
    private readonly store: WalletStore,
  ) {}

  @Post()
  @AdminRoute()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const command = validate(createWalletBody(this.config.SUPPORTED_CURRENCIES), body);
    return walletView(await this.createWallet.execute(command));
  }

  @Get(":walletId")
  @ProviderRoute()
  async get(@Param() params: unknown) {
    const { walletId } = validate(walletParams, params);
    const wallet = await this.store.findById(walletId);
    if (!wallet) throw new NotFoundError("wallet not found");
    return walletView(wallet);
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
    @Headers("x-correlation-id") correlationHeader: string | undefined,
    @CurrentPrincipal() actor: Principal,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ): Promise<WagerResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { money, ...fields } = validate(wagerBody, body);
    const correlationId = correlationIdFrom(correlationHeader);
    const result = await this.processWager.execute({
      request: { ...fields, money: Money.from(money) },
      actor,
      idempotencyKey: key,
      correlationId,
    });
    response.setHeader("x-correlation-id", correlationId);
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
