// ==UserScript==
// @name         Seerr Request
// @namespace    taznc.seerr
// @version      1.1.0
// @description  Show Overseerr/Jellyseerr library status and request movies & TV from IMDb, Letterboxd, TMDb, and Trakt.
// @author       joshashworth
// @match        https://imdb.com/*
// @match        https://*.imdb.com/*
// @match        https://letterboxd.com/*
// @match        https://themoviedb.org/*
// @match        https://*.themoviedb.org/*
// @match        https://trakt.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-request/seerr-request.user.js
// @downloadURL  https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-request/seerr-request.user.js
// @supportURL   https://github.com/Taznc/userscripts/issues
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';

  // ------------------------------------------------------------------
  // Pure core — everything in this section is exported for node --test
  // and must stay free of GM_*/DOM globals.
  // ------------------------------------------------------------------

  // MediaStatus: 1 UNKNOWN 2 PENDING 3 PROCESSING 4 PARTIAL 5 AVAILABLE 6 DELETED
  // MediaRequestStatus: 1 PENDING 2 APPROVED 3 DECLINED 4 FAILED 5 COMPLETED

  // The two request-shape predicates the whole script keys off. Centralized
  // because "!q.is4k && open status" is exactly the invariant that drifts
  // when written out four times.
  const findFailedRequest = (mi) =>
    ((mi && mi.requests) || []).find((q) => q.status === 4 && !q.is4k) || null;
  const findOpenRequest = (mi) =>
    ((mi && mi.requests) || []).find((q) => !q.is4k && (q.status === 1 || q.status === 2)) || null;

  // Ordered condition chain; first match wins. The FAILED-request check MUST
  // precede the PENDING/PROCESSING check: a failed request leaves media status
  // at 2/3, and checking media status first would render a permanently
  // disabled "Requested" badge with no path to recovery.
  function buttonState(lookup) {
    if (!lookup.configured) return { state: 'setup', label: 'Set up Seerr', active: true };
    // Offline is active: clicking re-runs the lookup instead of stranding
    // the page in a dead state until navigation.
    if (lookup.error) return { state: 'offline', label: 'Seerr offline — retry', active: true };
    if (lookup.loading) return { state: 'checking', label: 'Checking…', active: false };
    const r = lookup.result;
    if (!r) return { state: 'notfound', label: 'Not on TMDb', active: false };
    const mi = r.mediaInfo;
    const failed = findFailedRequest(mi);
    if (failed) return { state: 'retry', label: 'Retry request', active: true, requestId: failed.id };
    const st = mi ? mi.status : undefined;
    if (st === 2 || st === 3) {
      // A known open (pending/approved, non-4K) request id makes the amber
      // state an undo button: click cancels via DELETE /request/{id}.
      const open = findOpenRequest(mi);
      return open
        ? { state: 'requested', label: 'Requested', active: true, cancelId: open.id }
        : { state: 'requested', label: 'Requested', active: false };
    }
    if (st === 5) return { state: 'available', label: 'In Plex', active: false };
    const requestLabel =
      r.mediaType === 'tv' ? 'Request show' : r.mediaType === 'movie' ? 'Request movie' : 'Request in Seerr';
    if (st === 4) {
      if (r.mediaType !== 'tv') return { state: 'available', label: 'In Plex', active: false };
      if (r.seasonsExhausted) {
        // Nothing left to request: the truthful states are "Requested"
        // (cancellable when the open request id is known) or "In Plex".
        const open = findOpenRequest(mi);
        return open
          ? { state: 'requested', label: 'Requested', active: true, cancelId: open.id }
          : { state: 'available', label: 'In Plex', active: false };
      }
      return { state: 'request', label: requestLabel, active: true };
    }
    return { state: 'request', label: requestLabel, active: true };
  }

  // From GET /api/v1/tv/{id}: which season checkboxes are checked/disabled.
  // Season 0 (specials) and zero-episode seasons are excluded.
  function seasonDefaults(tv) {
    const perSeason = new Map(
      ((tv.mediaInfo && tv.mediaInfo.seasons) || []).map((s) => [s.seasonNumber, s.status])
    );
    return (tv.seasons || [])
      .filter((s) => s.seasonNumber > 0 && (s.episodeCount || 0) > 0)
      .map((s) => {
        const st = perSeason.get(s.seasonNumber);
        if (st === 4 || st === 5) return { n: s.seasonNumber, checked: false, disabled: true, note: 'in Plex' };
        if (st === 2 || st === 3) return { n: s.seasonNumber, checked: false, disabled: true, note: 'requested' };
        return { n: s.seasonNumber, checked: true, disabled: false, note: null };
      });
  }

  // TTL + LRU cache over injectable storage. Storage shape:
  // { order: [oldest…newest], items: { key: { v, ts } } }
  function makeCache({ load, save, now, ttlMs = 3600e3, cap = 500 }) {
    const read = () => load() || { order: [], items: {} };
    const touch = (d, key) => {
      d.order = d.order.filter((k) => k !== key);
      d.order.push(key);
    };
    return {
      get(key) {
        const d = read();
        const e = d.items[key];
        if (!e) return undefined;
        if (now() - e.ts > ttlMs) {
          delete d.items[key];
          d.order = d.order.filter((k) => k !== key);
          save(d);
          return undefined;
        }
        touch(d, key);
        save(d);
        return e.v;
      },
      set(key, v) {
        const d = read();
        touch(d, key);
        d.items[key] = { v, ts: now() };
        while (d.order.length > cap) {
          const evicted = d.order.shift();
          delete d.items[evicted];
        }
        save(d);
      },
      invalidate(key) {
        const d = read();
        delete d.items[key];
        d.order = d.order.filter((k) => k !== key);
        save(d);
      },
    };
  }

  // Flatten a resolve result into the small shape the status cache stores.
  // cancelId is the open (pending/approved, non-4K) request, if any — it is
  // what makes a "Requested" badge cancellable.
  function cacheEntryFrom(result) {
    const mi = result.mediaInfo || {};
    const failed = findFailedRequest(mi);
    const open = findOpenRequest(mi);
    return {
      tmdbId: result.id,
      mediaType: result.mediaType,
      status: mi.status || 1,
      status4k: mi.status4k || 1,
      failedId: failed ? failed.id : null,
      cancelId: open ? open.id : null,
      seasonsExhausted: Boolean(result.seasonsExhausted),
    };
  }

  // List-badge state from a cache entry. Requestable items get an actionable
  // 'request' badge (one-click from the list); failed gets 'retry-able'.
  function dotStateFor(entry) {
    if (entry.failedId) return 'failed';
    if (entry.status === 5) return 'available';
    if (entry.status === 4) {
      if (entry.mediaType !== 'tv') return 'available';
      if (entry.seasonsExhausted) return entry.cancelId ? 'requested' : 'available';
      return 'request';
    }
    if (entry.status === 2 || entry.status === 3) return 'requested';
    return 'request';
  }

  // Hide-owned toggle: which badge states disappear from list pages when
  // the user turns on hiding. Actionable states always stay visible.
  function shouldHideCard(state, hideOwned) {
    return Boolean(hideOwned) && (state === 'available' || state === 'requested');
  }

  // A mutation batch is "ours" only when every ADDED element is script UI.
  // Removals are asymmetric: a site framework stripping one of our nodes
  // (React reconciliation) must schedule a re-route, or the button stays
  // gone until an unrelated mutation. Site-node removals also re-route —
  // route is debounced, idle-scheduled, and idempotent, so that is cheap.
  function isOurMutation(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !n.hasAttribute('data-seerr-id')) return false;
      }
      for (const n of r.removedNodes) {
        if (n.nodeType === 1) return false;
      }
    }
    return true;
  }

  // First movie/tv result, honoring an optional media-type hint. The hint
  // matters for tmdb: queries — id 278 can be both a movie and a tv show.
  // Person results are always skipped. No fuzzy matching, ever.
  function pickResult(results, hint) {
    const media = (results || []).filter((r) => r.mediaType === 'movie' || r.mediaType === 'tv');
    if (hint) {
      const hit = media.find((r) => r.mediaType === hint);
      if (hit) return hit;
    }
    return media[0] || null;
  }

  const clientError = (kind, message) => Object.assign(new Error(message || kind), { kind });

  // Seerr API client. `transport(method, url, body) -> Promise<{status, json}>`
  // is injected: tests pass a fake; the browser passes a GM_xmlhttpRequest
  // wrapper. Error contract: offline | auth | noseasons | duplicate | server.
  function makeClient({ cfg, transport }) {
    const base = (cfg.url || '').replace(/\/+$/, '');

    async function call(method, path, body) {
      let resp;
      try {
        resp = await transport(method, base + path, body);
      } catch (e) {
        throw clientError('offline', e && e.message);
      }
      if (resp.status === 401 || resp.status === 403) throw clientError('auth');
      if (resp.status === 404) throw clientError('notfound');
      if (resp.status === 409) throw clientError('duplicate');
      // 202 = NoSeasonsAvailableError. In the 2xx range but NOTHING was
      // created — a naive 2xx check reports false success.
      if (resp.status === 202) throw clientError('noseasons', resp.json && resp.json.message);
      if (resp.status < 200 || resp.status >= 300) {
        throw clientError('server', (resp.json && resp.json.message) || 'HTTP ' + resp.status);
      }
      return resp.json;
    }

    const details = (mediaType, tmdbId) =>
      call('GET', '/api/v1/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + tmdbId);

    return {
      details,

      async resolve(query, hint) {
        const json = await call('GET', '/api/v1/search?query=' + encodeURIComponent(query));
        const r = pickResult(json && json.results, hint);
        if (!r) return null;
        // A FAILED request hides behind media status 2/3, and a partially-
        // available TV show may have every remaining season already
        // requested — both need the details call to tell the truth.
        const st = r.mediaInfo && r.mediaInfo.status;
        const needsDetails = st === 2 || st === 3 || (st === 4 && r.mediaType === 'tv');
        if (needsDetails) {
          try {
            const d = await details(r.mediaType, r.id);
            if (d && d.mediaInfo) r.mediaInfo = d.mediaInfo;
            if (r.mediaType === 'tv') {
              const defs = seasonDefaults(d);
              // Every aired season is in Plex or already requested: there is
              // nothing an active Request button could do.
              r.seasonsExhausted = defs.length > 0 && defs.every((s) => s.disabled);
            }
          } catch (e) {
            // Status stays as searched — strictly less wrong than failing the lookup.
          }
        }
        return r;
      },

      // Fast path sends NO serverId/profileId/rootFolder so Seerr's own
      // defaults and anime-profile routing apply. userId is attribution,
      // not routing — always sent when configured.
      request(body) {
        const payload = {};
        for (const [k, v] of Object.entries(body)) {
          if (v !== undefined && v !== null && v !== '') payload[k] = v;
        }
        if (payload.userId === undefined && cfg.userId != null && cfg.userId !== '') {
          const uid = Number(cfg.userId);
          // Garbage config would serialize NaN as null in the body.
          if (Number.isFinite(uid)) payload.userId = uid;
        }
        return call('POST', '/api/v1/request', payload);
      },

      retry(requestId) {
        return call('POST', '/api/v1/request/' + requestId + '/retry');
      },

      cancel(requestId) {
        return call('DELETE', '/api/v1/request/' + requestId); // 204 on success
      },

      async services() {
        const out = { radarr: [], sonarr: [], ts: Date.now() };
        for (const kind of ['radarr', 'sonarr']) {
          const servers = await call('GET', '/api/v1/service/' + kind);
          for (const s of servers || []) {
            try {
              out[kind].push(await call('GET', '/api/v1/service/' + kind + '/' + s.id));
            } catch (e) {
              out[kind].push({ server: s, profiles: [], rootFolders: [], unreachable: true });
            }
          }
        }
        return out;
      },

      testConnection() {
        return call('GET', '/api/v1/status');
      },
    };
  }

  // ------------------------------------------------------------------
  // Adapters — declarative, data-not-behavior. An adapter never calls the
  // API, never renders UI. extract returns { query, mediaType } or null;
  // cards returns [{ el, query }]. No ID => no button/dots => no fuzzy match.
  // ------------------------------------------------------------------

  const IMDB_TT = /\/title\/(tt\d+)/;

  const adapters = [
    {
      name: 'imdb',
      detail: {
        match: /^https:\/\/(www\.)?imdb\.com\/title\/tt\d+/,
        extract(url, doc) {
          const m = url.match(IMDB_TT);
          if (!m) return null;
          let tt = m[1];
          // Episode tt IDs resolve to zero results (tv_episode_results is
          // unmapped server-side) — swap in the parent series tt from JSON-LD.
          try {
            const ld = doc.querySelector('script[type="application/ld+json"]');
            if (ld) {
              const data = JSON.parse(ld.textContent);
              if (data && data['@type'] === 'TVEpisode') {
                const parent =
                  data.partOfSeries && data.partOfSeries.url && data.partOfSeries.url.match(IMDB_TT);
                if (parent) tt = parent[1];
              }
            }
          } catch (e) {
            // Malformed JSON-LD: the URL tt is still correct for non-episodes.
          }
          return { query: 'imdb:' + tt, mediaType: null };
        },
        anchor(doc) {
          return (
            doc.querySelector('h1[data-testid="hero__pageTitle"]') ||
            doc.querySelector('[data-testid="hero-title-block__title"]') ||
            doc.querySelector('h1')
          );
        },
      },
      list: {
        // Any IMDb page: homepage carousels, editorial lists, filmographies,
        // and the "More like this" shelf on title pages. The scanner only
        // acts on /title/tt anchors inside card containers, so pages with
        // none cost nothing. Title pages still get the detail button first.
        match: /^https:\/\/(www\.)?imdb\.com\//,
        cards(doc) {
          const seen = new Set();
          const out = [];
          for (const a of doc.querySelectorAll('a[href*="/title/tt"]')) {
            const m = (a.getAttribute('href') || '').match(IMDB_TT);
            if (!m || seen.has(m[1])) continue;
            const el = a.closest(
              '.ipc-metadata-list-summary-item, .ipc-poster-card, li.ipc-metadata-list-summary-item, .lister-item, li'
            );
            if (!el) continue;
            seen.add(m[1]);
            out.push({ el, query: 'imdb:' + m[1] });
          }
          return out;
        },
      },
    },
    {
      name: 'letterboxd',
      detail: {
        match: /^https:\/\/letterboxd\.com\/film\/[^/]+/,
        extract(url, doc) {
          const body = doc.body;
          const id = body && body.getAttribute && body.getAttribute('data-tmdb-id');
          if (!id) return null; // no ID, no button — never fuzzy-match
          const type = (body.getAttribute('data-tmdb-type') || 'movie') === 'tv' ? 'tv' : 'movie';
          return { query: 'tmdb:' + id, mediaType: type };
        },
        anchor(doc) {
          return doc.querySelector('.actions-panel') || doc.querySelector('h1');
        },
      },
      // Letterboxd poster grids do not expose a TMDb ID (spec risk #1):
      // detail pages only, no list dots.
    },
    {
      name: 'tmdb',
      detail: {
        match: /^https:\/\/(www\.)?themoviedb\.org\/(movie|tv)\/\d+/,
        extract(url) {
          const m = url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
          if (!m) return null;
          return { query: 'tmdb:' + m[2], mediaType: m[1] };
        },
        anchor(doc) {
          return doc.querySelector('.header .title h2') || doc.querySelector('h2') || doc.querySelector('h1');
        },
      },
      list: {
        match: /^https:\/\/(www\.)?themoviedb\.org\/(discover|search|movie(?!\/\d)|tv(?!\/\d))/,
        cards(doc) {
          // TMDb's current frontend is Tailwind utility classes with no
          // semantic .card/.item — confirmed live (Popular Movies grid):
          // .closest('.card, .item, li') matched 0 of 40 real cards. The
          // visual card is a few ancestors up, identifiable only by the
          // 'rounded-xl' + 'border' utility classes it always carries.
          const findCard = (a) => {
            let el = a;
            for (let i = 0; i < 6 && el; i++) {
              const c = el.className;
              if (typeof c === 'string' && c.includes('rounded-xl') && c.includes('border')) return el;
              el = el.parentElement;
            }
            return null;
          };
          const seen = new Set();
          const out = [];
          for (const a of doc.querySelectorAll('a[href*="/movie/"], a[href*="/tv/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/(movie|tv)\/(\d+)/);
            if (!m) continue;
            const key = m[1] + ':' + m[2];
            if (seen.has(key)) continue;
            const el = findCard(a);
            if (!el) continue;
            seen.add(key);
            out.push({ el, query: 'tmdb:' + m[2], mediaType: m[1] });
          }
          return out;
        },
      },
    },
    {
      name: 'trakt',
      // Trakt shipped a full SvelteKit rewrite (2026) that dropped the old
      // data-tmdb-id/themoviedb.org markup entirely — confirmed against
      // live DOM. Detail pages still surface a stable external id: the
      // IMDb rating badge in the summary header links to imdb.com/title/tt…
      // even before any "expand ratings" interaction. List/grid cards
      // (trending, watchlist, "Where to Watch") carry only an internal
      // slug link and NO external id of any kind — so, per the no-fuzzy-
      // matching rule, Trakt gets a detail-page button only.
      detail: {
        match: /^https:\/\/trakt\.tv\/(movies|shows)\/[^/]+/,
        extract(url, doc) {
          const seg = url.match(/trakt\.tv\/(movies|shows)\//);
          if (!seg) return null;
          const link = doc.querySelector('a[href*="imdb.com/title/tt"]');
          const m = link && (link.href || link.getAttribute('href') || '').match(/imdb\.com\/title\/(tt\d+)/);
          if (!m) return null; // no IMDb link on page, no button
          return { query: 'imdb:' + m[1], mediaType: seg[1] === 'movies' ? 'movie' : 'tv' };
        },
        anchor(doc) {
          return (
            doc.querySelector('[data-testid="summary-media-title"]') ||
            doc.querySelector('.trakt-summary-actions-bar') ||
            doc.querySelector('.action-buttons') ||
            doc.querySelector('h1')
          );
        },
      },
    },
  ];

  // A throw inside any adapter is contained: logged with the adapter name,
  // costs only that site its button. Other adapters are unaffected.
  function safeExtract(adapter, url, doc) {
    try {
      return adapter.detail ? adapter.detail.extract(url, doc) : null;
    } catch (e) {
      console.warn('[seerr] adapter "' + adapter.name + '" extract failed:', e);
      return null;
    }
  }

  function safeCards(adapter, doc) {
    try {
      return adapter.list ? adapter.list.cards(doc) : [];
    } catch (e) {
      console.warn('[seerr] adapter "' + adapter.name + '" cards failed:', e);
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Node test boundary. Under `node --test` we export the pure core and
  // stop; boot() only ever runs under a userscript manager.
  // ------------------------------------------------------------------
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      VERSION,
      buttonState,
      seasonDefaults,
      makeCache,
      makeClient,
      pickResult,
      dotStateFor,
      cacheEntryFrom,
      shouldHideCard,
      isOurMutation,
      findOpenRequest,
      findFailedRequest,
      adapters,
      safeExtract,
      safeCards,
    };
    return;
  }

  // ------------------------------------------------------------------
  // Config (GM storage — not page-readable)
  // ------------------------------------------------------------------

  const getCfg = () => GM_getValue('seerr_cfg', null) || { url: '', key: '', userId: '' };
  const setCfg = (c) => GM_setValue('seerr_cfg', c);
  const isConfigured = (c) => Boolean(c.url && c.key);

  const getProfiles = () => {
    const p = GM_getValue('seerr_profiles', null);
    if (!p || Date.now() - p.ts > 7 * 24 * 3600e3) return null; // 7-day TTL
    return p;
  };
  const setProfiles = (p) => GM_setValue('seerr_profiles', p);

  // The cache lives in memory and flushes to GM storage on a trailing
  // debounce: GM_setValue re-serializes the whole store, and doing that per
  // card made badges visibly slow on long lists.
  let cacheData = GM_getValue('seerr_cache', null);
  let cacheFlush = null;
  const statusCache = makeCache({
    load: () => cacheData,
    save: (d) => {
      cacheData = d;
      clearTimeout(cacheFlush);
      cacheFlush = setTimeout(() => GM_setValue('seerr_cache', cacheData), 1500);
    },
    now: () => Date.now(),
  });

  function gmTransport(cfg) {
    return (method, url, body) =>
      new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers: {
            'X-Api-Key': cfg.key,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          data: body ? JSON.stringify(body) : undefined,
          timeout: 10000,
          onload: (r) => {
            let json = null;
            try {
              json = JSON.parse(r.responseText);
            } catch (e) {
              /* non-JSON body */
            }
            resolve({ status: r.status, json });
          },
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        });
      });
  }

  const client = () => {
    const cfg = getCfg();
    return makeClient({ cfg, transport: gmTransport(cfg) });
  };

  // ------------------------------------------------------------------
  // UI — everything renders inside closed Shadow DOM so site CSS can't
  // clobber it and the host page can't reach in.
  // ------------------------------------------------------------------

  const PALETTE = {
    request:   { bg: '#2563eb', fg: '#ffffff', border: '#2563eb' },
    retry:     { bg: '#dc2626', fg: '#ffffff', border: '#dc2626' },
    setup:     { bg: '#2563eb', fg: '#ffffff', border: '#2563eb' },
    available: { bg: '#dcfce7', fg: '#166534', border: '#86efac' },
    requested: { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d' },
    offline:   { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },
    checking:  { bg: '#f3f4f6', fg: '#6b7280', border: '#d1d5db' },
    notfound:  { bg: '#f3f4f6', fg: '#6b7280', border: '#d1d5db' },
  };

  const BASE_CSS = `
    * { box-sizing: border-box; margin: 0; font-family: system-ui, -apple-system, sans-serif; }
    .btnwrap { display: inline-flex; align-items: stretch; border-radius: 8px; overflow: hidden; vertical-align: middle; }
    .btn, .caret { border: none; font-size: 13px; font-weight: 600; padding: 7px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .caret { padding: 7px 9px; border-left: 1px solid rgba(255,255,255,.3); }
    .btn:disabled, .caret:disabled { cursor: default; }
    .panel { position: fixed; z-index: 2147483647; width: 300px; background: #fff; color: #111827;
             border: 1px solid #d1d5db; border-radius: 12px; padding: 14px 16px;
             box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 13px; }
    .panel h3 { font-size: 15px; font-weight: 600; }
    .panel .sub { font-size: 12px; color: #6b7280; margin: 1px 0 10px; }
    .panel .sec { border-top: 1px solid #e5e7eb; margin-top: 10px; padding-top: 10px; }
    .panel label { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
    .panel label.dis { color: #9ca3af; }
    .panel .note { color: #16a34a; font-size: 12px; }
    .panel .fld { display: block; padding: 4px 0; }
    .panel .fld span { display: block; font-size: 12px; color: #6b7280; margin-bottom: 3px; }
    .panel select, .panel input[type=text], .panel input[type=password], .panel input[type=number] {
      width: 100%; font-size: 13px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #111827; }
    .panel .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .panel .go { background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; padding: 6px 14px; cursor: pointer; }
    .panel .ghost { background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; padding: 6px 12px; cursor: pointer; }
    .panel .err { color: #b91c1c; font-size: 12px; padding-top: 6px; }
    .panel .ok { color: #166534; font-size: 12px; padding-top: 6px; }
  `;

  function makeShadowHost(tag, id) {
    const host = document.createElement(tag);
    host.setAttribute('data-seerr-id', id);
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    root.appendChild(style);
    return { host, root };
  }

  // --- toast ---------------------------------------------------------

  let toastRoot = null;
  function toast(msg, kind) {
    if (!toastRoot || !toastRoot.host.isConnected) {
      toastRoot = makeShadowHost('div', 'toasts');
      Object.assign(toastRoot.host.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483647 });
      document.body.appendChild(toastRoot.host);
    }
    const t = document.createElement('div');
    const colors = kind === 'error' ? ['#fee2e2', '#991b1b', '#dc2626'] : ['#dcfce7', '#166534', '#16a34a'];
    t.style.cssText =
      'display:flex;align-items:center;gap:10px;margin-top:8px;padding:11px 14px;font-size:13px;' +
      'background:#fff;color:#111827;border:1px solid ' + colors[0] + ';border-left:3px solid ' + colors[2] + ';' +
      'box-shadow:0 4px 12px rgba(0,0,0,.12);max-width:340px;';
    t.textContent = msg;
    toastRoot.root.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function toastError(e) {
    const msgs = {
      offline: "Couldn't reach Seerr. Check the URL in settings",
      auth: 'Seerr rejected the API key. Check settings',
      noseasons: 'No seasons available to request',
      duplicate: 'Already requested',
      server: 'Seerr error: ' + (e.message || 'unknown'),
    };
    toast(msgs[e.kind] || msgs.server, 'error');
  }

  // --- panel scaffolding --------------------------------------------

  let openPanel = null;
  function closePanel() {
    if (openPanel) {
      openPanel.remove();
      openPanel = null;
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onEsc, true);
    }
  }
  function onDocClick(e) {
    if (openPanel && !e.composedPath().includes(openPanel.getRootNode().host)) closePanel();
  }
  function onEsc(e) {
    if (e.key === 'Escape') closePanel();
  }

  function showPanel(anchorRect, build) {
    closePanel();
    const { host, root } = makeShadowHost('div', 'panel');
    document.body.appendChild(host);
    const panel = document.createElement('div');
    panel.className = 'panel';
    root.appendChild(panel);
    build(panel);
    const top = Math.min(anchorRect.bottom + 8, window.innerHeight - panel.offsetHeight - 16);
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - 316);
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.left = left + 'px';
    openPanel = panel;
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    return panel;
  }

  const fld = (labelText, control) => {
    const wrap = document.createElement('label');
    wrap.className = 'fld';
    const span = document.createElement('span');
    span.textContent = labelText;
    wrap.append(span, control);
    return wrap;
  };

  const fillSel = (s, options, value) => {
    s.textContent = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.id);
      opt.textContent = o.name;
      s.appendChild(opt);
    }
    if (value !== undefined) s.value = String(value);
  };

  const sel = (options, value) => {
    const s = document.createElement('select');
    fillSel(s, options, value);
    return s;
  };

  // --- settings ------------------------------------------------------

  function showSettings() {
    const rect = { bottom: 80, left: window.innerWidth / 2 - 150 };
    showPanel(rect, (panel) => {
      const cfg = getCfg();
      const h = document.createElement('h3');
      h.textContent = 'Seerr settings';
      const sub = document.createElement('p');
      sub.className = 'sub';
      sub.textContent = 'Stored in Tampermonkey storage. @connect is *: the script may contact the host you enter here.';
      const url = document.createElement('input');
      url.type = 'text';
      url.placeholder = 'https://seerr.example.com';
      url.value = cfg.url;
      const key = document.createElement('input');
      key.type = 'password';
      key.placeholder = 'API key (Settings → General)';
      key.value = cfg.key;
      const user = document.createElement('input');
      user.type = 'number';
      user.placeholder = 'Request as user ID (optional)';
      user.value = cfg.userId;
      const status = document.createElement('div');

      const testBtn = document.createElement('button');
      testBtn.className = 'ghost';
      testBtn.textContent = 'Test connection';
      testBtn.onclick = async () => {
        status.className = 'sub';
        status.textContent = 'Testing…';
        try {
          const st = await makeClient({
            cfg: { url: url.value, key: key.value },
            transport: gmTransport({ key: key.value }),
          }).testConnection();
          status.className = 'ok';
          status.textContent = 'Connected — Seerr v' + ((st && st.version) || '?');
        } catch (e) {
          status.className = 'err';
          status.textContent = e.kind === 'auth' ? 'Rejected API key' : "Couldn't connect";
        }
      };

      const saveBtn = document.createElement('button');
      saveBtn.className = 'go';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = async () => {
        setCfg({ url: url.value.replace(/\/+$/, ''), key: key.value, userId: user.value });
        status.className = 'sub';
        status.textContent = 'Saved. Fetching profiles…';
        try {
          setProfiles(await client().services());
          status.className = 'ok';
          status.textContent = 'Saved — profiles cached';
        } catch (e) {
          status.className = 'err';
          status.textContent = 'Saved, but profile fetch failed';
        }
        route(true);
      };

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'ghost';
      refreshBtn.textContent = 'Refresh profiles';
      refreshBtn.onclick = async () => {
        status.className = 'sub';
        status.textContent = 'Refreshing…';
        try {
          setProfiles(await client().services());
          status.className = 'ok';
          status.textContent = 'Profiles refreshed';
        } catch (e) {
          status.className = 'err';
          status.textContent = 'Refresh failed';
        }
      };

      const row = document.createElement('div');
      row.className = 'row sec';
      row.append(testBtn, refreshBtn, saveBtn);
      panel.append(h, sub, fld('Seerr URL', url), fld('API key', key), fld('Request as user ID', user), row, status);
    });
  }

  // --- request options panel ----------------------------------------

  // Profile dropdowns default to "Seerr default (auto)" (empty value): an
  // explicit profileId would override Seerr's server-side anime routing.
  function profileControls(mediaType, is4k) {
    const cached = getProfiles();
    const kind = mediaType === 'tv' ? 'sonarr' : 'radarr';
    const servers = ((cached && cached[kind]) || []).filter(
      (s) => Boolean(s.server && s.server.is4k) === is4k && !s.unreachable
    );
    const auto = { id: '', name: 'Seerr default (auto)' };
    const server = sel(
      servers.length
        ? servers.map((s) => ({ id: s.server.id, name: s.server.name }))
        : [{ id: '', name: is4k ? 'No 4K server' : 'No server' }]
    );
    const profile = sel([]);
    const root = sel([]);
    const dflt = servers.find((s) => s.server.isDefault) || servers[0] || null;
    // Profile and root-folder lists always follow the SELECTED server —
    // showing server B with server A's profile ids would apply a profile id
    // against the wrong server.
    const fill = () => {
      const cur = servers.find((s) => String(s.server.id) === server.value) || dflt;
      fillSel(profile, [auto, ...((cur && cur.profiles) || [])], '');
      fillSel(
        root,
        [{ id: '', name: 'Seerr default' }, ...((cur && cur.rootFolders) || []).map((f) => ({ id: f.path, name: f.path }))],
        ''
      );
    };
    server.onchange = fill;
    if (dflt) server.value = String(dflt.server.id);
    fill();
    return {
      available: servers.length > 0,
      server,
      profile,
      root,
      defaultServerId: dflt ? dflt.server.id : null,
      servers,
    };
  }

  function showRequestPanel(ctx) {
    // ctx: { rect, result, tvDetails|null, onDone }
    showPanel(ctx.rect, (panel) => {
      const r = ctx.result;
      const h = document.createElement('h3');
      h.textContent = r.title || r.name || 'Request';
      const sub = document.createElement('p');
      sub.className = 'sub';
      sub.textContent = r.mediaType === 'tv' ? 'TV series' : 'Movie';

      let seasonBoxes = [];
      const seasonSec = document.createElement('div');
      if (ctx.tvDetails) {
        seasonSec.className = 'sec';
        const defaults = seasonDefaults(ctx.tvDetails);
        const master = document.createElement('input');
        master.type = 'checkbox';
        master.checked = true;
        const masterLabel = document.createElement('label');
        masterLabel.append(master, document.createTextNode('All remaining seasons'));
        seasonSec.appendChild(masterLabel);
        const inner = document.createElement('div');
        inner.style.paddingLeft = '22px';
        for (const s of defaults) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = s.checked;
          cb.disabled = s.disabled;
          cb.dataset.season = s.n;
          const lab = document.createElement('label');
          if (s.disabled) lab.className = 'dis';
          lab.append(cb, document.createTextNode('Season ' + s.n + ' '));
          if (s.note) {
            const note = document.createElement('span');
            note.className = 'note';
            note.textContent = '· ' + s.note;
            lab.appendChild(note);
          }
          inner.appendChild(lab);
          if (!s.disabled) seasonBoxes.push(cb);
        }
        seasonSec.appendChild(inner);
        const sync = () => {
          goBtn.textContent = 'Request ' + seasonBoxes.filter((b) => b.checked).length;
          goBtn.disabled = !seasonBoxes.some((b) => b.checked);
        };
        master.onchange = () => {
          seasonBoxes.forEach((b) => (b.checked = master.checked));
          sync();
        };
        seasonBoxes.forEach((b) => (b.onchange = sync));
        setTimeout(() => sync(), 0);
      }

      const optSec = document.createElement('div');
      optSec.className = 'sec';
      let is4k = false;
      let controls = profileControls(r.mediaType, is4k);
      const serverFld = fld('Server', controls.server);
      const profileFld = fld('Quality profile', controls.profile);
      const rootFld = fld('Root folder', controls.root);
      const userInput = document.createElement('input');
      userInput.type = 'number';
      userInput.value = getCfg().userId;
      optSec.append(serverFld, profileFld, rootFld, fld('Request as user ID', userInput));

      const footer = document.createElement('div');
      footer.className = 'row sec';
      const k4Label = document.createElement('label');
      const k4 = document.createElement('input');
      k4.type = 'checkbox';
      // status4k tells us the 4K library state — offering a 4K request for
      // a title already available/requested in 4K would just 409.
      const s4 = (r.mediaInfo && r.mediaInfo.status4k) || 1;
      const k4Note = s4 === 4 || s4 === 5 ? ' · already in Plex' : s4 === 2 || s4 === 3 ? ' · already requested' : '';
      if (k4Note) k4.disabled = true;
      k4Label.append(k4, document.createTextNode('Request in 4K' + k4Note));
      // 4K routes to a separate server with its own profiles: toggling
      // re-populates the selects, it does not filter them.
      k4.onchange = () => {
        is4k = k4.checked;
        controls = profileControls(r.mediaType, is4k);
        serverFld.replaceChild(controls.server, serverFld.lastChild);
        profileFld.replaceChild(controls.profile, profileFld.lastChild);
        rootFld.replaceChild(controls.root, rootFld.lastChild);
      };
      const goBtn = document.createElement('button');
      goBtn.className = 'go';
      goBtn.textContent = 'Request';
      goBtn.onclick = async () => {
        goBtn.disabled = true;
        const body = { mediaType: r.mediaType, mediaId: r.id, is4k };
        if (ctx.tvDetails) body.seasons = seasonBoxes.filter((b) => b.checked).map((b) => Number(b.dataset.season));
        if (controls.profile.value) body.profileId = Number(controls.profile.value);
        // A profile id is meaningless without its server, and an explicitly
        // chosen non-default server matters even with the auto profile —
        // dropping it silently routed the request to the default server.
        const sid = controls.server.value === '' ? null : Number(controls.server.value);
        if (sid !== null && (body.profileId !== undefined || sid !== controls.defaultServerId)) {
          body.serverId = sid;
        }
        if (controls.root.value) body.rootFolder = controls.root.value;
        if (userInput.value) body.userId = Number(userInput.value);
        try {
          const resp = await client().request(body);
          closePanel();
          ctx.onDone(body, false, resp);
        } catch (e) {
          goBtn.disabled = false;
          if (e.kind === 'duplicate') {
            closePanel();
            ctx.onDone(body, true, null);
          } else {
            toastError(e);
          }
        }
      };
      footer.append(k4Label, goBtn);

      panel.append(h, sub, seasonSec, optSec, footer);
    });
  }

  // --- button --------------------------------------------------------

  function renderButton(container, state, handlers) {
    container.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'btnwrap';
    const c = PALETTE[state.state] || PALETTE.checking;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = state.label;
    btn.disabled = !state.active;
    btn.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';';
    if (!state.active) btn.style.cssText += 'border:1px solid ' + c.border + ';';
    btn.onclick = () => handlers.primary(state);
    wrap.appendChild(btn);
    if (state.state === 'request') {
      const caret = document.createElement('button');
      caret.className = 'caret';
      caret.textContent = '▾';
      caret.setAttribute('aria-label', 'Request options');
      caret.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';';
      caret.onclick = (e) => {
        e.stopPropagation();
        handlers.options(state, caret.getBoundingClientRect());
      };
      wrap.appendChild(caret);
    }
    container.appendChild(wrap);
  }

  // ------------------------------------------------------------------
  // Boot — SPA-aware mounting, detail flow, lazy list dots
  // ------------------------------------------------------------------

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  let currentDetailKey = null;

  async function detailFlow(adapter) {
    const url = hrefNow();
    const extracted = safeExtract(adapter, url, document);
    if (!extracted) {
      currentDetailKey = null;
      return;
    }
    const key = extracted.query;
    const existing = document.querySelector('[data-seerr-id="btn"]');
    if (key === currentDetailKey && existing && existing.isConnected) return; // idempotent remount
    currentDetailKey = key;
    if (existing) existing.remove();

    // anchor() is adapter code like extract/cards: a redesign-induced throw
    // must cost only the inline placement, not escape into the page.
    let anchorEl = null;
    try {
      anchorEl = adapter.detail.anchor(document);
    } catch (e) {
      console.warn('[seerr] adapter "' + adapter.name + '" anchor failed:', e);
    }
    const { host, root } = makeShadowHost('span', 'btn');
    host.style.cssText = 'display:inline-block;margin:6px 8px 6px 0;vertical-align:middle;';
    const container = document.createElement('span');
    root.appendChild(container);
    if (anchorEl && anchorEl.parentElement) {
      anchorEl.insertAdjacentElement('afterend', host);
    } else {
      // Anchor drifted after a redesign: float instead of vanishing.
      Object.assign(host.style, { position: 'fixed', bottom: '16px', left: '16px', zIndex: 2147483647 });
      document.body.appendChild(host);
    }

    const cfg = getCfg();
    const rerender = (lookup) => renderButton(container, buttonState(lookup), handlers);
    let result = null;

    // Re-render as amber "Requested"; a known request id makes that state a
    // click-to-cancel button (buttonState adds cancelId from requests[]).
    const showRequested = (requestId) => {
      const requests = requestId ? [{ id: requestId, status: 1, is4k: false }] : [];
      rerender({ configured: true, result: { ...result, mediaInfo: { status: 2, requests } } });
    };

    let primaryBusy = false; // double-click on the button must not double-POST
    const handlers = {
      async primary(state) {
        if (primaryBusy) return;
        primaryBusy = true;
        try {
          await handlePrimary(state);
        } finally {
          primaryBusy = false;
        }
      },
      options(state, rect) {
        if (result.mediaType === 'tv') openTvPanel(rect);
        else showRequestPanel({ rect, result, tvDetails: null, onDone: done });
      },
    };

    async function handlePrimary(state) {
        if (state.state === 'setup') return showSettings();
        if (state.state === 'offline') {
          // Click-to-retry: re-run the whole lookup for this page.
          currentDetailKey = null;
          route(false);
          return;
        }
        if (state.state === 'retry') {
          try {
            await client().retry(state.requestId);
            statusCache.invalidate(key);
            toast('Retry sent');
            showRequested(state.requestId);
          } catch (e) {
            toastError(e);
          }
          return;
        }
        if (state.state === 'requested' && state.cancelId) {
          try {
            await client().cancel(state.cancelId);
            statusCache.invalidate(key);
            toast('Request canceled');
            rerender({ configured: true, result: { ...result, mediaInfo: { status: 1 } } });
          } catch (e) {
            if (e.kind === 'notfound') {
              // Already gone in Seerr: same end state as a successful cancel.
              statusCache.invalidate(key);
              rerender({ configured: true, result: { ...result, mediaInfo: { status: 1 } } });
            } else {
              toastError(e);
            }
          }
          return;
        }
        if (state.state !== 'request' || !result) return;
        if (result.mediaType === 'movie') {
          try {
            const resp = await client().request({ mediaType: 'movie', mediaId: result.id });
            statusCache.invalidate(key);
            toast('Requested ' + (result.title || 'movie'));
            showRequested(resp && resp.id);
          } catch (e) {
            if (e.kind === 'duplicate') {
              showRequested(null);
            } else {
              toastError(e);
            }
          }
        } else {
          // TV: seasons are a real decision — open the panel.
          openTvPanel(host.getBoundingClientRect());
        }
    }

    const done = (body, wasDuplicate, resp) => {
      statusCache.invalidate(key);
      if (!wasDuplicate) {
        toast(
          body.seasons
            ? 'Requested ' + body.seasons.length + ' season' + (body.seasons.length === 1 ? '' : 's')
            : 'Requested'
        );
      }
      showRequested(resp && resp.id);
    };

    async function openTvPanel(rect) {
      try {
        const tvDetails = await client().details('tv', result.id);
        showRequestPanel({ rect, result, tvDetails, onDone: done });
      } catch (e) {
        toastError(e);
      }
    }

    if (!isConfigured(cfg)) return rerender({ configured: false });
    rerender({ configured: true, loading: true });
    try {
      result = await client().resolve(key, extracted.mediaType || undefined);
      if (result) statusCache.set(key, cacheEntryFrom(result));
      rerender({ configured: true, result });
    } catch (e) {
      rerender({ configured: true, error: e });
    }
  }

  // --- list dots -----------------------------------------------------

  const BADGE_STYLES = {
    available: { bg: '#16a34a', label: 'In Plex', click: false },
    requested: { bg: '#d97706', label: 'Requested', click: false }, // clickable when cancelId known
    failed:    { bg: '#dc2626', label: 'Retry', click: true },
    request:   { bg: '#2563eb', label: 'Request', click: true },
    busy:      { bg: '#6b7280', label: '…', click: false },
  };
  // getComputedStyle forces a synchronous layout — doing it per card during
  // scroll is jank. Cards of the same class share positioning, so memoize
  // the "is it position:static?" answer by className.
  const positionMemo = new Map();
  function ensurePositioned(el) {
    const key = el.tagName + '|' + String(el.className);
    let isStatic = positionMemo.get(key);
    if (isStatic === undefined) {
      isStatic = getComputedStyle(el).position === 'static';
      positionMemo.set(key, isStatic);
    }
    if (isStatic) el.style.position = 'relative';
  }

  let hideOwned = Boolean(GM_getValue('seerr_hide_owned', false));

  // Show/hide one card per the current toggle. Original inline display is
  // preserved so unhiding restores exactly what the site had.
  function applyCardVisibility(badge) {
    const bs = badgeState.get(badge);
    const card = bs && bs.card;
    if (!card) return;
    if (shouldHideCard(bs.state, hideOwned)) {
      if (card.style.display !== 'none') {
        card.__seerrDisplay = card.style.display;
        card.style.display = 'none';
      }
    } else if (card.style.display === 'none' && '__seerrDisplay' in card) {
      card.style.display = card.__seerrDisplay;
    }
  }

  let hidePill = null;
  function updateHidePill() {
    if (!hidePill) return;
    hidePill.textContent = hideOwned ? 'Owned: hidden' : 'Owned: shown';
    hidePill.style.background = hideOwned ? '#2563eb' : '#374151';
  }

  function ensureHidePill() {
    if (hidePill && hidePill.getRootNode().host.isConnected) return;
    const { host, root } = makeShadowHost('div', 'hidepill');
    Object.assign(host.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483646 });
    hidePill = document.createElement('button');
    hidePill.style.cssText =
      'border:none;border-radius:999px;padding:6px 14px;font:600 12px/1.5 system-ui,-apple-system,sans-serif;' +
      'color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    hidePill.title = 'Toggle hiding items already in Plex or requested';
    hidePill.onclick = () => {
      hideOwned = !hideOwned;
      GM_setValue('seerr_hide_owned', hideOwned);
      updateHidePill();
      for (const badge of document.querySelectorAll('[data-seerr-id="dot"]')) applyCardVisibility(badge);
    };
    root.appendChild(hidePill);
    document.body.appendChild(host);
    updateHidePill();
  }

  function removeHidePill() {
    const host = document.querySelector('[data-seerr-id="hidepill"]');
    if (host) host.remove();
    hidePill = null;
  }

  const seenCards = new WeakSet();
  const lookupQueue = [];
  let inFlight = 0;
  const MAX_CONCURRENT = 8;

  // Badge state lives in a script-scoped WeakMap, not element expandos:
  // page scripts can reach the badge elements (they are page DOM), and a
  // writable __entry would let a hostile script redirect what a genuine
  // user click requests.
  const badgeState = new WeakMap(); // badge el -> { entry, query, card, state }
  const cardData = new WeakMap(); // card el -> { el, query, mediaType }

  function paintBadge(badge, state) {
    const s = BADGE_STYLES[state];
    const bs = badgeState.get(badge);
    if (!bs) return;
    // 'requested' is an undo button only when we know the request id.
    const clickable = state === 'requested' ? Boolean(bs.entry && bs.entry.cancelId) : s.click;
    bs.state = state;
    badge.textContent =
      state === 'request' && bs.entry
        ? bs.entry.mediaType === 'tv'
          ? 'Request show'
          : 'Request movie'
        : s.label;
    badge.style.background = s.bg;
    badge.style.pointerEvents = clickable ? 'auto' : 'none';
    badge.style.cursor = clickable ? 'pointer' : 'default';
    badge.title =
      state === 'requested' && clickable
        ? 'Requested — click to cancel'
        : clickable
          ? 'Click to ' + s.label.toLowerCase() + ' in Seerr'
          : s.label;
    applyCardVisibility(badge);
  }

  // One-click request straight from the list badge: movies fire immediately,
  // TV auto-requests all missing seasons (the season panel's default). A
  // second click on the resulting "Requested" badge cancels the request.
  async function badgeAction(badge) {
    const bs = badgeState.get(badge);
    if (!bs || !bs.entry) return;
    const prev = bs.state;
    if (prev !== 'request' && prev !== 'failed' && prev !== 'requested') return;
    const entry = bs.entry;
    // Guard the ids even though non-clickable states have pointer-events
    // off — a synthetic click must never reach cancel(null)/retry(null).
    if (prev === 'requested' && !entry.cancelId) return;
    if (prev === 'failed' && !entry.failedId) return;
    const paintEntry = (updated, state) => {
      statusCache.set(bs.query, updated);
      bs.entry = updated;
      paintBadge(badge, state);
    };
    const markRequested = (resp) =>
      paintEntry({ ...entry, status: 2, failedId: null, cancelId: resp && resp.id ? resp.id : null }, 'requested');
    const markCanceled = () => paintEntry({ ...entry, status: 1, failedId: null, cancelId: null }, 'request');
    paintBadge(badge, 'busy');
    badge.textContent = prev === 'requested' ? 'Canceling…' : 'Requesting…';
    try {
      if (prev === 'requested') {
        await client().cancel(entry.cancelId);
        markCanceled();
        toast('Request canceled');
      } else if (prev === 'failed') {
        const resp = await client().retry(entry.failedId);
        markRequested(resp);
        toast('Retry sent');
      } else if (entry.mediaType === 'tv') {
        const tv = await client().details('tv', entry.tmdbId);
        const seasons = seasonDefaults(tv).filter((s) => s.checked).map((s) => s.n);
        if (!seasons.length) throw clientError('noseasons');
        const resp = await client().request({ mediaType: 'tv', mediaId: entry.tmdbId, seasons });
        markRequested(resp);
        toast('Requested ' + seasons.length + ' season' + (seasons.length === 1 ? '' : 's'));
      } else {
        const resp = await client().request({ mediaType: 'movie', mediaId: entry.tmdbId });
        markRequested(resp);
        toast('Requested');
      }
    } catch (e) {
      if (e.kind === 'duplicate') {
        markRequested(null);
      } else if (e.kind === 'notfound' && prev === 'requested') {
        markCanceled(); // request already gone in Seerr: same end state
      } else if (e.kind === 'noseasons') {
        // Nothing requestable after all (stale cache): correct the badge.
        paintEntry({ ...entry, seasonsExhausted: true }, entry.cancelId ? 'requested' : 'available');
        toast('All seasons already in Plex or requested');
      } else {
        toastError(e);
        paintBadge(badge, prev); // restore so it stays actionable
      }
    }
  }

  function renderDot(el, entry, query) {
    let badge = el.querySelector(':scope > [data-seerr-id="dot"]');
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute('data-seerr-id', 'dot');
      badge.style.cssText =
        'position:absolute;top:6px;right:6px;z-index:10;display:inline-block;' +
        'padding:2px 8px;border-radius:999px;font:600 11px/1.5 system-ui,-apple-system,sans-serif;' +
        'color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;';
      ensurePositioned(el);
      // Card containers are usually wrapped in the title link: stop the
      // badge click from also navigating to the title page.
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Badges are page DOM: a script on the site can dispatch synthetic
        // clicks. Only real user input may spend the API key.
        if (!e.isTrusted) return;
        badgeAction(badge);
      });
      badgeState.set(badge, { entry: null, query: null, card: el, state: 'busy' });
      el.appendChild(badge);
    }
    let bs = badgeState.get(badge);
    if (!bs) {
      // Badge survived a framework re-parent that cloned it: re-adopt.
      bs = { entry: null, query: null, card: el, state: 'busy' };
      badgeState.set(badge, bs);
    }
    bs.entry = entry;
    bs.query = query;
    paintBadge(badge, dotStateFor(entry));
  }

  function pumpQueue() {
    while (inFlight < MAX_CONCURRENT && lookupQueue.length) {
      // LIFO: the most recently intersected card is the one on screen right
      // now — it should beat cards scrolled past seconds ago.
      const card = lookupQueue.pop();
      inFlight++;
      client()
        .resolve(card.query, card.mediaType)
        .then((r) => {
          if (!r) {
            // Cache the miss too: not-on-TMDb titles otherwise re-fire a
            // lookup on every viewport pass.
            statusCache.set(card.query, { notFound: true });
            return;
          }
          const entry = cacheEntryFrom(r);
          statusCache.set(card.query, entry);
          renderDot(card.el, entry, card.query);
        })
        .catch(() => {
          /* a dot is never worth a toast */
        })
        .finally(() => {
          inFlight--;
          pumpQueue();
        });
    }
  }

  const cardObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        cardObserver.unobserve(entry.target);
        const card = cardData.get(entry.target);
        if (!card) continue;
        const cached = statusCache.get(card.query);
        if (cached) {
          if (!cached.notFound) renderDot(card.el, cached, card.query); // cache hit: zero calls
        } else {
          lookupQueue.push(card);
          pumpQueue();
        }
      }
    },
    // Start lookups ~a screen and a half before a card scrolls into view,
    // so badges are usually already painted by the time you reach them.
    { rootMargin: '1200px 0px' }
  );

  function listFlow(adapter) {
    if (!isConfigured(getCfg())) return;
    ensureHidePill();
    for (const card of safeCards(adapter, document)) {
      if (card.query === currentDetailKey) continue; // don't badge the page itself
      if (seenCards.has(card.el)) continue;
      seenCards.add(card.el);
      cardData.set(card.el, card);
      cardObserver.observe(card.el);
    }
  }

  // --- route ---------------------------------------------------------

  // Test seam: the harness page simulates site URLs. Honored ONLY when no
  // userscript manager is present (the harness stubs GM_getValue but not
  // GM_info) — under Tampermonkey a hostile page setting this property
  // must not be able to redirect which title the script resolves.
  const hrefNow = () =>
    (typeof GM_info === 'undefined' && window.__seerrHrefOverride) || location.href;

  function route(force) {
    if (force) currentDetailKey = null;
    const href = hrefNow();
    // Detail and list flows are not exclusive: a title page gets its button
    // AND badges on its "More like this" shelf. detailFlow sets
    // currentDetailKey synchronously, which listFlow uses to skip the card
    // that refers to the page itself.
    let matchedDetail = false;
    for (const adapter of adapters) {
      if (adapter.detail && adapter.detail.match.test(href)) {
        detailFlow(adapter);
        matchedDetail = true;
        break;
      }
    }
    if (!matchedDetail) {
      currentDetailKey = null;
      // A button surviving navigation to a page with no detail adapter
      // would show the previous title's action.
      const stale = document.querySelector('[data-seerr-id="btn"]');
      if (stale) stale.remove();
    }
    let matchedList = false;
    for (const adapter of adapters) {
      if (adapter.list && adapter.list.match.test(href)) {
        listFlow(adapter);
        matchedList = true;
        break;
      }
    }
    if (!matchedList) removeHidePill();
  }

  // Chrome (and most browsers): run scans when the main thread is idle so
  // they never compete with scroll frames. Fallback keeps Safari working.
  const whenIdle =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
      : (fn) => setTimeout(fn, 50);

  function boot() {
    GM_registerMenuCommand('Seerr settings', showSettings);
    // All four sites are SPAs: a one-shot mount dies on the first in-site
    // navigation. Observe, debounce, re-route at idle; mounting is
    // idempotent, so an extra pass is always safe.
    const scheduleRoute = debounce(() => whenIdle(() => route(false)), 200);
    new MutationObserver((records) => {
      if (isOurMutation(records)) return;
      scheduleRoute();
    }).observe(document.body, { childList: true, subtree: true });
    route(false);
  }

  boot();
})();
