import { MetricReadingsSchema, type MetricKey, type MetricReadings } from '@vd/core';
import { CAPABILITY_METHODS, type SourceAdapter } from './adapter.ts';
import { AdapterCapabilitySchema, AdapterManifestSchema } from './manifest.ts';
import {
  MetricRefreshResultSchema,
  NormalizedVideoSchema,
  type MetricRefreshResult,
  type NormalizedVideo,
  type RawItem,
} from './normalized.ts';

export class AdapterContractError extends Error {
  readonly problems: readonly string[];
  constructor(adapterId: string, problems: readonly string[]) {
    super(`Adapter "${adapterId}" violates the contract:\n  - ${problems.join('\n  - ')}`);
    this.name = 'AdapterContractError';
    this.problems = problems;
  }
}

/** Returns a list of contract problems (empty = valid). Never throws. */
export function checkAdapter(adapter: SourceAdapter): string[] {
  const problems: string[] = [];
  const parsed = AdapterManifestSchema.safeParse(adapter.manifest);
  if (!parsed.success) {
    for (const i of parsed.error.issues)
      problems.push(`manifest.${i.path.join('.')}: ${i.message}`);
    return problems;
  }
  const declared = new Set(parsed.data.capabilities);
  for (const capability of AdapterCapabilitySchema.options) {
    const method = CAPABILITY_METHODS[capability];
    const implemented = typeof adapter[method] === 'function';
    if (declared.has(capability) && !implemented) {
      problems.push(`declares "${capability}" but does not implement ${method}()`);
    }
    if (!declared.has(capability) && implemented) {
      problems.push(`implements ${method}() but does not declare "${capability}"`);
    }
  }
  return problems;
}

export function assertValidAdapter(adapter: SourceAdapter): void {
  const problems = checkAdapter(adapter);
  if (problems.length > 0) {
    // The manifest may be malformed at runtime (that is why we are throwing), so read it as unknown.
    const manifest: unknown = adapter.manifest;
    const id =
      typeof manifest === 'object' &&
      manifest !== null &&
      'id' in manifest &&
      typeof manifest.id === 'string'
        ? manifest.id
        : '(unknown)';
    throw new AdapterContractError(id, problems);
  }
}

export type NormalizeResult =
  { ok: true; value: NormalizedVideo } | { ok: false; errors: string[] };

/**
 * Pipeline boundary: runs normalize(), validates the output against the shared
 * schema, and enforces that only declared metrics carry values. Never throws —
 * invalid items are reported so the caller can quarantine them.
 */
export function safeNormalize(adapter: SourceAdapter, raw: RawItem): NormalizeResult {
  let output: unknown;
  try {
    output = adapter.normalize(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`normalize() threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const parsed = NormalizedVideoSchema.safeParse(output);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];
  const { manifest } = adapter;
  if (isReference(adapter, value)) {
    if (!manifest.referencePlatforms.includes(value.platform)) {
      errors.push(
        `platform "${value.platform}" is neither the manifest platform "${manifest.platform}" nor in manifest.referencePlatforms`,
      );
    }
    // Engagement seen on a referencing post is not engagement of the video itself.
    if (value.metrics) {
      errors.push(`a reference to a "${value.platform}" video must not carry metrics`);
    }
    // Labels on a referencing post describe that post, not the linked video.
    if (value.moderationLabels?.length) {
      errors.push(
        `a reference to a "${value.platform}" video must not carry source moderation labels`,
      );
    }
  } else if (value.metrics) {
    errors.push(...undeclaredMetricErrors(adapter, value.metrics));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * True when the adapter observed a video hosted on another platform (e.g. a
 * link in a post). References never overwrite canonical data or carry metrics.
 */
export function isReference(adapter: SourceAdapter, video: Pick<NormalizedVideo, 'platform'>) {
  return video.platform !== adapter.manifest.platform;
}

function undeclaredMetricErrors(adapter: SourceAdapter, metrics: MetricReadings): string[] {
  const provided = new Set<MetricKey>(adapter.manifest.metricsProvided);
  const readings = MetricReadingsSchema.parse(metrics);
  const errors: string[] = [];
  for (const [key, reading] of Object.entries(readings) as [MetricKey, typeof readings.views][]) {
    if (reading.kind === 'value' && !provided.has(key)) {
      errors.push(`metric "${key}" has a value but is not in manifest.metricsProvided`);
    }
  }
  return errors;
}

export type RefreshResultCheck =
  | { ok: true; value: MetricRefreshResult }
  | { ok: false; platformVideoId: string | null; errors: string[] };

/** Validates refreshMetrics() output with the same rules as safeNormalize(). Never throws. */
export function checkRefreshResults(
  adapter: SourceAdapter,
  results: readonly unknown[],
): RefreshResultCheck[] {
  return results.map((result) => {
    const parsed = MetricRefreshResultSchema.safeParse(result);
    if (!parsed.success) {
      const id =
        typeof result === 'object' &&
        result !== null &&
        'platformVideoId' in result &&
        typeof result.platformVideoId === 'string'
          ? result.platformVideoId
          : null;
      return {
        ok: false,
        platformVideoId: id,
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }
    const errors = parsed.data.metrics ? undeclaredMetricErrors(adapter, parsed.data.metrics) : [];
    return errors.length > 0
      ? { ok: false, platformVideoId: parsed.data.platformVideoId, errors }
      : { ok: true, value: parsed.data };
  });
}
