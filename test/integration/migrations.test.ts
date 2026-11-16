import { afterAll, beforeAll, expect, test } from 'bun:test';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm';
import { TEST_DATABASE_URL, newClient } from '../helpers/db';

/** Runs the full migration cycle on a scratch database so the shared test DB is untouched. */
const scratchDb = `wallet_migrations_${process.pid}`;
const adminUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${scratchDb}`);

beforeAll(async () => {
  const admin = newClient(adminUrl);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${scratchDb}`);
  await admin.query(`CREATE DATABASE ${scratchDb}`);
  await admin.end();
});

afterAll(async () => {
  const admin = newClient(adminUrl);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
  await admin.end();
});

async function tables(): Promise<string[]> {
  const c = newClient(scratchUrl);
  await c.connect();
  const { rows } = await c.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY 1`,
  );
  await c.end();
  return rows.map((r) => r.table_name);
}

test('migrations go up, down (step by step and fully) and up again', async () => {
  const orm = await createOrm({ ...loadConfig({}), DATABASE_URL: scratchUrl, DB_POOL_MIN: 0, DB_POOL_MAX: 2 });
  const migrator = orm.getMigrator();
  try {
    const all = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
    expect((await migrator.up()).length).toBe(3);
    expect(await tables()).toEqual(all);

    await migrator.down();
    expect(await tables()).toEqual(['wager_transactions', 'wallet_ledger_entries', 'wallets']);

    await migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);

    expect((await migrator.up()).length).toBe(3);
    expect(await tables()).toEqual(all);
    expect(await migrator.getPendingMigrations()).toEqual([]);
  } finally {
    await orm.close(true);
  }
});
