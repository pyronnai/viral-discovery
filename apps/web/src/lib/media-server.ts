/** Download dependencies built from the server context (config + db + logger). */
import type { DownloadDeps } from './download.ts';
import { getContext } from './server.ts';

export function mediaDeps(): DownloadDeps {
  const ctx = getContext();
  const hosts = ctx.config.MEDIA_ASSET_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  return {
    db: ctx.db,
    assetsDir: ctx.config.MEDIA_ASSETS_DIR ?? null,
    maxBytes: ctx.config.MEDIA_ASSET_MAX_BYTES,
    allowedHosts: hosts?.length ? hosts : null,
    logger: ctx.logger,
  };
}
