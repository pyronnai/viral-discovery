import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from './program.ts';
import { checkConfig } from './checks.ts';
import { exitCodeFor, type CommandIO } from './output.ts';
import { collectParam } from './runtime.ts';

/** Captures output; DATABASE_URL points nowhere, so any DB access would fail loudly. */
function harness(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none', LOG_LEVEL: 'silent', ...env },
  };
  const run = (...args: string[]) => buildProgram(io).parseAsync(['node', 'vd', ...args]);
  return { out, err, run };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('cli program', () => {
  it('registers the infrastructure and discovery commands', () => {
    const names = buildProgram({ out: () => {}, err: () => {} }).commands.map((c) => c.name());
    expect(names.sort()).toEqual([
      'adapters',
      'config-check',
      'db-check',
      'discover',
      'health',
      'refresh-metrics',
      'submit-url',
    ]);
  });
});

describe('checkConfig', () => {
  it('fails with the validation issue when DATABASE_URL is missing', () => {
    const { result, config } = checkConfig({});
    expect(config).toBeNull();
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/DATABASE_URL/);
  });

  it('redacts the password in its report', () => {
    const { result } = checkConfig({ DATABASE_URL: 'postgres://u:hunter2@localhost/db' });
    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('hunter2');
  });
});

describe('exitCodeFor', () => {
  it('only fails on "fail"', () => {
    expect(exitCodeFor([{ name: 'a', status: 'warn', detail: '' }])).toBe(0);
    expect(exitCodeFor([{ name: 'a', status: 'fail', detail: '' }])).toBe(1);
  });
});

describe('adapters', () => {
  it('works with no credentials and never prints secret values', async () => {
    const h = harness({ YOUTUBE_API_KEY: 'yt-secret-value', TWITCH_CLIENT_ID: 'cid' });
    await h.run('adapters', '--json');
    const parsed = JSON.parse(h.out.join('\n')) as {
      adapters: { id: string; configured: boolean; missingEnv: string[] }[];
    };
    expect(parsed.adapters.map((a) => [a.id, a.configured, a.missingEnv])).toEqual([
      ['youtube', true, []],
      ['twitch', false, ['TWITCH_CLIENT_SECRET']],
      ['bluesky', true, []],
      ['manual-url', true, []],
    ]);
    expect(h.out.join('\n')).not.toContain('yt-secret-value');
  });
});

describe('discover', () => {
  it('explains a missing credential without touching the database', async () => {
    const h = harness();
    await h.run('discover', 'youtube', '--param', 'regionCode=US');
    expect(process.exitCode).toBe(1);
    expect(h.err.join('\n')).toBe(
      '✖ adapter "youtube" is not configured: set YOUTUBE_API_KEY (see docs/sources/youtube.md)',
    );
  });

  it('says Reddit is planned but access-gated', async () => {
    const h = harness();
    await h.run('discover', 'reddit');
    expect(h.err.join('\n')).toMatch(/planned but not implemented.*approval/);
    expect(process.exitCode).toBe(1);
  });

  it('reports errors as JSON in --json mode', async () => {
    const h = harness();
    await h.run('discover', 'nope', '--json');
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      ok: false,
      error: { kind: 'CliError', message: 'unknown adapter "nope"; see "vd adapters"' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('requires an adapter or --query', async () => {
    const h = harness();
    await h.run('discover');
    expect(h.err.join('\n')).toMatch(/missing adapter/);
  });
});

describe('submit-url', () => {
  it('rejects unsupported URLs before reading any configuration', async () => {
    const h = harness({ DATABASE_URL: undefined });
    await h.run('submit-url', 'https://vimeo.com/12345');
    expect(h.err.join('\n')).toBe(
      '✖ unsupported URL (unsupported_host): unsupported host "vimeo.com" (supported: YouTube, TikTok, Twitch clips)',
    );
    expect(process.exitCode).toBe(1);
  });

  it('asks for the full URL instead of following TikTok short links', async () => {
    const h = harness();
    await h.run('submit-url', 'https://vm.tiktok.com/ZMabc/', '--json');
    const parsed = JSON.parse(h.out.join('\n')) as { ok: boolean; error: { message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toMatch(/paste the full/);
  });
});

describe('collectParam', () => {
  it('builds params, turning repeated keys into lists', () => {
    let params = collectParam('regionCode=US');
    params = collectParam('regionCode=GB', params);
    params = collectParam('q=funny cats=yes', params);
    expect(params).toEqual({ regionCode: ['US', 'GB'], q: 'funny cats=yes' });
    expect(() => collectParam('novalue')).toThrow(/key=value/);
  });
});
