/**
 * @file sqs-consumer.test.ts
 * @author Pablo Reis Rebonato
 * @description Integration tests for the SQS consumer: inbox, DLQ, retries leading to FAILED, and graceful shutdown.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { ApiClient, wager } from '../helpers/api';
import { eventually, startTestApp, type TestApp, testQueues } from '../helpers/app';
import { assertWalletConsistent, newPool } from '../helpers/db';
import { approximateCount, drain, queueUrl, sendWager, testSqs } from '../helpers/sqs';

let db: pg.Pool;
const sqs = testSqs();

beforeAll(() => {
  db = newPool();
});
afterAll(async () => {
  await db.end();
  sqs.destroy();
});

const txByExternal = async (externalId: string) =>
  (await db.query(`SELECT id, status, failure_code FROM wager_transactions WHERE external_transaction_id = $1`, [externalId])).rows;
const debits = async (walletId: string) =>
  (
    await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [
      walletId,
    ])
  ).rows[0]?.n;

describe('SQS consumer', () => {
  let t: TestApp;
  let api: ApiClient;
  let wagerUrl: string;
  let dlqUrl: string;

  beforeAll(async () => {
    t = await startTestApp({ CONSUMER_ENABLED: true, PENDING_WORKER_ENABLED: true });
    api = new ApiClient(t.baseUrl);
    wagerUrl = await queueUrl(sqs, t.config.SQS_WAGER_QUEUE);
    dlqUrl = await queueUrl(sqs, t.config.SQS_WAGER_DLQ);
  });
  afterAll(() => t.close());

  test('processes a message through the same use case, records the inbox and acks after commit', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '25.00');
    const messageId = await sendWager(sqs, wagerUrl, bet);
    const rows = await eventually(async () => {
      const r = await txByExternal(bet.externalTransactionId);
      return r.length ? r : undefined;
    });
    expect(rows[0].status).toBe('PROCESSED');
    const inbox = await db.query(`SELECT consumer_name, processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id = $1`, [
      messageId,
    ]);
    expect(inbox.rows).toEqual([{ consumer_name: t.config.CONSUMER_NAME, processed: true }]);
    await eventually(async () => {
      const c = await approximateCount(sqs, wagerUrl);
      return c.visible === 0 && c.inFlight === 0;
    });
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('75.00');
  });

  test('redelivery of the same messageId (broker dedup bypassed) has no extra effect — inbox', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    const messageId = await sendWager(sqs, wagerUrl, bet);
    await sendWager(sqs, wagerUrl, bet, { messageId });
    await sendWager(sqs, wagerUrl, bet, { messageId });
    await eventually(async () => {
      const c = await approximateCount(sqs, wagerUrl);
      return (await txByExternal(bet.externalTransactionId)).length === 1 && c.visible === 0 && c.inFlight === 0;
    });
    expect(await debits(w.walletId)).toBe(1);
    const metrics = await api.request('GET', '/metrics');
    expect(String(metrics.body)).toMatch(/idempotent_duplicates_total\{source="inbox"[^}]*\} [1-9]/);
    await assertWalletConsistent(db, w.walletId);
  });

  test('same operation through another messageId and through HTTP is an idempotent replay', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '10.00');
    await sendWager(sqs, wagerUrl, bet);
    await sendWager(sqs, wagerUrl, bet);
    const http = await api.submit(bet);
    expect([200]).toContain(http.status);
    await eventually(async () => {
      const c = await approximateCount(sqs, wagerUrl);
      return c.visible === 0 && c.inFlight === 0;
    });
    expect(await debits(w.walletId)).toBe(1);
    await assertWalletConsistent(db, w.walletId);
  });

  test('business rejection is committed and acked (not retried, not DLQ)', async () => {
    const w = await api.createWallet('5.00');
    const bet = wager(w, 'BET', '50.00');
    await sendWager(sqs, wagerUrl, bet);
    const rows = await eventually(async () => {
      const r = await txByExternal(bet.externalTransactionId);
      return r.length ? r : undefined;
    });
    expect(rows[0]).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    await eventually(async () => {
      const c = await approximateCount(sqs, wagerUrl);
      return c.visible === 0 && c.inFlight === 0;
    });
  });

  test('poison messages (invalid JSON, numeric amount, OPENING, idempotency conflict) go to the DLQ', async () => {
    await drain(sqs, dlqUrl, { timeoutMs: 2000 });
    const w = await api.createWallet('100.00');
    const valid = wager(w, 'BET', '1.00');
    await api.submit(valid, `shared-key-${valid.externalTransactionId}`);

    await sendWager(sqs, wagerUrl, valid, { body: '{not json' });
    await sendWager(sqs, wagerUrl, valid, {
      body: JSON.stringify({
        messageId: 'm-num',
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...valid, money: { amount: 1, currency: 'BRL' }, idempotencyKey: 'x' },
      }),
    });
    await sendWager(sqs, wagerUrl, wager(w, 'OPENING', '1.00'));
    await sendWager(
      sqs,
      wagerUrl,
      { ...valid, money: { amount: '2.00', currency: 'BRL' }, externalTransactionId: 'other-ext' },
      { idempotencyKey: `shared-key-${valid.externalTransactionId}` },
    );

    const dead = await drain(sqs, dlqUrl, { until: (all) => all.length >= 4, timeoutMs: 20_000 });
    const reasons = dead.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(['IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'INVALID_JSON', 'INVALID_PAYLOAD', 'OPENING_NOT_ALLOWED']);
    await eventually(async () => {
      const c = await approximateCount(sqs, wagerUrl);
      return c.visible === 0 && c.inFlight === 0;
    });
    expect(await debits(w.walletId)).toBe(1);
    const metrics = await api.request('GET', '/metrics');
    expect(String(metrics.body)).toMatch(/dlq_messages_total\{reason="INVALID_JSON"/);
  });

  test('REFUND via SQS before its BET is parked and settled when the BET arrives', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '20.00');
    const refund = wager(w, 'REFUND', '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await sendWager(sqs, wagerUrl, refund);
    await eventually(async () => (await txByExternal(refund.externalTransactionId))[0]?.status === 'PENDING_REFERENCE');
    await sendWager(sqs, wagerUrl, bet);
    await eventually(async () => (await txByExternal(refund.externalTransactionId))[0]?.status === 'PROCESSED');
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('100.00');
  });
});

describe('transient failures, retry and DLQ', () => {
  test('a message that keeps failing transiently is retried with backoff, recorded as FAILED and dead-lettered after maxReceiveCount', async () => {
    const queues = testQueues();
    const t = await startTestApp({
      ...queues,
      CONSUMER_ENABLED: true,
      SQS_MAX_RECEIVE_COUNT: 3,
      SQS_RETRY_BASE_S: 1,
      SQS_RETRY_MAX_S: 1,
      DB_LOCK_TIMEOUT_MS: 100,
      TX_MAX_RETRIES: 0,
    });
    const api = new ApiClient(t.baseUrl);
    const w = await api.createWallet('100.00');
    const blocker = await db.connect();
    try {
      // Hold a conflicting row lock: every attempt hits lock_timeout (a transient failure).
      // FOR NO KEY UPDATE still allows the FK check of the FAILED audit row.
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR NO KEY UPDATE', [w.walletId]);
      const bet = wager(w, 'BET', '10.00');
      await sendWager(sqs, await queueUrl(sqs, queues.SQS_WAGER_QUEUE), bet);
      const dead = await drain(sqs, await queueUrl(sqs, queues.SQS_WAGER_DLQ), { until: (all) => all.length >= 1, timeoutMs: 30_000 });
      expect(dead[0]?.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
      expect(dead[0]?.MessageAttributes?.receiveCount?.StringValue).toBe('3');
      const rows = await txByExternal(bet.externalTransactionId);
      expect(rows).toEqual([{ id: expect.any(String), status: 'FAILED', failure_code: 'INFRASTRUCTURE_PERMANENT_FAILURE' }]);
      const metrics = String((await api.request('GET', '/metrics')).body);
      expect(metrics).toMatch(/retries_total\{reason="sqs_transient"[^}]*\} 2/);
      expect(metrics).toMatch(/lock_conflicts_total\{reason="lock_timeout"/);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await t.close();
    }
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('100.00');
  });
});

describe('graceful shutdown', () => {
  test('closing a consumer mid-stream loses nothing: in-flight work completes, the rest is redelivered to another consumer', async () => {
    const queues = testQueues();
    const first = await startTestApp({ ...queues, CONSUMER_ENABLED: true, CONSUMER_CONCURRENCY: 10, SQS_VISIBILITY_TIMEOUT_S: 30 });
    const api = new ApiClient(first.baseUrl);
    const w = await api.createWallet('1000.00');
    const url = await queueUrl(sqs, queues.SQS_WAGER_QUEUE);
    const bets = Array.from({ length: 30 }, () => wager(w, 'BET', '1.00'));
    // one message group (the wallet) → processed sequentially, so shutdown happens mid-batch
    for (const bet of bets) await sendWager(sqs, url, bet);
    await eventually(async () => ((await debits(w.walletId)) ?? 0) >= 1);
    await first.close();
    const afterFirst = (await debits(w.walletId)) ?? 0;

    // a 30s visibility timeout would delay redelivery; released messages must come back immediately
    const second = await startTestApp({ ...queues, CONSUMER_ENABLED: true });
    try {
      await eventually(async () => (await debits(w.walletId)) === 30, { timeoutMs: 25_000 });
      expect(afterFirst).toBeLessThanOrEqual(30);
      const b = await assertWalletConsistent(db, w.walletId);
      expect(b.stored).toBe('970.00');
      const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [
        w.walletId,
      ]);
      expect(rows[0].n).toBe(30);
    } finally {
      await second.close();
    }
  });
});
