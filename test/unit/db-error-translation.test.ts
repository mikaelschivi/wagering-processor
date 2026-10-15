import { describe, expect, test } from "bun:test";
import {
  InvariantDbError,
  TransientDbError,
  UniqueRaceError,
  UnknownCommitOutcomeError,
} from "../../src/application/ports";
import { InsufficientFundsError } from "../../src/domain/errors";
import { translateDbError } from "../../src/infra/db/postgres-wager-store";

const pg = (code: string, constraint?: string) => Object.assign(new Error(`pg ${code}`), { code, constraint });

describe("translateDbError", () => {
  test.each(["40001", "40P01", "55P03", "57014", "25P03", "53300"])("sqlstate %s is transient", (code) => {
    expect(translateDbError(pg(code), false)).toBeInstanceOf(TransientDbError);
    expect(translateDbError(pg(code), true)).toBeInstanceOf(TransientDbError);
  });

  test.each(["ux_tx_provider_idem", "ux_tx_provider_external"])("unique violation on %s is a race", (constraint) => {
    const translated = translateDbError(pg("23505", constraint), false);
    expect(translated).toBeInstanceOf(UniqueRaceError);
    expect((translated as UniqueRaceError).constraint).toBe(constraint);
  });

  test.each([
    ["23505", "ux_single_reversal"],
    ["23514", "ck_tx_amount_positive"],
    ["23503", "fk_ledger_wallet_currency"],
    ["WG001", undefined],
  ])("sqlstate %s is an invariant violation", (code, constraint) => {
    const translated = translateDbError(pg(code, constraint), false);
    expect(translated).toBeInstanceOf(InvariantDbError);
    expect((translated as InvariantDbError).sqlstate).toBe(code);
  });

  test.each([pg("08006"), pg("57P01"), pg("ECONNRESET"), pg("ECONNREFUSED"), new Error("Connection terminated unexpectedly"), new Error("Knex: Timeout acquiring a connection. The pool is probably full.")])(
    "connection failure %#: transient before the commit, unknown during it",
    (error) => {
      expect(translateDbError(error, false)).toBeInstanceOf(TransientDbError);
      expect(translateDbError(error, true)).toBeInstanceOf(UnknownCommitOutcomeError);
    },
  );

  test("business errors and port errors pass through", () => {
    const business = new InsufficientFundsError("low");
    const race = new UniqueRaceError("x");
    expect(translateDbError(business, false)).toBe(business);
    expect(translateDbError(race, true)).toBe(race);
  });

  test("unrecognised errors pass through unchanged", () => {
    const error = new TypeError("bug");
    expect(translateDbError(error, false)).toBe(error);
  });

  test("the original error is kept as the cause", () => {
    const original = pg("40P01");
    expect((translateDbError(original, false) as TransientDbError).cause).toBe(original);
  });
});
