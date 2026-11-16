/**
 * @file outbox-message.ts
 * @author Pablo Reis Rebonato
 * @description Outbox record that holds an integration event until it is published, with retry scheduling.
 */

import { IntegrationEvent } from '../events/integration-event';
import { BackoffPolicy, DEFAULT_OUTBOX_BACKOFF } from '../shared/backoff';
import { InvalidTransactionStateError } from '../shared/errors';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

/**
 * Event waiting to be published. It is written in the same SQL transaction as the
 * financial change; a publisher worker delivers it later (at-least-once).
 * The outbox id is the eventId, so duplicates can be recognised downstream.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** Wraps an event for publication; the outbox id is the eventId. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  /** Reconstruction from persistence without validation. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pending and its next attempt time has been reached. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  /** Marks the event delivered to the broker (at-least-once: it may already have been delivered before). */
  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
    this._lastError = undefined;
  }

  /** Increments attempts and computes the next nextAttemptAt (exponential backoff with jitter). */
  scheduleRetry(now: Date, error?: string, policy: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF, random?: () => number): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts, random);
    this._lastError = error?.slice(0, 500);
  }
}
