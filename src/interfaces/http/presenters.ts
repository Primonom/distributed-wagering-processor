/**
 * @file presenters.ts
 * @author Pablo Reis Rebonato
 * @description Response presenters and the mapping from submission outcome to HTTP status.
 */

import type { SubmitWagerResult } from '../../application/use-cases/submit-wager-transaction';
import { FAILURE_CODE_ACTION, WagerTransaction, WagerTransactionStatus, Wallet, WalletLedgerEntry } from '../../domain';

export function presentWallet(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(e: WalletLedgerEntry) {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export function presentTransaction(t: WagerTransaction) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    balance: t.balanceSnapshot?.toJSON() ?? null,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

/**
 * HTTP status per outcome (identical for first submission and replay, except that a
 * replay carries idempotentReplay=true):
 *   PROCESSED → 200, PENDING_REFERENCE/PENDING → 202, REJECTED → 422, FAILED → 500 (retryable=false)
 */
export function statusForSubmission(r: SubmitWagerResult): number {
  switch (r.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function presentSubmission(r: SubmitWagerResult) {
  const body: Record<string, unknown> = {
    transactionId: r.transactionId,
    status: r.status,
    balance: r.balance,
    idempotentReplay: r.idempotentReplay,
  };
  if (r.failureCode) {
    body.failureCode = r.failureCode;
    body.providerAction = FAILURE_CODE_ACTION[r.failureCode];
    body.retryable = false;
  }
  return body;
}
