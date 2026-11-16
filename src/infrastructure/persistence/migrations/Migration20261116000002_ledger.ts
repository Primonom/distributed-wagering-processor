import { Migration } from '@mikro-orm/migrations';

/**
 * Append-only ledger. Guarantees enforced by the database:
 *  - arithmetic of every line (CHECK), non-negative balances, positive amounts;
 *  - at most one line per (transaction, wallet), a gap-free version chain per wallet;
 *  - the line uses the wallet currency and belongs to the transaction's wallet (composite FKs);
 *  - immutability (UPDATE/DELETE/TRUNCATE blocked by triggers);
 *  - wallet.balance always equals the balance_after of the line with wallet.version
 *    (deferred constraint trigger, checked at COMMIT), so balance and ledger cannot drift.
 */
export class Migration20261116000002_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(20,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(20,2) NOT NULL,
  balance_after   numeric(20,2) NOT NULL,
  wallet_version  integer       NOT NULL,
  created_at      timestamptz   NOT NULL,
  CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
  CONSTRAINT ledger_one_entry_per_transaction_wallet UNIQUE (transaction_id, wallet_id),
  CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
  CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_positive CHECK (amount > 0),
  CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),
  CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
  CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
  CONSTRAINT ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  )
);

-- Keyset pagination: WHERE wallet_id = $1 AND (created_at, id) > ($2, $3) ORDER BY created_at, id
CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);

CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

-- Chain: balance_before of version N equals balance_after of version N-1.
CREATE FUNCTION ledger_check_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  prev_after numeric(20,2);
BEGIN
  IF NEW.wallet_version = 1 THEN
    IF NEW.balance_before <> 0 THEN
      RAISE EXCEPTION 'first ledger entry of wallet % must start at 0', NEW.wallet_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT balance_after INTO prev_after FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
  IF FOUND THEN
    IF prev_after <> NEW.balance_before THEN
      RAISE EXCEPTION 'ledger chain broken for wallet % at version %', NEW.wallet_id, NEW.wallet_version USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT (NEW.wallet_version = 2 AND NEW.balance_before = 0
             AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id)) THEN
    -- the only allowed gap is version 1 of a wallet opened with a zero balance
    RAISE EXCEPTION 'ledger chain gap for wallet % at version %', NEW.wallet_id, NEW.wallet_version USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_check_chain();

-- At COMMIT: the line matches a PROCESSED, balance-affecting transaction with the same
-- amount/currency and a compatible direction, and the wallet has caught up with it.
CREATE FUNCTION ledger_check_transaction() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  w_version integer;
BEGIN
  SELECT kind, status, amount, currency INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
  IF t.status <> 'PROCESSED' OR t.kind = 'LOSS' OR t.amount <> NEW.amount OR t.currency <> NEW.currency
     OR (t.kind = 'BET' AND NEW.direction <> 'DEBIT')
     OR (t.kind IN ('WIN','REFUND','OPENING') AND NEW.direction <> 'CREDIT') THEN
    RAISE EXCEPTION 'ledger entry % does not match transaction % (% % %)', NEW.id, NEW.transaction_id, t.kind, t.status, t.amount
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT version INTO w_version FROM wallets WHERE id = NEW.wallet_id;
  IF w_version < NEW.wallet_version THEN
    RAISE EXCEPTION 'ledger entry % is ahead of wallet % version', NEW.id, NEW.wallet_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER ledger_matches_transaction AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction();

-- At COMMIT: every wallet state (balance, version) is backed by the ledger line of that version.
CREATE FUNCTION wallets_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  cur record;
BEGIN
  -- re-read the row: with several updates in one transaction only the final state matters
  SELECT balance, version INTO cur FROM wallets WHERE id = NEW.id;
  IF cur.version = 1 AND cur.balance = 0
     AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wallet_ledger_entries
                  WHERE wallet_id = NEW.id AND wallet_version = cur.version AND balance_after = cur.balance) THEN
    RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger entry', NEW.id, cur.version, cur.balance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger();
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
DROP TRIGGER IF EXISTS wallets_balance_matches_ledger ON wallets;
DROP FUNCTION IF EXISTS wallets_check_ledger();
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP FUNCTION IF EXISTS ledger_check_transaction();
DROP FUNCTION IF EXISTS ledger_check_chain();
DROP FUNCTION IF EXISTS ledger_append_only();
`);
  }
}
