import { describe, expect, it } from 'vitest';
import { buildReadings, metricValue } from '@vd/core';
import { UpstreamError, describeUrl, requestJson } from './http.ts';
import { AdapterManifestSchema } from './manifest.ts';
import { stringList, parseParams, InvalidParamsError } from './params.ts';
import { checkRefreshResults, isReference, safeNormalize } from './validate.ts';
import { createFakeFetch, createFixtureAdapter, route, toRaw } from './testing/index.ts';
import { z } from 'zod';

const at = new Date('2026-09-28T10:00:00Z');
const item = { id: 'a1', title: 't', author: 'x', views: 5, publishedAt: '2026-09-27T08:00:00Z' };

describe('reference platforms', () => {
  const linker = (referencePlatforms: string[], withMetrics = false) => {
    const base = createFixtureAdapter([item], { referencePlatforms });
    return {
      ...base,
      normalize: (raw: Parameters<typeof base.normalize>[0]) => ({
        ...base.normalize(raw),
        platform: 'youtube',
        metrics: withMetrics ? buildReadings({ views: metricValue(1) }) : null,
      }),
    };
  };

  it('accepts a declared reference without metrics', () => {
    const adapter = linker(['youtube']);
    const result = safeNormalize(adapter, toRaw(item, at));
    expect(result.ok).toBe(true);
    if (result.ok) expect(isReference(adapter, result.value)).toBe(true);
  });

  it('rejects undeclared reference platforms and references carrying metrics', () => {
    const undeclared = safeNormalize(linker([]), toRaw(item, at));
    expect(!undeclared.ok && undeclared.errors.join()).toMatch(/neither the manifest platform/);
    const withMetrics = safeNormalize(linker(['youtube'], true), toRaw(item, at));
    expect(!withMetrics.ok && withMetrics.errors.join()).toMatch(/must not carry metrics/);
  });

  it('forbids referencing the adapter’s own platform', () => {
    const parsed = AdapterManifestSchema.safeParse({
      ...createFixtureAdapter().manifest,
      referencePlatforms: ['fixture'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('checkRefreshResults', () => {
  it('validates shape and declared metrics per result', () => {
    const adapter = createFixtureAdapter();
    const checks = checkRefreshResults(adapter, [
      {
        platformVideoId: 'a',
        availability: 'available',
        metrics: buildReadings({ views: metricValue(3) }),
        observedAt: at,
      },
      {
        platformVideoId: 'b',
        availability: 'available',
        metrics: buildReadings({ likes: metricValue(3) }),
        observedAt: at,
      },
      { platformVideoId: 'c', availability: 'gone', metrics: null, observedAt: at },
    ]);
    expect(checks.map((c) => c.ok)).toEqual([true, false, false]);
    expect(checks[1]).toMatchObject({
      platformVideoId: 'b',
      errors: [expect.stringMatching(/likes/)],
    });
  });
});

describe('requestJson', () => {
  const url = 'https://api.example.test/v1/items?key=super-secret&q=1';

  it('maps HTTP status to a typed error without the query string', async () => {
    const fetch = createFakeFetch([route('/v1/items', { status: 404, body: { error: 'nope' } })]);
    const err = await requestJson(url, { service: 'example', fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'not_found', status: 404, body: { error: 'nope' } });
    expect((err as Error).message).toBe('example: HTTP 404 for https://api.example.test/v1/items');
  });

  it('reports non-JSON success bodies as invalid_response', async () => {
    const fetch = createFakeFetch([route('/v1/items', { body: '<html>' })]);
    await expect(requestJson(url, { service: 'example', fetch })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('reports network failures without leaking the URL query', async () => {
    const fetch = () => Promise.reject(new TypeError('fetch failed'));
    const err = await requestJson(url, { service: 'example', fetch }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network' });
    expect((err as Error).message).not.toContain('super-secret');
  });

  it('describeUrl drops the query string', () => {
    expect(describeUrl(url)).toBe('https://api.example.test/v1/items');
  });
});

describe('params helpers', () => {
  it('accepts CSV or arrays for list params and names bad params', () => {
    const schema = z.object({ region: stringList(z.string().length(2)) });
    expect(parseParams('x', schema, { region: 'US, GB,' })).toEqual({ region: ['US', 'GB'] });
    expect(parseParams('x', schema, { region: ['DE'] })).toEqual({ region: ['DE'] });
    expect(() => parseParams('x', schema, { region: 'USA' })).toThrow(InvalidParamsError);
    expect(() => parseParams('x', schema, { region: 'USA' })).toThrow(
      /invalid x query parameters: region\.0/,
    );
  });
});
