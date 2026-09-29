import type { ComponentView, SourceCount } from '@vd/review';

/** CANONICAL vs DISCOVERED VIA (public propagation) vs MANUAL / PROVENANCE. */
export function SourcesBlock({
  platform,
  publicPropagation,
  provenance,
  versions,
}: {
  platform: string;
  publicPropagation: SourceCount[];
  provenance: SourceCount[];
  versions: number;
}) {
  return (
    <div className="sources">
      <div>
        <span className="k">Canonical</span> <strong>{platform}</strong>
        {versions > 1 ? <span className="pill">{versions} versions</span> : null}
      </div>
      <div>
        <span className="k">Discovered via</span>{' '}
        {publicPropagation.length ? (
          publicPropagation.map((s) => (
            <span key={s.source} className="pill pill-public">
              {s.source}
              {s.observations > 1 ? ` × ${s.observations}` : ''}
            </span>
          ))
        ) : (
          <span className="muted">no public source</span>
        )}
      </div>
      {provenance.length ? (
        <div>
          <span className="k">Manual / provenance</span>{' '}
          {provenance.map((s) => (
            <span
              key={s.source}
              className="pill pill-provenance"
              title="Not counted as public propagation"
            >
              {s.source}
              {s.observations > 1 ? ` × ${s.observations}` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STRENGTH_CLASS: Record<string, string> = {
  'very strong': 's5',
  strong: 's4',
  moderate: 's3',
  weak: 's2',
  'very weak': 's1',
  unavailable: 's0',
};

/** Component breakdown: unavailable components say so (with the reason), never zero. */
export function ScoreBreakdown({ components }: { components: ComponentView[] }) {
  if (components.length === 0) return <p className="muted small">No score breakdown yet.</p>;
  return (
    <table className="breakdown">
      <tbody>
        {components.map((c) => (
          <tr key={c.key}>
            <th scope="row">
              {c.label}
              {c.basis === 'source_propagation' ? (
                <span className="basis"> (discovery-source)</span>
              ) : null}
            </th>
            <td>
              <span className={`strength ${STRENGTH_CLASS[c.strength] ?? ''}`}>{c.strength}</span>
              {c.reason ? <span className="reason"> — {c.reason}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ScoreBadge({
  text,
  stateLabel,
  state,
  confidence,
}: {
  text: string;
  stateLabel: string;
  state: string;
  confidence: string;
}) {
  return (
    <div className={`score score-${state}`}>
      <div className="score-value" aria-label={`Virality score ${text}`}>
        {text}
      </div>
      <div className="score-state">{stateLabel}</div>
      <div className="score-conf">confidence {confidence}</div>
    </div>
  );
}

/** Tiny inline SVG growth chart (no charting dependency). */
export function Sparkline({
  points,
  width = 320,
  height = 80,
}: {
  points: { at: Date; value: number }[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.at.getTime());
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (width - 8) + 4);
  const sy = (y: number) =>
    y1 === y0 ? height / 2 : height - 4 - ((y - y0) / (y1 - y0)) * (height - 8);
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${sx(p.at.getTime()).toFixed(1)},${sy(p.value).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="growth over time"
    >
      <path d={d} fill="none" strokeWidth="2" />
      {points.map((p) => (
        <circle key={p.at.getTime()} cx={sx(p.at.getTime())} cy={sy(p.value)} r="3" />
      ))}
    </svg>
  );
}
