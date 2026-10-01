import Link from 'next/link';
import type { CardView } from '@vd/review';
import { DuplicateIndicator } from './Duplicates.tsx';
import { ScoreBadge, ScoreBreakdown, SourcesBlock } from './Evidence.tsx';
import { InboxActions } from './InboxActions.tsx';
import { Representations, StateBadges } from './Representations.tsx';
import { Thumbnail } from './Thumbnail.tsx';

/**
 * Compact inbox card, optimized for scanning many videos:
 * select | thumbnail | who/what/when + labels + metrics + state + sources | score | actions.
 */
export function CandidateCard({ card }: { card: CardView }) {
  const significant = card.flags.filter((f) => f.significant);
  const metrics = card.metrics
    ? (
        [
          ['views', card.metrics.views],
          ['likes', card.metrics.likes],
          ['comments', card.metrics.comments],
          ['shares', card.metrics.shares],
        ] as const
      )
        // Only metrics the platform actually provided; unavailable ones are omitted.
        .filter(([, value]) => value !== '—')
        .map(([name, value]) => `${value} ${name}`)
        .join(' · ')
    : null;
  return (
    <article
      className={`card${significant.length ? ' card-flagged' : ''}${card.inbox.used ? ' card-used' : ''}`}
    >
      <input
        type="checkbox"
        className="card-select"
        data-select-cluster
        value={card.clusterId}
        aria-label={`Select ${card.title}`}
      />
      <Link href={card.href} className="card-thumb" aria-label={`Open details: ${card.title}`}>
        <Thumbnail src={card.thumbnailUrl} alt={card.title} platform={card.platform} />
        <span className="duration">{card.duration}</span>
      </Link>

      <div className="card-main">
        <div className="card-meta">
          <span className="platform">{card.platform}</span>
          <Link
            href={`/?view=all&creator=${encodeURIComponent(card.creatorHandle ?? card.creator ?? '')}`}
            className="creator"
            title="All candidates from this creator"
          >
            {card.creator ?? 'unknown creator'}
          </Link>
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
          <StateBadges inbox={card.inbox} conflict={card.conflicts.review} />
        </div>
        <Link href={card.href} className="card-title">
          {card.title}
        </Link>
        <div className="labels">
          {card.classification.kind === 'classified' ? (
            card.classification.labels.map((l) => (
              <Link
                key={l.label}
                href={`/?label=${l.label}`}
                className="label"
                title={`confidence ${l.confidence.toFixed(2)}`}
              >
                {l.label}
              </Link>
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
          {metrics ? <span>{metrics}</span> : <span className="muted">no canonical metrics</span>}
          <span
            className={`rights rights-${card.rights.status}`}
            title="Unknown rights are not permission"
          >
            Rights: {card.rights.label}
          </span>
          <DuplicateIndicator
            href={card.href}
            label={card.duplicatesLabel}
            versionPlatforms={card.versionPlatforms}
          />
          {card.possibleDuplicateOfUsed ? (
            <span className="warn">⚠ possibly the same clip as something already used</span>
          ) : null}
          {card.availabilityNote ? <span className="warn">{card.availabilityNote}</span> : null}
        </div>
        <Representations
          representations={card.representations}
          canonicalUrl={card.canonicalUrl}
          platform={card.platform}
          access={card.access}
          compact
        />
        <details className="why">
          <summary>Why is this here?</summary>
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
        <InboxActions clusterId={card.clusterId} state={card.inbox} />
        <Link href={card.href} className="small">
          Details →
        </Link>
      </div>
    </article>
  );
}
