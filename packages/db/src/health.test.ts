import { describe, expect, it } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from './client.ts';
import { checkDatabase } from './health.ts';
import { ALL_TABLES } from './schema.ts';

const dialect = new PgDialect();
const ALL = Object.values(ALL_TABLES).map((t) => getTableName(t));

interface FakeState {
  connectError?: Error;
  /** undefined = the drizzle migrations table does not exist. */
  migrationsCount?: number;
  tables: string[];
  failOn?: RegExp;
}

/**
 * A stand-in for Postgres that answers the health-check queries. Like Postgres,
 * any statement that names the migrations table fails with 42P01 when the table
 * does not exist — even inside a branch that would never be evaluated.
 */
function fakeDb(state: FakeState): Database {
  const execute = (query: SQL) => {
    const text = dialect.sqlToQuery(query).sql;
    if (state.connectError) return Promise.reject(state.connectError);
    if (state.failOn?.test(text)) return Promise.reject(new Error('permission denied'));
    if (/SHOW server_version/.test(text)) {
      return Promise.resolve({ rows: [{ server_version: '17.0' }] });
    }
    if (/__drizzle_migrations/.test(text) && state.migrationsCount === undefined) {
      const err = Object.assign(
        new Error('relation "drizzle.__drizzle_migrations" does not exist'),
        { code: '42P01' },
      );
      return Promise.reject(new Error('Failed query', { cause: err }));
    }
    if (/to_regclass/.test(text)) {
      return Promise.resolve({ rows: [{ present: state.migrationsCount !== undefined }] });
    }
    if (/count\(\*\)/.test(text)) {
      return Promise.resolve({ rows: [{ count: String(state.migrationsCount) }] });
    }
    if (/information_schema\.tables/.test(text)) {
      return Promise.resolve({ rows: state.tables.map((table_name) => ({ table_name })) });
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
  return { execute } as unknown as Database;
}

describe('checkDatabase', () => {
  it('reports a connection failure as unreachable', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    const health = await checkDatabase(fakeDb({ connectError: err, tables: [] }));
    expect(health).toMatchObject({ ok: false, status: 'unreachable', serverVersion: null });
    expect(health.error).toBe('connect ECONNREFUSED 127.0.0.1:1 (ECONNREFUSED)');
  });

  it('reports a fresh, reachable database as unmigrated rather than unreachable', async () => {
    const health = await checkDatabase(fakeDb({ tables: [] }));
    expect(health).toMatchObject({
      ok: false,
      status: 'unmigrated',
      serverVersion: '17.0',
      migrationsApplied: null,
    });
    expect(health.error).toBeUndefined();
    expect(health.missingTables.sort()).toEqual([...ALL].sort());
  });

  it('reports a partially migrated database as unmigrated', async () => {
    const health = await checkDatabase(fakeDb({ migrationsCount: 1, tables: ['sources'] }));
    expect(health).toMatchObject({ ok: false, status: 'unmigrated', migrationsApplied: 1 });
    expect(health.missingTables).not.toContain('sources');
  });

  it('reports a fully migrated database as migrated', async () => {
    const health = await checkDatabase(fakeDb({ migrationsCount: 1, tables: ALL }));
    expect(health).toMatchObject({
      ok: true,
      status: 'migrated',
      migrationsApplied: 1,
      missingTables: [],
    });
  });

  it('does not mistake a failure after connecting for unreachability', async () => {
    const health = await checkDatabase(
      fakeDb({ migrationsCount: 1, tables: ALL, failOn: /information_schema/ }),
    );
    expect(health).toMatchObject({
      ok: false,
      status: 'error',
      serverVersion: '17.0',
      error: 'permission denied',
    });
  });
});
