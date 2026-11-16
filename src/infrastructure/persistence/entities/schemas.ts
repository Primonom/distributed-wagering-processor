/**
 * @file schemas.ts
 * @author Pablo Reis Rebonato
 * @description MikroORM entity schemas and persistence records, kept separate from domain classes.
 */

import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records. They are deliberately separate from the domain classes: the
 * domain stays free of ORM decorators and the mapping (Money ⇄ NUMERIC string + currency)
 * lives in one place (mappers.ts). NUMERIC columns are typed `decimal`, which MikroORM
 * hydrates as **string** — monetary values never pass through a JS number.
 */

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceSnapshot: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

const money = { type: 'decimal', precision: 20, scale: 2 } as const;
const ts = { type: 'Date', columnType: 'timestamptz' } as const;
const tsNullable = { ...ts, nullable: true } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...ts },
    updatedAt: { ...ts },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    balanceSnapshot: { ...money, nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...tsNullable },
    correlationId: { type: 'text' },
    createdAt: { ...ts },
    updatedAt: { ...ts },
    processedAt: { ...tsNullable },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...ts },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { ...ts },
    processedAt: { ...tsNullable },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { ...ts },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...tsNullable },
    publishedAt: { ...tsNullable },
    lastError: { type: 'text', nullable: true },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
