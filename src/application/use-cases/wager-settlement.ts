/**
 * @file wager-settlement.ts
 * @author Pablo Reis Rebonato
 * @description Single settlement path that resolves the reference, applies the domain decision and persists transaction, ledger and outbox events.
 */

import {
  BackoffPolicy,
  EventContext,
  FailureCode,
  IntegrationEvent,
  OutboxMessage,
  ReferenceContext,
  WagerDecision,
  WagerProcessor,
  WagerTransaction,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  Wallet,
  WalletBalanceChanged,
} from '../../domain';
import type { IdGenerator, TransactionalRepositories } from '../ports';

export interface PendingReferencePolicy {
  backoff: BackoffPolicy;
  maxAttempts: number;
}

/**
 * The single settlement path shared by HTTP, SQS and the PENDING_REFERENCE worker.
 * Preconditions: called inside a unit of work while holding the wallet row lock.
 */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  /** Loads the referenced operation (and whether it was already reversed) for the domain decision. */
  async resolveReference(repos: TransactionalRepositories, tx: WagerTransaction): Promise<ReferenceContext> {
    if (tx.referenceExternalTransactionId === undefined) {
      return { reference: undefined, alreadyReversed: false };
    }
    const reference = await repos.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId);
    const alreadyReversed =
      reference !== undefined && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;
    return { reference, alreadyReversed };
  }

  /**
   * Decides and applies the operation to wallet + transaction, then persists ledger,
   * wallet (version-checked update) and outbox events. `persistTx` inserts or updates
   * the transaction row before the ledger line is written (FK order).
   */
  async settle(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    persistTx: (tx: WagerTransaction) => Promise<void>,
    onWait: (tx: WagerTransaction, decision: Extract<WagerDecision, { outcome: 'WAIT_FOR_REFERENCE' }>) => void,
  ): Promise<{ decision: WagerDecision }> {
    const refCtx = await this.resolveReference(repos, tx);
    const decision = WagerProcessor.decide(tx, wallet, refCtx);
    const events: IntegrationEvent<unknown>[] = [];

    if (decision.outcome === 'WAIT_FOR_REFERENCE') {
      onWait(tx, decision);
      if (tx.status === WagerTransactionStatus.PendingReference) {
        events.push(WagerTransactionPendingReference.from(tx, ctx));
      } else if (tx.status === WagerTransactionStatus.Rejected) {
        events.push(WagerTransactionRejected.from(tx, wallet, ctx));
      }
      await persistTx(tx);
      await repos.outbox.insertMany(events.map((e) => OutboxMessage.enqueue(e)));
      return { decision };
    }

    const expectedVersion = wallet.version;
    const entry = WagerProcessor.apply(tx, wallet, decision, { entryId: this.ids.next() }, ctx.occurredAt);
    await persistTx(tx);
    if (entry) {
      await repos.wallets.updateBalance(wallet, expectedVersion);
      await repos.ledger.insert(entry);
      events.push(WalletBalanceChanged.from(wallet, entry, ctx));
    }
    if (tx.status === WagerTransactionStatus.Processed) {
      events.push(WagerTransactionProcessed.from(tx, wallet, ctx));
      // Operations that arrived before this one and wait for it can be retried right away.
      await repos.transactions.nudgePendingDependents(tx.providerId, tx.externalTransactionId, tx.walletId, ctx.occurredAt);
    } else {
      events.push(WagerTransactionRejected.from(tx, wallet, ctx));
    }
    await repos.outbox.insertMany(events.map((e) => OutboxMessage.enqueue(e)));
    return { decision };
  }

  /** First time a reference is missing: park the transaction. */
  parkNew(tx: WagerTransaction, wallet: Wallet, now: Date): void {
    tx.markPendingReference(this.pendingPolicy.backoff.nextAttemptAt(now, 1), now, wallet.balance);
  }

  /** Worker attempt failed to resolve the reference: schedule again or give up. */
  retryOrGiveUp(
    tx: WagerTransaction,
    wallet: Wallet,
    decision: Extract<WagerDecision, { outcome: 'WAIT_FOR_REFERENCE' }>,
    now: Date,
  ): void {
    if (tx.attempts + 1 >= this.pendingPolicy.maxAttempts) {
      tx.recordReferenceAttempt(now);
      const code = decision.reason === 'NOT_FOUND' ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
      tx.reject(code, now, wallet.balance);
      return;
    }
    tx.scheduleReferenceRetry(this.pendingPolicy.backoff.nextAttemptAt(now, tx.attempts + 2), now);
  }
}
