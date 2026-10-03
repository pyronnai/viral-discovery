# Bluesky fixtures

Shaped like real `app.bsky.feed.searchPosts` / `app.bsky.feed.getPosts` responses
from `https://api.bsky.app` observed on 2026-09-28 (post views with
`app.bsky.embed.external#view`, `app.bsky.embed.video#view`, and
`app.bsky.embed.recordWithMedia#view` embeds). All DIDs, handles, CIDs, text, and
URLs are invented — no real accounts or posts are stored here.

`searchPosts-labelled.json` mirrors the moderation-label shapes observed from
`api.bsky.app` searchPosts on 2026-10-03: post `labels[]` from the Bluesky
moderation service (`src` = `did:plc:ar7c4by46qjdydhdevvrndac`, its real public
DID) and from the author (self-labels, also present as `record.labels`
selfLabels), account-level author labels (`uri` = the DID), profile-record author
labels (`uri` = `…/app.bsky.actor.profile/self`), and an unlabelled post shaped
like the pilot's adult-captioned item (which the platform had not labelled).
Identities, CIDs, text and URLs are invented.
