/**
 * @file metrics.ts
 * @author Pablo Reis Rebonato
 * @description Prometheus metrics registry (one per instance) implementing the MetricsPort.
 */

import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsPort } from '../../application/ports';

/**
 * Prometheus metrics. One Registry per application instance (tests boot several apps in
 * one process, so the global default registry is never used).
 */
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by final status and kind (replays excluded)',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'idempotent_duplicates_total',
    help: 'Duplicate submissions answered from persisted state (idempotent replay or inbox hit)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'retries_total',
    help: 'Retries performed, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, serialization failures and version mismatches',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages moved to the dead-letter queue, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'processing_duration_seconds',
    help: 'Processing latency by operation and outcome',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance differs from the ledger',
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });
  private readonly outboxPublishLag = new Histogram({
    name: 'outbox_publish_lag_seconds',
    help: 'Time between the event being committed and being published',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });

  constructor(instanceId: string, collectDefaults = true) {
    this.registry.setDefaultLabels({ instance: instanceId });
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  transactionOutcome(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  idempotentDuplicate(source: 'http' | 'sqs' | 'inbox'): void {
    this.duplicates.inc({ source });
  }
  retry(reason: string): void {
    this.retries.inc({ reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  processingDuration(operation: string, seconds: number, outcome: string): void {
    this.duration.observe({ operation, outcome }, seconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
  outboxPublished(count: number, lagSeconds: number[]): void {
    if (count > 0) this.outboxPublishedCounter.inc(count);
    for (const lag of lagSeconds) this.outboxPublishLag.observe(lag);
  }
  outboxState(pending: number, oldestPendingAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestPendingAgeSeconds);
  }
}
