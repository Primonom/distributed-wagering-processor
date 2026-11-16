/**
 * @file messaging-and-events.test.ts
 * @author Pablo Reis Rebonato
 * @description Unit tests for canonical JSON, payload hashing, backoff, inbox and integration events.
 */

import { describe, expect, test } from 'bun:test';
import {
  BackoffPolicy,
  canonicalJson,
  computeWagerPayloadHash,
  FailureCode,
  InboxMessage,
  InvalidTransactionStateError,
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  Wallet,
  WalletBalanceChanged,
} from '../../src/domain';

const at = new Date('2026-01-01T00:00:00.000Z');
let n = 0;
const ctx = { nextId: () => `evt-${++n}`, correlationId: 'corr-1', causationId: 'cause-1', occurredAt: at };

describe('canonical JSON and payload hash', () => {
  test('keys are sorted recursively, undefined omitted', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, 1] }, z: undefined })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  test('rejects floats so that money can never leak in as a number', () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(TypeError);
  });

  const base = {
    providerId: 'p',
    externalTransactionId: 'e',
    playerId: 'pl',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('same business fields → same hash regardless of key order', () => {
    const shuffled = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'pl',
      externalTransactionId: 'e',
      providerId: 'p',
    };
    expect(computeWagerPayloadHash(base)).toBe(computeWagerPayloadHash(shuffled));
    expect(computeWagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('any divergent business field changes the hash (idempotency conflict detection)', () => {
    const h = computeWagerPayloadHash(base);
    expect(computeWagerPayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(h);
    expect(computeWagerPayloadHash({ ...base, kind: 'WIN' })).not.toBe(h);
    expect(computeWagerPayloadHash({ ...base, roundId: 'r2' })).not.toBe(h);
    expect(computeWagerPayloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(h);
  });

  test('a transaction whose stored hash differs does not match the new payload', () => {
    const stored = WagerTransaction.create({
      id: 't',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'p:e',
      payloadHash: computeWagerPayloadHash(base),
      walletId: 'w',
      playerId: 'pl',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Bet,
      money: Money.from(base.money),
      correlationId: 'c',
      createdAt: at,
    });
    expect(stored.matchesPayload(computeWagerPayloadHash(base))).toBe(true);
    expect(stored.matchesPayload(computeWagerPayloadHash({ ...base, money: { amount: '99.00', currency: 'BRL' } }))).toBe(false);
  });
});

describe('BackoffPolicy', () => {
  test('grows exponentially, is capped and jittered within [d/2, d]', () => {
    const p = BackoffPolicy.create({ baseMs: 1000, factor: 2, maxMs: 8000, jitter: false });
    expect([1, 2, 3, 4, 5, 6].map((a) => p.delayFor(a))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    const j = BackoffPolicy.create({ baseMs: 1000, factor: 2, maxMs: 8000, jitter: true });
    expect(j.delayFor(3, () => 0)).toBe(2000);
    expect(j.delayFor(3, () => 1)).toBe(4000);
  });
});

describe('InboxMessage', () => {
  test('processes once', () => {
    const msg = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });
});

describe('Integration events and outbox', () => {
  const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
  const tx = WagerTransaction.create({
    id: 't',
    providerId: 'prov',
    externalTransactionId: 'e',
    idempotencyKey: 'k',
    payloadHash: 'h',
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    gameId: 'g',
    kind: WagerTransactionKind.Win,
    money: Money.from({ amount: '5.00', currency: 'BRL' }),
    correlationId: 'corr-1',
    createdAt: at,
  });

  test('event types and versions live on the subclasses; data is JSON-stable', () => {
    const entry = wallet.credit(tx.money, { entryId: 'le', transactionId: tx.id, at });
    tx.markProcessed(undefined, at, wallet.balance);
    const changed = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = changed.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.data).toEqual({
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Credit,
      money: { amount: '5.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '5.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(WagerTransactionProcessed.from(tx, wallet, ctx).toJSON().data.balanceAfter).toEqual({ amount: '5.00', currency: 'BRL' });
  });

  test('rejected and pending-reference events', () => {
    const rej = WagerTransaction.create({ ...baseProps(), id: 't2' });
    rej.reject(FailureCode.InsufficientFunds, at, wallet.balance);
    expect(WagerTransactionRejected.from(rej, wallet, ctx).toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
    const pend = WagerTransaction.create({
      ...baseProps(),
      id: 't3',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'b',
    });
    pend.markPendingReference(new Date(at.getTime() + 1000), at, wallet.balance);
    const evt = WagerTransactionPendingReference.from(pend, ctx).toJSON();
    expect(evt.eventType).toBe('WagerTransactionPendingReference');
    expect(evt.data.nextAttemptAt).toBe('2026-01-01T00:00:01.000Z');
  });

  test('outbox: enqueue → retry with backoff → published', () => {
    const event = WagerTransactionProcessed.from(tx, wallet, ctx);
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at)).toBe(true);
    const policy = BackoffPolicy.create({ baseMs: 1000, factor: 2, maxMs: 10_000, jitter: false });
    msg.scheduleRetry(at, 'boom', policy);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt?.getTime()).toBe(at.getTime() + 1000);
    expect(msg.isDue(at)).toBe(false);
    msg.scheduleRetry(at, 'boom', policy);
    expect(msg.nextAttemptAt?.getTime()).toBe(at.getTime() + 2000);
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(at)).toThrow(InvalidTransactionStateError);
    expect(() => msg.scheduleRetry(at)).toThrow(InvalidTransactionStateError);
  });
});

function baseProps() {
  return {
    id: 'x',
    providerId: 'prov',
    externalTransactionId: `e-${++n}`,
    idempotencyKey: `k-${n}`,
    payloadHash: 'h',
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    gameId: 'g',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '5.00', currency: 'BRL' }),
    correlationId: 'corr-1',
    createdAt: at,
  };
}
