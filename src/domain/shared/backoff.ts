/**
 * @file backoff.ts
 * @author Pablo Reis Rebonato
 * @description Exponential backoff policy with equal jitter used by retries and background workers.
 */

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed and
 * the other half is random. This keeps a guaranteed minimum spacing between attempts
 * while still de-synchronising competing instances (no thundering herd).
 */
export interface BackoffPolicyProps {
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
}

/** Immutable backoff configuration; `random` is injectable so tests are deterministic. */
export class BackoffPolicy {
  private constructor(private readonly props: Readonly<BackoffPolicyProps>) {}

  /** @throws RangeError when base/factor/max are not consistent. */
  static create(props: BackoffPolicyProps): BackoffPolicy {
    if (!(props.baseMs > 0) || !(props.factor >= 1) || !(props.maxMs >= props.baseMs)) {
      throw new RangeError('Invalid backoff policy');
    }
    return new BackoffPolicy({ ...props });
  }

  /** Delay before attempt number `attempt` (1-based: delayFor(1) is the first retry). */
  delayFor(attempt: number, random: () => number = Math.random): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = Math.min(this.props.maxMs, this.props.baseMs * this.props.factor ** exponent);
    if (!this.props.jitter) return Math.round(raw);
    const half = raw / 2;
    return Math.round(half + random() * half);
  }

  /** Absolute instant of the next attempt, `delayFor(attempt)` after `now`. */
  nextAttemptAt(now: Date, attempt: number, random?: () => number): Date {
    return new Date(now.getTime() + this.delayFor(attempt, random));
  }
}

export const DEFAULT_OUTBOX_BACKOFF = BackoffPolicy.create({ baseMs: 1_000, factor: 2, maxMs: 60_000, jitter: true });
