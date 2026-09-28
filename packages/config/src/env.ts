import { z } from 'zod';

/**
 * Environment schema. Every variable the application reads must be declared here.
 * Source credentials are optional: an adapter is only registered when its own
 * variables are set, so one missing key never blocks unrelated sources.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/db)' })
    .min(1, 'DATABASE_URL must not be empty')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), {
      message: 'DATABASE_URL must start with postgres:// or postgresql://',
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  PGBOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'PGBOSS_SCHEMA must be a lowercase SQL identifier')
    .default('pgboss'),

  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

  // ── source adapters (all optional; see docs/sources/*.md) ─────────────────
  YOUTUBE_API_KEY: z.string().min(1).optional(),
  TWITCH_CLIENT_ID: z.string().min(1).optional(),
  TWITCH_CLIENT_SECRET: z.string().min(1).optional(),
  /** Unauthenticated Bluesky AppView host. Defaults to https://api.bsky.app. */
  BLUESKY_APPVIEW_URL: z.url({ protocol: /^https$/ }).optional(),
});

/** Names of variables that hold secrets. Never print their values. */
export const SECRET_ENV_KEYS = ['YOUTUBE_API_KEY', 'TWITCH_CLIENT_SECRET'] as const;

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n` +
        'See .env.example for the full list of variables.',
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Parses and validates configuration. Throws ConfigError with readable messages. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Treat empty strings as "unset" so defaults apply and required checks fire clearly.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}

/** Redacts credentials from a connection string for safe logging/printing. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}
