import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildReadings, metricValue } from '@vd/core';
import type { AdapterContext } from './adapter.ts';
import { AdapterContractError, checkAdapter, safeNormalize } from './validate.ts';
import { AdapterRegistry } from './registry.ts';
import { createInMemoryQuotaBudget } from './quota.ts';
import {
  createFixtureAdapter,
  describeAdapterContract,
  toRaw,
  type FixturePayload,
} from './testing/index.ts';

const at = new Date('2026-09-28T10:00:00Z');
const items: FixturePayload[] = [
  {
    id: 'a1',
    title: 'Cat vs cucumber',
    author: 'kit',
    views: 1200,
    publishedAt: '2026-09-27T08:00:00Z',
  },
  { id: 'a2', title: 'Dog fail', author: 'rex', views: 50, publishedAt: '2026-09-26T08:00:00Z' },
];

// The reusable suite, run against the in-memory fixture adapter.
describeAdapterContract('fixture', {
  create: () => createFixtureAdapter(items),
  validFixtures: items.map((i) => toRaw(i, at)),
  invalidFixtures: [
    {
      adapterId: 'fixture-source',
      externalId: 'bad',
      fetchedAt: at,
      payload: { id: 1 },
      context: {},
    },
  ],
});

function ctx(limits: Record<string, number> = {}): AdapterContext {
  return {
    logger: pino({ level: 'silent' }),
    signal: new AbortController().signal,
    quota: createInMemoryQuotaBudget(limits),
    now: () => at,
  };
}

describe('checkAdapter', () => {
  it('flags a declared capability without an implementation', () => {
    const adapter = createFixtureAdapter(items, {
      capabilities: ['discovery.search', 'normalize'],
    });
    const problems = checkAdapter(adapter);
    expect(problems).toContain(
      'declares "discovery.search" but does not implement discoverSearch()',
    );
    expect(problems).toContain(
      'implements discoverTrending() but does not declare "discovery.trending"',
    );
  });

  it('requires the normalize capability', () => {
    const adapter = {
      ...createFixtureAdapter(items),
      manifest: {
        ...createFixtureAdapter().manifest,
        capabilities: ['discovery.trending' as const],
      },
    };
    expect(checkAdapter(adapter).join()).toMatch(/normalize/);
  });
});

describe('safeNormalize', () => {
  it('rejects values for metrics the manifest does not declare', () => {
    const base = createFixtureAdapter(items);
    const adapter = {
      ...base,
      normalize: (raw: Parameters<typeof base.normalize>[0]) => ({
        ...base.normalize(raw),
        metrics: buildReadings({ views: metricValue(1), shares: metricValue(5) }),
      }),
    };
    const result = safeNormalize(adapter, toRaw(items[0]!, at));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/shares/);
  });

  it('reports a thrown normalize() instead of throwing', () => {
    const result = safeNormalize(createFixtureAdapter(), {
      ...toRaw(items[0]!, at),
      payload: null,
    });
    expect(result).toEqual({ ok: false, errors: ['normalize() threw: malformed fixture payload'] });
  });
});

describe('AdapterRegistry', () => {
  it('registers, resolves by capability/query kind, and unregisters', () => {
    const registry = new AdapterRegistry().register(createFixtureAdapter(items));
    expect(registry.size).toBe(1);
    expect(registry.supportsQueryKind('fixture-source', 'trending')).toBe(true);
    expect(registry.supportsQueryKind('fixture-source', 'search')).toBe(false);
    expect(() => registry.register(createFixtureAdapter())).toThrow(/already registered/);
    expect(registry.unregister('fixture-source')).toBe(true);
    expect(() => registry.get('fixture-source')).toThrow(/No adapter/);
  });

  it('refuses invalid adapters', () => {
    const bad = createFixtureAdapter(items, { capabilities: ['discovery.search', 'normalize'] });
    expect(() => new AdapterRegistry().register(bad)).toThrow(AdapterContractError);
  });
});

describe('discovery through the contract', () => {
  it('stops when the quota bucket is exhausted', async () => {
    const adapter = createFixtureAdapter(items);
    const out: string[] = [];
    for await (const raw of adapter.discoverTrending!(
      { kind: 'trending', params: {}, region: null, limit: 10 },
      ctx({ default: 1 }),
    )) {
      out.push(raw.externalId);
    }
    expect(out).toEqual(['a1']);
  });
});

describe('createInMemoryQuotaBudget', () => {
  it('tracks usage per bucket and treats unconfigured buckets as locally unlimited', () => {
    const q = createInMemoryQuotaBudget({ 'search.list': 2 });
    expect(q.tryConsume('search.list', 2)).toBe(true);
    expect(q.tryConsume('search.list', 1)).toBe(false);
    expect(q.remaining('search.list')).toBe(0);
    expect(q.tryConsume('default', 500)).toBe(true);
    expect(q.remaining('default')).toBeNull();
    expect(q.usage()).toEqual({ 'search.list': 2, default: 500 });
  });
});
