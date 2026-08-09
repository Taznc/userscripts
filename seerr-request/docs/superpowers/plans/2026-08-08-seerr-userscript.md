# Seerr Request Userscript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-file Tampermonkey userscript that shows Seerr library status and submits requests from IMDb, Letterboxd, TMDb, and Trakt detail pages, with status dots on list pages.

**Architecture:** One IIFE in `seerr-request.user.js` with five internal sections (config, seerr client, ui, adapters, boot). Pure logic (status mapper, season defaults, cache, adapter extractors) is exported through a `module.exports` guard so `node --test` can require the file directly; the boot section only runs under Tampermonkey. All UI renders inside a Shadow DOM host so site CSS cannot clobber it.

**Tech Stack:** Vanilla JS (ES2020), Tampermonkey GM_* APIs, `node:test` for unit tests. No dependencies, no build step.

## Global Constraints

- Single file deliverable: `seerr-request.user.js`. Tests in `test/`.
- No runtime or dev dependencies. Tests run with `node --test test/`.
- Never send `serverId`/`profileId`/`rootFolder` on the fast path (preserves Seerr anime routing). Always send configured `userId` when set.
- HTTP 202 from POST /request is a FAILURE ("no seasons available"), never success.
- FAILED request check precedes PENDING/PROCESSING in the status mapper.
- All queries to /api/v1/search use a prefix: `imdb:tt…` or `tmdb:…`.
- Fuzzy title matching is never used anywhere.
- Status cache: GM storage, 1h TTL, LRU cap 500, invalidate on successful request.
- List lookups: lazy via IntersectionObserver, max 8 concurrent (revised from 4 in the scroll-perf pass).
- Every failure path resolves to a button state or toast; no exception escapes into the host page.

## File Structure

```
seerr-request.user.js      the deliverable (all sections)
test/pure.test.js          buttonState, seasonDefaults, cache
test/adapters.test.js      extract/cards against stub-doc fixtures
docs/superpowers/specs/    (exists)
docs/superpowers/plans/    this file
README.md                  install + configure instructions
```

Test fixtures are lightweight stub objects mimicking each site's queried
selectors (no jsdom — the no-dependency rule forbids HTML parsing in tests).

---

### Task 1: Skeleton + export guard

**Files:** Create `seerr-request.user.js`, `test/pure.test.js`

**Produces:** a requireable module exporting `{ VERSION, buttonState, seasonDefaults, makeCache, adapters, pickResult }` (later tasks fill these in); Tampermonkey metadata block with `@match` for the four sites, `@grant` GM_xmlhttpRequest/GM_setValue/GM_getValue/GM_registerMenuCommand, `@connect *`, `@run-at document-idle`.

- [ ] Write failing smoke test: `require('../seerr-request.user.js')` exposes `VERSION` and does not throw (proves the boot guard works under node).
- [ ] Run `node --test test/` — FAIL (file missing).
- [ ] Write metadata block + IIFE with `const exported = {...}; if (typeof module !== 'undefined') { module.exports = exported; return; } boot();` and an empty `boot()`.
- [ ] Run `node --test test/` — PASS.
- [ ] `git commit -m "feat: userscript skeleton with node-requireable export guard"`

### Task 2: Status → button-state mapper

**Files:** Modify `seerr-request.user.js`, `test/pure.test.js`

**Produces:** `buttonState(lookup) -> { state, label, active, requestId? }` where `lookup = { configured, error, loading, result }` and `result = { mediaType, mediaInfo? }`, `mediaInfo = { status, status4k, requests?: [{id, status, is4k}] }`. States: `setup | offline | checking | notfound | retry | requested | available | request`.

- [ ] Write failing tests covering, in order: unconfigured → setup; error → offline; loading → checking; no result → notfound; requests[] containing `{status:4}` on media status 3 → **retry** with requestId (the trap case); status 2|3 → requested; status 5 → available; status 4 + movie → available; status 4 + tv → request; absent/1/6 → request.
- [ ] Run — FAIL. Implement `buttonState` as an ordered condition chain exactly matching the spec table. FAILED filter respects `is4k === false` for the non-4K button path.
- [ ] Run — PASS. Commit `"feat: status-to-button mapper with failed-request precedence"`.

### Task 3: Season defaulting

**Files:** Modify `seerr-request.user.js`, `test/pure.test.js`

**Produces:** `seasonDefaults(tvDetails) -> [{ n, checked, disabled, note }]` from `GET /api/v1/tv/{id}` shape `{ seasons: [{seasonNumber, episodeCount}], mediaInfo?: { seasons: [{seasonNumber, status}] } }`. Season 0 (specials) excluded. Per-season status 4|5 → disabled, note `'in Plex'`; 2|3 → disabled, note `'requested'`; else checked.

- [ ] Failing tests: mixed availability (spec's Breaking Bad case: S1–2 available, S3–5 requestable), all-available → all disabled, no mediaInfo → all checked, specials skipped, zero-episode seasons skipped.
- [ ] Implement; run; commit `"feat: season defaulting from per-season availability"`.

### Task 4: Status cache

**Files:** Modify `seerr-request.user.js`, `test/pure.test.js`

**Produces:** `makeCache({ load, save, now, ttlMs=3600e3, cap=500 })` → `{ get(key), set(key, value), invalidate(key) }`. Storage shape: `{ order: [keys], items: { key: {v, ts} } }`. `get` returns undefined past TTL. `set` evicts LRU beyond cap. Browser boot wires `load/save` to `GM_getValue/GM_setValue('seerr_cache')`.

- [ ] Failing tests: set/get roundtrip; expiry via injected `now`; LRU eviction at cap 3 (test-sized); `get` refreshes recency; `invalidate` removes.
- [ ] Implement; run; commit `"feat: TTL+LRU status cache with injectable storage"`.

### Task 5: Adapters

**Files:** Modify `seerr-request.user.js`, create `test/adapters.test.js`

**Produces:** `adapters: [{ name, detail?: {match, extract(url, doc), anchor(doc)}, list?: {match, cards(doc)} }]` and `pickResult(results, mediaTypeHint)` (first result with `media_type` movie/tv, filtered by hint when given — needed because `tmdb:278` can return a movie *and* a tv hit for the same id).

Extract contracts:
- **imdb** detail `imdb\.com/title/(tt\d+)`: parse JSON-LD; if `@type === 'TVEpisode'`, take parent series tt from `partOfSeries.url`; → `{query:'imdb:tt…'}` (no hint — server decides type). List: anchors matching `/title/(tt\d+)` inside result/list/chart item containers, deduped by tt.
- **letterboxd** detail `letterboxd\.com/film/[^/]+`: `body[data-tmdb-id]` → `{query:'tmdb:N', mediaType:'movie'}`. List: only if poster cards expose `data-tmdb-id` (spec risk #1); otherwise omit `list`.
- **tmdb** detail `themoviedb\.org/(movie|tv)/(\d+)`: from URL → `{query:'tmdb:N', mediaType: seg}`.
- **trakt** detail `trakt\.tv/(movies|shows)/…`: TMDb link in external-links section `a[href*="themoviedb.org/"]` → `{query:'tmdb:N', mediaType: movies→movie, shows→tv}`.

- [ ] Failing tests using stub docs (`{ querySelector, querySelectorAll }` returning canned elements): each extract above including the IMDb episode→parent case and the tmdb movie/tv hint; `pickResult` skips `person` results and honors the hint; adapter throw containment (a stub doc that throws → caller receives null, no exception).
- [ ] Implement; run; commit `"feat: declarative site adapters for imdb/letterboxd/tmdb/trakt"`.

### Task 6: Seerr API client

**Files:** Modify `seerr-request.user.js`, `test/pure.test.js`

**Produces:** `makeClient({ cfg, transport })` → `{ resolve(query, hint), details(mediaType, tmdbId), request(body), retry(requestId), services(), testConnection() }`. `transport(method, url, body)` → `Promise<{status, json}>`; browser boot supplies a `GM_xmlhttpRequest` wrapper (10s timeout, JSON headers, `X-Api-Key`). Error contract: transport rejection → `{kind:'offline'}`; 401/403 → `{kind:'auth'}`; 202 → `{kind:'noseasons'}`; 409 → `{kind:'duplicate'}`; other non-2xx → `{kind:'server', message}`.

`resolve` = one GET `/api/v1/search?query=<encoded>` + `pickResult`; **if** result status is 2|3 it fetches `details()` once to obtain `requests[]` for the FAILED check (the only case needing a second call). `request()` strips undefined fields and never includes profileId/serverId/rootFolder unless explicitly passed; includes `userId` from cfg when set.

- [ ] Failing tests with a fake transport: resolve happy path (1 call); resolve pending → exactly 2 calls; 202 mapped to noseasons failure; 409 mapped to duplicate; fast-path body contains userId but no profileId; query is URI-encoded (`imdb%3Att0111161`).
- [ ] Implement; run; commit `"feat: seerr api client with injectable transport and 202-as-failure"`.

### Task 7: UI layer (shadow DOM)

**Files:** Modify `seerr-request.user.js`

**Produces:** `ui.mountButton(anchorEl, state, handlers)` (idempotent via `data-seerr-id` on the host), `ui.panel(opts)` (split-button caret panel: seasons for TV, server/profile/root/user/4K selects fed from the profile cache, profile default entry "Seerr default (auto)" with empty value, 4K toggle re-populates from is4k servers), `ui.toast(msg, kind)`, `ui.dot(cardEl, state)`, `ui.settings(cfg, actions)` overlay. All inside `host.attachShadow({mode:'closed'})`; palette matches the approved mockups (blue active, green available, amber requested, red offline/retry).

No unit tests — DOM-only; covered by the Task 10 manual checklist.

- [ ] Implement button + toast; verify by loading a static test page in the browser preview.
- [ ] Implement panel (seasons + options) and settings overlay with Test-connection and Refresh-profiles buttons.
- [ ] Commit `"feat: shadow-dom ui: split button, options panel, toasts, dots, settings"`.

### Task 8: Config + profile cache

**Files:** Modify `seerr-request.user.js`

**Produces:** `getCfg()/setCfg()` over `GM_getValue('seerr_cfg')` `{url, key, userId}`; `refreshProfiles(client)` fetching `/service/radarr`, `/service/radarr/{id}`, `/service/sonarr`, `/service/sonarr/{id}` for every server, stored as `{radarr:[…], sonarr:[…], ts}` with 7-day TTL; `GM_registerMenuCommand('Seerr settings', …)`. Unconfigured state renders the "Set up Seerr" button (buttonState already handles it).

- [ ] Implement; wire settings save → refreshProfiles; commit `"feat: gm-backed config and 7-day profile cache"`.

### Task 9: Boot wiring

**Files:** Modify `seerr-request.user.js`

**Produces:** `boot()` — MutationObserver on `document.body` debounced 200 ms → `route()`: match detail adapter → extract → cached/`resolve` → `buttonState` → mount; match list adapter → `cards()` → IntersectionObserver → queue (max 4 in flight) → cache → dots (only for available/requested/failed states). Click handlers: fast path POST (movie) / season panel (TV); caret → options panel; retry → `retry(id)`; every success invalidates the cache key, flips the button, toasts. Adapter throws are try/caught per the containment contract.

- [ ] Implement route() + detail flow; implement list flow with the queue; commit `"feat: spa-aware boot, detail flow, lazy list dots"`.

### Task 10: Manual verification + README

**Files:** Create `README.md`

- [ ] Run full `node --test test/` — all green.
- [ ] README: install (drag into Tampermonkey), configure (URL, API key from Seerr Settings → General, user id), the `@connect *` tradeoff note, and the manual checklist: IMDb movie / IMDb series / IMDb episode → parent / Letterboxd film / TMDb tv / Trakt show; SPA navigation on IMDb; list dots on an IMDb search page; 4K server re-population; failed-request retry.
- [ ] Commit `"docs: readme with install and manual verification checklist"`.

## Self-Review

- Spec coverage: resolve prefixes (T5/T6), status table incl. FAILED precedence (T2), 202 handling (T6), anime-routing fast path (T6/T9), userId attribution (T6), seasons (T3), 4K re-population (T7), cache TTL/LRU/invalidation (T4/T9), lazy list lookups + concurrency (T9), settings + profile cache (T8), episode→parent (T5), containment (T5/T9), no-fuzzy rule (T5), mounting idempotence (T7/T9). Non-goals untouched.
- Placeholders: none — every task names exact functions, shapes, and test cases.
- Type consistency: `buttonState` states consumed by T7/T9 match T2's enum; `makeCache` API in T9 matches T4; client error kinds in T9 toasts match T6.
