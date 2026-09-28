import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { ALL_TABLES } from './schema.ts';
import { getTableName } from 'drizzle-orm';

export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * - unreachable: could not connect / run a trivial query (network, auth, …).
 * - unmigrated:  connected, but application tables are missing (fresh DB → run migrations).
 * - migrated:    connected and every application table is present.
 * - error:       connected, but a later inspection query failed unexpectedly.
 */
export type DbHealthStatus = 'unreachable' | 'unmigrated' | 'migrated' | 'error';

export interface DbHealth {
  ok: boolean;
  status: DbHealthStatus;
  latencyMs: number;
  serverVersion: string | null;
  /** null when the migrations table does not exist (no migration has ever run). */
  migrationsApplied: number | null;
  missingTables: string[];
  error?: string;
}

/** Connectivity + migration status check. Never throws. */
export async function checkDatabase(db: Database): Promise<DbHealth> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let serverVersion: string | null;
  try {
    const version = await db.execute<{ server_version: string }>(sql`SHOW server_version`);
    serverVersion = version.rows[0]?.server_version ?? null;
  } catch (err) {
    return failure('unreachable', elapsed(), null, err);
  }
  const latencyMs = elapsed();

  try {
    // Postgres resolves every relation in a statement before running it, so the
    // migrations table must be probed on its own before it is counted.
    const probe = await db.execute<{ present: boolean }>(
      sql`SELECT to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) IS NOT NULL AS present`,
    );
    let migrationsApplied: number | null = null;
    if (probe.rows[0]?.present) {
      const counted = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`,
      );
      migrationsApplied = Number(counted.rows[0]?.count ?? 0);
    }

    const expected = Object.values(ALL_TABLES).map((t) => getTableName(t));
    const present = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const presentSet = new Set(present.rows.map((r) => r.table_name));
    const missingTables = expected.filter((t) => !presentSet.has(t));

    const ok = missingTables.length === 0;
    return {
      ok,
      status: ok ? 'migrated' : 'unmigrated',
      latencyMs,
      serverVersion,
      migrationsApplied,
      missingTables,
    };
  } catch (err) {
    return failure('error', latencyMs, serverVersion, err);
  }
}

function failure(
  status: 'unreachable' | 'error',
  latencyMs: number,
  serverVersion: string | null,
  err: unknown,
): DbHealth {
  return {
    ok: false,
    status,
    latencyMs,
    serverVersion,
    migrationsApplied: null,
    missingTables: [],
    error: rootCauseMessage(err),
  };
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
