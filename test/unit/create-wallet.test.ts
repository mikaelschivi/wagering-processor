import { describe, expect, test } from "bun:test";
import { CreateWallet } from "../../src/application/create-wallet";
import { Clock, IdGenerator, WalletStore } from "../../src/application/ports";
import { InvalidMoneyError, WalletAlreadyExistsError } from "../../src/domain/errors";
import type { Wallet, WalletLedgerEntry } from "../../src/domain/wallet";
import { InMemoryWalletStore } from "../../src/infra/db/in-memory-wallet-store";

const now = new Date("2026-02-03T04:05:06.000Z");

class FixedClock extends Clock {
  now() {
    return now;
  }
}

class SequentialIds extends IdGenerator {
  private n = 0;
  next() {
    return `id-${++this.n}`;
  }
}

class RecordingStore extends WalletStore {
  readonly inner = new InMemoryWalletStore();
  readonly entries: (WalletLedgerEntry | undefined)[] = [];

  async create(wallet: Wallet, openingEntry?: WalletLedgerEntry) {
    await this.inner.create(wallet);
    this.entries.push(openingEntry);
  }

  findById(id: string) {
    return this.inner.findById(id);
  }
}

function setup() {
  const store = new RecordingStore();
  return { store, useCase: new CreateWallet(store, new SequentialIds(), new FixedClock()) };
}

const command = (amount: string, playerId = "player-1", currency = "BRL") => ({
  playerId,
  initialBalance: { amount, currency },
});

describe("CreateWallet", () => {
  test("creates a wallet with the initial balance at version 1", async () => {
    const { useCase, store } = setup();
    const wallet = await useCase.execute(command("1000.00"));
    expect(wallet).toMatchObject({ id: "id-1", playerId: "player-1", currency: "BRL", version: 1 });
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(wallet.createdAt).toEqual(now);
    expect((await store.findById("id-1"))!.balance.toString()).toBe("1000.00");
  });

  test("saves an opening credit entry alongside a funded wallet", async () => {
    const { useCase, store } = setup();
    await useCase.execute(command("50.00"));
    const entry = store.entries[0]!;
    expect(entry).toMatchObject({ walletId: "id-1", transactionId: "id-2", id: "id-3", walletVersion: 1 });
    expect(entry.balanceAfter.toString()).toBe("50.00");
  });

  test("a zero balance creates the wallet with no ledger entry", async () => {
    const { useCase, store } = setup();
    const wallet = await useCase.execute(command("0.00"));
    expect(wallet.version).toBe(1);
    expect(store.entries).toEqual([undefined]);
  });

  test("rejects an invalid amount and stores nothing", async () => {
    const { useCase, store } = setup();
    await expect(useCase.execute(command("25"))).rejects.toThrow(InvalidMoneyError);
    expect(store.entries).toEqual([]);
  });

  test("a second wallet for the same player and currency conflicts and names the first", async () => {
    const { useCase, store } = setup();
    await useCase.execute(command("10.00"));
    const error = await useCase.execute(command("20.00")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect((error as WalletAlreadyExistsError).existingWalletId).toBe("id-1");
    expect(store.entries).toHaveLength(1);
  });

  test("the same player may hold wallets in different currencies", async () => {
    const { useCase } = setup();
    await useCase.execute(command("10.00", "player-1", "BRL"));
    const usd = await useCase.execute(command("10.00", "player-1", "USD"));
    expect(usd.currency).toBe("USD");
  });

  test("different players do not conflict", async () => {
    const { useCase } = setup();
    await useCase.execute(command("10.00", "player-1"));
    await expect(useCase.execute(command("10.00", "player-2"))).resolves.toBeDefined();
  });
});

describe("InMemoryWalletStore", () => {
  test("findById returns undefined for an unknown id", async () => {
    expect(await new InMemoryWalletStore().findById("nope")).toBeUndefined();
  });

  test("returns copies, so callers cannot mutate stored state", async () => {
    const { useCase, store } = setup();
    const created = await useCase.execute(command("10.00"));
    const loaded = (await store.findById(created.id))!;
    loaded.credit({
      money: created.balance,
      transactionId: "t",
      entryId: "e",
      at: now,
    });
    expect((await store.findById(created.id))!.version).toBe(1);
  });
});
