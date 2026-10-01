import type { DiscoveryHealth, SourceHealth, SourceState } from '@vd/review';

const STATE_TEXT: Record<SourceState, string> = {
  healthy: '● healthy',
  stale: '◐ stale (no success in 24h)',
  failing: '✖ failing',
  never_run: '○ never run',
  disabled: '○ disabled',
  unconfigured: '○ adapter not configured',
};

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';

function quota(s: SourceHealth) {
  if (!s.quota.length) return <span className="muted">—</span>;
  return s.quota.map((q) => (
    <div key={q.bucket}>
      {q.bucket}: {q.used}
      {q.budget !== null ? ` / ${q.budget}` : ''}
    </div>
  ));
}

function Row({ s }: { s: SourceHealth }) {
  return (
    <tr>
      <td>{s.name}</td>
      <td className={`health-${s.state}`}>{STATE_TEXT[s.state]}</td>
      <td>{fmt(s.lastSuccessAt)}</td>
      <td>
        {s.runs24h} runs · {s.found24h} found · {s.new24h} new
      </td>
      <td>{s.quarantined24h}</td>
      <td>{quota(s)}</td>
      <td className="small">
        {s.lastError ? (
          <>
            {s.lastError}
            <div className="muted">{fmt(s.lastErrorAt)}</div>
          </>
        ) : (
          <span className="muted">none</span>
        )}
      </td>
    </tr>
  );
}

/** One block per adapter (configured or not), with its stored sources. */
export function SourceHealthTable({ health }: { health: DiscoveryHealth }) {
  return (
    <>
      {health.adapters.map((a) => (
        <div key={a.id} className="health-adapter">
          <h3>
            {a.displayName} <span className="muted small">({a.platform})</span>{' '}
            {a.configured ? (
              <span className="pill pill-public">configured</span>
            ) : (
              <span className="pill pill-provenance">
                not configured — set {a.missingEnv.join(', ')}
              </span>
            )}
          </h3>
          {a.sources.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>State</th>
                  <th>Last success</th>
                  <th>Last 24h</th>
                  <th>Quarantined (24h)</th>
                  <th>Quota today</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {a.sources.map((s) => (
                  <Row key={s.sourceId} s={s} />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small muted">No sources stored for this adapter yet.</p>
          )}
        </div>
      ))}
      {health.orphanSources.length ? (
        <p className="small warn">
          Sources for adapters unknown to this build:{' '}
          {health.orphanSources.map((s) => s.name).join(', ')}
        </p>
      ) : null}
      {health.planned.map((p) => (
        <p key={p.id} className="small muted">
          {p.id}: planned, not implemented — {p.reason}.
        </p>
      ))}
    </>
  );
}
