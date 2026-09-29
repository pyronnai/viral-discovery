'use client';

import { useState, useTransition } from 'react';
import { rightsAction } from '../app/actions.ts';

const STATUSES = [
  ['unknown', 'Unknown'],
  ['requested', 'Requested'],
  ['granted', 'Granted'],
  ['denied', 'Denied'],
  ['own_content', 'Own content'],
] as const;

/** Manual rights record (history kept). No outreach or requests are automated. */
export function RightsForm({ clusterId, current }: { clusterId: string; current: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="rights-form"
      action={(form) => {
        setMessage(null);
        startTransition(async () => {
          const r = await rightsAction(clusterId, form);
          setMessage(r.ok ? 'Saved' : `⚠ ${r.error}`);
        });
      }}
    >
      <label>
        Status
        <select name="status" defaultValue={current}>
          {STATUSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Rights holder
        <input name="rightsHolder" maxLength={200} placeholder="optional" />
      </label>
      <label>
        Evidence URL
        <input name="evidenceUrl" type="url" placeholder="https://… (optional)" />
      </label>
      <label>
        Notes
        <input name="notes" maxLength={500} placeholder="optional" />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save rights'}
      </button>
      {message ? <span className="small muted">{message}</span> : null}
    </form>
  );
}
