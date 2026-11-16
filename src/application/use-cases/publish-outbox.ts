import { BackoffPolicy, IntegrationEventEnvelope } from '../../domain';
import type { Clock, EventPublisher, LoggerPort, MetricsPort, UnitOfWork } from '../ports';

export interface PublishOutboxSettings {
  batchSize: number;
  retryPolicy: BackoffPolicy;
  /** Test hook: runs after the broker accepted the batch and before published_at commits. */
  afterPublish?: () => void;
}

/**
 * Transactional-outbox relay. Runs on every instance:
 *   BEGIN; SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now
 *          ORDER BY occurred_at LIMIT n FOR UPDATE SKIP LOCKED;
 *   publish to SQS; UPDATE published_at (or schedule retry with backoff); COMMIT.
 * SKIP LOCKED gives concurrent publishers disjoint batches. A crash after publishing and
 * before COMMIT releases the locks, so the rows are published again: delivery is
 * at-least-once and consumers de-duplicate by eventId.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly settings: PublishOutboxSettings,
  ) {}

  async runOnce(): Promise<number> {
    return this.uow.run({ name: 'publish-outbox', retryOnConflict: false }, async (repos) => {
      const now = this.clock.now();
      const batch = await repos.outbox.lockDueBatch(now, this.settings.batchSize);
      if (batch.length === 0) return 0;

      let results: Array<{ id: string; ok: boolean; error?: string }>;
      try {
        results = await this.publisher.publishBatch(
          batch.map((m) => ({ id: m.id, groupId: m.aggregateId, envelope: m.payload as unknown as IntegrationEventEnvelope<unknown> })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results = batch.map((m) => ({ id: m.id, ok: false, error: message }));
      }
      this.settings.afterPublish?.();

      const byId = new Map(results.map((r) => [r.id, r]));
      const publishedAt = this.clock.now();
      const lags: number[] = [];
      let failed = 0;
      for (const message of batch) {
        const result = byId.get(message.id);
        if (result?.ok) {
          message.markPublished(publishedAt);
          lags.push(Math.max(0, (publishedAt.getTime() - message.occurredAt.getTime()) / 1000));
        } else {
          failed++;
          message.scheduleRetry(publishedAt, result?.error ?? 'not acknowledged by broker', this.settings.retryPolicy);
        }
        await repos.outbox.update(message);
      }
      this.metrics.outboxPublished(lags.length, lags);
      if (failed > 0) {
        this.metrics.retry('outbox_publish');
        this.logger.warn({ failed, published: lags.length }, 'outbox publish partially failed; rescheduled with backoff');
      }
      return lags.length;
    });
  }

  async refreshGauges(): Promise<void> {
    const stats = await this.uow.read((r) => r.outbox.stats(this.clock.now()));
    this.metrics.outboxState(stats.pending, stats.oldestPendingAgeSeconds);
  }
}
