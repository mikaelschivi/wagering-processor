import { Migration } from "@mikro-orm/migrations";

export class Migration0003TransactionGuard extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'a % transaction cannot change', OLD.status USING ERRCODE = 'WG001';
        END IF;
        IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id
           OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id
           OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.correlation_id <> OLD.correlation_id OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE = 'WG001';
        END IF;
        IF NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'a stored transaction is never PENDING' USING ERRCODE = 'WG001';
        END IF;
        IF NEW.status = 'PENDING_REFERENCE'
           AND NEW.reference_transaction_id IS DISTINCT FROM OLD.reference_transaction_id THEN
          RAISE EXCEPTION 'the reference is only set when the transaction leaves PENDING_REFERENCE' USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wager_transactions_guard ON wager_transactions`);
    this.addSql(`DROP FUNCTION wager_transactions_guard()`);
  }
}
