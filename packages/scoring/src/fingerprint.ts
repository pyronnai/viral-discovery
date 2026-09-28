import { createHash } from 'node:crypto';
import type { ScoringConfig } from './config.ts';
import type { ScoringInput } from './types.ts';

/**
 * Stable hash of the evidence a score depends on (excluding the clock and the
 * population). Identical evidence ⇒ identical fingerprint ⇒ rescoring is a no-op.
 */
export function evidenceFingerprint(input: ScoringInput, config: ScoringConfig): string {
  const asOf = input.asOf.getTime();
  const payload = {
    config,
    platform: input.platform,
    publishedAt: input.publishedAt?.toISOString() ?? null,
    firstDiscoveredAt: input.firstDiscoveredAt.toISOString(),
    snapshots: input.snapshots
      .filter((s) => s.capturedAt.getTime() <= asOf)
      .map((s) => ({ at: s.capturedAt.toISOString(), metrics: s.metrics }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    sightings: input.sightings
      .filter((s) => s.seenAt.getTime() <= asOf)
      .map((s) => [s.sourceId, s.observationKey, s.seenAt.toISOString(), s.sourceEngagement])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    creator: input.creator ? [...input.creator.otherVideoValues].sort((a, b) => a - b) : null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
