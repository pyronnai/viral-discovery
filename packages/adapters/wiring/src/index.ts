/**
 * The ONLY place platform adapters are wired into a process (worker and CLI both
 * call this). Adding or removing a source is a change here plus its package.
 *
 * Each adapter is registered only when its own configuration is present. A
 * missing YouTube key never blocks Bluesky, Twitch, or manual URL submission.
 */
import {
  AdapterRegistry,
  type AdapterManifest,
  type FetchLike,
  type SourceAdapter,
} from '@vd/adapter-contract';
import { createBlueskyAdapter, blueskyManifest } from '@vd/adapter-bluesky';
import { createManualUrlAdapter, manualUrlManifest } from '@vd/adapter-manual-url';
import { createBrightDataProvider, createTikTokAdapter, tiktokManifest } from '@vd/adapter-tiktok';
import { createTwitchAdapter, twitchManifest } from '@vd/adapter-twitch';
import { createYouTubeAdapter, youtubeManifest } from '@vd/adapter-youtube';
import type { AppConfig } from '@vd/config';

export interface AdapterStatus {
  id: string;
  displayName: string;
  platform: string;
  capabilities: readonly string[];
  referencePlatforms: readonly string[];
  configured: boolean;
  /** Names (never values) of required variables that are not set. */
  missingEnv: string[];
  docsPath: string;
}

export interface WiredAdapters {
  registry: AdapterRegistry;
  statuses: AdapterStatus[];
  /** adapter id → platform for every known adapter, configured or not. */
  platforms: Record<string, string>;
  /** adapter id → sighting role (propagation | provenance) for every known adapter. */
  sightingRoles: Record<string, 'propagation' | 'provenance'>;
}

type AdapterConfig = Pick<
  AppConfig,
  | 'YOUTUBE_API_KEY'
  | 'YOUTUBE_STATS_BATCH_SIZE'
  | 'TWITCH_CLIENT_ID'
  | 'TWITCH_CLIENT_SECRET'
  | 'BLUESKY_APPVIEW_URL'
  | 'TIKTOK_PUBLIC_PROVIDER'
  | 'BRIGHTDATA_API_TOKEN'
  | 'BRIGHTDATA_TIKTOK_DATASET_ID'
  | 'BRIGHTDATA_API_URL'
  | 'BRIGHTDATA_MAX_WAIT_SECONDS'
>;

interface Definition {
  manifest: AdapterManifest;
  create: (config: AdapterConfig, fetch: FetchLike | undefined) => SourceAdapter;
  /** Missing variable names when they depend on configuration (default: manifest.requiredEnv). */
  missingEnv?: (config: AdapterConfig) => string[];
  /** Display name when it depends on configuration (e.g. the data provider). */
  displayName?: (config: AdapterConfig) => string;
}

/** The public TikTok data provider: explicit, else Bright Data when its token is set. */
export function tiktokProvider(config: AdapterConfig): 'brightdata' | 'none' {
  return config.TIKTOK_PUBLIC_PROVIDER ?? (config.BRIGHTDATA_API_TOKEN ? 'brightdata' : 'none');
}

const DEFINITIONS: readonly Definition[] = [
  {
    manifest: youtubeManifest,
    create: (c, fetch) =>
      createYouTubeAdapter({
        apiKey: c.YOUTUBE_API_KEY ?? '',
        ...(c.YOUTUBE_STATS_BATCH_SIZE ? { statsBatchSize: c.YOUTUBE_STATS_BATCH_SIZE } : {}),
        ...(fetch ? { fetch } : {}),
      }),
  },
  {
    manifest: twitchManifest,
    create: (c, fetch) =>
      createTwitchAdapter({
        clientId: c.TWITCH_CLIENT_ID ?? '',
        clientSecret: c.TWITCH_CLIENT_SECRET ?? '',
        ...(fetch ? { fetch } : {}),
      }),
  },
  {
    manifest: blueskyManifest,
    create: (c, fetch) =>
      createBlueskyAdapter({
        ...(c.BLUESKY_APPVIEW_URL ? { appviewUrl: c.BLUESKY_APPVIEW_URL } : {}),
        ...(fetch ? { fetch } : {}),
      }),
  },
  {
    manifest: manualUrlManifest,
    create: (_c, fetch) => createManualUrlAdapter(fetch ? { fetch } : {}),
  },
  {
    manifest: tiktokManifest,
    // Provider-neutral adapter; the provider is chosen (and credentialed) here only.
    create: (c, fetch) =>
      createTikTokAdapter({
        provider: createBrightDataProvider({
          token: c.BRIGHTDATA_API_TOKEN ?? '',
          ...(c.BRIGHTDATA_TIKTOK_DATASET_ID ? { datasetId: c.BRIGHTDATA_TIKTOK_DATASET_ID } : {}),
          ...(c.BRIGHTDATA_API_URL ? { baseUrl: c.BRIGHTDATA_API_URL } : {}),
          ...(c.BRIGHTDATA_MAX_WAIT_SECONDS
            ? { maxWaitMs: c.BRIGHTDATA_MAX_WAIT_SECONDS * 1000 }
            : {}),
          ...(fetch ? { fetch } : {}),
        }),
      }),
    missingEnv: (c) => {
      if (c.TIKTOK_PUBLIC_PROVIDER === 'none') return ['TIKTOK_PUBLIC_PROVIDER=brightdata'];
      return c.BRIGHTDATA_API_TOKEN ? [] : ['BRIGHTDATA_API_TOKEN'];
    },
    displayName: (c) =>
      tiktokProvider(c) === 'brightdata'
        ? 'TikTok public data via Bright Data'
        : 'TikTok public data (no provider configured)',
  },
];

/** Adapters documented but not implemented (access-gated). Listed so tools can say why. */
export const PLANNED_ADAPTERS = [
  {
    id: 'reddit',
    reason: 'Data API access requires Reddit approval (commercial use: explicit written approval)',
    docsPath: 'docs/sources/reddit.md',
  },
] as const;

export function buildAdapterRegistry(
  config: AdapterConfig,
  options: { fetch?: FetchLike } = {},
): WiredAdapters {
  const registry = new AdapterRegistry();
  const statuses: AdapterStatus[] = [];
  for (const { manifest, create, missingEnv: missingFor, displayName } of DEFINITIONS) {
    const missingEnv = missingFor
      ? missingFor(config)
      : manifest.requiredEnv.filter(
          (name) => !(config as Record<string, string | number | undefined>)[name],
        );
    const configured = missingEnv.length === 0;
    if (configured) registry.register(create(config, options.fetch));
    statuses.push({
      id: manifest.id,
      displayName: displayName ? displayName(config) : manifest.displayName,
      platform: manifest.platform,
      capabilities: manifest.capabilities,
      referencePlatforms: manifest.referencePlatforms,
      configured,
      missingEnv,
      docsPath: manifest.docsPath,
    });
  }
  return {
    registry,
    statuses,
    platforms: Object.fromEntries(statuses.map((s) => [s.id, s.platform])),
    sightingRoles: Object.fromEntries(
      DEFINITIONS.map((d) => [d.manifest.id, d.manifest.sightingRole]),
    ),
  };
}

/** A helpful message for an adapter that exists but is not configured, or undefined. */
export function unconfiguredMessage(
  statuses: AdapterStatus[],
  adapterId: string,
): string | undefined {
  const status = statuses.find((s) => s.id === adapterId);
  if (status && !status.configured) {
    return `adapter "${adapterId}" is not configured: set ${status.missingEnv.join(', ')} (see ${status.docsPath})`;
  }
  const planned = PLANNED_ADAPTERS.find((p) => p.id === adapterId);
  if (planned)
    return `adapter "${adapterId}" is planned but not implemented: ${planned.reason} (see ${planned.docsPath})`;
  return undefined;
}
