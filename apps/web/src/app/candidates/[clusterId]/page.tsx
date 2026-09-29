import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ANALYSIS_FIELDS, type AnalysisField } from '@vd/classification';
import {
  REVIEW_LABELS,
  componentViews,
  formatCount,
  getCandidate,
  growthSeries,
  splitSources,
  toCardView,
} from '@vd/review';
import { ClassifyButton } from '../../../components/ClassifyButton.tsx';
import {
  ScoreBadge,
  ScoreBreakdown,
  SourcesBlock,
  Sparkline,
} from '../../../components/Evidence.tsx';
import { ReviewControls } from '../../../components/ReviewControls.tsx';
import { RightsForm } from '../../../components/RightsForm.tsx';
import { Thumbnail } from '../../../components/Thumbnail.tsx';
import { getContext } from '../../../lib/server.ts';

export const dynamic = 'force-dynamic';

const ANALYSIS_LABELS: Record<AnalysisField, string> = {
  hook: 'Hook',
  setup: 'Setup',
  payoff: 'Payoff / punchline',
  emotionalDriver: 'Emotional driver',
  novelty: 'Novelty / unexpected element',
  pacingNotes: 'Pacing',
  audienceAppeal: 'Likely audience appeal',
  reusableFormat: 'Reusable format',
  suggestedTheme: 'Suggested theme',
  whyItMayWork: 'Why it may work',
};

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ clusterId: string }>;
}) {
  const { clusterId } = await params;
  const ctx = getContext();
  const detail = await getCandidate(ctx.db, clusterId);
  if (!detail) notFound();
  const now = new Date();
  const card = toCardView(detail.summary, ctx.roles, now);
  const latestScore = detail.scores[0] ?? null;
  const classification = detail.classifications.find((c) => c.current) ?? null;
  const series = growthSeries(detail.snapshots);
  const sightingSources = splitSources(detail.summary.sources, ctx.roles);

  return (
    <article className="detail">
      <p>
        <Link href="/">← Back to feed</Link>
      </p>
      <div className="detail-head">
        <Thumbnail src={card.thumbnailUrl} alt={card.title} platform={card.platform} large />
        <div className="detail-meta">
          <h1>{card.title}</h1>
          <p>
            <strong>{card.platform}</strong> · {card.creator ?? 'unknown creator'}
            {card.creatorHandle ? ` (@${card.creatorHandle})` : ''} · {card.duration} · published{' '}
            {fmt(detail.summary.publishedAt)} · first discovered{' '}
            {fmt(detail.summary.firstDiscoveredAt)}
          </p>
          {card.availabilityNote ? <p className="warn">{card.availabilityNote}</p> : null}
          <p>
            <a className="btn" href={card.canonicalUrl} target="_blank" rel="noopener noreferrer">
              Open original ↗
            </a>{' '}
            <span className="muted small">{card.canonicalUrl}</span>
          </p>
          <ReviewControls clusterId={clusterId} status={card.review.status} withNote />
        </div>
        <ScoreBadge
          text={card.score.text}
          stateLabel={card.score.stateLabel}
          state={card.score.state}
          confidence={card.score.confidence}
        />
      </div>

      <section>
        <h2>Virality evidence</h2>
        <p className="muted small">
          Deterministic score ({latestScore?.algorithmVersion ?? 'not scored'}) — measured from
          metrics and sightings, not from AI analysis.
          {latestScore?.nextRescoreAt
            ? ` Next time-based rescore: ${fmt(latestScore.nextRescoreAt)}.`
            : ''}
        </p>
        <ScoreBreakdown components={componentViews(latestScore?.components ?? null)} />
        {latestScore?.reasonCodes.length ? (
          <p className="small muted">Reasons: {latestScore.reasonCodes.join(', ')}</p>
        ) : null}
        <SourcesBlock
          platform={card.platform}
          publicPropagation={sightingSources.publicPropagation}
          provenance={sightingSources.provenance}
          versions={card.versions}
        />
      </section>

      <section>
        <h2>Metrics over time</h2>
        {series ? (
          <>
            <Sparkline points={series.points} />
            <p className="small muted">{series.metric} over time</p>
          </>
        ) : null}
        {detail.snapshots.length === 0 ? (
          <p className="muted">
            No canonical metrics — this platform/source provides none, or none were collected yet.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Captured</th>
                <th>Views</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Shares</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {detail.snapshots.map((s) => (
                <tr key={new Date(s.capturedAt).toISOString()}>
                  <td>{fmt(s.capturedAt)}</td>
                  {(['views', 'likes', 'comments', 'shares'] as const).map((m) => (
                    <td
                      key={m}
                      title={s[m] === null ? (s.unavailable[m] ?? 'unavailable') : undefined}
                    >
                      {s[m] === null ? <span className="muted">n/a</span> : formatCount(s[m])}
                    </td>
                  ))}
                  <td>{s.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Score history</h2>
        {detail.scores.length === 0 ? (
          <p className="muted">Not scored yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Computed</th>
                <th>Score</th>
                <th>State</th>
                <th>Confidence</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {detail.scores.map((s) => (
                <tr key={`${s.algorithmVersion}-${new Date(s.computedAt).toISOString()}`}>
                  <td>{fmt(s.computedAt)}</td>
                  <td>{s.value === null ? '—' : s.value.toFixed(1)}</td>
                  <td>{s.state.replaceAll('_', ' ')}</td>
                  <td>{s.confidence.toFixed(2)}</td>
                  <td>{s.algorithmVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          AI content analysis <span className="ai-tag">model-generated hypotheses, not facts</span>
        </h2>
        <ClassifyButton
          clusterId={clusterId}
          classified={classification !== null}
          enabled={ctx.classifier.configured}
          reason={ctx.classifier.configured ? null : ctx.classifier.reason}
        />
        {classification ? (
          <>
            <p>{classification.summary}</p>
            <div className="labels">
              {classification.labels.map((l) => (
                <span key={l.label} className="label">
                  {l.label} <small>{l.confidence.toFixed(2)}</small>
                </span>
              ))}
            </div>
            {classification.safetyFlags.length ? (
              <ul className="flags">
                {classification.safetyFlags.map((f) => (
                  <li
                    key={f.flag}
                    className={card.flags.find((x) => x.flag === f.flag)?.significant ? 'flag' : ''}
                  >
                    ⚠ <strong>{f.flag.replaceAll('_', ' ')}</strong> ({f.confidence.toFixed(2)}) —{' '}
                    {f.note}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No review flags.</p>
            )}
            <dl className="analysis">
              {ANALYSIS_FIELDS.map((field) => (
                <div key={field}>
                  <dt>{ANALYSIS_LABELS[field]}</dt>
                  <dd>
                    {classification.analysis[field] ?? (
                      <span className="muted">not inferable from available inputs</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="small muted">
              {classification.provider}/{classification.model} · {classification.taxonomyVersion} ·{' '}
              {classification.promptVersion} · classified {fmt(classification.classifiedAt)} ·
              thumbnail{' '}
              {typeof classification.inputsUsed['thumbnail'] === 'string'
                ? classification.inputsUsed['thumbnail']
                : '—'}
            </p>
          </>
        ) : (
          <p className="muted">
            Unclassified
            {detail.failures[0]
              ? ` — last attempt failed (${detail.failures[0].errorKind}, ${fmt(detail.failures[0].attemptedAt)})`
              : ''}
            .
          </p>
        )}
      </section>

      <section>
        <h2>Rights</h2>
        <p>
          Current: <strong>{card.rights.label}</strong> · Review:{' '}
          <strong>{card.review.label}</strong>{' '}
          <span className="muted small">(approval does not imply rights clearance)</span>
        </p>
        <RightsForm clusterId={clusterId} current={card.rights.status} />
        {detail.rights.length ? (
          <ul className="history">
            {detail.rights.map((r) => (
              <li key={new Date(r.createdAt).toISOString() + r.status}>
                {fmt(r.createdAt)} — {r.status}
                {r.rightsHolder ? ` · holder: ${r.rightsHolder}` : ''}
                {r.evidenceUrl ? (
                  <>
                    {' '}
                    ·{' '}
                    <a href={r.evidenceUrl} target="_blank" rel="noopener noreferrer">
                      evidence
                    </a>
                  </>
                ) : null}
                {r.notes ? ` · ${r.notes}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h2>Review history</h2>
        {detail.reviews.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="history">
            {detail.reviews.map((r) => (
              <li key={new Date(r.createdAt).toISOString() + r.status}>
                {fmt(r.createdAt)} — <strong>{REVIEW_LABELS[r.status] ?? r.status}</strong> by{' '}
                {r.reviewer}
                {r.note ? ` · “${r.note}”` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Sightings</h2>
        <p className="small muted">
          Clustering is exact-identity only for now: {detail.versions.length} version(s) in this
          cluster.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Seen</th>
              <th>Source</th>
              <th>Role</th>
              <th>Observation</th>
            </tr>
          </thead>
          <tbody>
            {detail.sightings.map((s) => {
              const post = (s.context['postUrl'] as string | undefined) ?? null;
              const role =
                ctx.roles[s.adapterId] === 'propagation' ? 'public propagation' : 'provenance';
              return (
                <tr key={`${s.source}-${s.observationKey}-${new Date(s.seenAt).toISOString()}`}>
                  <td>{fmt(s.seenAt)}</td>
                  <td>{s.source}</td>
                  <td>{role}</td>
                  <td>
                    {post && /^https:\/\//.test(post) ? (
                      <a href={post} target="_blank" rel="noopener noreferrer">
                        {s.observationKey}
                      </a>
                    ) : (
                      s.observationKey
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </article>
  );
}
