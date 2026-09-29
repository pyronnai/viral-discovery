import { ConfigError, createLogger, loadConfig } from '@vd/config';
import { buildAdapterRegistry as wire } from '@vd/adapter-wiring';
import { createClassifier } from '@vd/classification';
import { createDb } from '@vd/db';
import { pipelineHandlers } from './pipeline-handlers.ts';
import { startWorker } from './worker.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config, { component: 'worker' });
  const wired = wire(config);
  // The pipeline gets its own pool; pg-boss keeps its own connections.
  const pipelineDb = createDb({
    url: config.DATABASE_URL,
    poolMax: Math.max(2, Math.floor(config.DATABASE_POOL_MAX / 2)),
    applicationName: 'viral-discovery-pipeline',
  });
  const worker = await startWorker({
    config,
    logger,
    registry: wired.registry,
    handlers: pipelineHandlers(
      {
        db: pipelineDb.db,
        registry: wired.registry,
        logger,
        adapterPlatforms: wired.platforms,
        adapterSightingRoles: wired.sightingRoles,
      },
      undefined,
      { classifier: createClassifier(config) },
    ),
  }).catch(async (err: unknown) => {
    await pipelineDb.close();
    throw err;
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    worker
      .stop()
      .then(() => pipelineDb.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `worker failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  if (err instanceof Error && err.cause !== undefined) {
    const cause = err.cause instanceof Error ? err.cause.message : JSON.stringify(err.cause);
    process.stderr.write(`caused by: ${cause}\n`);
  }
  process.exit(1);
});
