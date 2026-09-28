import { eq } from 'drizzle-orm';
import { safeNormalize, type SourceAdapter } from '@vd/adapter-contract';
import { schema } from '@vd/db';
import { resolveVideoUrl, type UrlRejectionReason } from '@vd/url-identity';
import {
  adapterContext,
  ingestOne,
  runItems,
  type PipelineDeps,
  type RunSummary,
} from './ingest.ts';
import { recordApiUsage } from './persist.ts';
import { PipelineError, ensureSource, loadQuotaBudget, usageDate } from './sources.ts';

export class UnsupportedUrlError extends PipelineError {
  readonly reason: UrlRejectionReason;
  constructor(reason: UrlRejectionReason, message: string) {
    super(message);
    this.name = 'UnsupportedUrlError';
    this.reason = reason;
  }
}

export type EnrichmentResult =
  | { status: 'enriched'; adapterId: string; snapshot: boolean }
  | { status: 'not_found'; adapterId: string; message: string }
  | { status: 'failed'; adapterId: string; message: string }
  | { status: 'no_adapter'; message: string };

export interface SubmitResult {
  run: RunSummary;
  video: {
    id: string;
    platform: string;
    platformVideoId: string;
    canonicalUrl: string;
    title: string | null;
    availability: string;
  };
  enrichment: EnrichmentResult;
}

/** The adapter that records submissions: any adapter that can look up references to the platform. */
function submissionAdapter(deps: PipelineDeps, platform: string): SourceAdapter | undefined {
  return deps.registry
    .list()
    .find(
      (a) =>
        a.manifest.capabilities.includes('discovery.url') &&
        a.manifest.referencePlatforms.includes(platform),
    );
}

/** A configured adapter for the video's own platform that can look up a single URL. */
function canonicalAdapter(deps: PipelineDeps, platform: string): SourceAdapter | undefined {
  return deps.registry
    .list()
    .find(
      (a) => a.manifest.platform === platform && a.manifest.capabilities.includes('discovery.url'),
    );
}

/**
 * Records a manually submitted URL:
 *  1. identity via @vd/url-identity (unsupported URLs are rejected, never guessed);
 *  2. a sighting from the submission source (e.g. "manual-url"), as a reference;
 *  3. enrichment from the canonical platform's adapter, if one is configured —
 *     authoritative metadata + first metric snapshot, without a sighting.
 */
export async function submitUrl(deps: PipelineDeps, url: string): Promise<SubmitResult> {
  const resolved = resolveVideoUrl(url);
  if (!resolved.ok) throw new UnsupportedUrlError(resolved.reason, resolved.message);

  const recorder = submissionAdapter(deps, resolved.platform);
  if (!recorder) throw new PipelineError(`no adapter can record ${resolved.platform} URLs`);
  const source = await ensureSource(deps.db, recorder.manifest);
  const lookup = recorder.lookupUrl?.bind(recorder);
  if (!lookup) throw new PipelineError(`adapter "${recorder.manifest.id}" cannot look up URLs`);

  const run = await runItems(deps, {
    adapter: recorder,
    source,
    trigger: 'manual',
    sourceQueryId: null,
    request: { adapterId: recorder.manifest.id, kind: 'url', url },
    filters: {},
    items: async function* (ctx) {
      const raw = await lookup(url, ctx);
      if (raw) yield raw;
    },
  });
  const videoId = run.videoIds[0];
  if (run.status !== 'succeeded' || !videoId) {
    throw new PipelineError(
      `submission was not recorded: ${run.error ?? run.stats.invalidSamples[0]?.errors.join('; ') ?? 'no item'}`,
    );
  }

  const enrichment = await enrich(deps, resolved.platform, url, videoId);

  const [video] = await deps.db
    .select({
      id: schema.videos.id,
      platform: schema.videos.platform,
      platformVideoId: schema.videos.platformVideoId,
      canonicalUrl: schema.videos.canonicalUrl,
      title: schema.videos.title,
      availability: schema.videos.availability,
    })
    .from(schema.videos)
    .where(eq(schema.videos.id, videoId));
  if (!video) throw new PipelineError('submitted video vanished');
  return { run, video, enrichment };
}

async function enrich(
  deps: PipelineDeps,
  platform: string,
  url: string,
  expectedVideoId: string,
): Promise<EnrichmentResult> {
  const adapter = canonicalAdapter(deps, platform);
  if (!adapter?.lookupUrl) {
    return {
      status: 'no_adapter',
      message: `no configured ${platform} adapter; stored identity and whatever the submission source provides`,
    };
  }
  const adapterId = adapter.manifest.id;
  const now = deps.now ?? (() => new Date());
  const source = await ensureSource(deps.db, adapter.manifest);
  const quota = await loadQuotaBudget(deps.db, source, now());
  try {
    const raw = await adapter.lookupUrl(url, adapterContext(deps, adapter, quota));
    if (!raw) {
      return {
        status: 'not_found',
        adapterId,
        message: `${platform} did not return this video (removed, private, or wrong id)`,
      };
    }
    const normalized = safeNormalize(adapter, raw);
    if (!normalized.ok) {
      return { status: 'failed', adapterId, message: normalized.errors.join('; ') };
    }
    const result = await ingestOne(deps.db, {
      adapter,
      source,
      runId: null,
      raw,
      video: normalized.value,
      writeSighting: false,
      writeSnapshot: true,
    });
    if (result.videoId !== expectedVideoId) {
      return {
        status: 'failed',
        adapterId,
        message: 'canonical lookup resolved to a different video',
      };
    }
    return { status: 'enriched', adapterId, snapshot: result.snapshot };
  } catch (err) {
    return {
      status: 'failed',
      adapterId,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await recordApiUsage(deps.db, source.id, usageDate(now()), quota.usage());
  }
}
