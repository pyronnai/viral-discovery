'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { obtainedAction, reviewAction, savedAction } from '../app/actions.ts';

export interface InboxState {
  saved: boolean;
  obtained: boolean;
  used: boolean;
  approved: boolean;
  rejected: boolean;
}

type Change =
  | { kind: 'saved'; value: boolean }
  | { kind: 'obtained'; value: boolean }
  | { kind: 'decision'; status: 'approved' | 'rejected' | 'already_used' };

function apply(state: InboxState, change: Change): InboxState {
  if (change.kind === 'obtained') return { ...state, obtained: change.value };
  // Saved / approved / rejected / used are one triage decision; obtained is independent.
  const cleared = { saved: false, approved: false, rejected: false, used: false };
  if (change.kind === 'saved') return { ...state, ...cleared, saved: change.value };
  return {
    ...state,
    ...cleared,
    approved: change.status === 'approved',
    rejected: change.status === 'rejected',
    used: change.status === 'already_used',
  };
}

/**
 * Primary: Save · Obtained · Used. Secondary: Approve · Reject. Optimistic; reverts
 * with an error if the server rejects. Saved ≠ Obtained ≠ Used.
 */
export function InboxActions({
  clusterId,
  state,
  withNote,
}: {
  clusterId: string;
  state: InboxState;
  /** Detail page: show a note field used for "obtained". */
  withNote?: boolean;
}) {
  const [optimistic, change] = useOptimistic(state, apply);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const run = (c: Change) => {
    setError(null);
    startTransition(async () => {
      change(c);
      const result =
        c.kind === 'saved'
          ? await savedAction(clusterId, c.value)
          : c.kind === 'obtained'
            ? await obtainedAction(clusterId, c.value, withNote && note ? note : undefined)
            : await reviewAction(clusterId, c.status);
      if (!result.ok) setError(result.error);
      else if (c.kind === 'obtained') setNote('');
    });
  };

  return (
    <div className="inbox-actions">
      <div className="inbox-primary">
        <button
          type="button"
          className={`btn btn-saved${optimistic.saved ? ' active' : ''}`}
          aria-pressed={optimistic.saved}
          disabled={pending}
          title={
            optimistic.saved ? 'Remove from the saved shortlist' : 'Add to the saved shortlist'
          }
          onClick={() => {
            run({ kind: 'saved', value: !optimistic.saved });
          }}
        >
          {optimistic.saved ? '★ Saved' : '☆ Save'}
        </button>
        <button
          type="button"
          className={`btn btn-obtained${optimistic.obtained ? ' active' : ''}`}
          aria-pressed={optimistic.obtained}
          disabled={pending}
          title="You obtained the source media yourself (tracking only; nothing is downloaded)"
          onClick={() => {
            run({ kind: 'obtained', value: !optimistic.obtained });
          }}
        >
          {optimistic.obtained ? '⬇ Obtained' : '⬇ Obtained?'}
        </button>
        <button
          type="button"
          className={`btn btn-already_used${optimistic.used ? ' active' : ''}`}
          aria-pressed={optimistic.used}
          disabled={pending || optimistic.used}
          title="Already used — never surface this clip (or its reposts) as fresh again"
          onClick={() => {
            run({ kind: 'decision', status: 'already_used' });
          }}
        >
          {optimistic.used ? '✓ Used' : 'Used'}
        </button>
      </div>
      <div className="inbox-secondary">
        <button
          type="button"
          className={`btn btn-ghost btn-approved${optimistic.approved ? ' active' : ''}`}
          disabled={pending}
          onClick={() => {
            run({ kind: 'decision', status: 'approved' });
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn btn-ghost btn-rejected${optimistic.rejected ? ' active' : ''}`}
          disabled={pending}
          onClick={() => {
            run({ kind: 'decision', status: 'rejected' });
          }}
        >
          Reject
        </button>
      </div>
      {withNote ? (
        <input
          className="review-note"
          placeholder="Obtained note (optional, e.g. where/how)"
          maxLength={500}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      ) : null}
      {pending ? <span className="small muted">saving…</span> : null}
      {error ? <div className="error-inline">⚠ {error}</div> : null}
    </div>
  );
}
