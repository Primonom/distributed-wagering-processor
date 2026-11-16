/**
 * @file money.ts
 * @author Pablo Reis Rebonato
 * @description Immutable fixed-scale Money value object backed by decimal.js, with string-only input and output.
 */

import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** DTO shape used on every external contract (HTTP, SQS, events). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Isolated Decimal constructor: we never touch the global Decimal configuration.
 * Precision 40 is far above NUMERIC(20,2) so arithmetic between valid amounts is exact.
 */
const Dec = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export const MONEY_SCALE = 2;
/** NUMERIC(20,2) => at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const UNSIGNED_AMOUNT = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${MONEY_SCALE}})?$`);
const SIGNED_AMOUNT = new RegExp(`^-?(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${MONEY_SCALE}})?$`);
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Immutable monetary value with a fixed scale of 2 decimal places.
 * Amounts enter and leave the domain only as decimal strings — never as JS numbers.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Parses an amount coming from an external contract. Rejects NaN, Infinity,
   * scientific notation, empty strings, signs, more than 2 decimal places and
   * negative values.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object with amount and currency');
    }
    return Money.parse(props.amount, props.currency, { allowNegative: false });
  }

  /**
   * Reconstructs a value read from trusted storage (NUMERIC columns are returned as
   * strings by the driver). Signed values are allowed because internal computations
   * such as reconciliation differences can be negative.
   */
  static fromPersisted(amount: string, currency: string): Money {
    return Money.parse(amount, currency, { allowNegative: true });
  }

  /** @throws InvalidMoneyError when the currency is not an ISO-4217 code. */
  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Dec(0), currency);
  }

  private static parse(amount: unknown, currency: unknown, opts: { allowNegative: boolean }): Money {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    Money.assertCurrency(currency);
    const pattern = opts.allowNegative ? SIGNED_AMOUNT : UNSIGNED_AMOUNT;
    if (!pattern.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount.slice(0, 32)}" is not a valid ${opts.allowNegative ? '' : 'non-negative '}decimal with at most ${MONEY_SCALE} decimal places`,
      );
    }
    const value = new Dec(amount);
    // "-0.00" is normalised to zero so that equality and serialisation stay canonical.
    return new Money(value.isZero() ? new Dec(0) : value, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
  }

  /** Fixed-scale decimal string, e.g. "25.00". */
  get amount(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  /** @throws CurrencyMismatchError when currencies differ. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  /** @throws CurrencyMismatchError when currencies differ. The result may be negative. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return this.isZero() ? this : new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  /** @throws CurrencyMismatchError when currencies differ. */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** @throws CurrencyMismatchError when currencies differ. */
  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  /** Value equality; different currencies are never equal (no exception). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  hasSameCurrency(other: Money | string): boolean {
    return this.currency === (typeof other === 'string' ? other : other.currency);
  }

  /** Wire representation: amount as a fixed-scale string, never a number. */
  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
