import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('parses and serialises with a fixed scale of 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('25.05').toJSON()).toEqual({ amount: '25.05', currency: 'BRL' });
    expect(brl('0').toString()).toBe('0.00 BRL');
    expect(brl('999999999999999999.99').amount).toBe('999999999999999999.99');
  });

  test.each([
    ['NaN'], ['Infinity'], ['-Infinity'], ['1e3'], ['1E-2'], [''], [' '], [' 1.00'], ['1.00 '],
    ['1.001'], ['0.005'], ['-1.00'], ['-0.01'], ['+1.00'], ['.5'], ['5.'], ['01.00'], ['1,00'],
    ['0x10'], ['1_000'], ['1000000000000000000.00'],
  ])('rejects invalid contract amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (numbers are never accepted)', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(undefined as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLL'], [''], ['12A']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('arithmetic is exact (no binary floating point)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('0.01').add(brl('999999999999999999.98')).amount).toBe('999999999999999999.99');
    let acc = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) acc = acc.add(brl('0.01'));
    expect(acc.amount).toBe('10.00');
  });

  test('is immutable: every operation returns a new instance', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('negate, sign and comparison helpers', () => {
    const ten = brl('10.00');
    expect(ten.negate().amount).toBe('-10.00');
    expect(ten.negate().isNegative()).toBe(true);
    expect(ten.isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
    expect(brl('9.99').isLessThan(ten)).toBe(true);
    expect(ten.isLessThan(ten)).toBe(false);
    expect(ten.isGreaterThanOrEqual(brl('10'))).toBe(true);
    expect(ten.equals(brl('10'))).toBe(true);
    expect(ten.equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
  });

  test('operations across currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('fromPersisted accepts signed values and normalises -0', () => {
    expect(Money.fromPersisted('-5.00', 'BRL').amount).toBe('-5.00');
    expect(Money.fromPersisted('-0.00', 'BRL').amount).toBe('0.00');
    expect(() => Money.fromPersisted('1.234', 'BRL')).toThrow(InvalidMoneyError);
  });
});
