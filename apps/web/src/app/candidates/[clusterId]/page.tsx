import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ANALYSIS_FIELDS, type AnalysisField } from '@vd/classification';
import {
  REVIEW_LABELS,
  componentViews,
  conflictViews,
  formatCount,
  getCandidate,
  getCreatorHistory,
  growthSeries,
  mergedInto,
  platformName,
  splitSources,
  toCardView,
  toDuplicateView,
  versionViews,
} from '@vd/review';
import { ClassifyButton } from '../../../components/ClassifyButton.tsx';
import { SourceModerationWarning } from '../../../components/SourceModeration.tsx';
import {
  ConflictBanner,
  PossibleDuplicates,
  VersionsTable,
} from '../../../components/Duplicates.tsx';
import {
  ScoreBadge,
  ScoreBreakdown,
  SourcesBlock,
  Sparkline,
} from '../../../components/Evidence.tsx';
import { InboxActions } from '../../../components/InboxActions.tsx';
import { MediaPreview } from '../../../components/MediaPreview.tsx';
import {
  RepresentationList,
  Representations,
  StateBadges,
} from '../../../components/Representations.tsx';
import { ReviewControls } from '../../../components/ReviewControls.tsx';
import { RightsForm } from '../../../components/RightsForm.tsx';
import { Thumbnail } from '../../../components/Thumbnail.tsx';
import { describeDownload } from '../../../lib/download.ts';
import { mediaDeps } from '../../../lib/media-server.ts';
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
  if (!detail) {
    // A merged-away candidate redirects to the cluster that now holds its versions.
    const into = await mergedInto(ctx.db, clusterId);
    if (into) redirect(`/candidates/${into}`);
    notFound();
  }
  const now = new Date();
  const card = toCardView(detail.summary, ctx.roles, now);
  const creatorHistory = (await getCreatorHistory(ctx.db, clusterId)).map((r) =>
    toCardView(r, ctx.roles, now),
  );
  const latestSnapshot = detail.snapshots[detail.snapshots.length - 1] ?? null;
  const latestScore = detail.scores[0] ?? null;
  const classification = detail.classifications.find((c) => c.current) ?? null;
  const series = growthSeries(detail.snapshots);
  const sightingSources = splitSources(detail.summary.sources, ctx.roles);
  const versions = versionViews(detail);
  const duplicates = detail.possibleDuplicates.map(toDuplicateView);
  const rejected = detail.rejectedDuplicates.map(toDuplicateView);
  const conflicts = conflictViews(detail.summary, detail.merges);
  const versionPlatform = new Map(
    detail.versions.map((v) => [v.videoId, platformName(v.platform)]),
  );
  // Validated (scheme, path, host, type, size) — not just "a media_assets row exists".
  const download = await describeDownload(mediaDeps(), clusterId);

  return (
    <article className="detail">
      <p>
        <Link href="/">← Back to inbox</Link>
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
          <StateBadges inbox={card.inbox} conflict={card.conflicts.review} />
          <Representations
            clusterId={clusterId}
            representations={card.representations}
            canonicalUrl={card.canonicalUrl}
            platform={card.platform}
            platformKey={card.platformKey}
            access={card.access}
            download={
              download.available
                ? { available: true, videoId: download.videoId, filename: download.filename }
                : { available: false }
            }
          />
          <MediaPreview clusterId={clusterId} info={download} />
          <InboxActions clusterId={clusterId} state={card.inbox} withNote />
          {card.inbox.obtained ? (
            <p className="small">
              ⬇ Obtained {fmt(card.inbox.obtainedAt)}
              {card.inbox.obtainedNote ? ` — “${card.inbox.obtainedNote}”` : ''}
            </p>
          ) : null}
        </div>
        <ScoreBadge
          text={card.score.text}
          stateLabel={card.score.stateLabel}
          state={card.score.state}
          confidence={card.score.confidence}
        />
      </div>

      <ConflictBanner conflicts={conflicts} />

      <section>
        <h2>Source &amp; access</h2>
        <dl className="facts">
          <div>
            <dt>Creator</dt>
            <dd>
              {card.creator ?? 'unknown'}
              {card.creatorHandle ? ` (@${card.creatorHandle})` : ''}
            </dd>
          </div>
          <div>
            <dt>Canonical platform</dt>
            <dd>{card.platform}</dd>
          </div>
          <div>
            <dt>Original URL</dt>
            <dd>
              <a href={card.canonicalUrl} target="_blank" rel="noopener noreferrer">
                {card.canonicalUrl}
              </a>
            </dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{fmt(detail.summary.publishedAt)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{card.duration}</dd>
          </div>
          <div>
            <dt>Latest metrics</dt>
            <dd>
              {latestSnapshot
                ? `${formatCount(latestSnapshot.views)} views · ${formatCount(latestSnapshot.likes)} likes · ${formatCount(latestSnapshot.comments)} comments (${fmt(latestSnapshot.capturedAt)})`
                : 'none from this platform'}
            </dd>
          </div>
          <div>
            <dt>Labels</dt>
            <dd>
              {card.classification.kind === 'classified'
                ? card.classification.labels.map((l) => l.label).join(', ')
                : 'unclassified'}
            </dd>
          </div>
          <div>
            <dt>Virality</dt>
            <dd>
              {card.score.text} · {card.score.stateLabel.toLowerCase()} · confidence{' '}
              {card.score.confidence}
            </dd>
          </div>
          <div>
            <dt>Duplicates</dt>
            <dd>{card.duplicateStatus}</dd>
          </div>
          <div>
            <dt>Rights</dt>
            <dd>
              {card.rights.label}
              {card.rights.status === 'unknown' ? ' — not permission' : ''}
            </dd>
          </div>
          <div>
            <dt>Media</dt>
            <dd>
              {download.available
                ? `${card.access.label} · ${download.contentType} · ${download.filename}`
                : card.access.mediaDownload
                  ? `${card.access.label} · not servable: ${download.reason}`
                  : card.access.label}
            </dd>
          </div>
        </dl>
        <h3>Available representations</h3>
        <RepresentationList clusterId={clusterId} representations={card.representations} />
      </section>

      <section>
        <h2>Virality evidence</h2>
        <p className="muted small">
          Deterministic score ({latestScore?.algorithmVersion ?? 'not scored'}) — measured from
          metrics and sightings, not from AI analysis.
          {latestScore?.nextRescoreAt
            ? ` Next time-based rescore: ${fmt(latestScore.nextRescoreAt)}.`
            : ''}
          {versions.length > 1
            ? ` Metrics and score are the representative version's (${card.platform}).`
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
        <h2>Versions / representations</h2>
        <VersionsTable versions={versions} />
      </section>

      <section id="duplicates">
        <h2>
          Possible duplicates{' '}
          <span className="ai-tag">detector suggestions — nothing is shared until confirmed</span>
        </h2>
        <PossibleDuplicates clusterId={clusterId} duplicates={duplicates} />
        {rejected.length ? (
          <details className="small">
            <summary>{rejected.length} marked not the same</summary>
            <ul className="history">
              {rejected.map((d) => (
                <li key={d.candidateId}>
                  {fmt(d.decidedAt)} — {d.platform} “{d.title}” ({d.confidenceText})
                  {d.note ? ` · ${d.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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
        <h2>Platform moderation labels</h2>
        <SourceModerationWarning moderation={card.sourceModeration} />
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
        <RightsForm
          clusterId={clusterId}
          current={card.conflicts.rights ? 'unknown' : card.rights.status}
        />
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
                {r.originClusterId ? (
                  <span className="muted"> · carried over from a merged version</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h2>More from this creator</h2>
        {creatorHistory.length === 0 ? (
          <p className="muted small">No other candidates from this creator yet.</p>
        ) : (
          <ul className="history">
            {creatorHistory.map((h) => (
              <li key={h.clusterId}>
                <Link href={h.href}>{h.title}</Link>{' '}
                <span className="muted small">
                  · {h.platform} · {h.age} old · score {h.score.text} (
                  {h.score.stateLabel.toLowerCase()}) · {h.review.label}
                </span>
              </li>
            ))}
          </ul>
        )}
        {card.creator || card.creatorHandle ? (
          <Link
            className="small"
            href={`/?view=all&creator=${encodeURIComponent(card.creatorHandle ?? card.creator ?? '')}`}
          >
            All candidates from this creator →
          </Link>
        ) : null}
      </section>

      <section>
        <h2>Review history</h2>
        <ReviewControls
          clusterId={clusterId}
          status={card.review.status}
          conflict={card.conflicts.review}
          withNote
        />
        {detail.reviews.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="history">
            {detail.reviews.map((r) => (
              <li key={new Date(r.createdAt).toISOString() + r.status}>
                {fmt(r.createdAt)} — <strong>{REVIEW_LABELS[r.status] ?? r.status}</strong> by{' '}
                {r.reviewer}
                {r.note ? ` · “${r.note}”` : ''}
                {r.originClusterId ? (
                  <span className="muted"> · carried over from a merged version</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {detail.merges.length ? (
          <ul className="history">
            {detail.merges.map((m) => (
              <li key={m.id}>
                {fmt(m.mergedAt)} — merged another version into this candidate (
                {m.trigger === 'auto' ? 'auto-confirmed by detector' : 'confirmed by owner'})
                {m.reviewConflict ? ' · review conflict' : ''}
                {m.rightsConflict ? ' · rights conflict' : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h2>Sightings</h2>
        <p className="small muted">
          Where each version was observed. Sightings of confirmed versions stay sightings; they are
          not separate viral discoveries.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Seen</th>
              <th>Version</th>
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
                  <td>{versionPlatform.get(s.videoId) ?? '—'}</td>
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
