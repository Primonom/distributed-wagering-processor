import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvariantViolationError,
  LedgerDirection,
  Money,
  Wallet,
  WalletLedgerEntry,
} from '../../src/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const ids = () => ({ entryId: `e-${++seq}`, transactionId: `t-${seq}`, at });

function openWallet(amount = '100.00') {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(amount), at, opening: { transactionId: 'open-tx', entryId: 'open-entry' } });
}

describe('Wallet', () => {
  test('opens with version 1 and an OPENING credit entry when initial balance > 0', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('opens without ledger entry when initial balance is zero', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    expect(openingEntry).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('positive opening requires the OPENING transaction ids', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at })).toThrow(InvariantViolationError);
  });

  test('debit/credit change balance, bump version by one and return a balanced entry', () => {
    const { wallet } = openWallet('100.00');
    const debit = wallet.debit(brl('80.00'), ids());
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(debit.isBalanced()).toBe(true);
    expect(debit.walletVersion).toBe(2);
    const credit = wallet.credit(brl('5.50'), ids());
    expect(wallet.balance.amount).toBe('25.50');
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.amount).toBe('20.00');
    expect(credit.balanceAfter.amount).toBe('25.50');
  });

  test('never goes negative', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(() => wallet.debit(brl('10.01'), ids())).toThrow(InsufficientBalanceError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    wallet.debit(brl('10.00'), ids());
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('rejects operations in another currency', () => {
    const { wallet } = openWallet('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, ids())).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, ids())).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rejects zero movements (version only changes when balance changes)', () => {
    const { wallet } = openWallet('10.00');
    expect(() => wallet.credit(Money.zero('BRL'), ids())).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate restores state without validation', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('3.00'), version: 7, createdAt: at, updatedAt: at });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('3.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e', walletId: 'w', transactionId: 't', money: brl('10.00'), walletVersion: 2, createdAt: at,
  };

  test('validates arithmetic in the factory', () => {
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, balanceBefore: brl('1.00'), balanceAfter: brl('12.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceBefore: brl('5.00'), balanceAfter: Money.fromPersisted('-5.00', 'BRL') })).toThrow(InvariantViolationError);
    const ok = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceBefore: brl('15.00'), balanceAfter: brl('5.00') });
    expect(ok.isBalanced()).toBe(true);
    expect(ok.signedAmount().amount).toBe('-10.00');
  });

  test('rejects non-positive amounts', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.zero('BRL'), direction: LedgerDirection.Credit, balanceBefore: brl('1'), balanceAfter: brl('1') })).toThrow(InvariantViolationError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, balanceBefore: brl('0'), balanceAfter: brl('10') });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999');
    }).toThrow();
  });
});
