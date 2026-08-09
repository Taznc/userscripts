# Seerr request userscript — design

- **Date:** 2026-08-08
- **Status:** Approved for planning
- **Deliverable:** `seerr-request.user.js`, a single-file userscript

## Goal

Request movies and TV shows in Overseerr/Jellyseerr ("Seerr") directly from the
media sites where you actually browse, without opening Seerr. On a title page,
show whether the title is already in the library and offer a one-click request.
On a list page, show at a glance which titles you already have.

## Non-goals

These are deliberately excluded from v1. Each is recorded with the reason so the
decision doesn't get re-litigated silently.

| Excluded | Reason |
|---|---|
| Rotten Tomatoes support | Exposes no IMDb or TMDb ID; would require fuzzy title matching |
| Click-to-request from list cards | Materially bigger build (per-card popups, TV seasons with no room for a panel); status view ships first |
| Watchlist as a secondary action | Not requested; Overseerr's watchlist is Plex-synced and read-only, so support differs by flavor |
| Auto-approve after request | Not requested; the approval step is a deliberate speed bump |
| Keyboard shortcuts | Saves little over a button already on screen |
| Request history / management UI | Seerr's own UI does this well |
| Radarr/Sonarr *release* profiles (preferred-word filters) | Not exposed by the Seerr API at all |

## Verified API facts

Everything below was read from Overseerr source at `sct/overseerr@98ea135`, not
assumed. Jellyseerr shares this surface.

### Resolving an external ID — `server/lib/search.ts`

Search providers match on a **prefixed** query via lookbehind:

```
/(?<=tmdb:)\d+/        tmdb:278
/(?<=imdb:)(tt|nm)\d+/ imdb:tt0111161
/(?<=tvdb:)\d+/        tvdb:81189
/(?<=year:)\d{4}/      year:1994
```

A bare `tt0111161` does **not** match. It falls through to TMDb fuzzy text
search on the literal string and returns junk. All queries must carry a prefix.

External-ID lookups don't return `media_type`; Overseerr injects it server-side
based on which result array the hit landed in (`movie_results`, `tv_results`,
`person_results`). Consequence: adapters need not know whether a title is a
movie or a series — resolve determines it.

`tv_episode_results` is **not** mapped. An IMDb *episode* `tt` ID therefore
resolves to zero results.

### Search response already carries library status — `server/routes/search.ts`

`GET /api/v1/search` runs `Media.getRelatedMedia()` over its results and returns
them through `mapSearchResults`, so each result includes `mediaInfo`. One call
gets both the TMDb ID and the library status. No second call needed for movies.

### Status enums — `server/constants/media.ts`

```
MediaStatus:        1 UNKNOWN  2 PENDING  3 PROCESSING
                    4 PARTIALLY_AVAILABLE  5 AVAILABLE  6 DELETED
MediaRequestStatus: 1 PENDING  2 APPROVED  3 DECLINED  4 FAILED  5 COMPLETED
```

These are distinct. `mediaInfo.status` describes the *media*; a request that
failed downstream in Radarr appears only in `mediaInfo.requests[].status`.

### Request body — `server/routes/request.ts`

`POST /api/v1/request` accepts `mediaType`, `mediaId`, `is4k`, `serverId`,
`profileId`, `rootFolder`, `languageProfileId` (TV), `tags`, `userId`, and
`seasons` (TV, array of season numbers).

Response codes:

| Code | Meaning |
|---|---|
| 201 | Created |
| **202** | `NoSeasonsAvailableError` — **nothing was created** |
| 403 | `RequestPermissionError` or `QuotaRestrictedError` |
| 409 | `DuplicateMediaRequestError` |
| 500 | Other |

**202 is in the 2xx success range but means the request did not happen.** A
naive `status >= 200 && status < 300` check reports false success. It must be
handled explicitly.

Setting `profileId` requires the `REQUEST_ADVANCED` permission, which an admin
API key satisfies.

### Servers and profiles — `server/routes/service.ts`

- `GET /api/v1/service/radarr` → `[{ id, name, is4k, isDefault, activeDirectory, activeProfileId, activeTags }]`
- `GET /api/v1/service/radarr/{id}` → `{ server, profiles[], rootFolders[], tags }`
- `GET /api/v1/service/sonarr` and `/sonarr/{id}` — same shape, plus
  `activeAnimeProfileId`, `activeAnimeDirectory`, `activeLanguageProfileId`,
  and `languageProfiles[]`

Sonarr's separate `activeAnimeProfileId` is how Seerr auto-routes anime to a
different quality profile, decided server-side from TMDb keywords.

**Sending an explicit `profileId` overrides that routing.** Anime would land on
the normal TV profile. Therefore the fast path must send *no* `profileId`, and
the options panel's dropdown must default to a "Seerr default (auto)" entry
rather than pre-selecting the named default profile.

## Architecture

One file, no build step, installed by dragging into Tampermonkey. Internally
five ordered sections inside an IIFE:

```
metadata block  @match per site, @grant GM_xmlhttpRequest / GM_setValue /
                GM_getValue / GM_registerMenuCommand, @connect
config          GM storage read/write, settings panel, profile cache
seerr           API client: resolve / details / request / services
ui              button, options panel, season list, dot, toast
adapters[]      declarative per-site descriptors
boot            adapter selection, mount loop, list observer
```

`@connect` is required — Tampermonkey blocks `GM_xmlhttpRequest` to undeclared
hosts. Because the Seerr URL is user-configured, the script ships `@connect *`,
with that tradeoff stated plainly in the settings panel.

### Why one file with an internal registry

Considered and rejected: a bundler with ES modules (real toolchain overhead and
a dist artifact to keep in sync, for ~800 lines), and one userscript per site
(duplicates the client, config, and API key four times).

The adapter boundary provides the isolation a multi-file layout would, without
the toolchain. A single file also means the API key lives in exactly one place.

## Adapter contract

Adapters are **data, not behavior**. An adapter never calls the API, never
renders UI, and never touches config. Both halves are optional.

```js
{
  name:   'imdb',
  detail: {
    match:   RegExp,                       // tested against location.href
    extract: (url, doc) => ({ query }),    // e.g. { query: 'imdb:tt0111161' }
    anchor:  (doc) => Element | null,      // where the button mounts
  },
  list: {
    match: RegExp,
    cards: (doc) => [{ el: Element, query: string }],
  },
}
```

`extract` returns a **Seerr query string**, not a raw ID. That is the central
simplification: every site collapses to the same one-line core call, and media
type is resolved server-side.

A throw inside any adapter is caught, logged with the adapter name, and costs
only that site its button. Other adapters are unaffected.

### Site adapters

| Site | Detail match | Query source | List pages |
|---|---|---|---|
| IMDb | `imdb.com/title/(tt\d+)` | URL path → `imdb:tt…` | search results, watchlist, user lists, charts |
| Letterboxd | `letterboxd.com/film/…` | `body[data-tmdb-id]` or the TMDb sidebar link → `tmdb:…` | only if poster cards expose a resolvable ID |
| TMDb | `themoviedb.org/(movie\|tv)/(\d+)` | URL path → `tmdb:…` | discover and search grids |
| Trakt | `trakt.tv/(movies\|shows)/…` | TMDb ID from page meta → `tmdb:…` | lists, watchlist |

**IMDb episode pages** share the `/title/tt…/` URL shape but resolve to zero
results, since `tv_episode_results` is unmapped. The IMDb adapter detects the
episode breadcrumb and extracts the parent series `tt` ID instead.

**No ID, no dots.** If a site's list cards don't carry a resolvable ID, that
site gets no list dots. Fuzzy title matching is never used — the same rule that
excluded Rotten Tomatoes. Letterboxd list support is therefore contingent on
what its poster markup actually exposes, to be confirmed during implementation.

## Detail-page flow

```
page load  → adapter.detail.extract()
           → GET /api/v1/search?query=imdb:tt0111161      (1 call)
             └─ tmdbId, mediaType, mediaInfo
           → button renders from status

click left half (fast path)
  movie → POST /api/v1/request { mediaType:'movie', mediaId }
  tv    → GET /api/v1/tv/{tmdbId}     (per-season availability)
        → season panel
        → POST /api/v1/request { mediaType:'tv', mediaId, seasons:[3,4,5] }

click caret (options panel)
  reads cached profiles — 0 calls
  → POST with any of serverId, profileId, rootFolder, userId, is4k
```

The fast path deliberately omits `serverId`, `profileId`, and `rootFolder` so
Seerr's own defaults and anime routing apply. It **does** include the configured
`userId` — attribution is orthogonal to routing, and without it every request
would show as made by the admin API user.

## Status → button mapping

Evaluated in order; the first match wins.

| Condition | Button |
|---|---|
| No config saved | "Set up Seerr" → opens settings |
| Network failure | "Seerr offline" (red, disabled) |
| Lookup in flight | "Checking…" (muted, disabled) |
| Zero results | "Not on TMDb" (muted, disabled) |
| `requests[]` has a `FAILED` (4) | "Retry" (red, **active**) → `POST /api/v1/request/{id}/retry` |
| `status` 2 PENDING or 3 PROCESSING | "Requested" (amber, disabled) |
| `status` 5 AVAILABLE | "In Plex" (green, disabled) |
| `status` 4 PARTIALLY_AVAILABLE, movie | "In Plex" (green, disabled) |
| `status` 4 PARTIALLY_AVAILABLE, TV | "Request in Seerr" (active); panel shows gaps |
| absent, 1 UNKNOWN, or 6 DELETED | "Request in Seerr" (active) |

The FAILED row must precede the PENDING/PROCESSING row. A failed request leaves
media status at PENDING or PROCESSING, so checking media status first would
render a permanently disabled "Requested" badge with no path to recovery.

`is4k` state reads `status4k` on the same object, so the 4K checkbox reflects
real 4K availability rather than assuming it matches non-4K.

Selecting 4K **re-populates** the profile dropdown from the `is4k: true` server,
which has its own profile list. It does not filter the existing list.

## List-page flow

```
page load → adapter.list.cards(doc) → [{el, query}, …]
          → IntersectionObserver on each el
card enters viewport
          → cache hit?  render dot, 0 calls
          → cache miss? enqueue lookup (max 4 concurrent)
                        → GET /api/v1/search?query=…
                        → write cache, render dot
```

Eager lookup of all cards is rejected: a 50-result IMDb page would fire 50
parallel calls for cards that may never be scrolled to.

**Dots render only for in-Plex, requested, and failed.** Absence of a dot means
not in library. A neutral dot on all 50 cards would be visual noise and doubles
the DOM work for no information.

### Cache

Required by list pages, not an optimization.

- Backing store: GM storage (not page-readable)
- Key: the query string (`imdb:tt0111161`)
- Value: `{ tmdbId, mediaType, status, status4k, ts }`
- TTL: 1 hour
- Bound: LRU, ~500 entries, so it cannot grow without limit
- **Invalidated for an item the instant a request succeeds**, so a dot never
  contradicts an action just taken

### Profile cache

Separate, longer-lived. Populated on settings save from the four `service`
endpoints; 7-day TTL plus a manual refresh button in settings. Keeps detail page
loads at exactly one API call and caret opens at zero.

## Config

`GM_registerMenuCommand('Seerr settings')` opens an overlay: Seerr URL, API key
(password field), request-as user ID, a profile-refresh button, and a "Test
connection" button hitting `/api/v1/status`.

Stored via `GM_setValue`, which is outside page-readable storage — a hostile or
ad-injected script on IMDb cannot read the key from `localStorage`.

With no config saved, the button renders "Set up Seerr" and opens the panel
rather than erroring.

## Mounting

All four sites are SPAs that swap content without a page load, so a one-shot
`DOMContentLoaded` mount stops working after the first in-site navigation.

A single `MutationObserver` on `document.body`, debounced ~200 ms, re-checks
whether the current URL still matches an adapter and whether the button is still
present. Buttons carry a `data-seerr-id` attribute, making remount idempotent —
no duplicates.

## Error handling

Every failure path resolves to a visible button state or a toast. No silent
no-ops, and no exception ever escapes into the host page.

| Failure | Handling |
|---|---|
| Network error / timeout | "Seerr offline" button; toast on click |
| 401 / 403 | Toast "Check API key" linking to settings |
| **202** | Toast "No seasons available to request" — **not** treated as success |
| 409 duplicate | Button flips to "Requested" — the correct end state anyway |
| 500 | Toast with the server's message |
| Adapter throw | Console log with adapter name; no button; other sites unaffected |
| Zero search results | "Not on TMDb" (disabled) |

## Testing

Pure functions get a `module.exports` guard at the end of the file. Tampermonkey
ignores it; `node --test` can require the file directly. No build step, no
dependencies.

Unit-tested pure functions:

- each adapter's `extract` and `cards`, against saved HTML fixtures per site
- the status → button-state mapper, across every enum combination, explicitly
  including a FAILED request sitting on PROCESSING media
- season defaulting (which boxes are checked and which are disabled given
  per-season availability)
- cache TTL, LRU eviction, and invalidation-on-request

Verified manually against the live instance via a checklist: DOM mounting per
site, SPA re-navigation, the API client, and dot rendering on a long list page.

## Known risks

1. **Letterboxd list dots may not be feasible.** Contingent on whether poster
   cards expose a TMDb ID. If they don't, Letterboxd ships detail-page only.
2. **List card selectors are the most breakage-prone code here.** Detail pages
   are anchored to stable URL structure; grid markup is not. Adapter isolation
   contains the blast radius to one site.
3. **`@connect *` is broader than ideal.** Unavoidable while the Seerr URL is
   user-configured. Stated in the settings panel.
4. **Admin API key is high-privilege.** It can approve, decline, and delete. The
   script only ever reads and creates requests, but the key itself is not
   scoped — Seerr has no scoped-token concept.
