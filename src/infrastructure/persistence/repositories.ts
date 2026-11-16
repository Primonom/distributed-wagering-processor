import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors/application-errors';
import type {
  InboxRepository,
  LedgerCursor,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import {
  InboxMessage,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from '../../domain';
import {
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './entities/schemas';
import { InboxMapper, LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // SELECT ... FOR UPDATE: row-level lock on this wallet only.
    const r = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByIdForShare(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_READ, refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletSchema, { playerId, currency }, { refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError('version_mismatch', `wallet ${wallet.id} is no longer at version ${expectedVersion}`);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionSchema, { id }, { refresh: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionSchema, { idempotencyKey }, { refresh: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }, { refresh: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, WagerTransactionMapper.toRecord(tx));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id },
      {
        status: r.status,
        failureCode: r.failureCode,
        referenceTransactionId: r.referenceTransactionId,
        processedAt: r.processedAt,
        balanceSnapshot: r.balanceSnapshot,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        updatedAt: r.updatedAt,
      },
    );
  }

  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.em.execute<Array<{ id: string; wallet_id: string }>>(
      `UPDATE wager_transactions t
          SET next_attempt_at = ?
         FROM (SELECT id FROM wager_transactions
                WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
                ORDER BY next_attempt_at
                LIMIT ?
                FOR UPDATE SKIP LOCKED) due
        WHERE t.id = due.id
    RETURNING t.id, t.wallet_id`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const where = after
      ? {
          walletId,
          $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }],
        }
      : { walletId };
    const rows = await this.em.find(LedgerEntrySchema, where, {
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      limit,
      refresh: true,
    });
    return rows.map((r) => LedgerEntryMapper.toDomain(r));
  }

  async sumForWallet(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    // Aggregation happens in PostgreSQL over NUMERIC and comes back as text.
    const rows = await this.em.execute<Array<{ balance: string; entries: number }>>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(38,2)::text AS balance,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] ?? { balance: '0.00', entries: 0 };
    return { balance: Money.fromPersisted(row.balance, currency), entries: row.entries };
  }

  async countForTransaction(transactionId: string): Promise<number> {
    return this.em.count(LedgerEntrySchema, { transactionId });
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const r = InboxMapper.toRecord(message);
    // ON CONFLICT DO NOTHING keeps the surrounding transaction usable on duplicates.
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [r.consumerName, r.messageId, r.payloadHash, r.receivedAt, r.processedAt],
    );
    return rows.length === 1;
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageSchema, messages.map((m) => OutboxMapper.toRecord(m)));
  }

  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SELECT ... FOR UPDATE SKIP LOCKED: concurrent publishers get disjoint batches.
    const rows = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
    );
    return rows.map((r) => OutboxMapper.toDomain(r));
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }

  async stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }> {
    const rows = await this.em.execute<Array<{ pending: number; age: number | null }>>(
      `SELECT COUNT(*)::int AS pending,
              EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at)))::float8 AS age
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    const row = rows[0];
    return { pending: row?.pending ?? 0, oldestPendingAgeSeconds: Math.max(0, row?.age ?? 0) };
  }
}

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
