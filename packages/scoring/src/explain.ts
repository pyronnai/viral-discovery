import type { ComponentName, ScoreResult } from './types.ts';

const LABELS: Record<ComponentName, string> = {
  velocity: 'velocity',
  acceleration: 'acceleration',
  engagement: 'engagement',
  freshness: 'freshness',
  crossSource: 'cross-source sightings',
  sourcePropagation: 'source propagation (discovery-source engagement)',
  creatorOutlier: 'creator outlier',
};

/** Human-readable breakdown, e.g. for the CLI and (later) the review dashboard. */
export function explainScore(result: ScoreResult): string[] {
  const head =
    result.score === null
      ? `Virality score: — (${result.state}; confidence ${result.confidence})`
      : `Virality score: ${result.score} (${result.state}; confidence ${result.confidence}; ${result.algorithmVersion})`;
  const lines = [head];
  for (const [name, c] of Object.entries(result.components) as [
    ComponentName,
    ScoreResult['components'][ComponentName],
  ][]) {
    if (!c.available) {
      lines.push(`  - ${LABELS[name]}: unavailable (${c.reason})`);
      continue;
    }
    const d = c.details;
    let extra = '';
    if (name === 'velocity')
      extra = ` — ${String(d['perHour'])} ${String(d['metric'])}/h over ${String(d['hours'])}h, ${c.normalization === 'platform_percentile' ? 'platform percentile' : 'absolute fallback scale'}`;
    if (name === 'crossSource')
      extra = ` — ${String(d['distinctSources'])} source(s), ${String(d['independentObservations'])} independent observation(s)`;
    if (name === 'sourcePropagation')
      extra = ` — ${String(d['interactions'])} interactions on ${String(d['items'])} source item(s)`;
    if (name === 'freshness') extra = ` — ${String(d['ageHours'])}h old`;
    if (name === 'acceleration') extra = ` — ×${String(d['ratio'])}`;
    lines.push(`  - ${LABELS[name]}: ${c.strength} (${c.value})${extra}`);
  }
  if (result.reasonCodes.length) lines.push(`  reasons: ${result.reasonCodes.join(', ')}`);
  return lines;
}
