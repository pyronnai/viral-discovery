import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
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

/**
 * True when `moduleUrl` is the script Node was started with. Compares real
 * filesystem paths rather than URL strings, so percent-encoding (spaces, unicode)
 * and symlinks cannot cause a silent mismatch.
 */
export function isEntrypoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
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
