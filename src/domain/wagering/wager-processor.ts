/**
 * @file wager-processor.ts
 * @author Pablo Reis Rebonato
 * @description Pure business rules that decide how a wager operation affects a wallet.
 */

import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { InvariantViolationError } from '../shared/errors';
import { FailureCode } from '../shared/failure-code';
import { Wallet } from '../wallet/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

/** What the persistence layer found for the transaction's reference. */
export interface ReferenceContext {
  /** undefined when the transaction carries no reference or the reference does not exist (yet). */
  reference: WagerTransaction | undefined;
  /** true if a PROCESSED REFUND/ROLLBACK already reverses `reference`. */
  alreadyReversed: boolean;
}

export type WagerDecision =
  | { outcome: 'PROCESS'; direction: LedgerDirection | undefined; reference: WagerTransaction | undefined }
  | { outcome: 'REJECT'; code: FailureCode; reference: WagerTransaction | undefined }
  | { outcome: 'WAIT_FOR_REFERENCE'; reason: 'NOT_FOUND' | 'NOT_YET_PROCESSED' };

/**
 * Pure business rules for applying a provider operation to a wallet (section 7).
 * The caller is responsible for holding the wallet lock and for persisting the result.
 * Both the synchronous path (HTTP/SQS) and the PENDING_REFERENCE worker go through here.
 */
export class WagerProcessor {
  private constructor() {}

  /**
   * Returns PROCESS (with the ledger direction), REJECT (with a failure code) or WAIT_FOR_REFERENCE; never mutates its inputs.
   * @throws InvariantViolationError when called with a wallet or reference that does not belong to `tx`.
   */
  static decide(tx: WagerTransaction, wallet: Wallet, ctx: ReferenceContext): WagerDecision {
    if (tx.walletId !== wallet.id) {
      throw new InvariantViolationError('transaction evaluated against the wrong wallet');
    }
    if (wallet.playerId !== tx.playerId) {
      return { outcome: 'REJECT', code: FailureCode.WalletPlayerMismatch, reference: undefined };
    }
    if (tx.money.currency !== wallet.currency) {
      return { outcome: 'REJECT', code: FailureCode.CurrencyMismatch, reference: undefined };
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = ctx.reference;
      if (!reference) {
        return { outcome: 'WAIT_FOR_REFERENCE', reason: 'NOT_FOUND' };
      }
      if (reference.providerId !== tx.providerId || reference.externalTransactionId !== tx.referenceExternalTransactionId) {
        throw new InvariantViolationError('reference resolved with the wrong key');
      }
      if (!tx.allowsReferenceKind(reference.kind)) {
        return { outcome: 'REJECT', code: FailureCode.InvalidReferenceKind, reference };
      }
      if (
        reference.walletId !== tx.walletId ||
        reference.playerId !== tx.playerId ||
        reference.money.currency !== tx.money.currency ||
        reference.roundId !== tx.roundId
      ) {
        return { outcome: 'REJECT', code: FailureCode.ReferenceMismatch, reference };
      }
      if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
        return { outcome: 'WAIT_FOR_REFERENCE', reason: 'NOT_YET_PROCESSED' };
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        return { outcome: 'REJECT', code: FailureCode.ReferenceNotProcessed, reference };
      }
      if (tx.isReversal()) {
        if (!tx.money.equals(reference.money)) {
          return { outcome: 'REJECT', code: FailureCode.AmountMismatch, reference };
        }
        if (ctx.alreadyReversed) {
          return { outcome: 'REJECT', code: FailureCode.AlreadyReversed, reference };
        }
      }
    }

    if (!tx.affectsBalance()) {
      return { outcome: 'PROCESS', direction: undefined, reference };
    }
    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
      return { outcome: 'REJECT', code, reference };
    }
    return { outcome: 'PROCESS', direction, reference };
  }

  /**
   * Applies a PROCESS/REJECT decision, mutating wallet and transaction. WAIT_FOR_REFERENCE
   * is left to the caller because the scheduling policy is an application concern.
   */
  static apply(
    tx: WagerTransaction,
    wallet: Wallet,
    decision: Exclude<WagerDecision, { outcome: 'WAIT_FOR_REFERENCE' }>,
    ids: { entryId: string },
    at: Date,
  ): WalletLedgerEntry | undefined {
    if (decision.outcome === 'REJECT') {
      tx.reject(decision.code, at, wallet.balance, decision.reference?.id);
      return undefined;
    }
    let entry: WalletLedgerEntry | undefined;
    if (decision.direction !== undefined) {
      entry = wallet.move(decision.direction, tx.money, { entryId: ids.entryId, transactionId: tx.id, at });
    }
    tx.markProcessed(decision.reference?.id, at, wallet.balance);
    return entry;
  }
}
