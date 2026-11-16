import { hostname } from 'node:os';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const schema = z.object({
  PORT: int(3000),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().default('postgres://wallet:wallet@localhost:5432/wallet'),
  DB_POOL_MIN: int(2),
  DB_POOL_MAX: int(20),
  DB_LOCK_TIMEOUT_MS: int(2000),
  DB_STATEMENT_TIMEOUT_MS: int(15000),
  TX_MAX_RETRIES: int(5),
  TX_RETRY_BASE_MS: int(20),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_ENDPOINT: z.string().default('http://localhost:4566'),
  SQS_BOOTSTRAP: bool.default(true),
  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wallet-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: int(5),
  SQS_VISIBILITY_TIMEOUT_S: int(30),
  SQS_WAIT_TIME_S: int(10),
  SQS_RETRY_BASE_S: int(2),
  SQS_RETRY_MAX_S: int(60),

  CONSUMER_ENABLED: bool.default(true),
  CONSUMER_NAME: z.string().default('wager-transactions-consumer'),
  CONSUMER_CONCURRENCY: int(10),

  OUTBOX_ENABLED: bool.default(true),
  OUTBOX_POLL_MS: int(250),
  OUTBOX_BATCH_SIZE: int(10),
  OUTBOX_RETRY_BASE_MS: int(1000),
  OUTBOX_RETRY_MAX_MS: int(60000),

  PENDING_WORKER_ENABLED: bool.default(true),
  PENDING_POLL_MS: int(500),
  PENDING_BATCH_SIZE: int(20),
  PENDING_RETRY_BASE_MS: int(1000),
  PENDING_RETRY_MAX_MS: int(120000),
  PENDING_MAX_ATTEMPTS: int(8),
  PENDING_LEASE_MS: int(30000),

  METRICS_GAUGE_INTERVAL_MS: int(5000),
  SHUTDOWN_TIMEOUT_MS: int(15000),
  /** Test-only crash points, e.g. "crash_after_commit". Never set in production. */
  FAULT_INJECTION: z.string().default(''),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const parsed = schema.parse(env);
  return { ...parsed, ...overrides };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
