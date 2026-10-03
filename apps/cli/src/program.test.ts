import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from './program.ts';
import { checkConfig } from './checks.ts';
import { exitCodeFor, type CommandIO } from './output.ts';
import { collectParam, fail } from './runtime.ts';

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
      'classify',
      'config-check',
      'db-check',
      'discover',
      'discover-due',
      'duplicates',
      'enrich-references',
      'health',
      'queries',
      'refresh-metrics',
      'rescore',
      'submit-url',
      'tick',
    ]);
  });
});

describe('duplicates', () => {
  it('has scan, list and explain subcommands', () => {
    const dup = buildProgram({ out: () => {}, err: () => {} }).commands.find(
      (c) => c.name() === 'duplicates',
    )!;
    expect(dup.commands.map((c) => c.name())).toEqual(['scan', 'list', 'explain']);
  });

  it('validates ids and statuses before touching the database', async () => {
    const h = harness();
    await h.run('duplicates', 'explain', 'nope', 'also-nope');
    expect(h.err.join('\n')).toMatch(/not a video id: nope/);
    const h2 = harness();
    await h2.run('duplicates', 'list', '--status', 'maybe', '--json');
    expect(JSON.parse(h2.out.join('\n'))).toMatchObject({
      ok: false,
    });
    expect(h2.out.join('\n')).toMatch(/--status must be one of/);
  });
});

describe('classify', () => {
  it('fails clearly without a classifier and never prints the key', async () => {
    const h = harness();
    await h.run('classify', '--eligible', '--json');
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      ok: false,
      error: {
        kind: 'CliError',
        message:
          'classifier unavailable: no classifier configured (set ANTHROPIC_API_KEY, or CLASSIFIER_PROVIDER=anthropic)',
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('rejects mixing --eligible with explicit ids', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'sk-secret-value' });
    await h.run('classify', '--eligible', '--cluster', 'x');
    expect(h.err.join('\n')).toBe('✖ use either --eligible or --cluster/--video');
    expect([...h.out, ...h.err].join('\n')).not.toContain('sk-secret-value');
  });
});

describe('phase 3 commands (validation before any database access)', () => {
  it('rescore rejects conflicting scopes', async () => {
    const h = harness();
    await h.run('rescore', '--unscored', '--recent', '24', '--json');
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      ok: false,
      error: { message: 'choose one of --video, --unscored, --recent (default: stale)' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('queries add validates adapter and kind', async () => {
    const h = harness();
    await h.run('queries', 'add', 'nope', '--kind', 'search');
    expect(h.err.join('\n')).toBe('✖ unknown adapter "nope"; see "vd adapters"');
    const k = harness();
    await k.run('queries', 'add', 'bluesky', '--kind', 'trending');
    expect(k.err.join('\n')).toBe('✖ adapter "bluesky" does not support kind "trending"');
  });

  it('prints the root cause of a wrapped database error, not the SQL', () => {
    const out: string[] = [];
    const cause = new Error('relation "sources" does not exist');
    fail(
      { out: (l) => out.push(l), err: (l) => out.push(l) },
      false,
      new Error('Failed query: select … params: x', { cause }),
    );
    expect(out).toEqual(['✖ database error: relation "sources" does not exist']);
  });

  it('refresh-metrics rejects a malformed ladder', async () => {
    const h = harness();
    await h.run('refresh-metrics', 'youtube', '--due', '--ladder', '2h,soon');
    expect(h.err.join('\n')).toMatch(/invalid ladder step "soon"/);
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

  it('passes recognized TikTok short links on to the pipeline (they need the database)', async () => {
    const h = harness();
    await h.run('submit-url', 'https://vm.tiktok.com/ZMabc/', '--json');
    const parsed = JSON.parse(h.out.join('\n')) as { ok: boolean; error: { message: string } };
    expect(parsed.ok).toBe(false);
    // It got past URL validation and failed only on the unreachable test database.
    expect(parsed.error.message).not.toMatch(/unsupported URL/);
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
