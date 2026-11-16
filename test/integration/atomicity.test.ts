/**
 * @file atomicity.test.ts
 * @author Pablo Reis Rebonato
 * @description Integration tests proving wallet, ledger, inbox and outbox writes commit or roll back together.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import type pg from 'pg';
import { PORTS, type UnitOfWork } from '../../src/application/ports';
import { InboxMessage, Money, OutboxMessage, WagerTransaction, WagerTransactionKind, WalletBalanceChanged } from '../../src/domain';
import { ApiClient } from '../helpers/api';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertWalletConsistent, hash, id, newPool } from '../helpers/db';

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

async function writeEverything(uow: UnitOfWork, walletId: string, messageId: string, failAtTheEnd: boolean) {
  await uow.run({ name: 'atomicity-test', retryOnConflict: false }, async (repos) => {
    const now = new Date();
    await repos.inbox.tryInsert(
      InboxMessage.rehydrate({ messageId, consumerName: 'atomicity', payloadHash: hash(), receivedAt: now, processedAt: now }),
    );
    const wallet = await repos.wallets.findByIdForUpdate(walletId);
    if (!wallet) throw new Error('wallet missing');
    const tx = WagerTransaction.create({
      id: id(),
      providerId: 'atomic',
      externalTransactionId: `ext-${messageId}`,
      idempotencyKey: `atomic:${messageId}`,
      payloadHash: hash(),
      walletId,
      playerId: wallet.playerId,
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      correlationId: 'c',
      createdAt: now,
    });
    const version = wallet.version;
    const entry = wallet.debit(tx.money, { entryId: id(), transactionId: tx.id, at: now });
    tx.markProcessed(undefined, now, wallet.balance);
    await repos.transactions.insert(tx);
    await repos.wallets.updateBalance(wallet, version);
    await repos.ledger.insert(entry);
    await repos.outbox.insertMany([
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { nextId: id, correlationId: 'c', occurredAt: now })),
    ]);
    if (failAtTheEnd) throw new Error('simulated crash before COMMIT');
  });
}

async function counts(walletId: string, messageId: string) {
  const q = async (sql: string, p: unknown[]) => (await db.query<{ n: number }>(sql, p)).rows[0]?.n;
  return {
    tx: await q(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE external_transaction_id = $1`, [`ext-${messageId}`]),
    ledger: await q(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId]),
    inbox: await q(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = $1`, [messageId]),
    outbox: await q(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1`, [walletId]),
  };
}

test('wallet, transaction, ledger, inbox and outbox commit together or not at all', async () => {
  const uow = t.app.get<UnitOfWork>(PORTS.UnitOfWork);
  const w = await api.createWallet('100.00');
  const before = await counts(w.walletId, 'none');

  const failed = `m-${id()}`;
  await expect(writeEverything(uow, w.walletId, failed, true)).rejects.toThrow('simulated crash');
  expect(await counts(w.walletId, failed)).toEqual({ tx: 0, ledger: before.ledger, inbox: 0, outbox: before.outbox });
  expect((await api.request('GET', `/wallets/${w.walletId}`)).body).toMatchObject({ balance: { amount: '100.00' }, version: 1 });

  const ok = `m-${id()}`;
  await writeEverything(uow, w.walletId, ok, false);
  expect(await counts(w.walletId, ok)).toEqual({ tx: 1, ledger: (before.ledger ?? 0) + 1, inbox: 1, outbox: (before.outbox ?? 0) + 1 });
  await assertWalletConsistent(db, w.walletId);
});

test('a wallet update without its ledger line is refused by the database at COMMIT (balance/ledger cannot drift)', async () => {
  const uow = t.app.get<UnitOfWork>(PORTS.UnitOfWork);
  const w = await api.createWallet('100.00');
  await expect(
    uow.run({ name: 'drift-test', retryOnConflict: false }, async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(w.walletId);
      if (!wallet) throw new Error('missing');
      const version = wallet.version;
      wallet.debit(Money.from({ amount: '1.00', currency: 'BRL' }), { entryId: id(), transactionId: id(), at: new Date() });
      await repos.wallets.updateBalance(wallet, version); // ledger line deliberately "forgotten"
    }),
  ).rejects.toThrow(/no matching ledger entry/);
  await assertWalletConsistent(db, w.walletId);
});

test('version check rejects a stale write (defence in depth on top of the row lock)', async () => {
  const uow = t.app.get<UnitOfWork>(PORTS.UnitOfWork);
  const w = await api.createWallet('100.00');
  await expect(
    uow.run({ name: 'stale-test', retryOnConflict: false }, async (repos) => {
      const wallet = await repos.wallets.findById(w.walletId);
      if (!wallet) throw new Error('missing');
      wallet.debit(Money.from({ amount: '1.00', currency: 'BRL' }), { entryId: id(), transactionId: id(), at: new Date() });
      await repos.wallets.updateBalance(wallet, 99);
    }),
  ).rejects.toThrow(/concurrency conflict/);
});
