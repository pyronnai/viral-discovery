import { describe, expect, it } from 'vitest';
import { ACCESS_COOKIE, safeNext, sameDigest, sha256Hex, tokenMatches } from './access.ts';
import { feedHref, hasFilters, parseFilters } from './filters.ts';

describe('feed filters <-> URL', () => {
  it('parses known values and ignores malformed ones', () => {
    expect(
      parseFilters({
        review: 'saved',
        label: 'animals',
        platform: 'youtube',
        source: 'bluesky',
        state: 'insufficient_evidence',
        minScore: '60',
        within: '24',
        rights: 'unknown',
        flagged: '1',
      }),
    ).toEqual({
      review: 'saved',
      label: 'animals',
      platform: 'youtube',
      source: 'bluesky',
      state: 'insufficient_evidence',
      minScore: 60,
      discoveredWithinHours: 24,
      rights: 'unknown',
      flagged: true,
    });
    const junk = parseFilters({
      review: 'published',
      label: 'cute',
      minScore: '-5',
      within: 'soon',
      platform: "x' or 1=1",
      rights: 'cleared',
    });
    expect(hasFilters(junk)).toBe(false);
  });

  it('round-trips through the URL, with a cursor for the next page', () => {
    const f = parseFilters({ review: 'unreviewed', label: 'funny', minScore: '70' });
    expect(feedHref(f)).toBe('/?review=unreviewed&label=funny&minScore=70');
    expect(
      parseFilters(Object.fromEntries(new URLSearchParams(feedHref(f, 'abc').slice(2)))),
    ).toEqual(f);
    expect(feedHref({})).toBe('/');
  });
});

describe('access gate helpers', () => {
  it('compares hashed tokens and only allows relative redirects', async () => {
    expect(ACCESS_COOKIE).toBe('vd_access');
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await tokenMatches('correct-token-123456', 'correct-token-123456')).toBe(true);
    expect(await tokenMatches('wrong-token-00000000', 'correct-token-123456')).toBe(false);
    expect(sameDigest('ab', 'abc')).toBe(false);
    expect(safeNext('/candidates/x')).toBe('/candidates/x');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
