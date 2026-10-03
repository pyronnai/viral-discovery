import type { CardView } from '@vd/review';

/**
 * Moderation labels the SOURCE PLATFORM attached — shown as reported, never
 * inferred, and kept visually apart from AI content analysis.
 */
export function SourceModerationWarning({
  moderation,
  compact = false,
}: {
  moderation: CardView['sourceModeration'];
  compact?: boolean;
}) {
  const shown = compact ? moderation.labels.filter((l) => l.explicit) : moderation.labels;
  if (!shown.length) return compact ? null : <p className="small muted">No platform labels.</p>;
  return (
    <div className={moderation.explicit ? 'warn source-moderation' : 'source-moderation'}>
      {moderation.explicit ? (
        <strong>⚠ Platform-labelled adult/graphic content — hidden from Viral Now. </strong>
      ) : null}
      {shown.map((l) => (
        <span
          key={`${l.platform}|${l.by}|${l.value}`}
          className={l.explicit ? 'flag' : 'label label-muted'}
          title={`${l.by}${l.labeler ? ` · labeler ${l.labeler}` : ''}`}
        >
          {l.platform} label: {l.value} <small>({l.by})</small>
        </span>
      ))}
    </div>
  );
}
