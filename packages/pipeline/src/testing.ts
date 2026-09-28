/**
 * Test helpers: an in-process Postgres (PGlite) with the real migrations applied.
 * Imported only by *.test.ts files.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { AdapterRegistry, type SourceAdapter } from '@vd/adapter-contract';
import { MIGRATIONS_FOLDER, schema, type AnyDatabase } from '@vd/db';
import type { PipelineDeps } from './ingest.ts';

export async function createTestDb(): Promise<{ db: AnyDatabase; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  });
  return { db, close: () => client.close() };
}

/** A controllable clock for deterministic observedAt/captured_at values. */
export function testClock(start = '2026-09-28T12:00:00Z') {
  let current = new Date(start);
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function testDeps(
  db: AnyDatabase,
  adapters: SourceAdapter[],
  now: () => Date,
): PipelineDeps {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return { db, registry, logger: pino({ level: 'silent' }), now };
}
