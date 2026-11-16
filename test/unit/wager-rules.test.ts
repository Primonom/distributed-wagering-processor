/**
 * @file wager-rules.test.ts
 * @author Pablo Reis Rebonato
 * @description Unit tests for WagerTransaction creation, its state machine and the wager business rules.
 */

import { describe, expect, test } from 'bun:test';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind as K,
  LedgerDirection,
  Money,
  WagerTransactionStatus as S,
  WagerProcessor,
  WagerTransaction,
  Wallet,
} from '../../src/domain';

const at = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
let seq = 0;

function wallet(balance = '100.00'): Wallet {
  return Wallet.rehydrate({ id: 'w-1', playerId: 'p-1', currency: 'BRL', balance: brl(balance), version: 1, createdAt: at, updatedAt: at });
}

function tx(kind: K, amount = '10.00', overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  const n = ++seq;
  return WagerTransaction.create({
    id: `tx-${n}`,
    providerId: 'prov',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `prov:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind,
    money: brl(amount),
    correlationId: 'corr',
    createdAt: at,
    ...overrides,
  });
}

/** Builds a PROCESSED transaction as it would come back from the database. */
function processed(kind: K, amount = '10.00', overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  const t = tx(kind, amount, overrides);
  return WagerTransaction.rehydrate({
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    correlationId: 'c',
    createdAt: at,
    status: S.Processed,
    processedAt: at,
    attempts: 0,
    updatedAt: at,
    referenceTransactionId: t.referenceExternalTransactionId ? 'some-ref' : undefined,
  });
}

function run(t: WagerTransaction, w: Wallet, reference?: WagerTransaction, alreadyReversed = false) {
  const decision = WagerProcessor.decide(t, w, { reference, alreadyReversed });
  if (decision.outcome === 'WAIT_FOR_REFERENCE') return { decision, entry: undefined };
  const entry = WagerProcessor.apply(t, w, decision, { entryId: `entry-${++seq}` }, at);
  return { decision, entry };
}

describe('WagerTransaction creation', () => {
  test('is born PENDING', () => {
    expect(tx(K.Bet).status).toBe(S.Pending);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => tx(K.Opening)).toThrow(InvalidWagerTransactionError);
    try {
      tx(K.Opening);
    } catch (e) {
      expect((e as InvalidWagerTransactionError).code).toBe('OPENING_NOT_ALLOWED');
    }
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => tx(K.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Rollback)).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET cannot carry a reference; a transaction cannot reference itself', () => {
    expect(() => tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('amount must be positive (LOSS may be zero)', () => {
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Win, '0')).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Loss, '0.00').affectsBalance()).toBe(false);
  });

  test('matchesPayload compares the payload hash', () => {
    const t = tx(K.Bet, '1.00', { payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('abd')).toBe(false);
  });
});

describe('state machine', () => {
  test('terminal states cannot transition', () => {
    const t = tx(K.Bet);
    t.markProcessed(undefined, at, brl('1.00'));
    expect(t.isTerminal()).toBe(true);
    expect(() => t.reject(FailureCode.InsufficientFunds, at, brl('1'))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InfrastructurePermanentFailure, at)).toThrow(InvalidTransactionStateError);
    expect(() => t.markProcessed(undefined, at, brl('1'))).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(at, at, brl('1'))).toThrow(InvalidTransactionStateError);

    const r = tx(K.Bet);
    r.reject(FailureCode.InsufficientFunds, at, brl('0'));
    expect(() => r.markProcessed(undefined, at, brl('1'))).toThrow(InvalidTransactionStateError);
    const f = tx(K.Bet);
    f.fail(FailureCode.InfrastructurePermanentFailure, at);
    expect(f.status).toBe(S.Failed);
    expect(() => f.reject(FailureCode.InsufficientFunds, at, brl('0'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → PENDING_REFERENCE → retry → PROCESSED', () => {
    const t = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'bet' });
    t.markPendingReference(new Date(at.getTime() + 1000), at, brl('5'));
    expect(t.status).toBe(S.PendingReference);
    expect(() => t.markPendingReference(at, at, brl('5'))).toThrow(InvalidTransactionStateError);
    t.scheduleReferenceRetry(new Date(at.getTime() + 2000), at);
    expect(t.attempts).toBe(1);
    t.markProcessed('ref-id', at, brl('15'));
    expect(t.status).toBe(S.Processed);
    expect(t.nextAttemptAt).toBeUndefined();
    expect(() => t.scheduleReferenceRetry(at, at)).toThrow(InvalidTransactionStateError);
  });

  test('ledgerDirectionFor', () => {
    expect(tx(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(processed(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(processed(K.Win))).toBe(LedgerDirection.Debit);
    expect(() => tx(K.Loss).ledgerDirectionFor()).toThrow();
  });
});

describe('business rules (section 7)', () => {
  test('BET debits and produces one DEBIT entry', () => {
    const w = wallet('100.00');
    const t = tx(K.Bet, '25.00');
    const { entry } = run(t, w);
    expect(t.status).toBe(S.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
    expect(t.balanceSnapshot?.amount).toBe('75.00');
  });

  test('BET with insufficient funds is REJECTED, no entry, balance untouched', () => {
    const w = wallet('10.00');
    const t = tx(K.Bet, '10.01');
    const { entry } = run(t, w);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(entry).toBeUndefined();
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('section 8 scenario (sequentialised by the wallet lock): 100.00, two BETs of 80.00', () => {
    const w = wallet('100.00');
    const a = tx(K.Bet, '80.00');
    const b = tx(K.Bet, '80.00');
    run(a, w);
    run(b, w);
    expect(a.status).toBe(S.Processed);
    expect(b.status).toBe(S.Rejected);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('20.00');
  });

  test('WIN credits, with or without BET reference', () => {
    const w = wallet('0.00');
    const win = tx(K.Win, '50.00');
    expect(run(win, w).entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('50.00');
    const bet = processed(K.Bet, '5.00');
    const win2 = tx(K.Win, '7.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run(win2, w, bet);
    expect(win2.status).toBe(S.Processed);
    expect(win2.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('57.00');
  });

  test('WIN referencing a non-BET is INVALID_REFERENCE_KIND', () => {
    const otherWin = processed(K.Win);
    const win = tx(K.Win, '1.00', { referenceExternalTransactionId: otherWin.externalTransactionId });
    run(win, wallet(), otherWin);
    expect(win.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('LOSS is PROCESSED without moving balance or producing ledger', () => {
    const w = wallet('10.00');
    const loss = tx(K.Loss, '0.00');
    const { entry, decision } = run(loss, w);
    expect(decision.outcome).toBe('PROCESS');
    expect(loss.status).toBe(S.Processed);
    expect(entry).toBeUndefined();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('10.00');
  });

  test('REFUND credits a PROCESSED BET of the same amount', () => {
    const w = wallet('75.00');
    const bet = processed(K.Bet, '25.00');
    const refund = tx(K.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const { entry } = run(refund, w, bet);
    expect(refund.status).toBe(S.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('REFUND only references BET', () => {
    const win = processed(K.Win);
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    run(refund, wallet(), win);
    expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('reversal amount must equal the reference amount', () => {
    const bet = processed(K.Bet, '25.00');
    const refund = tx(K.Refund, '24.99', { referenceExternalTransactionId: bet.externalTransactionId });
    run(refund, wallet(), bet);
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('a reference cannot be reversed twice', () => {
    const bet = processed(K.Bet, '25.00');
    const refund = tx(K.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run(refund, wallet(), bet, true);
    expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    const rollback = tx(K.Rollback, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run(rollback, wallet(), bet, true);
    expect(rollback.failureCode).toBe(FailureCode.AlreadyReversed);
  });

  test('ROLLBACK of BET credits; ROLLBACK of WIN/REFUND debits', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '10.00');
    const rbBet = tx(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(rbBet, w, bet).entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('110.00');

    const win = processed(K.Win, '30.00');
    const rbWin = tx(K.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(run(rbWin, w, win).entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('80.00');

    const refund = processed(K.Refund, '5.00', { referenceExternalTransactionId: 'b' });
    const rbRefund = tx(K.Rollback, '5.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(run(rbRefund, w, refund).entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
  });

  test('ROLLBACK that would overdraw is REVERSAL_WOULD_OVERDRAW (distinct from INSUFFICIENT_FUNDS)', () => {
    const w = wallet('10.00');
    const win = processed(K.Win, '30.00');
    const rb = tx(K.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
    const { entry } = run(rb, w, win);
    expect(rb.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(entry).toBeUndefined();
    expect(w.balance.amount).toBe('10.00');
  });

  test('ROLLBACK cannot reference LOSS, OPENING or ROLLBACK', () => {
    for (const kind of [K.Loss, K.Rollback]) {
      const ref = processed(kind, '10.00', kind === K.Rollback ? { referenceExternalTransactionId: 'zz' } : {});
      const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: ref.externalTransactionId });
      run(rb, wallet(), ref);
      expect(rb.failureCode).toBe(FailureCode.InvalidReferenceKind);
    }
  });

  test('reference must belong to the same wallet, player, currency and round', () => {
    const cases: Array<Partial<Parameters<typeof WagerTransaction.create>[0]>> = [
      { roundId: 'other-round' },
      { walletId: 'w-2' },
      { playerId: 'p-2' },
      { money: Money.from({ amount: '10.00', currency: 'USD' }) },
    ];
    for (const override of cases) {
      const bet = processed(K.Bet, '10.00', override);
      const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      run(refund, wallet(), bet);
      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    }
  });

  test('missing or not-yet-processed reference waits (PENDING_REFERENCE path)', () => {
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'not-there' });
    expect(run(refund, wallet()).decision).toEqual({ outcome: 'WAIT_FOR_REFERENCE', reason: 'NOT_FOUND' });
    const pendingBet = tx(K.Bet, '10.00');
    const refund2 = tx(K.Refund, '10.00', { referenceExternalTransactionId: pendingBet.externalTransactionId });
    expect(run(refund2, wallet(), pendingBet).decision).toEqual({ outcome: 'WAIT_FOR_REFERENCE', reason: 'NOT_YET_PROCESSED' });
  });

  test('rejected reference → REFERENCE_NOT_PROCESSED', () => {
    const bet = tx(K.Bet, '10.00');
    bet.reject(FailureCode.InsufficientFunds, at, brl('0'));
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run(refund, wallet(), bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('currency and player mismatches against the wallet', () => {
    const usdBet = tx(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    run(usdBet, wallet());
    expect(usdBet.failureCode).toBe(FailureCode.CurrencyMismatch);
    const otherPlayer = tx(K.Bet, '1.00', { playerId: 'p-9' });
    run(otherPlayer, wallet());
    expect(otherPlayer.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test('REJECTED never changes balance or version', () => {
    const w = wallet('5.00');
    for (const t of [tx(K.Bet, '6.00'), tx(K.Bet, '1.00', { playerId: 'x' })]) run(t, w);
    expect(w.balance.amount).toBe('5.00');
    expect(w.version).toBe(1);
  });
});
