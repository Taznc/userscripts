# Seerr Request userscript

Request movies and TV shows in Overseerr/Jellyseerr directly from IMDb,
Letterboxd, TMDb, and Trakt — with library status on the button, a season
picker for TV, quality-profile overrides, and at-a-glance status dots on
list pages.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open `seerr-request.user.js` — drag it into the browser, or paste it into
   Tampermonkey → Create new script. No build step.
3. Visit any IMDb title page. The button says **Set up Seerr** — click it.
4. Enter:
   - **Seerr URL** — e.g. `https://seerr.example.com`
   - **API key** — Seerr → Settings → General → API Key
   - **Request as user ID** — optional; the Seerr user requests are
     attributed to (find it in the URL of the user's profile page).
     Without it, requests show as made by the API key's admin user.
5. **Test connection**, then **Save** (this also caches your Radarr/Sonarr
   quality profiles for the options panel; **Refresh profiles** re-fetches
   after you change them in Seerr).

Note on permissions: the script ships `@connect *` because your Seerr host
is configured at runtime, not known in advance. Tampermonkey will note this
on install.

## Use

- **Blue "Request in Seerr"** — one click requests a movie with your Seerr
  defaults (quality profile, root folder, anime routing all untouched).
  For TV it opens a season picker that pre-checks only what you're missing.
- **Caret (▾)** — options panel: server, quality profile, root folder,
  request-as user, 4K. "Seerr default (auto)" leaves routing to Seerr —
  recommended unless you have a reason, because an explicit profile
  overrides Seerr's anime-profile routing.
- **Green "In Plex" / amber "Requested"** — already handled; nothing to do.
- **Red "Retry request"** — a previous request failed in Radarr/Sonarr;
  click to retry it.
- **List pages** (IMDb search/charts/lists/what-to-watch, TMDb, Trakt) —
  labeled badges on covers: green **In Plex**, amber **Requested**, red
  **Retry**, blue **Request**. The blue and red ones are clickable: movies
  request in one click, TV auto-requests every season you're missing, red
  retries the failed request. Lookups start ~1200px ahead of your scroll
  position (max 8 in-flight, on-screen cards first) and cache for an hour.
- IMDb **episode** pages request the parent series.

Letterboxd gets the button on film pages only — its poster grids don't
expose a TMDb ID, and this script never guesses by title.

## Development

```
node --test 'test/*.test.js'        # 42 unit tests, no dependencies
python3 -m http.server 8123         # then open harness/index.html?case=movie
```

The harness (`harness/`) simulates each site + a canned Seerr backend with
GM stubs; cases: `movie`, `tv`, `available`, `pending-failed`, `episode`,
`offline`, `unconfigured`, `list`.

Design and plan live in `docs/superpowers/`.

## Manual verification checklist (live instance)

- [ ] IMDb movie page: status renders, fast-path request lands in Seerr
- [ ] IMDb series page: season panel matches Seerr's own season availability
- [ ] IMDb episode page: button targets the parent series
- [ ] IMDb search page: dots appear as you scroll, none before
- [ ] SPA check: navigate IMDb home → title without a reload; button mounts
- [ ] Letterboxd film / TMDb tv / Trakt show: button mounts and resolves
- [ ] Caret: profiles listed match Radarr/Sonarr; 4K toggle swaps the lists
      (or shows "No 4K server" if you don't run one)
- [ ] Requested item shows amber in a fresh tab (cache invalidation)
- [ ] A failed request shows red Retry; retry flips Seerr to approved
