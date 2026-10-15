import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Principal, ProviderIdentityPort } from "../../src/application/ports";
import { routeAccess } from "../../src/infra/http/auth";
import { HealthController } from "../../src/infra/http/health.controller";
import { WagerTransactionsController, WalletsController } from "../../src/infra/http/controllers";
import { type BootedApp, bootApp } from "../helpers/app";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

class HeaderIdentity extends ProviderIdentityPort {
  resolve(request: { header(name: string): string | undefined }): Principal {
    const who = request.header("x-test-principal") ?? "admin";
    return who === "admin" ? { kind: "admin" } : { kind: "provider", providerId: who };
  }
}

let db: TestDatabase;
let booted: BootedApp;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  booted = await bootApp(db.config, new HeaderIdentity());
  baseUrl = booted.baseUrl;
}, 30_000);

afterAll(async () => {
  await booted.close();
  await db.drop();
});

const as = (principal: string) => ({ "content-type": "application/json", "x-test-principal": principal });

async function seed() {
  const playerId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: as("admin"),
    body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  const { id } = (await created.json()) as { id: string };
  return { playerId, walletId: id };
}

const submit = (principal: string, body: unknown, providerId: string) =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { ...as(principal), "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      providerId,
      externalTransactionId: crypto.randomUUID(),
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      ...(body as object),
    }),
  });

describe("authorization", () => {
  test("every route handler carries an access tag", () => {
    for (const controller of [HealthController, WalletsController, WagerTransactionsController]) {
      const handlers = Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== "constructor");
      for (const name of handlers) {
        const handler = (controller.prototype as unknown as Record<string, object>)[name]!;
        const isRoute = Reflect.getMetadata("path", handler) !== undefined;
        if (isRoute) expect(routeAccess(handler) ?? routeAccess(controller)).toBeDefined();
      }
    }
  });

  test("health stays open without any identity", async () => {
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });

  test("a provider cannot create wallets, an admin can", async () => {
    const body = JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" } });
    const denied = await fetch(`${baseUrl}/wallets`, { method: "POST", headers: as("provider-a"), body });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "FORBIDDEN_PROVIDER", retryable: false });
    expect((await fetch(`${baseUrl}/wallets`, { method: "POST", headers: as("admin"), body })).status).toBe(201);
  });

  test("reconciliation is admin-only", async () => {
    const wallet = await seed();
    const url = `${baseUrl}/wallets/${wallet.walletId}/reconciliation`;
    expect((await fetch(url, { method: "POST", headers: as("provider-a") })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: as("admin") })).status).toBe(200);
  });

  test("a provider submits for itself but not for another provider", async () => {
    const wallet = await seed();
    const own = await submit("provider-a", wallet, "provider-a");
    expect(own.status).toBe(200);
    const other = await submit("provider-a", wallet, "provider-b");
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "FORBIDDEN_PROVIDER" });
  });

  test("an admin may submit for any provider", async () => {
    const wallet = await seed();
    expect((await submit("admin", wallet, "provider-b")).status).toBe(200);
  });

  test("a provider reads its own transactions and gets 404 for another provider's", async () => {
    const wallet = await seed();
    const { transactionId } = (await (await submit("provider-a", wallet, "provider-a")).json()) as {
      transactionId: string;
    };
    const own = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`, { headers: as("provider-a") });
    expect(own.status).toBe(200);
    const foreign = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`, { headers: as("provider-b") });
    expect(foreign.status).toBe(404);
    const foreignByExternal = await fetch(
      `${baseUrl}/providers/provider-a/wagering/transactions/${crypto.randomUUID()}`,
      { headers: as("provider-b") },
    );
    expect(foreignByExternal.status).toBe(404);
    expect((await fetch(`${baseUrl}/wagering/transactions/${transactionId}`, { headers: as("admin") })).status).toBe(200);
  });
});
