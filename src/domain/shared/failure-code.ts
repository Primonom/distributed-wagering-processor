/**
 * @file failure-code.ts
 * @author Pablo Reis Rebonato
 * @description Stable public failure codes and the action each one asks of the game provider.
 */

/**
 * Stable, machine-readable rejection/failure codes. They are part of the public
 * contract: never rename a value, only add new ones.
 *
 * `providerAction` tells the game provider what to do with the operation:
 *  - RETRY:   the same request may succeed later (send it again, same idempotency key);
 *  - FIX:     the payload is wrong — correct it and send it as a *new* operation;
 *  - GIVE_UP: the operation is final; do not resend.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  OpeningNotAllowed = 'OPENING_NOT_ALLOWED',
  InfrastructurePermanentFailure = 'INFRASTRUCTURE_PERMANENT_FAILURE',
}

export type ProviderAction = 'RETRY' | 'FIX' | 'GIVE_UP';

export const FAILURE_CODE_ACTION: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'GIVE_UP',
  [FailureCode.CurrencyMismatch]: 'FIX',
  [FailureCode.WalletNotFound]: 'FIX',
  [FailureCode.WalletPlayerMismatch]: 'FIX',
  [FailureCode.ReferenceNotFound]: 'FIX',
  [FailureCode.ReferenceMismatch]: 'FIX',
  [FailureCode.InvalidReferenceKind]: 'FIX',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.AmountMismatch]: 'FIX',
  [FailureCode.OpeningNotAllowed]: 'FIX',
  [FailureCode.InfrastructurePermanentFailure]: 'GIVE_UP',
};

const ALL = new Set<string>(Object.values(FailureCode));

/** Type guard for values read from storage or the wire. */
export function isFailureCode(value: string): value is FailureCode {
  return ALL.has(value);
}
