/**
 * @file wagering-events.ts
 * @author Pablo Reis Rebonato
 * @description Concrete wallet integration events (balance changed, processed, rejected, pending reference) built from domain state.
 */

import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { FailureCode } from '../shared/failure-code';
import { MoneyProps } from '../shared/money';
import { WagerTransaction, WagerTransactionKind } from '../wagering/wager-transaction';
import { Wallet } from '../wallet/wallet';
import { EventContext, IntegrationEvent } from './integration-event';

/**
 * All wallet events use the walletId as aggregateId: the wallet is the consistency (and
 * concurrency) boundary, and it becomes the SQS MessageGroupId so consumers receive the
 * events of one wallet in order (best effort — see ARCHITECTURE.md).
 */

interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

function summarize(tx: WagerTransaction): TransactionSummary {
  const summary: TransactionSummary = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.referenceExternalTransactionId !== undefined) {
    summary.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  }
  if (tx.referenceTransactionId !== undefined) summary.referenceTransactionId = tx.referenceTransactionId;
  return summary;
}

export interface WagerTransactionProcessedData extends TransactionSummary {
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Emitted when an operation is PROCESSED (including LOSS, which moves no money). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      ...summarize(tx),
      balanceAfter: wallet.balance.toJSON(),
      processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
    };
    return new WagerTransactionProcessed(IntegrationEvent.propsFrom(wallet.id, data, ctx));
  }
}

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: FailureCode;
  balance: MoneyProps;
}

/** Emitted when an operation is REJECTED with a stable failure code. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error('rejected transaction without failureCode');
    const data: WagerTransactionRejectedData = {
      ...summarize(tx),
      failureCode: tx.failureCode,
      balance: wallet.balance.toJSON(),
    };
    return new WagerTransactionRejected(IntegrationEvent.propsFrom(wallet.id, data, ctx));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  attempts: number;
  nextAttemptAt: string | null;
}

/** Emitted when an operation is parked waiting for the operation it references. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const data: WagerTransactionPendingReferenceData = {
      ...summarize(tx),
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
    };
    return new WagerTransactionPendingReference(IntegrationEvent.propsFrom(tx.walletId, data, ctx));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted once per ledger entry, carrying the balance before and after. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
    };
    return new WalletBalanceChanged(IntegrationEvent.propsFrom(wallet.id, data, ctx));
  }
}
