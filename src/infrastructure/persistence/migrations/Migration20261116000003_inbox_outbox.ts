import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000003_inbox_outbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  char(64)    NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz NULL,
  CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id              uuid        PRIMARY KEY,
  aggregate_id    uuid        NOT NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,
  occurred_at     timestamptz NOT NULL,
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NULL,
  published_at    timestamptz NULL,
  last_error      text        NULL,
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_pending_is_scheduled CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL),
  CONSTRAINT outbox_payload_event_id CHECK (payload->>'eventId' = id::text)
);

-- Publisher scan: only unpublished rows are indexed, so the index stays small.
CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL;
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
`);
  }
}
