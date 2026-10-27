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
  /** Application batch size for videos:batchGetStats (YouTube documents no maximum). */
  YOUTUBE_STATS_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).optional(),
  TWITCH_CLIENT_ID: z.string().min(1).optional(),
  TWITCH_CLIENT_SECRET: z.string().min(1).optional(),
  /** Unauthenticated Bluesky AppView host. Defaults to https://api.bsky.app. */
  BLUESKY_APPVIEW_URL: z.url({ protocol: /^https$/ }).optional(),

  // ── content classification (optional; dashboard works without it) ─────────
  /** Default: "anthropic" when ANTHROPIC_API_KEY is set, otherwise "none". */
  CLASSIFIER_PROVIDER: z.enum(['anthropic', 'none']).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Model id for the classifier (default claude-opus-5-5). */
  CLASSIFIER_MODEL: z.string().min(1).optional(),
  /** Virality score at or above which scored/provisional candidates are classified. */
  CLASSIFICATION_MIN_SCORE: z.coerce.number().min(0).max(100).default(60),

  // ── web dashboard ─────────────────────────────────────────────────────────
  /** Viral Now window in hours (default: the scoring algorithm's window, 48). */
  VIRAL_NOW_HOURS: z.coerce.number().int().min(1).max(720).optional(),
  /**
   * Optional access gate for the internal dashboard. When set, every page asks for
   * this token once (stored as a hashed, httpOnly cookie). Use ≥ 16 random chars.
   */
  DASHBOARD_ACCESS_TOKEN: z
    .string()
    .min(16, 'DASHBOARD_ACCESS_TOKEN must be at least 16 characters')
    .optional(),

  // ── media assets (dashboard downloads of official/authorized assets only) ─
  /**
   * Directory holding local media assets referenced by `media_assets` rows with a
   * `local:` or `file://` url. Unset = local assets are never served.
   */
  MEDIA_ASSETS_DIR: z.string().min(1).optional(),
  /** Largest asset the dashboard will stream, in bytes (default 1 GiB). */
  MEDIA_ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(64 * 1024 ** 3)
    .default(1024 ** 3),
  /**
   * Optional comma-separated allowlist of hosts for remote (https) media assets.
   * Unset = any public https host named by a media_assets row (never private networks).
   */
  MEDIA_ASSET_HOSTS: z.string().min(1).optional(),
});

/** Names of variables that hold secrets. Never print their values. */
export const SECRET_ENV_KEYS = [
  'YOUTUBE_API_KEY',
  'TWITCH_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'DASHBOARD_ACCESS_TOKEN',
] as const;

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
