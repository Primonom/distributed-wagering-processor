import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { ensureMigrated, expectPgError, hash, id, newPool } from '../helpers/db';

/**
 * Every invariant the challenge requires "in the schema" is attacked here with raw SQL,
 * bypassing the application entirely.
 */
let db: pg.Pool;
const now = new Date().toISOString();

beforeAll(async () => {
  await ensureMigrated();
  db = newPool();
});
afterAll(async () => {
  await db.end();
});

/** Creates a consistent wallet (+ OPENING tx + ledger line) in one SQL transaction. */
async function seedWallet(balance = '100.00', currency = 'BRL'): Promise<{ walletId: string; playerId: string; openingId: string }> {
  const walletId = id();
  const playerId = `player-${id()}`;
  const openingId = id();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO wallets VALUES ($1,$2,$3,$4,1,$5,$5)`, [walletId, playerId, currency, balance, now]);
    if (!/[1-9]/.test(balance)) {
      await c.query('COMMIT');
      return { walletId, playerId, openingId };
    }
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, correlation_id, created_at, updated_at, processed_at, balance_snapshot)
       VALUES ($1,'internal',$2,$3,$4,$5,$6,'opening','internal','OPENING',$7,$8,'PROCESSED','c',$9,$9,$9,$7)`,
      [openingId, `opening:${walletId}`, `internal:opening:${walletId}`, hash(), walletId, playerId, balance, currency, now],
    );
    await c.query(
      `INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'CREDIT',$4,$5,0,$4,1,$6)`,
      [id(), walletId, openingId, balance, currency, now],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { walletId, playerId, openingId };
}

interface TxOverrides {
  id?: string;
  providerId?: string;
  externalId?: string;
  key?: string;
  kind?: string;
  status?: string;
  amount?: string;
  currency?: string;
  refExt?: string | null;
  refId?: string | null;
  failureCode?: string | null;
  processedAt?: string | null;
  nextAttemptAt?: string | null;
  payloadHash?: string;
}

function insertTx(client: pg.Pool | pg.PoolClient, walletId: string, playerId: string, o: TxOverrides = {}) {
  const txId = o.id ?? id();
  const status = o.status ?? 'PROCESSED';
  return client
    .query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
         correlation_id, created_at, updated_at, processed_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'round-1','game-1',$8,$9,$10,$11,$12,$13,$14,'c',$15,$15,$16,$17)`,
      [
        txId, o.providerId ?? 'prov', o.externalId ?? `ext-${txId}`, o.key ?? `key-${txId}`, o.payloadHash ?? hash(),
        walletId, playerId, o.kind ?? 'BET', o.amount ?? '10.00', o.currency ?? 'BRL', o.refExt ?? null, o.refId ?? null,
        status, o.failureCode !== undefined ? o.failureCode : (status === 'REJECTED' || status === 'FAILED' ? 'INSUFFICIENT_FUNDS' : null), now,
        o.processedAt !== undefined ? o.processedAt : status === 'PROCESSED' ? now : null,
        o.nextAttemptAt !== undefined ? o.nextAttemptAt : status === 'PENDING_REFERENCE' ? now : null,
      ],
    )
    .then(() => txId);
}

/** Applies a debit the way the application does: tx + wallet update + ledger line, in one transaction. */
async function debit(walletId: string, playerId: string, amount: string, before: string, after: string, version: number) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const txId = await insertTx(c, walletId, playerId, { amount });
    await c.query(`UPDATE wallets SET balance = $2, version = $3, updated_at = $4 WHERE id = $1`, [walletId, after, version, now]);
    await c.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'DEBIT',$4,'BRL',$5,$6,$7,$8)`, [id(), walletId, txId, amount, before, after, version, now]);
    await c.query('COMMIT');
    return txId;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('wallets', () => {
  test('one wallet per (player_id, currency)', async () => {
    const { playerId } = await seedWallet('0.00');
    await expectPgError(db.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',0,1,$3,$3)`, [id(), playerId, now]), { code: '23505', constraint: 'wallets_player_currency_uq' });
    // same player, other currency is fine
    await db.query(`INSERT INTO wallets VALUES ($1,$2,'USD',0,1,$3,$3)`, [id(), playerId, now]);
  });

  test('balance can never be negative', async () => {
    await expectPgError(db.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',-0.01,1,$3,$3)`, [id(), `p-${id()}`, now]), { code: '23514', constraint: 'wallets_balance_non_negative' });
  });

  test('version must be >= 1', async () => {
    await expectPgError(db.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',0,0,$3,$3)`, [id(), `p-${id()}`, now]), { code: '23514', constraint: 'wallets_version_positive' });
  });

  test('a positive balance without a ledger entry is rejected at commit', async () => {
    await expectPgError(db.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',50,1,$3,$3)`, [id(), `p-${id()}`, now]), { code: '23514', message: /no matching ledger entry/ });
  });

  test('balance change without matching ledger line is rejected at commit', async () => {
    const { walletId } = await seedWallet('100.00');
    await expectPgError(db.query(`UPDATE wallets SET balance = 90, version = 2 WHERE id = $1`, [walletId]), { code: '23514', message: /no matching ledger entry/ });
  });

  test('version must move by exactly one iff the balance changes', async () => {
    const { walletId } = await seedWallet('100.00');
    await expectPgError(db.query(`UPDATE wallets SET balance = 90, version = 5 WHERE id = $1`, [walletId]), { code: '23514', message: /increment version by 1/ });
    await expectPgError(db.query(`UPDATE wallets SET version = 2 WHERE id = $1`, [walletId]), { code: '23514', message: /only change together/ });
  });

  test('wallets cannot be deleted and identity is immutable', async () => {
    const { walletId } = await seedWallet('0.00');
    await expectPgError(db.query(`DELETE FROM wallets WHERE id = $1`, [walletId]), { code: '23001' });
    await expectPgError(db.query(`UPDATE wallets SET currency = 'USD' WHERE id = $1`, [walletId]), { code: '23001' });
  });

  test('a consistent debit (tx + wallet + ledger in one transaction) is accepted', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    await debit(walletId, playerId, '30.00', '100.00', '70.00', 2);
    const { rows } = await db.query(`SELECT balance::text, version FROM wallets WHERE id = $1`, [walletId]);
    expect(rows[0]).toEqual({ balance: '70.00', version: 2 });
  });
});

describe('wager_transactions', () => {
  test('UNIQUE(provider_id, external_transaction_id)', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    const ext = `ext-${id()}`;
    await insertTx(db, walletId, playerId, { externalId: ext, status: 'REJECTED' });
    await expectPgError(insertTx(db, walletId, playerId, { externalId: ext, status: 'REJECTED' }), { code: '23505', constraint: 'wager_tx_provider_external_uq' });
  });

  test('UNIQUE(idempotency_key)', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    const key = `key-${id()}`;
    await insertTx(db, walletId, playerId, { key, status: 'REJECTED' });
    await expectPgError(insertTx(db, walletId, playerId, { key, status: 'REJECTED' }), { code: '23505', constraint: 'wager_tx_idempotency_key_uq' });
  });

  test('kind and status must be valid', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    await expectPgError(insertTx(db, walletId, playerId, { kind: 'JACKPOT', status: 'REJECTED' }), { code: '23514', constraint: 'wager_tx_kind_valid' });
    await expectPgError(insertTx(db, walletId, playerId, { status: 'DONE', failureCode: null }), { code: '23514', constraint: 'wager_tx_status_valid' });
  });

  test('amount > 0 for BET/WIN/REFUND/ROLLBACK, >= 0 for LOSS', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    await expectPgError(insertTx(db, walletId, playerId, { amount: '0.00', status: 'REJECTED' }), { code: '23514', constraint: 'wager_tx_amount_positive' });
    await expectPgError(insertTx(db, walletId, playerId, { amount: '-1.00', kind: 'LOSS' }), { code: '23514' });
    await insertTx(db, walletId, playerId, { amount: '0.00', kind: 'LOSS' });
  });

  test('REFUND/ROLLBACK require reference_external_transaction_id', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectPgError(insertTx(db, walletId, playerId, { kind, status: 'REJECTED' }), { code: '23514', constraint: 'wager_tx_reversal_has_reference' });
    }
  });

  test('payload_hash is mandatory and well-formed; failure_code iff REJECTED/FAILED', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    await expectPgError(insertTx(db, walletId, playerId, { payloadHash: 'abc', status: 'REJECTED' }), { code: '23514', constraint: 'wager_tx_payload_hash_format' });
    await expectPgError(insertTx(db, walletId, playerId, { status: 'REJECTED', failureCode: null }), { code: '23514', constraint: 'wager_tx_failure_code_iff_failed' });
  });

  test('foreign key to wallets', async () => {
    await expectPgError(insertTx(db, id(), 'p', { status: 'REJECTED' }), { code: '23503' });
  });

  test('OPENING is reserved for the internal provider', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    await expectPgError(insertTx(db, walletId, playerId, { kind: 'OPENING', status: 'REJECTED' }), { code: '23514', constraint: 'wager_tx_opening_is_internal' });
  });

  test('a transaction can be reversed only once (partial unique index)', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const betId = await debit(walletId, playerId, '10.00', '100.00', '90.00', 2);
    const refExt = `ext-${betId}`;
    // reversals rejected by business rules can coexist (audit), PROCESSED ones cannot
    await insertTx(db, walletId, playerId, { kind: 'REFUND', status: 'REJECTED', refExt, refId: betId, failureCode: 'ALREADY_REVERSED' });
    await insertTx(db, walletId, playerId, { kind: 'REFUND', status: 'PROCESSED', refExt, refId: betId });
    await expectPgError(insertTx(db, walletId, playerId, { kind: 'ROLLBACK', status: 'PROCESSED', refExt, refId: betId }), { code: '23505', constraint: 'wager_tx_single_reversal_uq' });
    await expectPgError(insertTx(db, walletId, playerId, { kind: 'REFUND', status: 'PROCESSED', refExt, refId: betId }), { code: '23505', constraint: 'wager_tx_single_reversal_uq' });
  });

  test('terminal transactions are frozen, rows cannot be deleted', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    const txId = await insertTx(db, walletId, playerId, { status: 'REJECTED' });
    await expectPgError(db.query(`UPDATE wager_transactions SET status = 'PROCESSED', failure_code = NULL, processed_at = now() WHERE id = $1`, [txId]), { code: '23001', message: /terminal/ });
    await expectPgError(db.query(`DELETE FROM wager_transactions WHERE id = $1`, [txId]), { code: '23001' });
  });

  test('business fields of a pending transaction are immutable', async () => {
    const { walletId, playerId } = await seedWallet('0.00');
    const txId = await insertTx(db, walletId, playerId, { kind: 'REFUND', refExt: 'x', status: 'PENDING_REFERENCE' });
    await expectPgError(db.query(`UPDATE wager_transactions SET amount = 99 WHERE id = $1`, [txId]), { code: '23001', message: /immutable/ });
    await db.query(`UPDATE wager_transactions SET attempts = attempts + 1 WHERE id = $1`, [txId]);
  });
});

describe('wallet_ledger_entries', () => {
  test('arithmetic CHECK, positive amount, non-negative balance_after', async () => {
    const { walletId, openingId } = await seedWallet('100.00');
    const insert = (dir: string, amount: string, before: string, after: string, version = 2) =>
      db.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,$4,$5,'BRL',$6,$7,$8,$9)`, [id(), walletId, openingId, dir, amount, before, after, version, now]);
    await expectPgError(insert('DEBIT', '10.00', '100.00', '80.00'), { code: '23514', constraint: 'ledger_arithmetic' });
    await expectPgError(insert('CREDIT', '0.00', '100.00', '100.00'), { code: '23514', constraint: 'ledger_amount_positive' });
    await expectPgError(insert('DEBIT', '150.00', '100.00', '-50.00'), { code: '23514' });
    await expectPgError(insert('SIDEWAYS', '1.00', '100.00', '101.00'), { code: '23514' });
  });

  test('at most one ledger line per (transaction, wallet)', async () => {
    const { walletId, openingId } = await seedWallet('100.00');
    await expectPgError(
      db.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'CREDIT',1,'BRL',100,101,2,$4)`, [id(), walletId, openingId, now]),
      { code: '23505', constraint: 'ledger_one_entry_per_transaction_wallet' },
    );
  });

  test('UPDATE, DELETE and TRUNCATE are blocked (append-only)', async () => {
    const { walletId } = await seedWallet('100.00');
    await expectPgError(db.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [walletId]), { code: '23001', message: /append-only/ });
    await expectPgError(db.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId]), { code: '23001', message: /append-only/ });
    await expectPgError(db.query(`TRUNCATE wallet_ledger_entries CASCADE`), { code: '23001', message: /append-only/ });
  });

  test('ledger currency must match the wallet currency (composite FK)', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const txId = await insertTx(c, walletId, playerId, { amount: '1.00', currency: 'USD' });
      await expectPgError(c.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'DEBIT',1,'USD',100,99,2,$4)`, [id(), walletId, txId, now]), { code: '23503', constraint: 'ledger_wallet_currency_fk' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  test('version chain must be continuous (balance_before = previous balance_after)', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const txId = await insertTx(c, walletId, playerId, { amount: '10.00' });
      await expectPgError(c.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'DEBIT',10,'BRL',50,40,2,$4)`, [id(), walletId, txId, now]), { code: '23514', message: /chain broken/ });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  test('a ledger line for a LOSS or REJECTED transaction is rejected at commit', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const txId = await insertTx(c, walletId, playerId, { amount: '10.00', status: 'REJECTED' });
      await c.query(`UPDATE wallets SET balance = 90, version = 2 WHERE id = $1`, [walletId]);
      await c.query(`INSERT INTO wallet_ledger_entries VALUES ($1,$2,$3,'DEBIT',10,'BRL',100,90,2,$4)`, [id(), walletId, txId, now]);
      await expectPgError(c.query('COMMIT'), { code: '23514', message: /does not match transaction/ });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

describe('inbox / outbox', () => {
  test('inbox primary key (consumer_name, message_id)', async () => {
    const msg = `msg-${id()}`;
    await db.query(`INSERT INTO inbox_messages VALUES ('c1', $1, $2, now(), now())`, [msg, hash()]);
    await expectPgError(db.query(`INSERT INTO inbox_messages VALUES ('c1', $1, $2, now(), now())`, [msg, hash()]), { code: '23505', constraint: 'inbox_messages_pk' });
    await db.query(`INSERT INTO inbox_messages VALUES ('c2', $1, $2, now(), now())`, [msg, hash()]);
  });

  test('outbox payload must carry its own eventId and pending rows must be scheduled', async () => {
    const eventId = id();
    await expectPgError(db.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at) VALUES ($1,$2,'X',$3,now(),now())`, [eventId, id(), JSON.stringify({ eventId: id() })]), { code: '23514', constraint: 'outbox_payload_event_id' });
    await expectPgError(db.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at) VALUES ($1,$2,'X',$3,now())`, [eventId, id(), JSON.stringify({ eventId })]), { code: '23514', constraint: 'outbox_pending_is_scheduled' });
  });
});
