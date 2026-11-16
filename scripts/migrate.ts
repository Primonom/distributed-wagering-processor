/**
 * @file migrate.ts
 * @author Pablo Reis Rebonato
 * @description Cross-platform CLI that applies, reverts and lists the MikroORM migrations.
 */

/**
 * Usage:
 *   bun scripts/migrate.ts up            apply all pending migrations
 *   bun scripts/migrate.ts down          revert the last migration
 *   bun scripts/migrate.ts down --all    revert everything
 *   bun scripts/migrate.ts status
 */
import 'reflect-metadata';
import { loadConfig } from '../src/infrastructure/config/app-config';
import { createOrm } from '../src/infrastructure/persistence/mikro-orm';

const [command = 'up', flag] = process.argv.slice(2);
const config = loadConfig();
const orm = await createOrm({ ...config, DB_POOL_MIN: 0, DB_POOL_MAX: 2 });
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(', ')}` : 'nothing to apply');
      break;
    }
    case 'down': {
      const reverted = flag === '--all' ? await migrator.down({ to: 0 }) : await migrator.down();
      console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(', ')}` : 'nothing to revert');
      break;
    }
    case 'status': {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
      console.log(`pending:  ${pending.map((m) => m.name).join(', ') || '-'}`);
      break;
    }
    default:
      console.error(`unknown command ${command}`);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
