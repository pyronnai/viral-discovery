import type { ConflictView, DuplicateView, VersionView } from '@vd/review';
import { DuplicateDecision } from './DuplicateDecision.tsx';
import { Thumbnail } from './Thumbnail.tsx';

/** Small feed-card indicator; the full duplicate review lives on the detail page. */
export function DuplicateIndicator({
  href,
  label,
  versionPlatforms,
}: {
  href: string;
  label: string | null;
  versionPlatforms: string[];
}) {
  if (!label && versionPlatforms.length < 2) return null;
  return (
    <span className="dup-indicator">
      {versionPlatforms.length > 1 ? (
        <span className="pill pill-versions" title="Confirmed representations of the same clip">
          {versionPlatforms.join(' + ')}
        </span>
      ) : null}
      {label ? (
        <a className="dup-link" href={`${href}#duplicates`}>
          ⧉ {label}
        </a>
      ) : null}
    </span>
  );
}

/** Open merge conflicts: what each merged side had, and what the human must do. */
export function ConflictBanner({ conflicts }: { conflicts: ConflictView[] }) {
  if (!conflicts.length) return null;
  return (
    <div className="conflicts" role="alert">
      {conflicts.map((c) => (
        <div key={c.kind} className={`conflict conflict-${c.kind}`}>
          <strong>⚖ {c.title}</strong>
          {c.reason ? <div className="small">Why: {c.reason}</div> : null}
          <ul>
            {c.sides.map((s, i) => (
              <li key={`${c.kind}-${i}`}>
                {s.versions} version: <strong>{s.value}</strong>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** VERSIONS / REPRESENTATIONS of one underlying clip (confirmed only). */
export function VersionsTable({ versions }: { versions: VersionView[] }) {
  return (
    <>
      <p className="small muted">
        {versions.length === 1
          ? 'One platform representation. Near-duplicates on other platforms appear below once detected.'
          : `${versions.length} confirmed representations of the same underlying clip — one candidate, not separate discoveries.`}
      </p>
      <table className="table versions">
        <thead>
          <tr>
            <th>Platform</th>
            <th>Title</th>
            <th>Duration</th>
            <th>Linked as</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.videoId}>
              <td>
                <strong>{v.platform}</strong>
                {v.isRepresentative ? <span className="pill">representative</span> : null}
              </td>
              <td>
                {v.title}
                {v.creator ? <span className="muted small"> · {v.creator}</span> : null}
              </td>
              <td>{v.duration}</td>
              <td className="small">{v.joined}</td>
              <td>
                <a href={v.canonicalUrl} target="_blank" rel="noopener noreferrer">
                  Open original ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** POSSIBLE DUPLICATES: evidence-first, with CONFIRM SAME VIDEO / NOT THE SAME. */
export function PossibleDuplicates({
  clusterId,
  duplicates,
}: {
  clusterId: string;
  duplicates: DuplicateView[];
}) {
  if (!duplicates.length) return <p className="muted">No possible duplicates.</p>;
  return (
    <ul className="dups">
      {duplicates.map((d) => (
        <li key={d.candidateId} className="dup">
          <Thumbnail src={d.thumbnailUrl} alt={d.title} platform={d.platform} />
          <div className="dup-main">
            <div className="card-meta">
              <span className="platform">{d.platform}</span>
              {d.creator ? <span>{d.creator}</span> : null}
              <span className="muted">{d.duration}</span>
            </div>
            <a href={d.href} className="card-title">
              {d.title}
            </a>
            <div className="dup-confidence">
              Similarity confidence <strong>{d.confidenceText}</strong> ({d.strength}) — detector
              evidence, not a decision
            </div>
            <ul className="evidence">
              {d.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {d.needsHumanBecause.length ? (
              <div className="small muted">
                Not merged automatically: {d.needsHumanBecause.join('; ')}.
              </div>
            ) : null}
            <div className="links">
              <a href={d.canonicalUrl} target="_blank" rel="noopener noreferrer">
                Open original ↗
              </a>
            </div>
          </div>
          <DuplicateDecision candidateId={d.candidateId} clusterId={clusterId} />
        </li>
      ))}
    </ul>
  );
}
