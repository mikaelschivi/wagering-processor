import { Migration } from "@mikro-orm/migrations";

const APP_ROLE = process.env.DB_APP_USER ?? "wagering_app";
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error("DB_APP_USER is not a valid role name");

export class Migration0002Messaging extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL CHECK (consumer_name <> ''),
        message_id text NOT NULL CHECK (message_id <> ''),
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        seq bigserial NOT NULL UNIQUE,
        aggregate_id uuid NOT NULL,
        partition_key uuid NOT NULL,
        event_type text NOT NULL CHECK (event_type <> ''),
        event_version integer NOT NULL CHECK (event_version >= 1),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz NULL,
        last_error varchar(500) NULL
      )`);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_messages (seq) WHERE published_at IS NULL`);

    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq OR NEW.aggregate_id <> OLD.aggregate_id
           OR NEW.partition_key <> OLD.partition_key OR NEW.event_type <> OLD.event_type
           OR NEW.event_version <> OLD.event_version OR NEW.payload <> OLD.payload
           OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'WG001';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'a published outbox event cannot change' USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER outbox_guard BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard()`);
    this.addSql(`
      CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION reject_change()`);

    this.addSql(`
      CREATE FUNCTION inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.consumer_name <> OLD.consumer_name OR NEW.message_id <> OLD.message_id
           OR NEW.payload_hash <> OLD.payload_hash OR NEW.received_at <> OLD.received_at THEN
          RAISE EXCEPTION 'inbox identity is immutable' USING ERRCODE = 'WG001';
        END IF;
        IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
          RAISE EXCEPTION 'a processed inbox row cannot change' USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER inbox_guard BEFORE UPDATE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION inbox_guard()`);
    this.addSql(`
      CREATE TRIGGER inbox_no_delete BEFORE DELETE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION reject_change()`);

    this.addSql(`GRANT SELECT, INSERT, UPDATE ON inbox_messages, outbox_messages TO ${APP_ROLE}`);
    this.addSql(`GRANT USAGE, SELECT ON SEQUENCE outbox_messages_seq_seq TO ${APP_ROLE}`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE outbox_messages`);
    this.addSql(`DROP TABLE inbox_messages`);
    this.addSql(`DROP FUNCTION outbox_guard()`);
    this.addSql(`DROP FUNCTION inbox_guard()`);
  }
}
