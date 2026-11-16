import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import { ApiClient, wager } from '../helpers/api';
import { type TestApp, eventually, startTestApp, testQueues } from '../helpers/app';
import { assertWalletConsistent, newPool } from '../helpers/db';
import { drain, queueUrl, testSqs } from '../helpers/sqs';

let db: pg.Pool;
const sqs = testSqs();

beforeAll(() => {
  db = newPool();
});
afterAll(async () => {
  await db.end();
  sqs.destroy();
});

describe('out-of-order references (PENDING_REFERENCE worker)', () => {
  let t: TestApp;
  let api: ApiClient;
  beforeAll(async () => {
    t = await startTestApp({ PENDING_WORKER_ENABLED: true, PENDING_MAX_ATTEMPTS: 40, PENDING_RETRY_BASE_MS: 50, PENDING_RETRY_MAX_MS: 100 });
    api = new ApiClient(t.baseUrl);
  });
  afterAll(() => t.close());

  test('REFUND before its BET → 202 PENDING_REFERENCE → BET arrives → REFUND processed once', async () => {
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '30.00');
    const refund = wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await api.submit(refund);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    expect((await api.submit(bet)).body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    const settled = await eventually(async () => {
      const tx = await api.request('GET', `/wagering/transactions/${pending.body.transactionId}`);
      return tx.body.status === 'PROCESSED' ? tx.body : undefined;
    });
    expect(settled.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    // the replay of the original request now returns the final outcome
    const replay = await api.submit(refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '100.00' } });
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('100.00');
    expect(b.entries).toBe(3);
  });

  test('ROLLBACK of a WIN that arrives first is applied after the WIN', async () => {
    const w = await api.createWallet('0.00');
    const win = wager(w, 'WIN', '12.34');
    const rb = await api.submit(wager(w, 'ROLLBACK', '12.34', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb.status).toBe(202);
    await api.submit(win);
    await eventually(async () => (await api.request('GET', `/wagering/transactions/${rb.body.transactionId}`)).body.status === 'PROCESSED');
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('0.00');
  });

  test('events for the pending transition are written to the outbox', async () => {
    const w = await api.createWallet('5.00');
    const res = await api.submit(wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: 'never-1' }));
    const { rows } = await db.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY occurred_at`, [w.walletId]);
    expect(rows.map((r) => r.event_type)).toContain('WagerTransactionPendingReference');
    expect(res.status).toBe(202);
  });
});

describe('reference never arrives', () => {
  test('after the attempt limit the transaction is REJECTED with REFERENCE_NOT_FOUND and an event is emitted', async () => {
    const t = await startTestApp({ PENDING_WORKER_ENABLED: true, PENDING_MAX_ATTEMPTS: 3, PENDING_RETRY_BASE_MS: 20, PENDING_RETRY_MAX_MS: 40 });
    try {
      const api = new ApiClient(t.baseUrl);
      const w = await api.createWallet('10.00');
      const res = await api.submit(wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: 'missing-forever' }));
      expect(res.status).toBe(202);
      const tx = await eventually(async () => {
        const r = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
        return r.body.status === 'REJECTED' ? r.body : undefined;
      });
      expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(tx.attempts).toBe(3);
      const { rows } = await db.query(`SELECT event_type, payload->'data'->>'failureCode' AS code FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionRejected'`, [w.walletId]);
      expect(rows).toEqual([{ event_type: 'WagerTransactionRejected', code: 'REFERENCE_NOT_FOUND' }]);
      await assertWalletConsistent(db, w.walletId);
    } finally {
      await t.close();
    }
  });
});

describe('transactional outbox relay', () => {
  test('publishes committed events to SQS with eventId as dedup id and marks them published', async () => {
    const queues = testQueues();
    const writer = await startTestApp({ ...queues });
    const api = new ApiClient(writer.baseUrl);
    const relay = writer.app.get(PublishOutbox);
    try {
      // publish any backlog left by other test files first, then start clean
      while ((await relay.runOnce()) > 0);
      const eventsUrl = await queueUrl(sqs, queues.SQS_EVENTS_QUEUE);
      await drain(sqs, eventsUrl, { timeoutMs: 3000 });

      const w = await api.createWallet('100.00');
      await api.submit(wager(w, 'BET', '10.00'));
      await api.submit(wager(w, 'LOSS', '0.00', { roundId: 'r2' }));
      const { rows: expected } = await db.query<{ id: string; event_type: string }>(`SELECT id, event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY occurred_at, event_type`, [w.walletId]);
      // OPENING (BalanceChanged + Processed), BET (BalanceChanged + Processed), LOSS (Processed only)
      expect(expected.map((r) => r.event_type).sort()).toEqual([
        'WagerTransactionProcessed', 'WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged',
      ]);
      while ((await relay.runOnce()) > 0);

      const received = await drain(sqs, eventsUrl, { until: (all) => all.length >= expected.length });
      const ids = received.map((m) => JSON.parse(m.Body ?? '{}').eventId);
      expect(new Set(ids)).toEqual(new Set(expected.map((r) => r.id)));
      const sample = JSON.parse(received[0]?.Body ?? '{}');
      expect(sample).toMatchObject({ aggregateId: w.walletId, version: 1 });
      expect(received[0]?.Attributes?.MessageGroupId).toBe(w.walletId);
      expect(received[0]?.Attributes?.MessageDeduplicationId).toBe(sample.eventId);
      const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`, [w.walletId]);
      expect(rows[0].n).toBe(0);
    } finally {
      await writer.close();
    }
  });

  test('SQS unavailable → attempts and backoff recorded, nothing lost; published once SQS is back', async () => {
    const queues = testQueues();
    const broken = await startTestApp({ ...queues, SQS_ENDPOINT: 'http://127.0.0.1:1', SQS_BOOTSTRAP: false, OUTBOX_RETRY_BASE_MS: 50, OUTBOX_RETRY_MAX_MS: 50 });
    const healthy = await startTestApp({ ...queues });
    try {
      while ((await healthy.app.get(PublishOutbox).runOnce()) > 0);
      const api = new ApiClient(broken.baseUrl);
      const w = await api.createWallet('3.00');
      const failedRun = await broken.app.get(PublishOutbox).runOnce();
      expect(failedRun).toBe(0);
      const { rows } = await db.query(`SELECT attempts, next_attempt_at > now() AS deferred, last_error IS NOT NULL AS has_error FROM outbox_messages WHERE aggregate_id = $1`, [w.walletId]);
      expect(rows.length).toBe(2);
      for (const r of rows) expect(r).toEqual({ attempts: 1, deferred: true, has_error: true });

      await eventually(async () => {
        await healthy.app.get(PublishOutbox).runOnce();
        const { rows: left } = await db.query(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`, [w.walletId]);
        return left[0].n === 0;
      });
      const ready = await new ApiClient(broken.baseUrl).request('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.sqs.ok).toBe(false);
    } finally {
      await broken.close();
      await healthy.close();
    }
  });

  test('two concurrent publishers on the same outbox: every event published, none twice', async () => {
    const queues = testQueues();
    const a = await startTestApp({ ...queues, OUTBOX_BATCH_SIZE: 5 });
    const b = await startTestApp({ ...queues, OUTBOX_BATCH_SIZE: 5 });
    try {
      const relayA = a.app.get(PublishOutbox);
      const relayB = b.app.get(PublishOutbox);
      while ((await relayA.runOnce()) > 0);
      const eventsUrl = await queueUrl(sqs, queues.SQS_EVENTS_QUEUE);
      await drain(sqs, eventsUrl, { timeoutMs: 3000 });

      const api = new ApiClient(a.baseUrl);
      const wallets = await Promise.all(Array.from({ length: 10 }, () => api.createWallet('50.00')));
      await Promise.all(wallets.map((w) => api.submit(wager(w, 'BET', '5.00'))));
      const ids = wallets.map((w) => w.walletId);
      const { rows: expected } = await db.query<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[])`, [ids]);
      expect(expected.length).toBe(40);

      let publishedA = 0;
      let publishedB = 0;
      const loop = async (relay: PublishOutbox, add: (n: number) => void) => {
        for (;;) {
          const n = await relay.runOnce();
          if (n === 0) return;
          add(n);
        }
      };
      await Promise.all([loop(relayA, (n) => (publishedA += n)), loop(relayB, (n) => (publishedB += n))]);
      expect(publishedA + publishedB).toBe(40); // each row marked published exactly once
      expect(publishedA).toBeGreaterThan(0);
      expect(publishedB).toBeGreaterThan(0);

      const received = await drain(sqs, eventsUrl, { until: (all) => all.length >= 40 });
      const got = received.map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
      expect(got.length).toBe(40);
      expect(new Set(got)).toEqual(new Set(expected.map((r) => r.id)));
    } finally {
      await a.close();
      await b.close();
    }
  });
});
