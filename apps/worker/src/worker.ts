import { PgBoss } from 'pg-boss';
import { count, eq } from 'drizzle-orm';
import type { AppConfig, Logger } from '@vd/config';
import type { AdapterRegistry } from '@vd/adapter-contract';
import { checkDatabase, createDb, schema, type DbHandle } from '@vd/db';
import { ensureQueues } from './queues.ts';
import { registerHandlers, type JobHandlerMap } from './handlers.ts';

export interface WorkerDeps {
  config: AppConfig;
  logger: Logger;
  registry: AdapterRegistry;
  handlers: JobHandlerMap;
}

export interface RunningWorker {
  stop(): Promise<void>;
  readonly boss: PgBoss;
  readonly dbHandle: DbHandle;
}

export class WorkerStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkerStartupError';
  }
}

export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const { config, logger, registry, handlers } = deps;

  const dbHandle = createDb({
    url: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    applicationName: 'viral-discovery-worker',
  });

  const health = await checkDatabase(dbHandle.db);
  if (!health.ok) {
    await dbHandle.close();
    const reason =
      health.status === 'unmigrated'
        ? `schema incomplete (missing: ${health.missingTables.join(', ')}). Run "pnpm db:migrate".`
        : `database ${health.status === 'unreachable' ? 'unreachable' : 'check failed'}: ${health.error ?? 'unknown error'}`;
    throw new WorkerStartupError(reason);
  }
  logger.info(
    { serverVersion: health.serverVersion, migrationsApplied: health.migrationsApplied },
    'database ok',
  );

  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: config.PGBOSS_SCHEMA,
    application_name: 'viral-discovery-boss',
    max: Math.max(2, Math.floor(config.DATABASE_POOL_MAX / 2)),
  });
  boss.on('error', (err) => {
    logger.error({ err }, 'pg-boss error');
  });
  boss.on('warning', (warning) => {
    logger.warn({ warning }, 'pg-boss warning');
  });

  try {
    await boss.start();
    const created = await ensureQueues(boss);
    logger.info({ schema: config.PGBOSS_SCHEMA, createdQueues: created }, 'job queues ready');

    const registered = await registerHandlers(boss, handlers, logger);
    logger.info(
      { handlers: registered },
      registered.length
        ? 'job handlers registered'
        : 'no job handlers registered (expected in Phase 1)',
    );

    await reportSourceState(dbHandle, registry, logger);
  } catch (err) {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await dbHandle.close();
    throw new WorkerStartupError('worker failed to start', { cause: err });
  }

  logger.info({ adapters: registry.list().map((a) => a.manifest.id) }, 'worker started');

  let stopping: Promise<void> | undefined;
  return {
    boss,
    dbHandle,
    stop() {
      stopping ??= (async () => {
        logger.info('worker stopping');
        await boss.stop({ graceful: true, timeout: config.WORKER_SHUTDOWN_TIMEOUT_MS });
        await dbHandle.close();
        logger.info('worker stopped');
      })();
      return stopping;
    },
  };
}

/** Logs configured sources/queries vs registered adapters. Never schedules anything in Phase 1. */
async function reportSourceState(handle: DbHandle, registry: AdapterRegistry, logger: Logger) {
  const enabledSources = await handle.db
    .select({
      id: schema.sources.id,
      name: schema.sources.name,
      adapterId: schema.sources.adapterId,
    })
    .from(schema.sources)
    .where(eq(schema.sources.enabled, true));

  const unresolved = enabledSources.filter((s) => !registry.has(s.adapterId));
  if (unresolved.length > 0) {
    logger.warn(
      { sources: unresolved.map((s) => `${s.name} → ${s.adapterId}`) },
      'enabled sources reference adapters that are not registered; they will be ignored',
    );
  }

  const [queries] = await handle.db
    .select({ n: count() })
    .from(schema.sourceQueries)
    .where(eq(schema.sourceQueries.enabled, true));

  logger.info(
    {
      enabledSources: enabledSources.length,
      enabledQueries: queries?.n ?? 0,
      adapters: registry.size,
    },
    'source state: discovery scheduling is not implemented yet (Phase 1)',
  );
}
