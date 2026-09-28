import { destination } from 'pino';
import { UpstreamError } from '@vd/adapter-contract';
import { buildAdapterRegistry, type WiredAdapters } from '@vd/adapter-wiring';
import { createLogger, type AppConfig, type Logger } from '@vd/config';
import { createDb } from '@vd/db';
import type { PipelineDeps } from '@vd/pipeline';
import { checkConfig } from './checks.ts';
import type { CommandIO } from './output.ts';

/** A failure that should be shown to the user as-is (no stack trace). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliRuntime {
  config: AppConfig;
  wired: WiredAdapters;
  logger: Logger;
}

/** Validates base configuration and wires adapters. Does not touch the database. */
export function loadRuntime(io: CommandIO): CliRuntime {
  const { result, config } = checkConfig(io.env ?? process.env);
  if (!config) throw new CliError(`configuration invalid: ${result.detail}`);
  // Logs go to stderr so stdout stays clean for --json output.
  const logger = createLogger(config, { component: 'cli' }, destination(2));
  return { config, wired: buildAdapterRegistry(config), logger };
}

/** Opens the database for one command and always closes it. */
export async function withPipeline<T>(
  runtime: CliRuntime,
  fn: (deps: PipelineDeps) => Promise<T>,
): Promise<T> {
  const handle = createDb({
    url: runtime.config.DATABASE_URL,
    poolMax: 2,
    applicationName: 'viral-discovery-cli',
  });
  try {
    return await fn({ db: handle.db, registry: runtime.wired.registry, logger: runtime.logger });
  } finally {
    await handle.close();
  }
}

/**
 * Prints an error (text or JSON) and sets a non-zero exit code. Unexpected errors
 * print only their message; stack traces are for logs, not terminals.
 */
export function fail(io: CommandIO, json: boolean, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const kind = err instanceof UpstreamError ? err.kind : err instanceof Error ? err.name : 'Error';
  if (json) io.out(JSON.stringify({ ok: false, error: { kind, message } }, null, 2));
  else io.err(`✖ ${message}`);
  process.exitCode = 1;
}

/** Repeatable `--param key=value`; a repeated key becomes a list. */
export function collectParam(value: string, previous: Record<string, string | string[]> = {}) {
  const eq = value.indexOf('=');
  if (eq <= 0) throw new CliError(`--param expects key=value, got "${value}"`);
  const key = value.slice(0, eq).trim();
  const v = value.slice(eq + 1).trim();
  const existing = previous[key];
  return {
    ...previous,
    [key]: existing === undefined ? v : [...(Array.isArray(existing) ? existing : [existing]), v],
  };
}

export function positiveInt(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0)
      throw new CliError(`${name} must be a positive integer, got "${value}"`);
    return n;
  };
}
