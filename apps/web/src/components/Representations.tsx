import type { CardView } from '@vd/review';
import { DownloadMenu, downloadHref, type OfficialAsset } from './DownloadMenu.tsx';

/**
 * [ Open original ] [ Download ▾ ] plus every confirmed representation as an
 * alternate source. A source link is never presented as a download: the menu's
 * "Download file" needs an official/authorized asset (media_assets); external
 * downloaders are a clipboard + new-tab handoff from the central provider config.
 */
export function Representations({
  clusterId,
  representations,
  canonicalUrl,
  platform,
  platformKey,
  access,
  compact,
  download,
}: {
  clusterId: string;
  representations: CardView['representations'];
  canonicalUrl: string;
  platform: string;
  platformKey: string;
  access: CardView['access'];
  compact?: boolean;
  /** Detail page: validated download (overrides the feed's cheaper availability flag). */
  download?: OfficialAsset;
}) {
  const alternates = representations.filter((r) => !r.isRepresentative);
  const asset: OfficialAsset = download ?? { available: access.mediaDownload };
  return (
    <div className={compact ? 'reps reps-compact' : 'reps'}>
      <a className="btn btn-open" href={canonicalUrl} target="_blank" rel="noopener noreferrer">
        ▶ Open original on {platform} ↗
      </a>
      <DownloadMenu
        clusterId={clusterId}
        platformKey={platformKey}
        platformName={platform}
        canonicalUrl={canonicalUrl}
        asset={asset}
      />
      {alternates.length ? (
        <span className="reps-alt">
          <span className="k">Also on</span>
          {alternates.map((r) => (
            <a
              key={r.videoId}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pill"
            >
              {r.platform} ↗
            </a>
          ))}
        </span>
      ) : null}
      {!compact ? <span className="small muted">{access.label}</span> : null}
    </div>
  );
}

/** Full list for the detail page: "Available representations". */
export function RepresentationList({
  clusterId,
  representations,
}: {
  clusterId: string;
  representations: CardView['representations'];
}) {
  return (
    <ul className="rep-list">
      {representations.map((r) => (
        <li key={r.videoId}>
          <strong>{r.platform}</strong>
          {r.isRepresentative ? <span className="pill">canonical</span> : null}
          {r.creator ? <span className="muted"> · {r.creator}</span> : null} —{' '}
          <a href={r.url} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>{' '}
          <span className="small muted">{r.url}</span>
          <span className="small muted">
            {' '}
            · {r.mediaDownload ? 'official download available' : 'source link only'}
          </span>
          {r.mediaDownload ? (
            <>
              {' '}
              <a href={downloadHref(clusterId, r.videoId)} download className="small">
                ⬇ Download
              </a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Saved / Obtained / Used / Rejected badges — visible at a glance. */
export function StateBadges({ inbox, conflict }: { inbox: CardView['inbox']; conflict: boolean }) {
  const badges: [string, string][] = [];
  if (conflict) badges.push(['conflict', '⚖ Review conflict']);
  if (inbox.saved) badges.push(['saved', '★ Saved']);
  if (inbox.approved) badges.push(['approved', 'Approved']);
  if (inbox.obtained) badges.push(['obtained', '⬇ Obtained']);
  if (inbox.used) badges.push(['used', '✓ Already used']);
  if (inbox.rejected) badges.push(['rejected', 'Rejected']);
  if (!badges.length) return null;
  return (
    <span className="badges">
      {badges.map(([k, label]) => (
        <span key={k} className={`badge badge-${k}`}>
          {label}
        </span>
      ))}
    </span>
  );
}
