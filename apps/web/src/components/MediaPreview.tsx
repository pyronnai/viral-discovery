import type { DownloadInfo } from '../lib/download.ts';

/**
 * Native browser player for a playable official/authorized asset. Never
 * autoplays; the user presses play. Previewing does not mark the clip obtained.
 */
export function MediaPreview({ clusterId, info }: { clusterId: string; info: DownloadInfo }) {
  if (!info.available || !info.playable) return null;
  const src = `/api/candidates/${encodeURIComponent(clusterId)}/media?video=${encodeURIComponent(info.videoId)}`;
  return (
    <figure className="media-preview">
      <video controls preload="metadata" playsInline src={src}>
        <a href={src}>Open the media file</a>
      </video>
      <figcaption className="small muted">
        {info.kind.replaceAll('_', ' ')} from {info.provider}
        {info.licenseNote ? ` · ${info.licenseNote}` : ''}
        {info.sizeBytes !== null ? ` · ${(info.sizeBytes / 1_048_576).toFixed(1)} MB` : ''} ·{' '}
        {info.filename}
      </figcaption>
    </figure>
  );
}
