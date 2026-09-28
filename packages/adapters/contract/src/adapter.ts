import type { SourceQueryKind } from '@vd/core';
import type { Logger } from '@vd/config';
import type { AdapterCapability, AdapterManifest } from './manifest.ts';
import type {
  MetricRefreshResult,
  NormalizedCreator,
  NormalizedVideo,
  RawItem,
} from './normalized.ts';
import type { QuotaBudget } from './quota.ts';

/** Everything an adapter may use at runtime. Adapters must not reach for globals. */
export interface AdapterContext {
  logger: Logger;
  signal: AbortSignal;
  quota: QuotaBudget;
  now(): Date;
}

export interface DiscoveryRequest {
  kind: SourceQueryKind;
  /** Adapter-specific parameters from SourceQuery.params, validated by the adapter. */
  params: Record<string, unknown>;
  region: string | null;
  /** Soft upper bound on items to yield. */
  limit: number;
}

export interface VideoRef {
  platformVideoId: string;
  canonicalUrl: string;
}

export interface CreatorRef {
  platformCreatorId: string | null;
  handle: string | null;
}

/**
 * The contract every source adapter implements. Optional methods correspond 1:1
 * to capabilities; checkAdapter() reports, and assertValidAdapter() rejects, any
 * mismatch between declared capabilities and implemented methods.
 */
export interface SourceAdapter {
  readonly manifest: AdapterManifest;

  /** capability: discovery.search */
  discoverSearch?(req: DiscoveryRequest, ctx: AdapterContext): AsyncIterable<RawItem>;
  /** capability: discovery.trending */
  discoverTrending?(req: DiscoveryRequest, ctx: AdapterContext): AsyncIterable<RawItem>;
  /** capability: discovery.feed */
  discoverFeed?(req: DiscoveryRequest, ctx: AdapterContext): AsyncIterable<RawItem>;
  /** capability: discovery.url — returns null if the URL isn't this adapter's or isn't reachable. */
  lookupUrl?(url: string, ctx: AdapterContext): Promise<RawItem | null>;
  /** capability: metrics.refresh */
  refreshMetrics?(refs: readonly VideoRef[], ctx: AdapterContext): Promise<MetricRefreshResult[]>;
  /** capability: creator.enrich */
  enrichCreator?(ref: CreatorRef, ctx: AdapterContext): Promise<NormalizedCreator | null>;

  /**
   * capability: normalize (required). MUST be pure and deterministic: no I/O,
   * no clock reads (use raw.fetchedAt), no randomness.
   */
  normalize(raw: RawItem): NormalizedVideo;
}

/** Maps each capability to the method that implements it. */
export const CAPABILITY_METHODS = {
  'discovery.search': 'discoverSearch',
  'discovery.trending': 'discoverTrending',
  'discovery.feed': 'discoverFeed',
  'discovery.url': 'lookupUrl',
  'metrics.refresh': 'refreshMetrics',
  'creator.enrich': 'enrichCreator',
  normalize: 'normalize',
} as const satisfies Record<AdapterCapability, keyof SourceAdapter>;

/** Which capability serves which SourceQuery kind. */
export const QUERY_KIND_CAPABILITY = {
  search: 'discovery.search',
  trending: 'discovery.trending',
  channel_feed: 'discovery.feed',
  community_feed: 'discovery.feed',
} as const satisfies Record<SourceQueryKind, AdapterCapability>;
