import Link from 'next/link';
import { getDiscoveryHealth } from '@vd/review';
import { SourceHealthTable } from '../../components/SourceHealth.tsx';
import { getContext } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';

/** Is the agent actually finding fresh videos? A small operational view. */
export default async function HealthPage() {
  const ctx = getContext();
  const health = await getDiscoveryHealth(ctx.db, {
    adapters: ctx.adapters.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      platform: a.platform,
      configured: a.configured,
      missingEnv: a.missingEnv,
    })),
    planned: ctx.plannedAdapters,
  });
  const p = health.pipeline;
  return (
    <article className="detail">
      <p>
        <Link href="/">← Back to inbox</Link>
      </p>
      <h1>Discovery health</h1>
      <p className="small muted">
        Multi-source: each adapter feeds the same inbox. Recurring discovery runs via{' '}
        <code>pnpm cli tick</code> (see README → Scheduling).
      </p>

      <section>
        <h2>Pipeline</h2>
        <ul className="history">
          <li>
            New videos discovered (24h): <strong>{p.videosDiscovered24h}</strong>
          </li>
          <li>Last scoring: {fmt(p.lastScoredAt)}</li>
          <li>
            Last duplicate scan: {fmt(p.lastDuplicateScanAt)} · {p.unprocessedForDuplicates} videos
            waiting
          </li>
          <li>
            Last classification: {fmt(p.lastClassifiedAt)}
            {ctx.classifier.configured
              ? ''
              : ` (classifier not configured: ${ctx.classifier.reason})`}
          </li>
        </ul>
      </section>

      <section>
        <h2>Sources</h2>
        <SourceHealthTable health={health} />
      </section>
    </article>
  );
}
