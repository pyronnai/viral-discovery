import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactDatabaseUrl } from './env.ts';

const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const cfg = loadConfig(valid);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.PGBOSS_SCHEMA).toBe('pgboss');
    expect(cfg.DATABASE_POOL_MAX).toBe(10);
  });

  it('fails with a clear message when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join('\n')).toMatch(/DATABASE_URL/);
      expect((err as ConfigError).message).toMatch(/\.env\.example/);
    }
  });

  it('treats empty strings as unset', () => {
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('rejects non-postgres URLs and invalid enums', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('coerces numeric variables', () => {
    expect(loadConfig({ ...valid, DATABASE_POOL_MAX: '3' }).DATABASE_POOL_MAX).toBe(3);
  });
});

describe('redactDatabaseUrl', () => {
  it('masks the password', () => {
    expect(redactDatabaseUrl('postgres://u:secret@h:5432/d')).toBe('postgres://u:***@h:5432/d');
  });
});
