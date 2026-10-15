import { describe, expect, test } from "bun:test";
import { CreateWallet } from "../../src/application/create-wallet";
import { type DomainEvent, type OpeningRecord, WalletStore } from "../../src/application/ports";
import { InvalidMoneyError, WalletAlreadyExistsError } from "../../src/domain/errors";
import type { Wallet, WalletLedgerEntry } from "../../src/domain/wallet";
import { FixedClock, SequentialIds } from "../helpers/fakes";
import { InMemoryWalletStore } from "../helpers/in-memory-wallet-store";

const now = new FixedClock().now();

class RecordingStore extends WalletStore {
  readonly inner = new InMemoryWalletStore();
  readonly entries: (WalletLedgerEntry | undefined)[] = [];
  readonly events: DomainEvent[] = [];

  async create(wallet: Wallet, opening?: OpeningRecord, events: DomainEvent[] = []) {
    await this.inner.create(wallet);
    this.entries.push(opening?.entry);
    this.events.push(...events);
  }

  findById(id: string) {
    return this.inner.findById(id);
  }

  reconciliationSnapshot() {
    return Promise.resolve(undefined);
  }

  ledgerPage() {
    return Promise.resolve([]);
  }
}

function setup() {
  const store = new RecordingStore();
  return { store, useCase: new CreateWallet(store, new SequentialIds(), new FixedClock()) };
}

const command = (amount: string, playerId = "player-1", currency = "BRL") => ({
  playerId,
  initialBalance: { amount, currency },
  correlationId: "corr-1",
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

  test("a funded wallet emits the opening events with the request's correlation id", async () => {
    const { useCase, store } = setup();
    await useCase.execute(command("50.00"));
    expect(store.events.map((event) => event.toJSON())).toMatchObject([
      {
        eventType: "WagerTransactionProcessed",
        aggregateId: "id-2",
        correlationId: "corr-1",
        data: { kind: "OPENING", status: "PROCESSED", walletId: "id-1", balance: { amount: "50.00" } },
      },
      {
        eventType: "WalletBalanceChanged",
        aggregateId: "id-1",
        correlationId: "corr-1",
        data: { direction: "CREDIT", walletVersion: 1, balanceAfter: { amount: "50.00" } },
      },
    ]);
    expect(new Set(store.events.map((event) => event.eventId)).size).toBe(2);
  });

  test("a zero balance emits no events", async () => {
    const { useCase, store } = setup();
    await useCase.execute(command("0.00"));
    expect(store.events).toEqual([]);
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
