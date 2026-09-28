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
}

type AdapterConfig = Pick<
  AppConfig,
  | 'YOUTUBE_API_KEY'
  | 'YOUTUBE_STATS_BATCH_SIZE'
  | 'TWITCH_CLIENT_ID'
  | 'TWITCH_CLIENT_SECRET'
  | 'BLUESKY_APPVIEW_URL'
>;

interface Definition {
  manifest: AdapterManifest;
  create: (config: AdapterConfig, fetch: FetchLike | undefined) => SourceAdapter;
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
  for (const { manifest, create } of DEFINITIONS) {
    const missingEnv = manifest.requiredEnv.filter(
      (name) => !(config as Record<string, string | undefined>)[name],
    );
    const configured = missingEnv.length === 0;
    if (configured) registry.register(create(config, options.fetch));
    statuses.push({
      id: manifest.id,
      displayName: manifest.displayName,
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
