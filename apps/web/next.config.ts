import type { NextConfig } from 'next';

/**
 * Internal, single-user review dashboard. Server-rendered from the database; it
 * never proxies or downloads source media (thumbnails load directly from the
 * platform's CDN, "Open original" links to the canonical URL).
 */
const config: NextConfig = {
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@vd/adapter-bluesky',
    '@vd/adapter-contract',
    '@vd/adapter-manual-url',
    '@vd/adapter-twitch',
    '@vd/adapter-wiring',
    '@vd/adapter-youtube',
    '@vd/classification',
    '@vd/config',
    '@vd/core',
    '@vd/db',
    '@vd/pipeline',
    '@vd/review',
    '@vd/scoring',
    '@vd/url-identity',
    '@vd/url-resolution',
  ],
  // Node-only server dependencies stay external to the bundle.
  serverExternalPackages: ['pg', 'pino', '@anthropic-ai/sdk'],
};

export default config;
