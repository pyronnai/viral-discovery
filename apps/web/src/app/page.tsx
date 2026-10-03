import Link from 'next/link';
import { RIGHTS_STATUSES } from '@vd/core';
import {
  RIGHTS_LABELS,
  STATE_LABELS,
  VIRAL_NOW_HOURS,
  getFeed,
  getFilterOptions,
  getSummary,
  toCardView,
  type FeedFilters,
  type FeedSort,
  type InboxView,
} from '@vd/review';
import { BulkBar } from '../components/BulkBar.tsx';
import { CandidateCard } from '../components/CandidateCard.tsx';
import {
  effectiveView,
  feedHref,
  hasFilters,
  parseFilters,
  parseSort,
  type SearchParams,
} from '../lib/filters.ts';
import { getContext } from '../lib/server.ts';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const QUICK_LABELS = ['funny', 'animals', 'fails', 'reactions', 'memes', 'unexpected'] as const;

const SORT_LABELS: Record<FeedSort, string> = {
  virality: 'Virality',
  newest: 'Newest',
  growth: 'Fastest growing',
  views: 'Most viewed',
  discovered: 'Recently discovered',
};

const EMPTY: Record<InboxView, string> = {
  viral: `Nothing is breaking out right now (no candidate with real viral evidence in the window, untriaged). Check Unreviewed, or Discovery health.`,
  unreviewed: 'Inbox zero — every candidate has a decision.',
  saved: 'Nothing saved yet. Use ☆ Save on a card to build your shortlist.',
  obtained: 'Nothing marked obtained (and not yet used).',
  used: 'Nothing marked as already used yet.',
  rejected: 'Nothing rejected.',
  all: 'No candidates match these filters.',
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const parsed = parseFilters(params);
  const view = effectiveView(parsed);
  const ctx = getContext();
  const viralNowHours = ctx.config.VIRAL_NOW_HOURS ?? VIRAL_NOW_HOURS;
  const filters: FeedFilters = { ...parsed, view, viralNowHours };
  const sort = parseSort(params);
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : null;
  const now = new Date();
  const [summary, page, options] = await Promise.all([
    getSummary(ctx.db, now, { viralNowHours }),
    getFeed(ctx.db, { filters, sort, cursor, pageSize: PAGE_SIZE, now }),
    getFilterOptions(ctx.db),
  ]);
  const cards = page.items.map((row) => toCardView(row, ctx.roles, now));
  const exportQuery = feedHref(filters, null, sort).replace(/^\/\??/, '');

  const tab = (v: InboxView, label: string, count: number | null) => (
    <Link
      href={feedHref({ view: v }, null, sort)}
      className={`tab${view === v ? ' tab-active' : ''}`}
      aria-current={view === v ? 'page' : undefined}
    >
      {label}
      {count !== null ? <span className="tab-count">{count}</span> : null}
    </Link>
  );

  return (
    <>
      <nav className="tabs" aria-label="Inbox views">
        {tab('viral', '🔥 Viral Now', summary.viralNow)}
        {tab('unreviewed', '👀 Unreviewed', summary.unreviewed)}
        {tab('saved', '★ Saved', summary.saved)}
        {tab('obtained', '⬇ Obtained', summary.obtained)}
        {tab('used', '✓ Already used', summary.alreadyUsed)}
        {tab('rejected', 'Rejected', summary.rejected)}
        {tab('all', 'All', summary.total)}
        {summary.possibleDuplicates ? (
          <Link href={feedHref({ view: 'all', possibleDuplicates: true })} className="tab tab-warn">
            ⧉ {summary.possibleDuplicates} possible duplicates
          </Link>
        ) : null}
        {summary.conflicts ? (
          <Link href={feedHref({ view: 'all', review: 'conflict' })} className="tab tab-warn">
            ⚖ {summary.conflicts} merge conflicts
          </Link>
        ) : null}
      </nav>

      <nav className="chips" aria-label="Quick category filters">
        {QUICK_LABELS.map((l) => (
          <Link
            key={l}
            href={feedHref({ ...filters, label: filters.label === l ? undefined : l }, null, sort)}
            className={`chip${filters.label === l ? ' chip-active' : ''}`}
          >
            {l}
          </Link>
        ))}
      </nav>

      <form className="filters" method="get" action="/">
        <input type="hidden" name="view" value={view} />
        {filters.label ? <input type="hidden" name="label" value={filters.label} /> : null}
        <select name="sort" defaultValue={sort} aria-label="Sort">
          {Object.entries(SORT_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              Sort: {l}
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
        <input
          name="minScore"
          type="number"
          min={1}
          max={100}
          placeholder="Min score"
          defaultValue={filters.minScore ?? ''}
          aria-label="Minimum virality score"
        />
        <select
          name="within"
          defaultValue={filters.discoveredWithinHours ? String(filters.discoveredWithinHours) : ''}
          aria-label="Discovered within"
        >
          <option value="">Any freshness</option>
          <option value="6">Last 6h</option>
          <option value="24">Last 24h</option>
          <option value="72">Last 3 days</option>
          <option value="168">Last 7 days</option>
        </select>
        <input
          name="creator"
          placeholder="Creator or @handle"
          defaultValue={filters.creator ?? ''}
          aria-label="Creator"
          maxLength={80}
        />
        <select name="rights" defaultValue={filters.rights ?? ''} aria-label="Rights status">
          <option value="">Any rights</option>
          {[...RIGHTS_STATUSES, 'conflict' as const].map((r) => (
            <option key={r} value={r}>
              Rights: {RIGHTS_LABELS[r]}
            </option>
          ))}
        </select>
        <details className="more-filters">
          <summary>More</summary>
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
        </details>
        <button className="btn" type="submit">
          Apply
        </button>
        {hasFilters(filters) || sort !== 'virality' ? (
          <Link href={feedHref({ view })} className="small">
            Clear
          </Link>
        ) : null}
      </form>

      {!ctx.classifier.configured ? (
        <p className="notice">
          Content labels are off ({ctx.classifier.reason}). Candidates show as Unclassified; scores
          and the inbox still work.
        </p>
      ) : null}

      <BulkBar exportQuery={exportQuery} />

      {cards.length === 0 ? (
        <div className="empty">
          {summary.total === 0 ? (
            <>
              <h2>No candidates yet</h2>
              <p>
                Run discovery (e.g. <code>pnpm cli tick</code> or{' '}
                <code>pnpm cli discover bluesky --param q=funny</code>) or submit a URL. See{' '}
                <Link href="/health">Discovery health</Link>.
              </p>
            </>
          ) : (
            <>
              <h2>{EMPTY[view]}</h2>
              {hasFilters(filters) ? <Link href={feedHref({ view })}>Clear filters</Link> : null}
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
        {cursor ? <Link href={feedHref(filters, null, sort)}>↑ First page</Link> : null}
        {page.nextCursor ? (
          <Link className="btn" href={feedHref(filters, page.nextCursor, sort)}>
            Next {PAGE_SIZE} →
          </Link>
        ) : null}
      </div>
    </>
  );
}
