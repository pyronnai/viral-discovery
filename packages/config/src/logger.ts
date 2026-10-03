import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './env.ts';

export type { Logger } from 'pino';

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>,
  bindings: Record<string, unknown> = {},
  /** Defaults to stdout. The CLI passes stderr so logs never mix with command output. */
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV, ...bindings },
    redact: {
      paths: [
        '*.password',
        '*.apiKey',
        '*.clientSecret',
        '*.token',
        'DATABASE_URL',
        '*.YOUTUBE_API_KEY',
        '*.TWITCH_CLIENT_SECRET',
        '*.ANTHROPIC_API_KEY',
      ],
      censor: '[redacted]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
