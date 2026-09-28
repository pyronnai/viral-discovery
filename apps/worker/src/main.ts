import { ConfigError, createLogger, loadConfig } from '@vd/config';
import { buildAdapterRegistry } from './adapters.ts';
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
  const worker = await startWorker({
    config,
    logger,
    registry: buildAdapterRegistry(),
    handlers: {}, // Phase 1: no job handlers.
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    worker
      .stop()
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
