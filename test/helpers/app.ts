import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/bootstrap';
import { type AppConfig, loadConfig } from '../../src/infrastructure/config/app-config';
import { TEST_DATABASE_URL, ensureMigrated } from './db';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  close(): Promise<void>;
}

/** Unique, isolated FIFO queue names for one test file / scenario. */
export function testQueues(tag = randomUUID().slice(0, 8)) {
  return {
    SQS_WAGER_QUEUE: `t-${tag}-wager.fifo`,
    SQS_WAGER_DLQ: `t-${tag}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE: `t-${tag}-events.fifo`,
  };
}

/** Fast settings so time-based behaviour (retries, backoff) is observable in tests. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig(
    {},
    {
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: (process.env.TEST_LOG_LEVEL as AppConfig['LOG_LEVEL']) ?? 'silent',
      DB_POOL_MAX: 20,
      CONSUMER_ENABLED: false,
      OUTBOX_ENABLED: false,
      PENDING_WORKER_ENABLED: false,
      SQS_WAIT_TIME_S: 1,
      SQS_VISIBILITY_TIMEOUT_S: 5,
      SQS_RETRY_BASE_S: 1,
      SQS_RETRY_MAX_S: 2,
      OUTBOX_POLL_MS: 50,
      OUTBOX_RETRY_BASE_MS: 100,
      OUTBOX_RETRY_MAX_MS: 500,
      PENDING_POLL_MS: 50,
      PENDING_RETRY_BASE_MS: 50,
      PENDING_RETRY_MAX_MS: 200,
      PENDING_MAX_ATTEMPTS: 4,
      PENDING_LEASE_MS: 5000,
      METRICS_GAUGE_INTERVAL_MS: 200,
      SHUTDOWN_TIMEOUT_MS: 5000,
      INSTANCE_ID: `test-${randomUUID().slice(0, 6)}`,
      ...testQueues(),
      ...overrides,
    },
  );
}

export async function startTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  await ensureMigrated();
  const config = testConfig(overrides);
  const app = await createApp(config, { shutdownHooks: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    config,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

/** Polls `fn` until it returns a truthy value (no fixed sleeps as synchronisation). */
export async function eventually<T>(fn: () => Promise<T | undefined | null | false>, opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(opts.intervalMs ?? 50);
  }
  throw new Error(`eventually timed out: ${opts.message ?? ''} ${lastError ? String(lastError) : ''}`);
}
