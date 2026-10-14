import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";
import * as defaults from "../../src/globals";

const base = { DB_APP_PASSWORD: "secret" };

describe("loadConfig", () => {
  test("applies defaults for an empty environment", () => {
    const config = loadConfig(base);
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.APP_ROLES).toEqual(["api", "consumer", "outbox", "reference-worker"]);
    expect(config.TX_LOCK_TIMEOUT_MS).toBe(defaults.TX_LOCK_TIMEOUT_MS);
  });

  test("reads overrides and coerces numbers", () => {
    const config = loadConfig({ ...base, PORT: "4010", APP_ROLES: "api, outbox", TX_LOCK_TIMEOUT_MS: "1000" });
    expect(config.PORT).toBe(4010);
    expect(config.APP_ROLES).toEqual(["api", "outbox"]);
    expect(config.TX_LOCK_TIMEOUT_MS).toBe(1000);
  });

  test("defaults the database and queue settings", () => {
    const config = loadConfig(base);
    expect(config.DB_HOST).toBe("localhost");
    expect(config.DB_PORT).toBe(5432);
    expect(config.DB_APP_USER).toBe("wagering_app");
    expect(config.WAGER_QUEUE_NAME).toBe("wager-transactions.fifo");
    expect(config.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("requires the app database password", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  test("rejects an invalid endpoint url", () => {
    expect(() => loadConfig({ ...base, AWS_ENDPOINT_URL: "not a url" })).toThrow(ConfigError);
  });

  test("rejects an unknown role", () => {
    expect(() => loadConfig({ ...base, APP_ROLES: "api,admin" })).toThrow(ConfigError);
  });

  test("rejects a non-numeric or non-positive tunable", () => {
    expect(() => loadConfig({ ...base, TX_LOCK_TIMEOUT_MS: "fast" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SHUTDOWN_DRAIN_MS: "0" })).toThrow(ConfigError);
  });

  test("rejects an invalid port", () => {
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow(ConfigError);
  });

  test("rejects an override that breaks timeout nesting", () => {
    expect(() => loadConfig({ ...base, SQS_VISIBILITY_SAFETY_MARGIN_S: "5" })).toThrow(/nesting/);
  });

  test("accepts a short-visibility profile that still nests", () => {
    const config = loadConfig({
      ...base,
      SQS_VISIBILITY_TIMEOUT_S: "15",
      SQS_VISIBILITY_SAFETY_MARGIN_S: "8",
      USE_CASE_DEADLINE_MS: "3000",
      TX_LOCK_TIMEOUT_MS: "1000",
      TX_STATEMENT_TIMEOUT_MS: "2000",
    });
    expect(config.SQS_VISIBILITY_TIMEOUT_S).toBe(15);
  });
});
