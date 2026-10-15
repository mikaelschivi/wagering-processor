export interface WalletRef {
  playerId: string;
  walletId: string;
}

export interface Reply {
  status: number;
  body: { transactionId?: string; status?: string; failureCode?: string; code?: string; idempotentReplay?: boolean };
}

const json = { "content-type": "application/json" };

export async function createWallet(url: string, amount = "1000.00"): Promise<WalletRef> {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${url}/wallets`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: "BRL" } }),
  });
  const { id } = (await response.json()) as { id: string };
  return { playerId, walletId: id };
}

export interface WagerInput {
  wallet: WalletRef;
  external: string;
  kind?: string;
  amount?: string;
  reference?: string;
  key?: string;
}

export async function submit(url: string, input: WagerInput): Promise<Reply> {
  const { wallet, external, kind = "BET", amount = "10.00", reference, key = external } = input;
  const response = await fetch(`${url}/wagering/transactions`, {
    method: "POST",
    headers: { ...json, "idempotency-key": key },
    body: JSON.stringify({
      providerId: "provider-a",
      externalTransactionId: external,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "r",
      gameId: "g",
      kind,
      money: { amount, currency: "BRL" },
      ...(reference && { referenceExternalTransactionId: reference }),
    }),
  });
  return { status: response.status, body: (await response.json()) as Reply["body"] };
}

export async function submitUntilFinal(urls: string[], input: WagerInput, attempts = 40): Promise<Reply> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = urls[attempt % urls.length]!;
    const reply = await submit(url, input).catch(() => undefined);
    if (reply && reply.status !== 503 && reply.status < 500) return reply;
    await Bun.sleep(50);
  }
  throw new Error(`no final answer for ${input.external}`);
}

export async function balanceOf(url: string, wallet: WalletRef): Promise<string> {
  const response = await fetch(`${url}/wallets/${wallet.walletId}`);
  return ((await response.json()) as { balance: { amount: string } }).balance.amount;
}

export async function tally(replies: Reply[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const { status, body } of replies) {
    const key = `${status} ${body.status ?? body.code}${body.failureCode ? `/${body.failureCode}` : ""}${body.idempotentReplay ? " replay" : ""}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
