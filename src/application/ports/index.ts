import type {
  InboxMessage,
  IntegrationEventEnvelope,
  Money,
  OutboxMessage,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '../../domain';

// ---------------------------------------------------------------- repositories

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE — row lock on this wallet only (never a global lock). */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR SHARE — blocks writers of this wallet while reading a consistent view. */
  findByIdForShare(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE ... WHERE id = $1 AND version = $expectedVersion (defence in depth on top of
   * the row lock). Throws ConcurrencyConflictError('version_mismatch') if no row matched.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** true if a PROCESSED REFUND/ROLLBACK already reverses this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists mutable state (status, failure, reference, attempts, schedule). */
  update(tx: WagerTransaction): Promise<void>;
  /**
   * Leases up to `limit` due PENDING_REFERENCE transactions (FOR UPDATE SKIP LOCKED),
   * pushing their next_attempt_at by `leaseMs` so other instances skip them.
   */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** Balance recomputed from the ledger (SUM over NUMERIC in SQL). */
  sumForWallet(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
  countForTransaction(transactionId: string): Promise<number>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Returns false if (consumer, messageId) already exists. */
  tryInsert(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  insertMany(messages: OutboxMessage[]): Promise<void>;
  /** SELECT ... FOR UPDATE SKIP LOCKED of due, unpublished messages, ordered by occurred_at. */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  /** Name used in logs/metrics. */
  name: string;
  /** Retry the whole unit on lock timeouts, deadlocks, serialization or version conflicts. */
  retryOnConflict?: boolean;
}

/**
 * One SQL transaction. Everything written through the given repositories commits or
 * rolls back together. Implementations must not publish anything externally.
 */
export interface UnitOfWork {
  run<T>(options: UnitOfWorkOptions, work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  /** Read-only access outside an explicit transaction. */
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------- other ports

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered UUID (v7). */
  next(): string;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Publishes integration events to the broker. Only the outbox publisher may call it. */
export interface EventPublisher {
  publishBatch(events: Array<{ id: string; groupId: string; envelope: IntegrationEventEnvelope<unknown> }>): Promise<PublishResult[]>;
}

export interface ProviderIdentity {
  providerId: string;
  /** How the identity was established (e.g. 'none' for the no-op adapter, 'oidc' for Keycloak). */
  method: string;
}

/**
 * Extension point for provider authentication. The default adapter is an explicit no-op;
 * an OIDC adapter would resolve the providerId from a client-credentials token claim and
 * the use case would reject payloads whose providerId differs.
 */
export interface ProviderIdentityPort {
  resolve(credentials: { authorization?: string | undefined }): Promise<ProviderIdentity | undefined>;
}

export interface MetricsPort {
  transactionOutcome(status: string, kind: string): void;
  idempotentDuplicate(source: 'http' | 'sqs' | 'inbox'): void;
  retry(reason: string): void;
  lockConflict(reason: string): void;
  dlqMessage(reason: string): void;
  processingDuration(operation: string, seconds: number, outcome: string): void;
  reconciliationDivergence(): void;
  outboxPublished(count: number, lagSeconds: number[]): void;
  outboxState(pending: number, oldestPendingAgeSeconds: number): void;
}

export interface LoggerPort {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export const PORTS = {
  UnitOfWork: Symbol('UnitOfWork'),
  Clock: Symbol('Clock'),
  IdGenerator: Symbol('IdGenerator'),
  EventPublisher: Symbol('EventPublisher'),
  ProviderIdentity: Symbol('ProviderIdentityPort'),
  Metrics: Symbol('MetricsPort'),
  Logger: Symbol('LoggerPort'),
} as const;
