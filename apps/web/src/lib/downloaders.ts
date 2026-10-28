/**
 * External downloader handoff — the ONLY place that knows about third-party
 * downloader services. The dashboard never downloads, proxies, scrapes or
 * automates anything here: a handoff copies the candidate's canonical URL to the
 * clipboard and opens the service's public website in a new tab, where the user
 * pastes the link and completes the download themselves.
 *
 * Every entry was checked on VERIFIED_ON by visiting the site and reading what it
 * says about itself and its supported platforms (see `verification`). None of the
 * services documents a query parameter or deep link that prefills the source URL,
 * so `prefill` is null everywhere: the external href is the bare website, never
 * built from candidate data.
 */

export const VERIFIED_ON = '2026-10-28';

export interface DownloaderProvider {
  id: 'snaptik' | 'snapinsta' | 'snaptube';
  name: string;
  /** Public website (https origin + path). Opened as-is; candidate data is never appended. */
  website: string;
  /** Canonical platform keys (videos.platform) the service's web tool handles. */
  platforms: readonly string[];
  /** What the user does after the handoff. */
  instructions: string;
  /**
   * A documented URL-prefill / deep-link mechanism, or null. Only set from the
   * service's own current documentation — never inferred from its forms.
   */
  prefill: null | { param: string; docsUrl: string };
  /** True when the service offers a paste-a-link web tool usable in a browser. */
  webTool: boolean;
  verification: {
    checkedOn: string;
    status: 'verified' | 'unconfirmed';
    evidence: string;
  };
}

export const DOWNLOADER_PROVIDERS: readonly DownloaderProvider[] = [
  {
    id: 'snaptik',
    name: 'SnapTik',
    website: 'https://snaptik.app/',
    platforms: ['tiktok'],
    instructions: 'Paste the TikTok link into the SnapTik input field and press Download.',
    prefill: null,
    webTool: true,
    verification: {
      checkedOn: VERIFIED_ON,
      status: 'verified',
      evidence:
        'snaptik.app is the most-referenced SnapTik domain, identifies itself as "SnapTik.App", ' +
        'links its own App Store / Play Store apps, and offers a paste-a-link TikTok (and Douyin) ' +
        'downloader. No documented URL-prefill parameter.',
    },
  },
  {
    id: 'snapinsta',
    name: 'SnapInsta',
    website: 'https://snapinsta.to/',
    // DISABLED: no SnapInsta domain could be established as the authoritative
    // official site, so no Instagram handoff is offered. Re-enable (platforms:
    // ['instagram'], webTool: true) only after the domain is reliably verified.
    platforms: [],
    instructions: 'SnapInsta is disabled until its official domain is verified.',
    prefill: null,
    webTool: false,
    verification: {
      checkedOn: VERIFIED_ON,
      status: 'unconfirmed',
      evidence:
        'SnapInsta publishes no authoritative domain list. snapinsta.to is the most-referenced and ' +
        'most-visited SnapInsta domain (Instagram videos/reels/stories/photos; paste-a-link) but ' +
        'could not be confirmed as official; snapinsta.app no longer resolves, snapinsta.com is a ' +
        'placeholder, and snapinsta.ai also claims to be official. Not offered until confirmed.',
    },
  },
  {
    id: 'snaptube',
    name: 'SnapTube',
    website: 'https://www.snaptube.com/',
    // Officially an Android-only app (developer Mobiuspace names snaptube.com as its site).
    // Its official site has no paste-a-link browser tool; the "web tools" some SnapTube-
    // branded pages link to live on unrelated domains that do not acknowledge SnapTube.
    // Nothing verified → no platform is offered through SnapTube.
    platforms: [],
    instructions: 'SnapTube is an Android app; there is no verified browser web tool.',
    prefill: null,
    webTool: false,
    verification: {
      checkedOn: VERIFIED_ON,
      status: 'verified',
      evidence:
        'snaptube.com (named official by developer Mobiuspace in 2019; Crunchbase/ZoomInfo agree) ' +
        'is an APK download site that states the app is Android-only and offers no browser ' +
        'downloader; its /instagram-downloader/ and /facebook-downloader/ pages are app promos ' +
        'without a link input. No web tool verified for TikTok, Instagram, YouTube, Twitch or Bluesky.',
    },
  },
];

export const NO_DOWNLOADER_MESSAGE = 'No configured external downloader for this platform.';
export const EXTERNAL_DISCLAIMER =
  "Downloads are handled by external services. Follow the source platform and downloader's terms and applicable rights.";

/** Providers whose verified web tool handles this canonical platform (display order). */
export function downloadersFor(platformKey: string): DownloaderProvider[] {
  const key = platformKey.trim().toLowerCase();
  return DOWNLOADER_PROVIDERS.filter((p) => p.webTool && p.platforms.includes(key));
}

export function providerById(id: string): DownloaderProvider | null {
  return DOWNLOADER_PROVIDERS.find((p) => p.id === id) ?? null;
}

export interface Handoff {
  /** Where the new tab goes: the provider's website, verbatim. */
  href: string;
  /** What goes on the clipboard: the candidate's canonical URL, verbatim. */
  copyText: string;
  /** Confirmation shown after a successful copy. */
  copiedMessage: string;
  /** Shown when the clipboard is unavailable (the URL is then displayed with a Copy button). */
  copyFailedMessage: string;
}

/**
 * The handoff for one provider and one candidate. The external href is the
 * provider's configured website only: no candidate-controlled value can reach it
 * (there is no documented prefill to carry the URL, so it travels via clipboard).
 */
export function handoffFor(provider: DownloaderProvider, canonicalUrl: string): Handoff {
  return {
    href: provider.website,
    copyText: canonicalUrl,
    copiedMessage: `Video link copied — paste it into ${provider.name}.`,
    copyFailedMessage: `Couldn't copy automatically — copy the link below and paste it into ${provider.name}.`,
  };
}

/** Attempts a clipboard write; never throws. */
export async function copyText(
  text: string,
  write: ((text: string) => Promise<void>) | undefined,
): Promise<boolean> {
  if (!write) return false;
  try {
    await write(text);
    return true;
  } catch {
    return false;
  }
}
