/**
 * Domain errors. They describe programming errors or invariant violations that the
 * domain refuses to accept. Business *outcomes* (e.g. insufficient funds on a BET) are
 * modelled as transaction rejections with a FailureCode, not as exceptions.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(message: string) {
    super(message);
  }
}

export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
  constructor(message: string) {
    super(message);
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: 'INVALID_PAYLOAD' | 'OPENING_NOT_ALLOWED' | 'REFERENCE_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${field} must be a non-empty string`);
  }
}
