import { describe, expect, it } from 'vitest';
import { safeNormalize, type RawItem } from '@vd/adapter-contract';
import { collect, createFakeFetch, route, testAdapterContext } from '@vd/adapter-contract/testing';
import labelled from '../fixtures/searchPosts-labelled.json' with { type: 'json' };
import { PostView, createBlueskyAdapter, moderationLabels } from './adapter.ts';

const MOD = 'did:plc:ar7c4by46qjdydhdevvrndac';
const at = new Date('2026-10-03T02:00:00Z');
const fixture = (i: number) => labelled.posts[i]!;
const [modPost, selfPost, accountPost, profilePost, unlabelledPost] = [0, 1, 2, 3, 4].map(
  fixture,
) as [
  (typeof labelled.posts)[number],
  (typeof labelled.posts)[number],
  (typeof labelled.posts)[number],
  (typeof labelled.posts)[number],
  (typeof labelled.posts)[number],
];
const post = (p: unknown) => PostView.parse(p);

describe('bluesky source moderation labels', () => {
  it('keeps a moderation-service label on the post verbatim, as explicit content', () => {
    expect(moderationLabels(post(modPost), at)).toEqual([
      { value: 'porn', labeler: MOD, scope: 'content', selfApplied: false, explicit: true },
    ]);
  });

  it('reads author self-labels once, whether from post.labels or record.labels', () => {
    const labels = moderationLabels(post(selfPost), at);
    expect(labels.map((l) => [l.value, l.selfApplied, l.explicit])).toEqual([
      ['graphic-media', true, true],
      ['nudity', true, true],
    ]);
    // Only the record's selfLabels (no mirrored post.labels) still count.
    const recordOnly = { ...selfPost, labels: [] };
    expect(moderationLabels(post(recordOnly), at).map((l) => l.value)).toEqual([
      'graphic-media',
      'nudity',
    ]);
  });

  it('applies account labels (uri = DID) but not profile-record labels', () => {
    expect(moderationLabels(post(accountPost), at)).toEqual([
      { value: 'sexual', labeler: MOD, scope: 'account', selfApplied: false, explicit: true },
    ]);
    expect(moderationLabels(post(profilePost), at)).toEqual([]);
  });

  it('reports an unlabelled post as labelled with nothing — never guesses from text', () => {
    expect(moderationLabels(post(unlabelledPost), at)).toEqual([]);
  });

  it('drops negated and expired labels; keeps non-explicit values as non-explicit', () => {
    // Constructed (not observed): a negation pair, an expired label, and a custom value.
    const uri = modPost.uri;
    const constructed = {
      ...modPost,
      labels: [
        { src: MOD, uri, val: 'porn', cts: '2026-10-03T01:00:00Z' },
        { src: MOD, uri, val: 'porn', neg: true, cts: '2026-10-03T01:30:00Z' },
        { src: MOD, uri, val: 'graphic-media', exp: '2026-10-03T01:59:00Z' },
        { src: MOD, uri, val: '!warn' },
        { src: 'did:plc:somelabeler', uri, val: 'spoiler' },
        { not: 'a label' },
      ],
    };
    expect(moderationLabels(post(constructed), at)).toEqual([
      { value: '!warn', labeler: MOD, scope: 'content', selfApplied: false, explicit: false },
      {
        value: 'spoiler',
        labeler: 'did:plc:somelabeler',
        scope: 'content',
        selfApplied: false,
        explicit: false,
      },
    ]);
  });

  it('carries labels on native videos; a labelled post linking elsewhere adds none to the linked video', async () => {
    const adapter = createBlueskyAdapter({
      fetch: createFakeFetch([route('/xrpc/app.bsky.feed.searchPosts', { body: labelled })]),
      expandShortLinks: false,
    });
    const items: RawItem[] = await collect(
      adapter.discoverSearch!(
        { kind: 'search', params: { q: 'x' }, region: null, limit: 100 },
        testAdapterContext(),
      ),
    );
    const byId = new Map(
      items.map((raw) => {
        const result = safeNormalize(adapter, raw);
        if (!result.ok) throw new Error(result.errors.join('; '));
        return [result.value.platformVideoId, result.value];
      }),
    );
    expect(byId.get(modPost.uri)?.moderationLabels?.map((l) => l.value)).toEqual(['porn']);
    expect(byId.get(unlabelledPost.uri)?.moderationLabels).toEqual([]);
    const linked = byId.get('fixtureLbl1');
    expect(linked?.platform).toBe('youtube');
    expect(linked?.moderationLabels ?? null).toBeNull();
  });

  it('reports current labels on refresh (labelers often act after first discovery)', async () => {
    const adapter = createBlueskyAdapter({
      fetch: createFakeFetch([
        route('/xrpc/app.bsky.feed.getPosts', { body: { posts: [modPost] } }),
      ]),
    });
    const [result] = await adapter.refreshMetrics!(
      [{ platformVideoId: modPost.uri, canonicalUrl: 'https://bsky.app/x' }],
      testAdapterContext(),
    );
    expect(result?.moderationLabels?.map((l) => [l.value, l.explicit])).toEqual([['porn', true]]);
  });
});
