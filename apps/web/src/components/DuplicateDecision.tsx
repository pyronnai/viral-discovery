'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { confirmDuplicateAction, rejectDuplicateAction } from '../app/actions.ts';

/**
 * CONFIRM SAME VIDEO merges the two candidates (histories preserved; conflicts
 * surfaced). NOT THE SAME is remembered and never suggested again.
 */
export function DuplicateDecision({
  candidateId,
  clusterId,
}: {
  candidateId: string;
  clusterId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const decide = (kind: 'confirm' | 'reject') => {
    setError(null);
    startTransition(async () => {
      const result =
        kind === 'confirm'
          ? await confirmDuplicateAction(candidateId, clusterId)
          : await rejectDuplicateAction(candidateId, clusterId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(kind === 'confirm' ? 'Merged' : 'Marked not the same');
      if (result.redirectTo && result.redirectTo !== `/candidates/${clusterId}`) {
        router.push(result.redirectTo);
      } else router.refresh();
    });
  };

  return (
    <div className="dup-actions">
      <button
        type="button"
        className="btn btn-approved"
        disabled={pending || done !== null}
        onClick={() => {
          decide('confirm');
        }}
      >
        Confirm same video
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={pending || done !== null}
        onClick={() => {
          decide('reject');
        }}
      >
        Not the same
      </button>
      {pending ? <span className="small muted">saving…</span> : null}
      {done ? <span className="small">{done}</span> : null}
      {error ? <div className="error-inline">⚠ {error}</div> : null}
    </div>
  );
}
