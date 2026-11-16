/**
 * @file db.ts
 * @author Pablo Reis Rebonato
 * @description Test database helpers: migrations, raw SQL clients and wallet consistency assertions.
 */

import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet_test';

let migrated = false;

/** Applies all migrations to the dedicated test database (idempotent). */
export async function ensureMigrated(url = TEST_DATABASE_URL): Promise<void> {
  if (migrated && url === TEST_DATABASE_URL) return;
  const orm = await createOrm({ ...loadConfig({}), DATABASE_URL: url, DB_POOL_MIN: 0, DB_POOL_MAX: 2 });
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
  if (url === TEST_DATABASE_URL) migrated = true;
}

export function newClient(url = TEST_DATABASE_URL): pg.Client {
  return new pg.Client({ connectionString: url });
}

/** Small pool for test assertions (raw SQL, never the code under test). */
export function newPool(url = TEST_DATABASE_URL, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

export async function expectPgError(
  promise: Promise<unknown>,
  expected: { code?: string; constraint?: string; message?: RegExp },
): Promise<void> {
  let caught: (Error & { code?: string; constraint?: string }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { code?: string; constraint?: string };
  }
  expect(caught, `expected SQL error ${JSON.stringify(expected)}`).toBeDefined();
  if (expected.code) expect(caught?.code).toBe(expected.code);
  if (expected.constraint) expect(caught?.constraint).toBe(expected.constraint);
  if (expected.message) expect(caught?.message ?? '').toMatch(expected.message);
}

export const hash = (s: string = randomUUID()) => createHash('sha256').update(s).digest('hex');
export const id = () => uuidv7();

export interface ReconstructedBalance {
  stored: string;
  calculated: string;
  entries: number;
  version: number;
}

/** Shared invariant helper: wallet.balance vs. balance rebuilt from the ledger. */
export async function ledgerBalance(db: pg.Pool | pg.Client, walletId: string): Promise<ReconstructedBalance> {
  const { rows } = await db.query<{ stored: string; calculated: string; entries: number; version: number }>(
    `SELECT w.balance::text AS stored, w.version,
            COALESCE((SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
                        FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::numeric(38,2)::text AS calculated,
            (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return row;
}

/** Asserts the global invariant: stored balance == ledger-rebuilt balance, and >= 0. */
export async function assertWalletConsistent(db: pg.Pool | pg.Client, walletId: string): Promise<ReconstructedBalance> {
  const b = await ledgerBalance(db, walletId);
  expect(b.stored).toBe(b.calculated);
  expect(b.stored.startsWith('-')).toBe(false);
  return b;
}
