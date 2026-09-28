import { sql } from 'drizzle-orm';
import { ConfigError, loadConfig, redactDatabaseUrl, type AppConfig } from '@vd/config';
import { checkDatabase, createDb } from '@vd/db';
import type { CheckResult } from './output.ts';

export function checkConfig(env: Record<string, string | undefined> = process.env): {
  result: CheckResult;
  config: AppConfig | null;
} {
  try {
    const config = loadConfig(env);
    return {
      config,
      result: {
        name: 'config',
        status: 'pass',
        detail: `valid (NODE_ENV=${config.NODE_ENV}, DATABASE_URL=${redactDatabaseUrl(config.DATABASE_URL)})`,
      },
    };
  } catch (err) {
    const issues = err instanceof ConfigError ? err.issues : [String(err)];
    return {
      config: null,
      result: { name: 'config', status: 'fail', detail: issues.join('; '), data: { issues } },
    };
  }
}

export async function checkDb(config: AppConfig): Promise<CheckResult[]> {
  const handle = createDb({
    url: config.DATABASE_URL,
    poolMax: 1,
    applicationName: 'viral-discovery-cli',
  });
  try {
    const health = await checkDatabase(handle.db);
    if (health.error) {
      return [{ name: 'database', status: 'fail', detail: `unreachable: ${health.error}` }];
    }
    const results: CheckResult[] = [
      {
        name: 'database',
        status: 'pass',
        detail: `connected (PostgreSQL ${health.serverVersion ?? '?'}, ${health.latencyMs}ms)`,
      },
      health.missingTables.length === 0
        ? {
            name: 'schema',
            status: 'pass',
            detail: `all tables present (${health.migrationsApplied ?? 0} migration(s) applied)`,
          }
        : {
            name: 'schema',
            status: 'fail',
            detail: `missing tables: ${health.missingTables.join(', ')} — run "pnpm db:migrate"`,
          },
    ];
    const boss = await handle.db.execute<{ installed: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${config.PGBOSS_SCHEMA}) AS installed`,
    );
    results.push(
      boss.rows[0]?.installed
        ? {
            name: 'job-queue',
            status: 'pass',
            detail: `pg-boss schema "${config.PGBOSS_SCHEMA}" installed`,
          }
        : {
            name: 'job-queue',
            status: 'warn',
            detail: `pg-boss schema "${config.PGBOSS_SCHEMA}" not installed yet (created on first worker start)`,
          },
    );
    return results;
  } finally {
    await handle.close();
  }
}
