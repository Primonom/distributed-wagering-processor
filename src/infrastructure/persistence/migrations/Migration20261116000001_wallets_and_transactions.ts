/**
 * @file Migration20261116000001_wallets_and_transactions.ts
 * @author Pablo Reis Rebonato
 * @description Reversible migration creating wallets and wager_transactions with their constraints and state machine trigger.
 */

import { Migration } from '@mikro-orm/migrations';

/**
 * Wallets and wager transactions. Every invariant that can be expressed declaratively
 * lives here as a constraint; the state machine guard is a trigger.
 */
export class Migration20261116000001_wallets_and_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   text          NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(20,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
  -- target of composite FKs that force ledger lines to use the wallet currency
  CONSTRAINT wallets_id_currency_uq     UNIQUE (id, currency),
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive     CHECK (version >= 1),
  CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_player_id_length     CHECK (length(player_id) BETWEEN 1 AND 128)
);

CREATE TABLE wager_transactions (
  id                                uuid          PRIMARY KEY,
  provider_id                       text          NOT NULL,
  external_transaction_id           text          NOT NULL,
  idempotency_key                   text          NOT NULL,
  payload_hash                      char(64)      NOT NULL,
  wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
  player_id                         text          NOT NULL,
  round_id                          text          NOT NULL,
  game_id                           text          NOT NULL,
  kind                              text          NOT NULL,
  amount                            numeric(20,2) NOT NULL,
  currency                          char(3)       NOT NULL,
  reference_external_transaction_id text          NULL,
  reference_transaction_id          uuid          NULL REFERENCES wager_transactions(id),
  status                            text          NOT NULL,
  failure_code                      text          NULL,
  balance_snapshot                  numeric(20,2) NULL,
  attempts                          integer       NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz   NULL,
  correlation_id                    text          NOT NULL,
  created_at                        timestamptz   NOT NULL,
  updated_at                        timestamptz   NOT NULL,
  processed_at                      timestamptz   NULL,
  CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_idempotency_key_uq   UNIQUE (idempotency_key),
  -- target of the ledger FK (transaction_id, wallet_id): a ledger line must belong to its transaction's wallet
  CONSTRAINT wager_tx_id_wallet_uq         UNIQUE (id, wallet_id),
  CONSTRAINT wager_tx_kind_valid   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT wager_tx_amount_positive     CHECK (kind = 'LOSS' OR amount > 0),
  CONSTRAINT wager_tx_reversal_has_reference CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_processed_reversal_resolved CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_not_self_reference  CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  CONSTRAINT wager_tx_failure_code_iff_failed CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_processed_at        CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CONSTRAINT wager_tx_pending_ref_schedule CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL),
  CONSTRAINT wager_tx_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
  CONSTRAINT wager_tx_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT wager_tx_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wager_tx_currency_format     CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_snapshot_non_negative CHECK (balance_snapshot IS NULL OR balance_snapshot >= 0)
);

-- A transaction can be reversed (REFUND or ROLLBACK) at most once, in total.
CREATE UNIQUE INDEX wager_tx_single_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- Worker scan for out-of-order operations.
CREATE INDEX wager_tx_pending_reference_idx
  ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- Lookup of operations waiting for a given reference (to retry them as soon as it lands).
CREATE INDEX wager_tx_waiting_on_reference_idx
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at);

-- State machine guard: terminal rows are frozen, identity/business fields are immutable,
-- only valid transitions are accepted, and rows are never deleted (audit trail).
CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be deleted (id=%)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
      NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
      OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable fields of wager transaction % cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'invalid transition PENDING_REFERENCE -> PENDING for %', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER wager_tx_guard_update BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();
CREATE TRIGGER wager_tx_guard_delete BEFORE DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();

-- Wallet identity is immutable and version moves by exactly +1 iff the balance changes.
CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets cannot be deleted (id=%)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'wallet identity fields are immutable (id=%)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet % balance change must increment version by 1 (% -> %)', OLD.id, OLD.version, NEW.version USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallet % version can only change together with the balance', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard();
CREATE TRIGGER wallets_guard_delete BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard();
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
DROP FUNCTION IF EXISTS wager_tx_guard();
DROP FUNCTION IF EXISTS wallets_guard();
`);
  }
}
