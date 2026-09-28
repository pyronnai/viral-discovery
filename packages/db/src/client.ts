import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;
/**
 * Any Postgres driver's Drizzle database over this schema. Code that only uses the
 * query builder (the ingestion pipeline) accepts this, so tests can run it on an
 * in-process Postgres (PGlite) as well as on node-postgres.
 */
export type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(options: {
  url: string;
  poolMax?: number;
  applicationName?: string;
}): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'viral-discovery',
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
