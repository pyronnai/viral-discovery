'use client';

/** Shown when the server cannot render (e.g. database unreachable or config invalid). */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="empty">
      <h2>Something went wrong loading the dashboard</h2>
      <p className="muted">
        Check that the database is reachable and <code>DATABASE_URL</code> is set (
        <code>pnpm cli health</code>).
        {error.digest ? ` Reference: ${error.digest}` : ''}
      </p>
      <button
        className="btn"
        type="button"
        onClick={() => {
          reset();
        }}
      >
        Try again
      </button>
    </div>
  );
}
