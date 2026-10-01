/**
 * Server-side context for the dashboard: validated config, one DB pool per
 * process, adapter sighting roles (from manifests), and the classifier if
 * configured. Rendering stored data never requires source API credentials.
 */
import { PLANNED_ADAPTERS, buildAdapterRegistry, type AdapterStatus } from '@vd/adapter-wiring';
import { createClassifier, type ClassifierSetup } from '@vd/classification';
import { createLogger, loadConfig, type AppConfig, type Logger } from '@vd/config';
import { createDb, type DbHandle } from '@vd/db';
import type { PipelineDeps } from '@vd/pipeline';
import type { SightingRoles } from '@vd/review';

export interface ServerContext {
  config: AppConfig;
  db: DbHandle['db'];
  roles: SightingRoles;
  platforms: Record<string, string>;
  /** Every known adapter with configured/unconfigured status (names of missing env only). */
  adapters: AdapterStatus[];
  plannedAdapters: { id: string; reason: string }[];
  classifier: ClassifierSetup;
  logger: Logger;
  pipeline: () => PipelineDeps;
}

const globalForContext = globalThis as unknown as { __vdContext?: ServerContext };

export function getContext(): ServerContext {
  if (globalForContext.__vdContext) return globalForContext.__vdContext;
  const config = loadConfig(process.env);
  const wired = buildAdapterRegistry(config);
  const handle = createDb({
    url: config.DATABASE_URL,
    poolMax: Math.min(config.DATABASE_POOL_MAX, 5),
    applicationName: 'viral-discovery-web',
  });
  const logger = createLogger(config, { component: 'web' });
  const context: ServerContext = {
    config,
    db: handle.db,
    roles: wired.sightingRoles,
    platforms: wired.platforms,
    adapters: wired.statuses,
    plannedAdapters: PLANNED_ADAPTERS.map((p) => ({ id: p.id, reason: p.reason })),
    classifier: createClassifier(config),
    logger,
    pipeline: () => ({
      db: handle.db,
      registry: wired.registry,
      logger,
      adapterPlatforms: wired.platforms,
      adapterSightingRoles: wired.sightingRoles,
    }),
  };
  globalForContext.__vdContext = context;
  return context;
}
