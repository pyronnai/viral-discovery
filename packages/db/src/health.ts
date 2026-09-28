import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { ALL_TABLES } from './schema.ts';
import { getTableName } from 'drizzle-orm';

export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  serverVersion: string | null;
  migrationsApplied: number | null;
  missingTables: string[];
  error?: string;
}

/** Connectivity + migration status check. Never throws. */
export async function checkDatabase(db: Database): Promise<DbHealth> {
  const started = performance.now();
  try {
    const version = await db.execute<{ server_version: string }>(sql`SHOW server_version`);
    const latencyMs = Math.round(performance.now() - started);

    const migrations = await db.execute<{ count: string | null }>(sql`
      SELECT CASE WHEN to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) IS NULL
        THEN NULL ELSE (SELECT count(*)::text FROM drizzle.__drizzle_migrations) END AS count`);
    const countRaw = migrations.rows[0]?.count ?? null;

    const expected = Object.values(ALL_TABLES).map((t) => getTableName(t));
    const present = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const presentSet = new Set(present.rows.map((r) => r.table_name));
    const missingTables = expected.filter((t) => !presentSet.has(t));

    return {
      ok: missingTables.length === 0,
      latencyMs,
      serverVersion: version.rows[0]?.server_version ?? null,
      migrationsApplied: countRaw === null ? null : Number(countRaw),
      missingTables,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      serverVersion: null,
      migrationsApplied: null,
      missingTables: [],
      error: rootCauseMessage(err),
    };
  }
}

/** Drizzle wraps driver errors ("Failed query: …"); report the underlying cause instead. */
function rootCauseMessage(err: unknown): string {
  let current: unknown = err;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  if (current instanceof Error) {
    const code = 'code' in current && typeof current.code === 'string' ? ` (${current.code})` : '';
    return (current.message || current.name) + code;
  }
  return String(current);
}
