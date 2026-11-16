import { LedgerDirection, oppositeDirection } from '../ledger/wallet-ledger-entry';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  InvariantViolationError,
} from '../shared/errors';
import { FailureCode } from '../shared/failure-code';
import { Money } from '../shared/money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds a provider may submit (OPENING is internal). */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Allowed reference kinds per operation. WIN/LOSS may *optionally* reference the BET
 * of the same round; REFUND/ROLLBACK must reference something.
 */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Balance observed when the transaction reached its current state (returned on replays). */
  balanceSnapshot?: Money | undefined;
  /** Re-processing attempts while waiting for a reference. */
  attempts: number;
  nextAttemptAt?: Date | undefined;
  updatedAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceSnapshot: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Provider operation. Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Internal OPENING credit created together with a wallet. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    if (props.providerId !== INTERNAL_PROVIDER_ID) {
      throw new InvariantViolationError('OPENING transactions belong to the internal provider');
    }
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening, referenceExternalTransactionId: undefined });
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const required: Array<keyof CreateWagerTransactionProps> = [
      'id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash',
      'walletId', 'playerId', 'roundId', 'gameId', 'correlationId',
    ];
    for (const field of required) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError('INVALID_PAYLOAD', `${field} must be a non-empty string`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('INVALID_PAYLOAD', `unknown kind ${String(props.kind)}`);
    }
    const allowsZero = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!allowsZero && props.money.isZero())) {
      throw new InvalidWagerTransactionError(
        'INVALID_PAYLOAD',
        allowsZero ? 'amount cannot be negative' : `amount must be greater than zero for ${props.kind}`,
      );
    }
    const reference = props.referenceExternalTransactionId;
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && (reference === undefined || reference.trim() === '')) {
      throw new InvalidWagerTransactionError('REFERENCE_REQUIRED', `${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && ALLOWED_REFERENCE_KINDS[props.kind].length === 0) {
      throw new InvalidWagerTransactionError('INVALID_PAYLOAD', `${props.kind} cannot reference another transaction`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('INVALID_PAYLOAD', 'a transaction cannot reference itself');
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind, props.money,
      reference, props.correlationId, props.createdAt,
      WagerTransactionStatus.Pending, undefined, undefined, undefined, undefined, 0, undefined, props.createdAt,
    );
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash,
      state.walletId, state.playerId, state.roundId, state.gameId, state.kind, state.money,
      state.referenceExternalTransactionId, state.correlationId, state.createdAt,
      state.status, state.referenceTransactionId, state.failureCode, state.processedAt,
      state.balanceSnapshot, state.attempts, state.nextAttemptAt, state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get balanceSnapshot(): Money | undefined { return this._balanceSnapshot; }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get updatedAt(): Date { return this._updatedAt; }

  // ---- transitions -------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvariantViolationError(`${this.kind} can only be processed against a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceSnapshot = balanceAfter;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  /** PENDING → PENDING_REFERENCE (first time the reference is missing). */
  markPendingReference(nextAttemptAt: Date, at: Date, balanceObserved: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`cannot mark ${this._status} transaction as PENDING_REFERENCE`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
    this._balanceSnapshot = balanceObserved;
    this._updatedAt = at;
  }

  /** PENDING_REFERENCE → PENDING_REFERENCE: one more failed resolution attempt. */
  scheduleReferenceRetry(nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`cannot schedule a reference retry for ${this._status} transaction`);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  /** Counts a resolution attempt without scheduling another (used right before giving up). */
  recordReferenceAttempt(at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`cannot record a reference attempt for ${this._status} transaction`);
    }
    this._attempts += 1;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, balanceObserved: Money, referenceTransactionId?: string): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceSnapshot = balanceObserved;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries ----------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  allowsReferenceKind(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debits; WIN/REFUND/OPENING credit; ROLLBACK is the inverse of its reference.
   * LOSS has no direction (it never touches the balance).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS has no ledger direction');
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${operation}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
