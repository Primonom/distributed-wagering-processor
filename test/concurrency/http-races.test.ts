import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { ApiClient, type HttpResult, wager } from '../helpers/api';
import { eventually } from '../helpers/app';
import { type Instance, queueEnv, spawnCluster, stopAll } from '../helpers/cluster';
import { assertWalletConsistent, newPool } from '../helpers/db';

/**
 * Real parallelism: 3 OS processes (separate pools, separate workers) hit the same
 * PostgreSQL. Requests are fired concurrently and spread round-robin across instances.
 */
let cluster: Instance[];
let clients: ApiClient[];
let db: pg.Pool;
const pick = (i: number) => clients[i % clients.length] as ApiClient;

beforeAll(async () => {
  cluster = await spawnCluster(3, { ...queueEnv(), PENDING_WORKER_ENABLED: 'true' }, 'race');
  clients = cluster.map((i) => new ApiClient(i.baseUrl));
  db = newPool(undefined, 8);
});
afterAll(async () => {
  await stopAll(cluster);
  await db.end();
});

const statuses = (results: HttpResult[]) => results.map((r) => `${r.status}:${r.body.status}:${r.body.failureCode ?? ''}`);
const debits = async (walletId: string) =>
  (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).rows[0]?.n;

describe('idempotency under concurrency', () => {
  test('the same BET sent 50 times in parallel to 3 instances debits exactly once', async () => {
    const w = await pick(0).createWallet('1000.00');
    const bet = wager(w, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => pick(i).submit(bet)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false).length).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '975.00')).toBe(true);
    expect(await debits(w.walletId)).toBe(1);
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('975.00');
  });

  test('parallel identical keys with conflicting payloads: one wins, the others get 409, never a second debit', async () => {
    const w = await pick(0).createWallet('1000.00');
    const base = wager(w, 'BET', '1.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => pick(i).submit({ ...base, money: { amount: `${(i % 3) + 1}.00`, currency: 'BRL' } }, 'same-key-' + base.externalTransactionId)),
    );
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok.length + conflicts.length).toBe(30);
    expect(new Set(ok.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debits(w.walletId)).toBe(1);
    await assertWalletConsistent(db, w.walletId);
  });
});

describe('competing for the same balance', () => {
  test('mandatory scenario ×20: 100.00 and two simultaneous BETs of 80.00 on different instances', async () => {
    const runs = await Promise.all(
      Array.from({ length: 20 }, async (_, run) => {
        const w = await pick(run).createWallet('100.00');
        const [a, b] = await Promise.all([pick(run).submit(wager(w, 'BET', '80.00')), pick(run + 1).submit(wager(w, 'BET', '80.00'))]);
        return { w, results: [a, b] as HttpResult[] };
      }),
    );
    for (const { w, results } of runs) {
      expect(statuses(results).sort()).toEqual(['200:PROCESSED:', '422:REJECTED:INSUFFICIENT_FUNDS']);
      expect(await debits(w.walletId)).toBe(1);
      const b = await assertWalletConsistent(db, w.walletId);
      expect(b.stored).toBe('20.00');
    }
  });

  test('hot wallet: 90 parallel BETs of 1.00 against 50.00 → exactly 50 processed, 40 rejected, 0.00', async () => {
    const w = await pick(0).createWallet('50.00');
    const results = await Promise.all(Array.from({ length: 90 }, (_, i) => pick(i).submit(wager(w, 'BET', '1.00'))));
    const processed = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS').length;
    const unavailable = results.filter((r) => r.status === 503).length;
    expect(unavailable).toBe(0);
    expect(processed).toBe(50);
    expect(rejected).toBe(40);
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('0.00');
    expect(b.version).toBe(51);
  });

  test('concurrent duplicate reversals of the same BET: exactly one REFUND/ROLLBACK is applied', async () => {
    const w = await pick(0).createWallet('100.00');
    const bet = wager(w, 'BET', '40.00');
    await pick(0).submit(bet);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        pick(i).submit(wager(w, i % 2 === 0 ? 'REFUND' : 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.body.failureCode === 'ALREADY_REVERSED').length).toBe(23);
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('100.00');
  });
});

describe('many wallets in parallel', () => {
  test('40 wallets × 10 mixed operations, all concurrent across 3 instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 40 }, (_, i) => pick(i).createWallet('100.00')));
    // per wallet: 6 BET 5.00 (-30), 2 WIN 7.50 (+15), 2 LOSS → expected 85.00
    const ops = wallets.flatMap((w) => [
      ...Array.from({ length: 6 }, () => wager(w, 'BET', '5.00')),
      ...Array.from({ length: 2 }, () => wager(w, 'WIN', '7.50')),
      ...Array.from({ length: 2 }, () => wager(w, 'LOSS', '0.00')),
    ]);
    const shuffled = ops.sort(() => Math.random() - 0.5);
    const started = performance.now();
    const results = await Promise.all(shuffled.map((op, i) => pick(i).submit(op)));
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const w of wallets) {
      const b = await assertWalletConsistent(db, w.walletId);
      expect(b.stored).toBe('85.00');
      expect(b.entries).toBe(9); // opening + 6 debits + 2 credits (LOSS has no line)
    }
    expect(elapsed).toBeGreaterThan(0);
  });
});

describe('out-of-order delivery across instances', () => {
  test('REFUND and its BET sent simultaneously to different instances always converge', async () => {
    const pairs = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const w = await pick(i).createWallet('100.00');
        const bet = wager(w, 'BET', '10.00');
        const refund = wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
        const [r1, r2] = await Promise.all([pick(i).submit(refund), pick(i + 1).submit(bet)]);
        expect([200, 202]).toContain(r1.status);
        expect(r2.status).toBe(200);
        return { w, refundId: r1.body.transactionId as string };
      }),
    );
    for (const { w, refundId } of pairs) {
      await eventually(async () => (await pick(0).request('GET', `/wagering/transactions/${refundId}`)).body.status === 'PROCESSED', { timeoutMs: 20_000 });
      const b = await assertWalletConsistent(db, w.walletId);
      expect(b.stored).toBe('100.00');
    }
  });
});
