/**
 * @file errors.ts
 * @author Pablo Reis Rebonato
 * @description Typed domain errors for invariant violations and invalid inputs.
 */

/**
 * Domain errors. They describe programming errors or invariant violations that the
 * domain refuses to accept. Business *outcomes* (e.g. insufficient funds on a BET) are
 * modelled as transaction rejections with a FailureCode, not as exceptions.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed amount or currency (NaN, scientific notation, scale > 2, negative, bad ISO code). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** Arithmetic or comparison attempted between different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** State machine transition not allowed from the current status. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** An aggregate invariant would be broken; indicates a programming error, never a business outcome. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}

/** Debit larger than the balance; callers are expected to check `canDebit` first. */
export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';
}

/** Provider operation that can never be accepted as submitted (bad payload, OPENING, missing reference). */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: 'INVALID_PAYLOAD' | 'OPENING_NOT_ALLOWED' | 'REFERENCE_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}

/** @throws InvariantViolationError when `value` is not a non-blank string. */
export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${field} must be a non-empty string`);
  }
}
