# Source: Manual URL submission

_Verified 2026-09-28. Adapter status: **implemented** (`packages/adapters/manual-url`,
adapter id `manual-url`). Needs no credentials._

A human pastes a video URL they found. It is how platforms **without a usable discovery
API** (TikTok) still enter the pipeline, and it works even when no other adapter is configured.

```bash
pnpm cli submit-url 'https://www.tiktok.com/@user/video/7412345678901234567'
pnpm cli submit-url 'https://youtu.be/dQw4w9WgXcQ' --json
pnpm cli submit-url 'https://clips.twitch.tv/SomeClipSlug'
```

## VERIFIED CURRENT BEHAVIOR

- URL identity comes from `@vd/url-identity` (pure; no network). Supported:
  - **YouTube**: `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, `m.`, `music.`, `youtube-nocookie.com`
  - **TikTok**: `tiktok.com/@user/video/<id>` (`www.`, `m.`), plus short links
    `tiktok.com/t/<code>`, `vm.tiktok.com/<code>`, `vt.tiktok.com/<code>` expanded by
    allowlisted redirects (`@vd/url-resolution`, see `tiktok.md`)
  - **Twitch clips**: `clips.twitch.tv/<id>`, `clips.twitch.tv/embed?clip=<id>`, `twitch.tv/<channel>/clip/<id>`
- Anything else is **rejected with a reason** (`invalid_url`, `unsupported_host`,
  `unsupported_path`, `short_link`) before any configuration or database access.
- TikTok URLs are enriched through TikTok's official oEmbed (see `tiktok.md`).
- Instagram/Facebook oEmbed (Meta oEmbed Read) is **not implemented**: it requires a Meta
  app with App Review, and since 2025-11-03 no longer returns author or thumbnail fields.

## ACCESS REQUIREMENTS

None. TikTok oEmbed needs no key.

## DISCOVERY CAPABILITIES

`discovery.url` only. `submit-url` does:

1. **Record** — the `manual-url` adapter looks up the URL and stores it as a **reference** to
   the canonical platform; the sighting's source is `manual-url`.
2. **Enrich** — if an adapter for the canonical platform with `discovery.url` is configured
   (YouTube with `YOUTUBE_API_KEY`, Twitch with client credentials), it fetches authoritative
   metadata and the first metric snapshot. No second sighting is created.

Submitting the same video again (in any URL form) never duplicates the video; each submission adds a sighting.

**Scoring role:** manual submissions are **provenance, not propagation**
(`manifest.sightingRole = "provenance"`). They are stored, reviewable, and enrich the video,
but never raise cross-source, source-propagation, or confidence — pasting a URL ten times
cannot change a video's virality score.

## METRICS AVAILABLE

None from this adapter. Metrics come only from canonical-platform enrichment or later `refresh-metrics`.

## QUOTA / RATE LIMIT INFORMATION

TikTok oEmbed: no published limit; one request per TikTok submission. YouTube enrichment:
1 `default` unit. Twitch enrichment: 1 request (+ token request when needed).

## LIMITATIONS

- YouTube/Twitch submissions without their adapter configured store identity only
  (`availability: unknown`, no title).

## COMPLIANCE CONSIDERATIONS

- Attribution must come from the platform (oEmbed author) or be added later by a human;
  nothing is scraped from HTML.
- No media download. Items are `content_origin = discovered_external`, rights `unknown`.

## OPEN QUESTIONS

1. Whether Meta oEmbed Read for an internal review tool is within its allowed usage (Instagram/Facebook remain unsupported).
2. Should submissions record who submitted them (a `submittedBy` field in sighting context)?
