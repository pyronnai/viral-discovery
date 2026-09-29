'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { reviewAction } from '../app/actions.ts';

const ACTIONS = [
  { status: 'approved', label: 'Approve', key: 'A' },
  { status: 'saved', label: 'Save', key: 'S' },
  { status: 'rejected', label: 'Reject', key: 'R' },
  { status: 'already_used', label: 'Used', key: 'U' },
] as const;

const LABELS: Record<string, string> = {
  approved: 'Approved',
  saved: 'Saved',
  rejected: 'Rejected',
  already_used: 'Already used',
};

/**
 * Cluster-level review decision. Optimistic: the new status shows immediately and
 * automatically reverts if the server action fails (the error is shown).
 */
export function ReviewControls({
  clusterId,
  status,
  withNote,
}: {
  clusterId: string;
  status: string | null;
  withNote?: boolean;
}) {
  const [optimistic, setOptimistic] = useOptimistic(status);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const decide = (next: string) => {
    setError(null);
    startTransition(async () => {
      setOptimistic(next);
      const result = await reviewAction(clusterId, next, withNote ? note : undefined);
      if (!result.ok) setError(result.error);
      else setNote('');
    });
  };

  return (
    <div className="review-controls">
      <div className={`review-status review-${optimistic ?? 'none'}`} aria-live="polite">
        {optimistic ? LABELS[optimistic] : 'Unreviewed'}
        {pending ? ' …' : ''}
      </div>
      <div className="review-buttons">
        {ACTIONS.map((a) => (
          <button
            key={a.status}
            type="button"
            className={`btn btn-${a.status}${optimistic === a.status ? ' active' : ''}`}
            aria-pressed={optimistic === a.status}
            disabled={pending}
            onClick={() => {
              decide(a.status);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      {withNote ? (
        <input
          className="review-note"
          placeholder="Optional note (saved with the next decision)"
          maxLength={500}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      ) : null}
      {error ? <div className="error-inline">⚠ {error}</div> : null}
    </div>
  );
}
