# Source: TikTok

_Verified 2026-09-28. Status: **manual URL enrichment only** (via the `manual-url`
adapter). There is **no automated TikTok discovery** in this system._

## Manual URL support ≠ automated discovery

|                                                                       | Supported?                                   |
| --------------------------------------------------------------------- | -------------------------------------------- |
| A human pastes a TikTok video URL → identity + oEmbed metadata stored | **Yes** (`vd submit-url`)                    |
| TikTok links found in Bluesky posts → sightings of the TikTok video   | **Yes** (full URLs only)                     |
| Searching/trending/feeds on TikTok                                    | **No** — no permitted API is available to us |
| TikTok view/like/comment/share counts                                 | **No** — oEmbed provides none                |

Primary reference: TikTok oEmbed — https://developers.tiktok.com/doc/embed-videos (page updated 2026-08-04).

## VERIFIED CURRENT BEHAVIOR

- `GET https://www.tiktok.com/oembed?url=<video url>`. **No API key is mentioned.**
- Documented response fields: `version, type, title, author_url, author_name, width,
height, html, thumbnail_width, thumbnail_height, thumbnail_url, provider_url, provider_name`.
- Documented URL form: `https://www.tiktok.com/@{username}/video/{video_id}`.
- Removed videos become unavailable in embeds too.
- **Live check 2026-09-28:** a public video URL returned 200 without credentials. The
  response also contained **undocumented** fields `author_unique_id`, `embed_product_id`,
  `embed_type`; they are **not used**.

## ACCESS REQUIREMENTS

None for oEmbed. The Research API and other TikTok APIs are **not used** (we do not know
that we qualify).

## DISCOVERY CAPABILITIES

None. TikTok videos enter only through manual submission or links on other sources.

## METRICS AVAILABLE

None. All metrics stay unavailable; no TikTok metric snapshot is ever written.

## QUOTA / RATE LIMIT INFORMATION

No published limit. One oEmbed request per submitted URL (`tiktok-oembed` bucket, local accounting).

## LIMITATIONS

- **Short links** (`vm.tiktok.com/…`, `vt.tiktok.com/…`, `tiktok.com/t/…`) are rejected
  with a request to paste the full URL; following the redirect would mean fetching TikTok pages.
- `/@user/photo/<id>` posts are not videos and are rejected.
- oEmbed gives no stable account id, so TikTok creators are stored as handle/display name
  on the video (no `creators` row).
- `thumbnail_url` is a signed CDN URL that likely expires.
- `title` is the video caption as oEmbed returns it.

## COMPLIANCE CONSIDERATIONS

- **No scraping** of TikTok pages, **no media download**, no use of the embed script beyond storing its HTML-free metadata.
- Manually submitted items are `content_origin = discovered_external`; rights stay `unknown`.

## OPEN QUESTIONS

1. Is there a permitted way to get TikTok engagement metrics for this use case (e.g. TikTok for Developers products other than the Research API)?
2. Is resolving short links via a single redirect request acceptable under TikTok's terms?
