import Link from 'next/link';
import { CONTENT_LABELS } from '@vd/classification';
import { RIGHTS_STATUSES } from '@vd/core';
import {
  BREAKING_OUT_SCORE,
  REVIEW_LABELS,
  RIGHTS_LABELS,
  STATE_LABELS,
  getFeed,
  getFilterOptions,
  getSummary,
  toCardView,
  type FeedFilters,
} from '@vd/review';
import { CandidateCard } from '../components/CandidateCard.tsx';
import { feedHref, hasFilters, parseFilters, type SearchParams } from '../lib/filters.ts';
import { getContext } from '../lib/server.ts';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function FeedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : null;
  const ctx = getContext();
  const now = new Date();
  const [summary, page, options] = await Promise.all([
    getSummary(ctx.db),
    getFeed(ctx.db, { filters, cursor, pageSize: PAGE_SIZE, now }),
    getFilterOptions(ctx.db),
  ]);
  const cards = page.items.map((row) => toCardView(row, ctx.roles, now));

  const bucket = (label: string, count: number, f: FeedFilters, emoji: string) => (
    <Link href={feedHref(f)} className="bucket">
      <span className="bucket-emoji">{emoji}</span>
      <span className="bucket-count">{count}</span>
      <span className="bucket-label">{label}</span>
    </Link>
  );

  return (
    <>
      <nav className="summary" aria-label="Review summary">
        {bucket(
          'Breaking out',
          summary.breakingOut,
          { state: 'scored', minScore: BREAKING_OUT_SCORE },
          '🔥',
        )}
        {bucket('Unreviewed', summary.unreviewed, { review: 'unreviewed' }, '👀')}
        {bucket('Saved', summary.saved, { review: 'saved' }, '⭐')}
        {bucket('Approved', summary.approved, { review: 'approved' }, '✅')}
        {bucket('Rejected', summary.rejected, { review: 'rejected' }, '⛔')}
        {bucket(
          'Insufficient evidence',
          summary.insufficientEvidence,
          { state: 'insufficient_evidence' },
          '❔',
        )}
        {bucket('Flagged', summary.flagged, { flagged: true }, '⚠')}
        {bucket(
          'Possible duplicates',
          summary.possibleDuplicates,
          { possibleDuplicates: true },
          '⧉',
        )}
        {summary.conflicts
          ? bucket('Merge conflicts', summary.conflicts, { review: 'conflict' }, '⚖')
          : null}
      </nav>

      <form className="filters" method="get" action="/">
        <select name="review" defaultValue={filters.review ?? ''} aria-label="Review status">
          <option value="">Any review</option>
          <option value="unreviewed">Unreviewed only</option>
          <option value="conflict">Merge conflict</option>
          {Object.entries(REVIEW_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select name="label" defaultValue={filters.label ?? ''} aria-label="Category">
          <option value="">Any category</option>
          {CONTENT_LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select
          name="platform"
          defaultValue={filters.platform ?? ''}
          aria-label="Canonical platform"
        >
          <option value="">Any platform</option>
          {options.platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select name="source" defaultValue={filters.source ?? ''} aria-label="Discovery source">
          <option value="">Any source</option>
          {options.sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="state" defaultValue={filters.state ?? ''} aria-label="Score state">
          <option value="">Any score state</option>
          {Object.entries(STATE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l.toLowerCase()}
            </option>
          ))}
        </select>
        <select name="rights" defaultValue={filters.rights ?? ''} aria-label="Rights status">
          <option value="">Any rights</option>
          {[...RIGHTS_STATUSES, 'conflict' as const].map((r) => (
            <option key={r} value={r}>
              {RIGHTS_LABELS[r]}
            </option>
          ))}
        </select>
        <input
          name="minScore"
          type="number"
          min={1}
          max={100}
          placeholder="Min score"
          defaultValue={filters.minScore ?? ''}
          aria-label="Minimum score"
        />
        <select
          name="within"
          defaultValue={filters.discoveredWithinHours ? String(filters.discoveredWithinHours) : ''}
          aria-label="Discovered within"
        >
          <option value="">Any time</option>
          <option value="6">Last 6h</option>
          <option value="24">Last 24h</option>
          <option value="72">Last 3 days</option>
          <option value="168">Last 7 days</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            name="flagged"
            value="1"
            defaultChecked={filters.flagged ?? false}
          />{' '}
          flagged
        </label>
        <label className="check">
          <input
            type="checkbox"
            name="dups"
            value="1"
            defaultChecked={filters.possibleDuplicates ?? false}
          />{' '}
          possible duplicates
        </label>
        <button className="btn" type="submit">
          Apply
        </button>
        {hasFilters(filters) ? (
          <Link href="/" className="small">
            Clear
          </Link>
        ) : null}
      </form>

      {!ctx.classifier.configured ? (
        <p className="notice">
          Content classification is off ({ctx.classifier.reason}). Candidates show as Unclassified.
        </p>
      ) : null}

      {cards.length === 0 ? (
        <div className="empty">
          {summary.total === 0 ? (
            <>
              <h2>No candidates yet</h2>
              <p>
                Run discovery (e.g. <code>pnpm cli discover bluesky --param q=funny</code>) or
                submit a URL.
              </p>
            </>
          ) : (
            <>
              <h2>No candidates match these filters</h2>
              <Link href="/">Clear filters</Link>
            </>
          )}
        </div>
      ) : (
        <section className="feed" aria-label="Candidates">
          {cards.map((card) => (
            <CandidateCard key={card.clusterId} card={card} />
          ))}
        </section>
      )}

      <div className="pager">
        {cursor ? <Link href={feedHref(filters)}>↑ First page</Link> : null}
        {page.nextCursor ? (
          <Link className="btn" href={feedHref(filters, page.nextCursor)}>
            Next {PAGE_SIZE} →
          </Link>
        ) : null}
      </div>
    </>
  );
}
