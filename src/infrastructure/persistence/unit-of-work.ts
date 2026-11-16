import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
} from '../../application/errors/application-errors';
import type {
  LoggerPort,
  MetricsPort,
  TransactionalRepositories,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../application/ports';
import { BackoffPolicy } from '../../domain';
import { translateDbError } from './db-errors';
import { createRepositories } from './repositories';

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

/**
 * Unit of Work over MikroORM's `em.transactional()` (READ COMMITTED).
 * Each attempt uses a fresh forked EntityManager (clean identity map), sets a short
 * `lock_timeout` so a hot wallet never blocks a connection for long, and retries the
 * whole unit on deadlock / serialization / lock timeout / version mismatch with
 * jittered exponential backoff. When retries are exhausted the error becomes
 * TransientInfrastructureError (HTTP 503 / SQS visibility backoff).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly backoff: BackoffPolicy;

  constructor(
    private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {
    this.backoff = BackoffPolicy.create({
      baseMs: Math.max(1, settings.retryBaseMs),
      factor: 2,
      maxMs: Math.max(1, settings.retryBaseMs) * 32,
      jitter: true,
    });
  }

  async run<T>(options: UnitOfWorkOptions, work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const maxRetries = options.retryOnConflict === false ? 0 : this.settings.maxRetries;
    const lockTimeout = Math.max(1, Math.trunc(this.settings.lockTimeoutMs));
    for (let attempt = 0; ; attempt++) {
      const em = this.orm.em.fork({ clear: true }) as EntityManager;
      try {
        return await em.transactional(async (tx) => {
          await tx.execute(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
          return work(createRepositories(tx as EntityManager));
        });
      } catch (raw) {
        const error = translateDbError(raw);
        if (error instanceof ConcurrencyConflictError) {
          this.metrics.lockConflict(error.reason);
          if (attempt < maxRetries) {
            this.metrics.retry(error.reason);
            const delay = this.backoff.delayFor(attempt + 1);
            this.logger.debug({ uow: options.name, attempt: attempt + 1, reason: error.reason, delayMs: delay }, 'retrying unit of work after concurrency conflict');
            await Bun.sleep(delay);
            continue;
          }
          this.logger.warn({ uow: options.name, attempts: attempt + 1, reason: error.reason }, 'unit of work gave up after concurrency conflicts');
          throw new TransientInfrastructureError(`${options.name}: concurrency conflict persisted after ${attempt + 1} attempts (${error.reason})`, error);
        }
        throw error;
      }
    }
  }

  async read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork({ clear: true }) as EntityManager;
    try {
      return await work(createRepositories(em));
    } catch (raw) {
      throw translateDbError(raw);
    }
  }
}
