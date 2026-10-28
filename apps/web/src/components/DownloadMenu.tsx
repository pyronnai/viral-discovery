'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  EXTERNAL_DISCLAIMER,
  NO_DOWNLOADER_MESSAGE,
  copyText,
  downloadersFor,
  handoffFor,
  type DownloaderProvider,
} from '../lib/downloaders.ts';

/** Direct download of an official/authorized media_assets row (server-streamed). */
export function downloadHref(clusterId: string, videoId?: string | null): string {
  const base = `/api/candidates/${encodeURIComponent(clusterId)}/download`;
  return videoId ? `${base}?video=${encodeURIComponent(videoId)}` : base;
}

export interface OfficialAsset {
  available: boolean;
  videoId?: string | null;
  filename?: string | null;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'copied'; message: string }
  | { kind: 'copy-failed'; message: string; url: string };

const clipboardWriter = (): ((text: string) => Promise<void>) | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const clipboard = navigator.clipboard as Clipboard | undefined;
  return clipboard ? (t) => clipboard.writeText(t) : undefined;
};

/**
 * [ Download ▼ ] — a popup menu (mouse / keyboard / touch; no hover) with:
 *   · the official asset download when a media_assets row exists,
 *   · one external downloader per verified provider for this platform (handoff:
 *     copy the canonical URL, open the provider's site in a new tab),
 *   · Copy original URL, Open original.
 * The external href is always the provider's configured website; the candidate's
 * URL travels only via the clipboard. Nothing goes through our backend.
 */
export function DownloadMenu({
  clusterId,
  platformKey,
  platformName,
  canonicalUrl,
  asset,
  defaultOpen,
}: {
  clusterId: string;
  platformKey: string;
  platformName: string;
  canonicalUrl: string;
  asset?: OfficialAsset;
  /** Tests / server rendering: start expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const providers = downloadersFor(platformKey);
  const official = asset?.available ? asset : null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const items = () =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      root.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = items();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  const copyOnly = async () => {
    const ok = await copyText(canonicalUrl, clipboardWriter());
    setStatus(
      ok
        ? { kind: 'copied', message: 'Original URL copied.' }
        : {
            kind: 'copy-failed',
            message: "Couldn't copy automatically — copy it here:",
            url: canonicalUrl,
          },
    );
  };

  /** Runs in the click that also opens the provider's site (the link's own navigation). */
  const handoff = async (provider: DownloaderProvider) => {
    const h = handoffFor(provider, canonicalUrl);
    const ok = await copyText(h.copyText, clipboardWriter());
    setStatus(
      ok
        ? { kind: 'copied', message: h.copiedMessage }
        : { kind: 'copy-failed', message: h.copyFailedMessage, url: h.copyText },
    );
  };

  return (
    <div className="dl" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`btn btn-download${open ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="Download options"
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        ⬇ Download ▾
      </button>
      {open ? (
        <div className="dl-menu" role="menu" id={menuId} aria-label={`Download: ${platformName}`}>
          {official ? (
            <a
              role="menuitem"
              className="dl-item"
              href={downloadHref(clusterId, official.videoId)}
              download={official.filename ?? true}
              onClick={() => {
                setOpen(false);
              }}
            >
              <strong>Download file</strong>
              <span className="small muted">official/authorized asset · saves to Downloads</span>
            </a>
          ) : null}
          {providers.map((p) => {
            const h = handoffFor(p, canonicalUrl);
            return (
              <a
                key={p.id}
                role="menuitem"
                className="dl-item dl-external"
                href={h.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${p.name} — copies the original URL and opens ${p.name} in a new tab (external service)`}
                title={p.instructions}
                onClick={() => {
                  void handoff(p);
                }}
              >
                <strong>{p.name} ↗</strong>
                <span className="small muted">external site · copies link, opens new tab</span>
              </a>
            );
          })}
          {!official && !providers.length ? (
            <p className="dl-none small muted">{NO_DOWNLOADER_MESSAGE}</p>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="dl-item"
            onClick={() => {
              void copyOnly();
            }}
          >
            <strong>Copy original URL</strong>
            <span className="small muted">{canonicalUrl}</span>
          </button>
          <a
            role="menuitem"
            className="dl-item"
            href={canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <strong>Open original on {platformName} ↗</strong>
          </a>
          {status.kind !== 'idle' ? (
            <div className="dl-status" role="status" aria-live="polite">
              {status.kind === 'copied' ? (
                <span>✓ {status.message}</span>
              ) : (
                <>
                  <span className="warn">⚠ {status.message}</span>
                  <span className="dl-fallback">
                    <input
                      className="review-note"
                      readOnly
                      value={status.url}
                      aria-label="Original video URL"
                      onFocus={(e) => {
                        e.currentTarget.select();
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={(e) => {
                        const input =
                          e.currentTarget.parentElement?.querySelector<HTMLInputElement>('input');
                        input?.select();
                        void copyOnly();
                      }}
                    >
                      Copy
                    </button>
                  </span>
                </>
              )}
            </div>
          ) : null}
          <p className="dl-disclaimer small muted">{EXTERNAL_DISCLAIMER}</p>
        </div>
      ) : null}
    </div>
  );
}
