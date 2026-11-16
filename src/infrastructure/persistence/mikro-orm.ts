import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver, defineConfig } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/app-config';
import { ALL_SCHEMAS } from './entities/schemas';
import { Migration20261116000001_wallets_and_transactions } from './migrations/Migration20261116000001_wallets_and_transactions';
import { Migration20261116000002_ledger } from './migrations/Migration20261116000002_ledger';
import { Migration20261116000003_inbox_outbox } from './migrations/Migration20261116000003_inbox_outbox';

/**
 * Migrations are registered explicitly (no filesystem globbing) so they work the same
 * under Bun, inside the Docker image and on Windows.
 */
export const MIGRATIONS = [
  { name: 'Migration20261116000001_wallets_and_transactions', class: Migration20261116000001_wallets_and_transactions },
  { name: 'Migration20261116000002_ledger', class: Migration20261116000002_ledger },
  { name: 'Migration20261116000003_inbox_outbox', class: Migration20261116000003_inbox_outbox },
];

type OrmConfig = Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MIN' | 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS'>;

export function ormOptions(config: OrmConfig) {
  const statementTimeout = Number(config.DB_STATEMENT_TIMEOUT_MS) | 0;
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: config.DATABASE_URL,
    entities: ALL_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: false,
    forceUtcTimezone: true,
    pool: {
      min: config.DB_POOL_MIN,
      max: config.DB_POOL_MAX,
      acquireTimeoutMillis: 10_000,
      afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.query(`SET statement_timeout = ${statementTimeout}; SET idle_in_transaction_session_timeout = 60000`, (err) => done(err, conn));
      },
    },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      disableForeignKeys: false,
    },
  });
}

export async function createOrm(config: OrmConfig): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>(ormOptions(config));
}
