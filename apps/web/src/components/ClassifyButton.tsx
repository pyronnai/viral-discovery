'use client';

import { useState, useTransition } from 'react';
import { classifyAction } from '../app/actions.ts';

export function ClassifyButton({
  clusterId,
  classified,
  enabled,
  reason,
}: {
  clusterId: string;
  classified: boolean;
  enabled: boolean;
  reason: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  if (!enabled) {
    return (
      <span className="muted small" title={reason ?? undefined}>
        Classifier not configured
      </span>
    );
  }
  return (
    <span className="classify">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const r = await classifyAction(clusterId, classified);
            setMessage(r.ok ? (r.message ?? 'done') : `⚠ ${r.error}`);
          });
        }}
      >
        {pending ? 'Classifying…' : classified ? 'Reclassify' : 'Classify'}
      </button>
      {message ? <span className="small muted">{message}</span> : null}
    </span>
  );
}
