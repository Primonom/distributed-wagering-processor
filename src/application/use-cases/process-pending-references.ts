import { WagerTransactionStatus } from '../../domain';
import type { Clock, IdGenerator, LoggerPort, MetricsPort, UnitOfWork } from '../ports';
import type { WagerSettlement } from './wager-settlement';

export interface PendingReferenceSettings {
  batchSize: number;
  leaseMs: number;
}

/**
 * Worker step for out-of-order operations. Runs on every instance:
 *  1. leases a batch of due PENDING_REFERENCE rows (FOR UPDATE SKIP LOCKED + next_attempt_at
 *     pushed by the lease) so instances never work on the same rows;
 *  2. re-processes each one in its own transaction through the SAME settlement path,
 *     taking the wallet lock first (same lock order as the synchronous path).
 * A crash mid-batch only delays the leased rows until the lease expires.
 */
export class ProcessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly settings: PendingReferenceSettings,
  ) {}

  /** Returns the number of transactions that left PENDING_REFERENCE in this run. */
  async runOnce(): Promise<number> {
    const claimed = await this.uow.run({ name: 'claim-pending-references', retryOnConflict: false }, (r) =>
      r.transactions.claimDuePendingReferences(this.clock.now(), this.settings.batchSize, this.settings.leaseMs),
    );
    let settled = 0;
    for (const item of claimed) {
      try {
        if (await this.processOne(item.id, item.walletId)) settled++;
      } catch (error) {
        // Lease expiry guarantees another attempt later; nothing was committed.
        this.logger.warn({ transactionId: item.id, walletId: item.walletId, err: error }, 'pending reference attempt failed');
      }
    }
    return settled;
  }

  async processOne(transactionId: string, walletId: string): Promise<boolean> {
    const started = performance.now();
    const result = await this.uow.run({ name: 'process-pending-reference' }, async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      const tx = await repos.transactions.findByIdForUpdate(transactionId);
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;

      const now = this.clock.now();
      this.metrics.retry('pending_reference');
      const ctx = { nextId: () => this.ids.next(), correlationId: tx.correlationId, causationId: tx.id, occurredAt: now };
      await this.settlement.settle(
        repos,
        tx,
        wallet,
        ctx,
        (t) => repos.transactions.update(t),
        (t, decision) => this.settlement.retryOrGiveUp(t, wallet, decision, now),
      );
      return tx;
    });
    if (!result) return false;
    const left = result.status !== WagerTransactionStatus.PendingReference;
    if (left) this.metrics.transactionOutcome(result.status, result.kind);
    this.metrics.processingDuration('pending_reference', (performance.now() - started) / 1000, result.status);
    this.logger.info(
      {
        correlationId: result.correlationId,
        transactionId: result.id,
        walletId: result.walletId,
        providerId: result.providerId,
        status: result.status,
        failureCode: result.failureCode,
        attempts: result.attempts,
      },
      left ? 'pending reference resolved' : 'reference still missing, rescheduled',
    );
    return left;
  }
}
