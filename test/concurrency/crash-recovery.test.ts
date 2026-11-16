import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { ApiClient, wager } from '../helpers/api';
import { eventually } from '../helpers/app';
import { type Instance, crash, queueEnv, spawnCluster, spawnInstance, stopAll, terminate } from '../helpers/cluster';
import { assertWalletConsistent, newPool } from '../helpers/db';
import { approximateCount, drain, queueUrl, sendWager, testSqs } from '../helpers/sqs';

let db: pg.Pool;
const sqs = testSqs();
const running: Instance[] = [];

async function spawn(name: string, env: Record<string, string>, waitReady = true) {
  const i = await spawnInstance(name, env, { waitReady });
  running.push(i);
  return i;
}

beforeAll(() => {
  db = newPool(undefined, 8);
});
afterAll(async () => {
  await stopAll(running);
  await db.end();
  sqs.destroy();
});

const debits = async (walletId: string) =>
  (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).rows[0]?.n ?? 0;
const queueEmpty = async (url: string) => {
  const c = await approximateCount(sqs, url);
  return c.visible === 0 && c.inFlight === 0;
};

/** Publishes the whole outbox backlog so that a test starts from published_at IS NOT NULL everywhere. */
async function flushOutbox(env: Record<string, string>) {
  const relay = await spawn('flush', { ...env, OUTBOX_ENABLED: 'true' });
  await eventually(async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    return rows[0]?.n === 0;
  }, { timeoutMs: 60_000 });
  await terminate(relay);
}

describe('SQS consumers on 3 instances', () => {
  test('the same operation delivered 50 times (new and repeated messageIds) produces one debit', async () => {
    const env = queueEnv();
    const nodes = await spawnCluster(3, { ...env, CONSUMER_ENABLED: 'true' }, 'sqs');
    running.push(...nodes);
    const api = new ApiClient(nodes[0]!.baseUrl);
    const w = await api.createWallet('500.00');
    const bet = wager(w, 'BET', '50.00');
    const url = await queueUrl(sqs, env.SQS_WAGER_QUEUE!);
    // half of the copies reuse one messageId (inbox hit), half are new messageIds (idempotent replay)
    await Promise.all(Array.from({ length: 50 }, (_, i) => sendWager(sqs, url, bet, i % 2 === 0 ? { messageId: 'dup-msg-' + bet.externalTransactionId } : {})));
    // simultaneous HTTP copies on top
    await Promise.all(nodes.map((n) => new ApiClient(n.baseUrl).submit(bet)));
    await eventually(() => queueEmpty(url), { timeoutMs: 60_000 });
    expect(await debits(w.walletId)).toBe(1);
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('450.00');
    await stopAll(nodes);
  });
});

describe('worker killed after COMMIT and before ACK', () => {
  test('the message is redelivered and the inbox prevents a second effect', async () => {
    const env = { ...queueEnv(), SQS_VISIBILITY_TIMEOUT_S: '2' };
    const writer = await spawn('writer', env);
    const api = new ApiClient(writer.baseUrl);
    const w = await api.createWallet('100.00');
    const bet = wager(w, 'BET', '30.00');

    const victim = await spawn('victim', { ...env, CONSUMER_ENABLED: 'true', FAULT_INJECTION: 'crash_after_commit' });
    const url = await queueUrl(sqs, env.SQS_WAGER_QUEUE!);
    const messageId = await sendWager(sqs, url, bet);
    const exitCode = await victim.proc.exited;
    expect(exitCode).not.toBe(0); // died by SIGKILL right after the commit

    // committed, but never acknowledged: the message is still on the queue
    expect(await debits(w.walletId)).toBe(1);
    const c = await approximateCount(sqs, url);
    expect(c.visible + c.inFlight).toBe(1);

    const rescuer = await spawn('rescuer', { ...env, CONSUMER_ENABLED: 'true' });
    await eventually(() => queueEmpty(url), { timeoutMs: 30_000 });
    expect(await debits(w.walletId)).toBe(1);
    const inbox = await db.query(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = $1`, [messageId]);
    expect(inbox.rows[0].n).toBe(1);
    const b = await assertWalletConsistent(db, w.walletId);
    expect(b.stored).toBe('70.00');
    const metrics = await (await fetch(`${rescuer.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/idempotent_duplicates_total\{source="inbox"[^}]*\} 1/);
    await stopAll([writer, rescuer]);
  });
});

describe('outbox crash scenarios', () => {
  test('commit → process dies before publishing → another instance publishes; crash after publish → duplicate is harmless', async () => {
    // standard (non-FIFO) events queue so that broker-side dedup cannot hide duplicates
    const env = { ...queueEnv(), SQS_EVENTS_QUEUE: `c-${crypto.randomUUID().slice(0, 8)}-events-std`, OUTBOX_BATCH_SIZE: '100' };
    await flushOutbox(env);
    const eventsUrl = await queueUrl(sqs, env.SQS_EVENTS_QUEUE);
    await drain(sqs, eventsUrl, { timeoutMs: 2000 });

    // 1) the writer commits financial changes + outbox rows and is killed before any publication
    const writer = await spawn('writer-no-relay', env);
    const api = new ApiClient(writer.baseUrl);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => api.createWallet('20.00')));
    await Promise.all(wallets.map((w) => api.submit(wager(w, 'BET', '5.00'))));
    await crash(writer);
    const ids = wallets.map((w) => w.walletId);
    const { rows: expected } = await db.query<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL`, [ids]);
    expect(expected.length).toBe(20);

    // 2) a relay publishes the batch and crashes before marking it published (locks released by the dead connection)
    const flaky = await spawn('relay-crash', { ...env, OUTBOX_ENABLED: 'true', FAULT_INJECTION: 'crash_after_publish' }, false);
    await flaky.proc.exited;
    const stillPending = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL`, [ids]);
    expect(stillPending.rows[0]?.n).toBe(20);

    // 3) a healthy instance takes over and publishes everything again
    const healthy = await spawn('relay-ok', { ...env, OUTBOX_ENABLED: 'true' });
    await eventually(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL`, [ids]);
      return rows[0]?.n === 0;
    }, { timeoutMs: 30_000 });

    const received = await drain(sqs, eventsUrl, { until: (all) => all.length >= 40, timeoutMs: 20_000 });
    const eventIds = received.map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    // at-least-once: every committed event arrived, the crashed batch arrived twice
    expect(eventIds.length).toBe(40);
    const unique = new Set(eventIds);
    expect(unique).toEqual(new Set(expected.map((r) => r.id)));
    // consumer-side de-duplication by eventId yields exactly the committed events
    const applied = new Map<string, unknown>();
    for (const m of received) {
      const env2 = JSON.parse(m.Body ?? '{}');
      if (!applied.has(env2.eventId)) applied.set(env2.eventId, env2);
    }
    expect(applied.size).toBe(20);
    await stopAll([healthy]);
  });

  test('two publisher processes drain the same outbox without losing events', async () => {
    const env = { ...queueEnv(), OUTBOX_BATCH_SIZE: '5' };
    await flushOutbox(env);
    const eventsUrl = await queueUrl(sqs, env.SQS_EVENTS_QUEUE!);
    await drain(sqs, eventsUrl, { timeoutMs: 2000 });
    const writer = await spawn('writer2', env);
    const api = new ApiClient(writer.baseUrl);
    const wallets = await Promise.all(Array.from({ length: 15 }, () => api.createWallet('20.00')));
    await Promise.all(wallets.map((w) => api.submit(wager(w, 'BET', '1.00'))));
    const ids = wallets.map((w) => w.walletId);
    const [p1, p2] = await Promise.all([spawn('pub1', { ...env, OUTBOX_ENABLED: 'true' }), spawn('pub2', { ...env, OUTBOX_ENABLED: 'true' })]);
    await eventually(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL`, [ids]);
      return rows[0]?.n === 0;
    }, { timeoutMs: 30_000 });
    const received = await drain(sqs, eventsUrl, { until: (all) => all.length >= 60, timeoutMs: 20_000 });
    expect(new Set(received.map((m) => JSON.parse(m.Body ?? '{}').eventId)).size).toBe(60);
    const count = async (i: Instance) => {
      const text = await (await fetch(`${i.baseUrl}/metrics`)).text();
      return Number.parseInt(/outbox_published_total\{[^}]*\} (\d+)/.exec(text)?.[1] ?? '0', 10);
    };
    expect((await count(p1)) + (await count(p2))).toBe(60);
    await stopAll([writer, p1, p2]);
  });
});

describe('restart with proof of final consistency', () => {
  test('the whole cluster is SIGKILLed mid-traffic (HTTP + SQS); after restart every wallet is consistent and replays add nothing', async () => {
    const env = { ...queueEnv(), CONSUMER_ENABLED: 'true', PENDING_WORKER_ENABLED: 'true', OUTBOX_ENABLED: 'true', SQS_VISIBILITY_TIMEOUT_S: '2' };
    const nodes = await spawnCluster(3, env, 'boot');
    running.push(...nodes);
    const clients = nodes.map((n) => new ApiClient(n.baseUrl));
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => clients[i % 3]!.createWallet('100.00')));
    const url = await queueUrl(sqs, env.SQS_WAGER_QUEUE!);

    const httpOps = wallets.flatMap((w) => Array.from({ length: 6 }, () => wager(w, 'BET', '3.00')));
    const sqsOps = wallets.flatMap((w) => {
      const bet = wager(w, 'BET', '2.00');
      return [bet, wager(w, 'REFUND', '2.00', { referenceExternalTransactionId: bet.externalTransactionId }), wager(w, 'WIN', '1.50')];
    });
    // reversals first for half of them to exercise PENDING_REFERENCE across the restart
    const sqsOrdered = sqsOps.sort(() => Math.random() - 0.5);
    for (const op of sqsOrdered) await sendWager(sqs, url, op);
    const inflight = Promise.allSettled(httpOps.map((op, i) => clients[i % 3]!.submit(op)));
    // pull the plug while traffic is still flowing: as soon as some of it has been committed
    await eventually(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = ANY($1::uuid[]) AND kind <> 'OPENING'`, [wallets.map((w) => w.walletId)]);
      return (rows[0]?.n ?? 0) >= 5;
    }, { intervalMs: 5 });
    await Promise.all(nodes.map((n) => crash(n)));
    await inflight;

    const reborn = await spawnCluster(3, env, 'reborn');
    running.push(...reborn);
    const fresh = reborn.map((n) => new ApiClient(n.baseUrl));
    // providers retry whatever did not get a definitive answer — and everything else too
    const retried = await Promise.all(httpOps.map((op, i) => fresh[i % 3]!.submit(op)));
    expect(retried.every((r) => r.status === 200)).toBe(true);
    await eventually(() => queueEmpty(url), { timeoutMs: 60_000 });
    await eventually(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = ANY($1::uuid[]) AND status = 'PENDING_REFERENCE'`, [wallets.map((w) => w.walletId)]);
      return rows[0]?.n === 0;
    }, { timeoutMs: 30_000 });

    for (const w of wallets) {
      const b = await assertWalletConsistent(db, w.walletId);
      // 100 - 6×3 - 2 + 2 + 1.50
      expect(b.stored).toBe('83.50');
    }
    // second round of retries: pure replays, no new effects
    const before = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ANY($1::uuid[])`, [wallets.map((w) => w.walletId)]);
    const replays = await Promise.all(httpOps.map((op, i) => fresh[(i + 1) % 3]!.submit(op)));
    expect(replays.every((r) => r.status === 200 && r.body.idempotentReplay === true)).toBe(true);
    const after = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ANY($1::uuid[])`, [wallets.map((w) => w.walletId)]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const recon = await fresh[0]!.request('POST', `/wallets/${wallets[0]!.walletId}/reconciliation`);
    expect(recon.body.consistent).toBe(true);
    await stopAll(reborn);
  });

  // On native Windows, Bun's proc.kill('SIGTERM') is a hard TerminateProcess: the graceful path only exists on POSIX.
  test.skipIf(process.platform === 'win32')('SIGTERM under SQS load: graceful drain, connections closed, nothing is lost', async () => {
    const env = { ...queueEnv(), CONSUMER_ENABLED: 'true', SQS_VISIBILITY_TIMEOUT_S: '30' };
    const a = await spawn('graceful-a', { ...env, LOG_LEVEL: 'info' });
    const api = new ApiClient(a.baseUrl);
    const w = await api.createWallet('100.00');
    const url = await queueUrl(sqs, env.SQS_WAGER_QUEUE!);
    for (let i = 0; i < 40; i++) await sendWager(sqs, url, wager(w, 'BET', '1.00'));
    await eventually(async () => (await debits(w.walletId)) >= 2);
    // Nest's shutdown hooks run the whole drain sequence and then re-raise SIGTERM (exit 143 = 128 + 15)
    expect([0, 143]).toContain(await terminate(a));
    const log = await Bun.file(a.logFile).text();
    expect(log).toContain('wager queue consumer stopped');
    expect(log).toContain('connections closed');
    const b = await spawn('graceful-b', env);
    // released messages come back immediately instead of after the 30s visibility timeout
    await eventually(async () => (await debits(w.walletId)) === 40, { timeoutMs: 25_000 });
    const final = await assertWalletConsistent(db, w.walletId);
    expect(final.stored).toBe('60.00');
    await stopAll([b]);
  });
});
