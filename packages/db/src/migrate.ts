import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createLogger, loadConfig, redactDatabaseUrl } from '@vd/config';
import { createDb } from './client.ts';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './health.ts';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const handle = createDb({ url, poolMax: 1, applicationName: 'viral-discovery-migrate' });
  try {
    await migrate(handle.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const logger = createLogger(config, { component: 'migrate' });
  logger.info({ db: redactDatabaseUrl(config.DATABASE_URL) }, 'applying migrations');
  runMigrations(config.DATABASE_URL)
    .then(() => {
      logger.info('migrations applied');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'migration failed');
      process.exitCode = 1;
    });
}
