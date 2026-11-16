/**
 * @file application-errors.ts
 * @author Pablo Reis Rebonato
 * @description Application error hierarchy, each class mapping to exactly one HTTP status and SQS handling strategy.
 */

/**
 * Application-level errors. Each one maps to exactly one HTTP status / SQS handling
 * class in the interface layer, so callers never have to parse messages.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — the request itself is malformed; resending it unchanged will never work. */
export class InvalidRequestError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 404 */
export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

/** 409 — same Idempotency-Key, different business payload. */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH';
  constructor(
    readonly idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(`Idempotency-Key ${idempotencyKey} was already used with a different payload`);
  }
}

/** 409 — (providerId, externalTransactionId) already exists under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';
  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly existingTransactionId: string,
  ) {
    super(`Transaction ${providerId}/${externalTransactionId} already exists under another Idempotency-Key`);
  }
}

/** 409 */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(
    readonly playerId: string,
    readonly currency: string,
    readonly existingWalletId?: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Lock timeout / deadlock / serialization failure / version mismatch. Retried inside the UoW. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(
    readonly reason: 'deadlock' | 'serialization' | 'lock_timeout' | 'version_mismatch',
    message: string,
  ) {
    super(message);
  }
}

/** 503 — database or broker temporarily unavailable, or retries exhausted. Safe to retry. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Unique constraint violation surfaced by persistence (constraint name kept for decisions). */
export class UniqueConstraintError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';
  constructor(
    readonly constraint: string | undefined,
    message: string,
  ) {
    super(message);
  }
}
