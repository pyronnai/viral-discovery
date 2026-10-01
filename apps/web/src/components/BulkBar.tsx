'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { bulkAction } from '../app/actions.ts';

const SELECTOR = 'input[data-select-cluster]';

function selected(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>(`${SELECTOR}:checked`)].map(
    (i) => i.value,
  );
}

const ACTIONS = [
  { action: 'save', label: '☆ Save' },
  { action: 'obtained', label: '⬇ Obtained' },
  {
    action: 'used',
    label: '✓ Used',
    confirm: 'Mark as ALREADY USED? They (and confirmed reposts) leave the inbox.',
  },
  { action: 'reject', label: 'Reject', confirm: 'Reject the selected candidates?' },
] as const;

/**
 * Bulk triage for the checkboxes on the cards, plus metadata/link export.
 * Broad actions (Used, Reject) ask for confirmation. No bulk publishing exists.
 */
export function BulkBar({ exportQuery }: { exportQuery: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const run = (action: string, confirmText?: string) => {
    const ids = selected();
    if (!ids.length) {
      setMessage('Select candidates first.');
      return;
    }
    if (confirmText && !window.confirm(`${confirmText}\n\n${ids.length} selected.`)) return;
    startTransition(async () => {
      const r = await bulkAction(ids, action);
      if (!r.ok) setMessage(`⚠ ${r.error}`);
      else {
        const { applied, unchanged, failed } = r.result;
        setMessage(
          `${applied.length} updated · ${unchanged.length} unchanged${failed.length ? ` · ${failed.length} failed` : ''}`,
        );
        for (const box of document.querySelectorAll<HTMLInputElement>(SELECTOR))
          box.checked = false;
        router.refresh();
      }
    });
  };

  const exportSelected = (format: 'csv' | 'json') => {
    const ids = selected();
    if (!ids.length) {
      setMessage('Select candidates to export, or use “Export view”.');
      return;
    }
    window.location.href = `/export?format=${format}&ids=${ids.join(',')}`;
  };

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <label className="check">
        <input
          type="checkbox"
          aria-label="Select all on this page"
          onChange={(e) => {
            for (const box of document.querySelectorAll<HTMLInputElement>(SELECTOR))
              box.checked = e.target.checked;
          }}
        />{' '}
        all
      </label>
      {ACTIONS.map((a) => (
        <button
          key={a.action}
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={() => {
            run(a.action, 'confirm' in a ? a.confirm : undefined);
          }}
        >
          {a.label}
        </button>
      ))}
      <span className="bulk-sep" />
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          exportSelected('csv');
        }}
      >
        Export selected (CSV)
      </button>
      <a className="btn btn-ghost" href={`/export?format=csv&${exportQuery}`}>
        Export view (CSV)
      </a>
      <a className="btn btn-ghost" href={`/export?format=json&${exportQuery}`}>
        JSON
      </a>
      {pending ? <span className="small muted">working…</span> : null}
      {message ? <span className="small">{message}</span> : null}
    </div>
  );
}
