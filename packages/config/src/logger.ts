import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './env.ts';

export type { Logger } from 'pino';

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>,
  bindings: Record<string, unknown> = {},
): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV, ...bindings },
    redact: {
      paths: ['*.password', '*.apiKey', '*.clientSecret', '*.token', 'DATABASE_URL'],
      censor: '[redacted]',
    },
  };
  return pino(options);
}
