'use client';

import { useState } from 'react';

/**
 * Loads the thumbnail directly from the platform's CDN (never proxied). A broken
 * or missing image degrades to a labeled placeholder instead of breaking the card.
 */
export function Thumbnail({
  src,
  alt,
  platform,
  large,
}: {
  src: string | null;
  alt: string;
  platform: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const className = large ? 'thumb thumb-large' : 'thumb';
  if (!src || failed) {
    return (
      <div
        className={`${className} thumb-missing`}
        role="img"
        aria-label={`No thumbnail (${platform})`}
      >
        <span>{platform}</span>
        <small>no thumbnail</small>
      </div>
    );
  }
  return (
    // Plain <img>: a remote CDN image, intentionally not optimized or proxied by us.
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
