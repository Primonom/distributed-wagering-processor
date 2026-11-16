import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { ApiClient, wager } from '../helpers/api';
import { type TestApp, startTestApp } from '../helpers/app';
import { assertWalletConsistent, newPool } from '../helpers/db';

let t: TestApp;
let api: ApiClient;
let db: pg.Pool;

beforeAll(async () => {
  t = await startTestApp();
  api = new ApiClient(t.baseUrl);
  db = newPool();
});
afterAll(async () => {
  await t.close();
  await db.end();
});

const ledgerCount = async (walletId: string) =>
  (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId])).rows[0]?.n;

describe('POST /wallets', () => {
  test('creates the wallet with an OPENING transaction and CREDIT line in one transaction', async () => {
    const res = await api.request('POST', '/wallets', { playerId: 'player-open-1-' + Date.now(), initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const walletId = res.body.id as string;
    const { rows } = await db.query(`SELECT kind, status, amount::text FROM wager_transactions WHERE wallet_id = $1`, [walletId]);
    expect(rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' }]);
    expect(await ledgerCount(walletId)).toBe(1);
    await assertWalletConsistent(db, walletId);
  });

  test('zero initial balance creates no ledger line', async () => {
    const { walletId } = await api.createWallet('0.00');
    expect(await ledgerCount(walletId)).toBe(0);
    await assertWalletConsistent(db, walletId);
  });

  test('duplicate (playerId, currency) is a 409; another currency is fine', async () => {
    const { playerId } = await api.createWallet('1.00');
    const dup = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('WALLET_ALREADY_EXISTS');
    const usd = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test.each([
    [{ amount: 10, currency: 'BRL' }],
    [{ amount: '10.001', currency: 'BRL' }],
    [{ amount: '-1.00', currency: 'BRL' }],
    [{ amount: '1e2', currency: 'BRL' }],
    [{ amount: 'NaN', currency: 'BRL' }],
    [{ amount: '', currency: 'BRL' }],
    [{ amount: '1.00', currency: 'brl' }],
  ])('invalid initial balance %p → 400', async (initialBalance) => {
    const res = await api.request('POST', '/wallets', { playerId: 'p-invalid', initialBalance });
    expect(res.status).toBe(400);
    expect(['INVALID_PAYLOAD', 'INVALID_MONEY']).toContain(res.body.code);
  });

  test('malformed JSON → 400', async () => {
    const res = await api.request('POST', '/wallets', '{"playerId":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYLOAD');
  });
});

describe('POST /wagering/transactions', () => {
  test('BET → 200 PROCESSED with the resulting balance; one DEBIT line', async () => {
    const w = await api.createWallet('1000.00');
    const res = await api.submit(wager(w, 'BET', '25.00'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerCount(w.walletId)).toBe(2);
    const wallet = await api.request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body).toMatchObject({ balance: { amount: '975.00' }, version: 2 });
    await assertWalletConsistent(db, w.walletId);
  });

  test('identical retry → 200 replay with the ORIGINAL balance, even after later movements', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    const first = await api.submit(bet);
    await api.submit(wager(w, 'BET', '30.00'));
    const replay = await api.submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(await ledgerCount(w.walletId)).toBe(3);
    await assertWalletConsistent(db, w.walletId);
  });

  test('same Idempotency-Key with a different payload → 409, not a replay', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    await api.submit(bet, 'key-' + bet.externalTransactionId);
    const conflict = await api.submit({ ...bet, money: { amount: '10.01', currency: 'BRL' } }, 'key-' + bet.externalTransactionId);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    expect(await ledgerCount(w.walletId)).toBe(2);
  });

  test('same external id under another Idempotency-Key → 409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    await api.submit(bet, 'k1-' + bet.externalTransactionId);
    const res = await api.submit(bet, 'k2-' + bet.externalTransactionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
  });

  test('missing Idempotency-Key → 400', async () => {
    const w = await api.createWallet('100.00');
    const res = await api.submit(wager(w, 'BET', '1.00'), null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('OPENING cannot be submitted; unknown kind and numeric amounts are invalid payloads', async () => {
    const w = await api.createWallet('100.00');
    expect((await api.submit(wager(w, 'OPENING', '1.00'))).body.code).toBe('OPENING_NOT_ALLOWED');
    expect((await api.submit(wager(w, 'JACKPOT', '1.00'))).status).toBe(400);
    const numeric = await api.submit({ ...wager(w, 'BET', '1.00'), money: { amount: 1 as unknown as string, currency: 'BRL' } });
    expect(numeric.status).toBe(400);
    expect((await api.submit(wager(w, 'REFUND', '1.00'))).body.code).toBe('REFERENCE_REQUIRED');
  });

  test('insufficient funds → 422 REJECTED, auditable, no ledger, balance untouched', async () => {
    const w = await api.createWallet('10.00');
    const res = await api.submit(wager(w, 'BET', '10.01'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' }, idempotentReplay: false, providerAction: 'GIVE_UP' });
    expect(typeof res.body.transactionId).toBe('string');
    const tx = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
    expect(tx.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await ledgerCount(w.walletId)).toBe(1);
    const replay = await api.submit(wager(w, 'BET', '10.01', { externalTransactionId: tx.body.externalTransactionId }));
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('wallet not found → 422 WALLET_NOT_FOUND; player mismatch and currency mismatch are persisted rejections', async () => {
    const w = await api.createWallet('10.00');
    const missing = await api.submit(wager({ walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: 'x' }, 'BET', '1.00'));
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ failureCode: 'WALLET_NOT_FOUND', transactionId: null });
    const otherPlayer = await api.submit(wager({ ...w, playerId: 'someone-else' }, 'BET', '1.00'));
    expect(otherPlayer.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    const usd = await api.submit(wager(w, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }));
    expect(usd.status).toBe(422);
    expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await ledgerCount(w.walletId)).toBe(1);
    await assertWalletConsistent(db, w.walletId);
  });

  test('WIN credits, LOSS is processed without ledger and without version bump', async () => {
    const w = await api.createWallet('50.00');
    const bet = wager(w, 'BET', '20.00');
    await api.submit(bet);
    const win = await api.submit(wager(w, 'WIN', '45.50', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.50' } });
    const before = await api.request('GET', `/wallets/${w.walletId}`);
    const loss = await api.submit(wager(w, 'LOSS', '0.00', { roundId: 'round-2' }));
    expect(loss.status).toBe(200);
    expect(loss.body.status).toBe('PROCESSED');
    const after = await api.request('GET', `/wallets/${w.walletId}`);
    expect(after.body.version).toBe(before.body.version);
    expect(await ledgerCount(w.walletId)).toBe(3);
    await assertWalletConsistent(db, w.walletId);
  });

  test('REFUND credits a BET once; any second reversal is ALREADY_REVERSED', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '40.00');
    await api.submit(bet);
    const refund = await api.submit(wager(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const again = await api.submit(wager(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again.body.failureCode).toBe('ALREADY_REVERSED');
    const rollback = await api.submit(wager(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE reference_transaction_id = (SELECT id FROM wager_transactions WHERE external_transaction_id = $1) AND status = 'PROCESSED'`, [bet.externalTransactionId]);
    expect(rows[0].n).toBe(1);
    await assertWalletConsistent(db, w.walletId);
  });

  test('reversal rules: amount, kind and round must match', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    await api.submit(bet);
    const win = wager(w, 'WIN', '5.00');
    await api.submit(win);
    expect((await api.submit(wager(w, 'REFUND', '9.99', { referenceExternalTransactionId: bet.externalTransactionId }))).body.failureCode).toBe('AMOUNT_MISMATCH');
    expect((await api.submit(wager(w, 'REFUND', '5.00', { referenceExternalTransactionId: win.externalTransactionId }))).body.failureCode).toBe('INVALID_REFERENCE_KIND');
    expect((await api.submit(wager(w, 'REFUND', '10.00', { roundId: 'other', referenceExternalTransactionId: bet.externalTransactionId }))).body.failureCode).toBe('REFERENCE_MISMATCH');
    const other = await api.createWallet('100.00');
    expect((await api.submit(wager(other, 'REFUND', '10.00', { referenceExternalTransactionId: bet.externalTransactionId }))).body.failureCode).toBe('REFERENCE_MISMATCH');
    await assertWalletConsistent(db, w.walletId);
  });

  test('ROLLBACK of BET credits; ROLLBACK of WIN debits; ROLLBACK of REFUND debits', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '30.00');
    await api.submit(bet);
    expect((await api.submit(wager(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }))).body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const win = wager(w, 'WIN', '20.00');
    await api.submit(win);
    expect((await api.submit(wager(w, 'ROLLBACK', '20.00', { referenceExternalTransactionId: win.externalTransactionId }))).body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const bet2 = wager(w, 'BET', '15.00', { roundId: 'round-9' });
    await api.submit(bet2);
    const refund = wager(w, 'REFUND', '15.00', { roundId: 'round-9', referenceExternalTransactionId: bet2.externalTransactionId });
    await api.submit(refund);
    const rb = await api.submit(wager(w, 'ROLLBACK', '15.00', { roundId: 'round-9', referenceExternalTransactionId: refund.externalTransactionId }));
    expect(rb.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '85.00' } });
    await assertWalletConsistent(db, w.walletId);
  });

  test('ROLLBACK of a WIN that would overdraw → 422 REVERSAL_WOULD_OVERDRAW (distinct code)', async () => {
    const w = await api.createWallet('0.00');
    const win = wager(w, 'WIN', '50.00');
    await api.submit(win);
    await api.submit(wager(w, 'BET', '40.00', { roundId: 'round-2' }));
    const rb = await api.submit(wager(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect((await api.request('GET', `/wallets/${w.walletId}`)).body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
    await assertWalletConsistent(db, w.walletId);
  });

  test('reference that does not exist yet → 202 PENDING_REFERENCE', async () => {
    const w = await api.createWallet('100.00');
    const res = await api.submit(wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-from-the-future' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    const replay = await api.submit(wager(w, 'REFUND', '10.00', { externalTransactionId: (await api.request('GET', `/wagering/transactions/${res.body.transactionId}`)).body.externalTransactionId, referenceExternalTransactionId: 'bet-from-the-future' }));
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe('queries', () => {
  test('GET transaction by id and by provider/external id; 404 and 400 for unknown/malformed ids', async () => {
    const w = await api.createWallet('10.00');
    const bet = wager(w, 'BET', '1.00');
    const res = await api.submit(bet);
    const byId = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '1.00', currency: 'BRL' }, balance: { amount: '9.00', currency: 'BRL' } });
    const byExt = await api.request('GET', `/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`);
    expect(byExt.body.transactionId).toBe(res.body.transactionId);
    expect((await api.request('GET', '/wagering/transactions/0192f291-27dd-7d3f-8071-5f8685deef37')).status).toBe(404);
    expect((await api.request('GET', `/providers/${bet.providerId}/wagering/transactions/nope`)).status).toBe(404);
    expect((await api.request('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37')).status).toBe(404);
    expect((await api.request('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('ledger keyset pagination walks every line exactly once with an opaque cursor', async () => {
    const w = await api.createWallet('100.00');
    for (let i = 0; i < 7; i++) await api.submit(wager(w, 'BET', '1.00'));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path = `/wallets/${w.walletId}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await api.request('GET', path);
      expect(page.status).toBe(200);
      seen.push(...(page.body.items as Array<{ id: string }>).map((e) => e.id));
      cursor = page.body.nextCursor as string | null;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.length).toBe(8);
    expect(new Set(seen).size).toBe(8);
    expect((await api.request('GET', `/wallets/${w.walletId}/ledger?limit=101`)).status).toBe(400);
    expect((await api.request('GET', `/wallets/${w.walletId}/ledger?cursor=garbage`)).body.code).toBe('INVALID_CURSOR');
  });
});

describe('reconciliation', () => {
  test('consistent wallet', async () => {
    const w = await api.createWallet('100.00');
    await api.submit(wager(w, 'BET', '25.00'));
    const res = await api.request('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergence (balance tampered bypassing all triggers) is reported, counted and NOT corrected', async () => {
    const w = await api.createWallet('100.00');
    const c = await db.connect();
    try {
      // Simulates an out-of-band write that skips application and trigger checks.
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET balance = balance + 5 WHERE id = $1`, [w.walletId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const res = await api.request('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: '5.00', currency: 'BRL' }, storedBalance: { amount: '105.00' }, calculatedBalance: { amount: '100.00' } });
    const again = await api.request('GET', `/wallets/${w.walletId}`);
    expect(again.body.balance.amount).toBe('105.00');
    const metrics = await api.request('GET', '/metrics');
    expect(String(metrics.body)).toMatch(/reconciliation_divergences_total\{[^}]*\} [1-9]/);
  });

  test('unknown wallet → 404', async () => {
    expect((await api.request('POST', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation')).status).toBe(404);
  });
});

describe('ops endpoints', () => {
  test('health and metrics are open and correlation id is echoed', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    const ready = await api.request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', checks: { postgres: { ok: true }, sqs: { ok: true } } });
    const res = await api.request('GET', '/health/live', undefined, { 'X-Correlation-Id': 'corr-abc-123' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc-123');
    const metrics = await api.request('GET', '/metrics');
    for (const name of ['wager_transactions_total', 'idempotent_duplicates_total', 'retries_total', 'dlq_messages_total', 'lock_conflicts_total', 'outbox_lag_seconds', 'processing_duration_seconds']) {
      expect(String(metrics.body)).toContain(name);
    }
  });
});
