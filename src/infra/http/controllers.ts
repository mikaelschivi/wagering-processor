import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { WalletStore } from "../../application/ports";
import { APP_CONFIG, type AppConfig } from "../../config";
import { NotFoundError } from "../../domain/errors";
import type { Wallet } from "../../domain/wallet";
import { createWalletBody, validate, walletParams } from "./schemas";

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
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const command = validate(createWalletBody(this.config.SUPPORTED_CURRENCIES), body);
    return walletView(await this.createWallet.execute(command));
  }

  @Get(":walletId")
  async get(@Param() params: unknown) {
    const { walletId } = validate(walletParams, params);
    const wallet = await this.store.findById(walletId);
    if (!wallet) throw new NotFoundError("wallet not found");
    return walletView(wallet);
  }
}
