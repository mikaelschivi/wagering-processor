import { Migration } from "@mikro-orm/migrations";

const APP_ROLE = process.env.DB_APP_USER ?? "wagering_app";
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error("DB_APP_USER is not a valid role name");

export class Migration0001Wallets extends Migration {
  async up(): Promise<void> {
    this.addSql(`CREATE TYPE wager_kind AS ENUM ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')`);
    this.addSql(
      `CREATE TYPE wager_status AS ENUM ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')`,
    );
    this.addSql(`CREATE TYPE ledger_direction AS ENUM ('DEBIT','CREDIT')`);

    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT ux_wallet_player_currency UNIQUE (player_id, currency),
        CONSTRAINT ux_wallet_id_currency UNIQUE (id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind wager_kind NOT NULL,
        amount numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL,
        reference_external_transaction_id text NULL,
        reference_transaction_id uuid NULL,
        status wager_status NOT NULL CHECK (status <> 'PENDING'),
        failure_code text NULL,
        result_balance numeric(20,2) NULL,
        result_currency char(3) NULL,
        result_wallet_version integer NULL,
        correlation_id text NOT NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz NULL,
        consecutive_failures integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT ux_tx_provider_idem UNIQUE (provider_id, idempotency_key),
        CONSTRAINT ux_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ux_tx_id_wallet UNIQUE (id, wallet_id),
        CONSTRAINT ux_tx_ledger_identity UNIQUE (id, wallet_id, amount, currency),
        CONSTRAINT fk_tx_reference_same_wallet FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ck_tx_amount_positive CHECK (amount > 0 OR kind = 'LOSS'),
        CONSTRAINT ck_tx_ref_required CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_tx_ref_forbidden CHECK (
          kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_tx_internal CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
        CONSTRAINT ck_tx_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_tx_processed_at CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_tx_reversal_resolved CHECK (
          status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT ck_tx_pending_schedule CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT ck_tx_result_snapshot CHECK (
          status = 'FAILED' OR
          (result_balance IS NOT NULL AND result_currency IS NOT NULL AND result_wallet_version IS NOT NULL))
      )`);
    this.addSql(`
      CREATE UNIQUE INDEX ux_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`
      CREATE INDEX ix_tx_pending_due ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX ix_tx_pending_by_ref ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX ix_tx_reference ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction ledger_direction NOT NULL,
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        CONSTRAINT fk_ledger_tx_identity FOREIGN KEY (transaction_id, wallet_id, amount, currency)
          REFERENCES wager_transactions (id, wallet_id, amount, currency),
        CONSTRAINT ux_ledger_tx UNIQUE (transaction_id),
        CONSTRAINT ux_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount))
      )`);

    this.addSql(`
      CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'rows in % are never changed or deleted', TG_TABLE_NAME USING ERRCODE = 'WG001';
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_change()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_change()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION reject_change()`);

    this.addSql(`
      CREATE FUNCTION ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx_status wager_status;
        tx_kind wager_kind;
        previous_after numeric(20,2);
      BEGIN
        SELECT status, kind INTO tx_status, tx_kind FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx_status IS DISTINCT FROM 'PROCESSED' OR tx_kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry needs a processed transaction that moves balance' USING ERRCODE = 'WG001';
        END IF;

        SELECT balance_after INTO previous_after FROM wallet_ledger_entries
          WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF FOUND THEN
          IF previous_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger entry does not continue from the previous balance' USING ERRCODE = 'WG001';
          END IF;
        ELSIF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id)
           OR NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
          RAISE EXCEPTION 'ledger entry leaves a gap in the wallet history' USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_chain_check BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_check()`);

    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
           OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'WG001';
        END IF;
        IF NEW.balance <> OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'a balance change must bump the version by one' USING ERRCODE = 'WG001';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'the version only changes with the balance' USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard()`);

    // One transaction touches one wallet once, so a single ledger row must explain the final wallet state.
    this.addSql(`
      CREATE FUNCTION wallets_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.version > 1 OR NEW.balance > 0) AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance
        ) THEN
          RAISE EXCEPTION 'wallet balance has no matching ledger entry' USING ERRCODE = 'WG001';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_ledger_consistency()`);

    this.addSql(`
      CREATE FUNCTION ledger_wallet_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM wallets
          WHERE id = NEW.wallet_id AND version = NEW.wallet_version AND balance = NEW.balance_after
        ) THEN
          RAISE EXCEPTION 'ledger entry has no matching wallet balance change' USING ERRCODE = 'WG001';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_wallet_consistency()`);

    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions TO ${APP_ROLE}`);
    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entries TO ${APP_ROLE}`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP TABLE wallets`);
    for (const fn of [
      "reject_change",
      "ledger_chain_check",
      "wallets_guard",
      "wallets_ledger_consistency",
      "ledger_wallet_consistency",
    ]) {
      this.addSql(`DROP FUNCTION ${fn}()`);
    }
    this.addSql(`DROP TYPE ledger_direction`);
    this.addSql(`DROP TYPE wager_status`);
    this.addSql(`DROP TYPE wager_kind`);
  }
}
