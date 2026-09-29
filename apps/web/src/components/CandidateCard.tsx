import Link from 'next/link';
import type { CardView } from '@vd/review';
import { ReviewControls } from './ReviewControls.tsx';
import { ScoreBadge, ScoreBreakdown, SourcesBlock } from './Evidence.tsx';
import { Thumbnail } from './Thumbnail.tsx';

/** Compact, scannable card: thumbnail | metadata | virality | labels | actions. */
export function CandidateCard({ card }: { card: CardView }) {
  const significant = card.flags.filter((f) => f.significant);
  return (
    <article className={`card${significant.length ? ' card-flagged' : ''}`}>
      <Link href={card.href} className="card-thumb" aria-label={`Open details: ${card.title}`}>
        <Thumbnail src={card.thumbnailUrl} alt={card.title} platform={card.platform} />
        <span className="duration">{card.duration}</span>
      </Link>

      <div className="card-main">
        <div className="card-meta">
          <span className="platform">{card.platform}</span>
          <span>{card.creator ?? 'unknown creator'}</span>
          {card.creatorHandle ? <span className="muted">@{card.creatorHandle}</span> : null}
          <span
            className="muted"
            title={
              card.ageBasis === 'published'
                ? 'since published'
                : 'since first discovered (publish time unknown)'
            }
          >
            {card.age}
            {card.ageBasis === 'discovered' ? '*' : ''} old
          </span>
        </div>
        <Link href={card.href} className="card-title">
          {card.title}
        </Link>
        <div className="labels">
          {card.classification.kind === 'classified' ? (
            card.classification.labels.map((l) => (
              <span key={l.label} className="label" title={`confidence ${l.confidence.toFixed(2)}`}>
                {l.label}
              </span>
            ))
          ) : card.classification.kind === 'failed' ? (
            <span className="label label-warn">
              Classification failed ({card.classification.error})
            </span>
          ) : (
            <span className="label label-muted">Unclassified</span>
          )}
          {significant.map((f) => (
            <span key={f.flag} className="flag" title={f.note}>
              ⚠ {f.flag.replaceAll('_', ' ')}
            </span>
          ))}
        </div>
        <div className="card-facts">
          {card.metrics ? (
            <span>
              {/* Only metrics the platform actually provided; unavailable ones are omitted. */}
              {(
                [
                  ['views', card.metrics.views],
                  ['likes', card.metrics.likes],
                  ['comments', card.metrics.comments],
                  ['shares', card.metrics.shares],
                ] as const
              )
                .filter(([, value]) => value !== '—')
                .map(([name, value]) => `${value} ${name}`)
                .join(' · ')}
            </span>
          ) : (
            <span className="muted">no canonical metrics</span>
          )}
          <span className={`rights rights-${card.rights.status}`}>Rights: {card.rights.label}</span>
          {card.availabilityNote ? <span className="warn">{card.availabilityNote}</span> : null}
        </div>
        <details className="why">
          <summary>Details / Why?</summary>
          <div className="why-body">
            <SourcesBlock
              platform={card.platform}
              publicPropagation={card.publicPropagation}
              provenance={card.provenance}
              versions={card.versions}
            />
            <ScoreBreakdown components={card.components} />
            {card.aiSummary ? (
              <p className="ai">
                <span className="ai-tag">AI content analysis</span> {card.aiSummary}
              </p>
            ) : null}
            <div className="links">
              <Link href={card.href}>Full details →</Link>
              <a href={card.canonicalUrl} target="_blank" rel="noopener noreferrer">
                Open original ↗
              </a>
            </div>
          </div>
        </details>
      </div>

      <ScoreBadge
        text={card.score.text}
        stateLabel={card.score.stateLabel}
        state={card.score.state}
        confidence={card.score.confidence}
      />

      <div className="card-actions">
        <ReviewControls clusterId={card.clusterId} status={card.review.status} />
        <a
          className="open-original"
          href={card.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open original ↗
        </a>
      </div>
    </article>
  );
}
