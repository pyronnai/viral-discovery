/**
 * One-click download of an official/authorized media asset. A plain link to the
 * download endpoint: the server answers with Content-Disposition: attachment, so
 * the browser saves the file to its normal Downloads folder. When no asset
 * exists the button is replaced by "Download unavailable" — a source link is
 * never presented as a download.
 */
export const DOWNLOAD_UNAVAILABLE = 'No downloadable media asset is available for this video.';

export function downloadHref(clusterId: string, videoId?: string | null): string {
  const base = `/api/candidates/${encodeURIComponent(clusterId)}/download`;
  return videoId ? `${base}?video=${encodeURIComponent(videoId)}` : base;
}

export function DownloadButton({
  clusterId,
  available,
  videoId,
  filename,
  compact,
}: {
  clusterId: string;
  available: boolean;
  /** Narrow to one representation (detail page per-version links). */
  videoId?: string | null;
  /** Known filename (detail page), used as the link's download hint. */
  filename?: string | null;
  compact?: boolean;
}) {
  if (!available) {
    return (
      <span className="download-unavailable">
        <span className="btn btn-disabled" aria-disabled="true" title={DOWNLOAD_UNAVAILABLE}>
          Download unavailable
        </span>
        <span className={`download-note small muted${compact ? ' download-note-compact' : ''}`}>
          {DOWNLOAD_UNAVAILABLE}
        </span>
      </span>
    );
  }
  return (
    <a
      className="btn btn-download"
      href={downloadHref(clusterId, videoId)}
      download={filename ?? true}
      title="Download the official/authorized media file to your Downloads folder"
    >
      ⬇ Download
    </a>
  );
}
