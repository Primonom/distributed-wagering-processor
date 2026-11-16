import {
  FailureCode,
  InboxMessage,
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
  isFailureCode,
} from '../../domain';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities/schemas';

/** NUMERIC(20,2) is returned as string; normalise in case a driver ever returns fewer decimals. */
const money = (amount: string, currency: string) => Money.fromPersisted(String(amount), currency.trim());

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency.trim(),
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const currency = r.currency.trim();
    const failureCode = r.failureCode && isFailureCode(r.failureCode) ? r.failureCode : undefined;
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      correlationId: r.correlationId,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode: failureCode as FailureCode | undefined,
      processedAt: r.processedAt ?? undefined,
      balanceSnapshot: r.balanceSnapshot === null ? undefined : money(r.balanceSnapshot, currency),
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt ?? undefined,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      balanceSnapshot: t.balanceSnapshot?.amount ?? null,
      attempts: t.attempts,
      nextAttemptAt: t.nextAttemptAt ?? null,
      correlationId: t.correlationId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const currency = r.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, currency),
      balanceBefore: money(r.balanceBefore, currency),
      balanceAfter: money(r.balanceAfter, currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const InboxMapper = {
  toRecord(m: InboxMessage): InboxMessageRecord {
    return {
      consumerName: m.consumerName,
      messageId: m.messageId,
      payloadHash: m.payloadHash,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt ?? null,
    };
  },
};

export const OutboxMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt ?? undefined,
      publishedAt: r.publishedAt ?? undefined,
      lastError: r.lastError ?? undefined,
    });
  },
  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      // the domain payload is frozen; the ORM needs a mutable copy
      payload: JSON.parse(JSON.stringify(m.payload)) as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? null,
      publishedAt: m.publishedAt ?? null,
      lastError: m.lastError ?? null,
    };
  },
};
