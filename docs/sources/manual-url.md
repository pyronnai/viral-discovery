# Source: Manual URL submission

_Researched 2026-09-28. Adapter status: **not implemented**._

A human pastes a video URL (found while browsing). The system records it as a
sighting and enriches it only through documented, permitted endpoints. This is how
platforms **without a usable discovery API** (TikTok, Instagram) enter the pipeline.

## VERIFIED CURRENT BEHAVIOR

**TikTok oEmbed** — https://developers.tiktok.com/doc/embed-videos (doc updated 2026-08-04)

- `GET https://www.tiktok.com/oembed?url=<video url>` returns embed HTML and video
  information following the oembed.com spec. The documented example includes
  `title`, `author_name`, `author_url`, and `html`.
- An embedded video becomes unavailable when the video is removed on TikTok.
- No engagement metrics are part of the documented response.

**Instagram / Facebook oEmbed (Meta oEmbed Read)** —
https://developers.facebook.com/docs/features-reference/oembed-read,
https://developers.facebook.com/blog/post/2025/04/08/oembed-updates/

- Requires a Meta app (app access token) and the oEmbed Read feature, which requires App Review.
- **Since 2025-11-03** the Instagram and Facebook post/video oEmbed responses no longer
  return `author_name`, `author_url`, `thumbnail_url`, `thumbnail_width`, `thumbnail_height`.
- The feature's allowed usage is providing front-end views (embeds) of public content.

## ASSUMPTIONS (unverified)

- TikTok oEmbed returns `thumbnail_url`/dimensions (seen in third-party examples;
  the official page excerpt read today was truncated before those fields). Thumbnail
  URLs may expire.
- TikTok oEmbed needs no API key (none is mentioned in the doc read).
- YouTube URLs are better enriched through the YouTube adapter (`videos.list` /
  `batchGetStats`) than through YouTube's oEmbed endpoint, which was not checked this session.

## ACCESS REQUIREMENTS

- TikTok: none known for oEmbed.
- Instagram/Facebook: Meta developer app + approved oEmbed Read feature.
- YouTube: the YouTube adapter's API key.

## QUOTAS / RATE LIMITS

- TikTok oEmbed: **no published limit found.** Throttle conservatively (e.g. 1 request/second).
- Meta: subject to Graph API app rate limits (not quantified here).

## COMPLIANCE CONSIDERATIONS

- **Attribution must be captured at submission time.** Because Instagram oEmbed no
  longer returns the author, the submission form must require the creator handle for
  Instagram/Facebook URLs, typed by the human.
- Do **not** fetch and parse Instagram/TikTok page HTML to fill missing fields. Meta
  suggests page metadata for thumbnails, but automated page fetching is a separate
  terms question. Default: leave the field null.
- No media download. Store the canonical URL and embed data only.
- Manual items carry `content_origin = 'discovered_external'` and `rights.status = 'unknown'`.

## OPEN QUESTIONS

1. Is using Meta oEmbed Read for an internal review dashboard (not a public site)
   within its allowed usage?
2. Should manual TikTok items ever get metrics? No permitted source is known, so
   they would be scored on cross-source signals and human judgment only.
