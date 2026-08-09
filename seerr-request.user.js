// ==UserScript==
// @name         Seerr Request
// @namespace    taznc.seerr
// @version      1.0.0
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

  // Ordered condition chain; first match wins. The FAILED-request check MUST
  // precede the PENDING/PROCESSING check: a failed request leaves media status
  // at 2/3, and checking media status first would render a permanently
  // disabled "Requested" badge with no path to recovery.
  function buttonState(lookup) {
    if (!lookup.configured) return { state: 'setup', label: 'Set up Seerr', active: true };
    if (lookup.error) return { state: 'offline', label: 'Seerr offline', active: false };
    if (lookup.loading) return { state: 'checking', label: 'Checking…', active: false };
    const r = lookup.result;
    if (!r) return { state: 'notfound', label: 'Not on TMDb', active: false };
    const mi = r.mediaInfo;
    const failed = (mi && mi.requests ? mi.requests : []).find((q) => q.status === 4 && !q.is4k);
    if (failed) return { state: 'retry', label: 'Retry request', active: true, requestId: failed.id };
    const st = mi ? mi.status : undefined;
    if (st === 2 || st === 3) return { state: 'requested', label: 'Requested', active: false };
    if (st === 5) return { state: 'available', label: 'In Plex', active: false };
    if (st === 4) {
      return r.mediaType === 'tv'
        ? { state: 'request', label: 'Request in Seerr', active: true }
        : { state: 'available', label: 'In Plex', active: false };
    }
    return { state: 'request', label: 'Request in Seerr', active: true };
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

  // List-badge state from a cache entry. Requestable items get an actionable
  // 'request' badge (one-click from the list); failed gets 'retry-able'.
  function dotStateFor(entry) {
    if (entry.failedId) return 'failed';
    if (entry.status === 5) return 'available';
    if (entry.status === 4) return entry.mediaType === 'tv' ? 'request' : 'available';
    if (entry.status === 2 || entry.status === 3) return 'requested';
    return 'request';
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
        // A FAILED request hides behind media status 2/3; only then is a
        // second call needed to see requests[].
        const st = r.mediaInfo && r.mediaInfo.status;
        if (st === 2 || st === 3) {
          try {
            const d = await details(r.mediaType, r.id);
            if (d && d.mediaInfo) r.mediaInfo = d.mediaInfo;
          } catch (e) {
            // Status stays "requested" — strictly less wrong than failing the lookup.
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
          payload.userId = Number(cfg.userId);
        }
        return call('POST', '/api/v1/request', payload);
      },

      retry(requestId) {
        return call('POST', '/api/v1/request/' + requestId + '/retry');
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
        match: /^https:\/\/(www\.)?imdb\.com\/(search|chart|list|india|what-to-watch|user\/[^/]+\/(watchlist|ratings|lists))/,
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
          const seen = new Set();
          const out = [];
          for (const a of doc.querySelectorAll('a[href*="/movie/"], a[href*="/tv/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/(movie|tv)\/(\d+)/);
            if (!m) continue;
            const key = m[1] + ':' + m[2];
            if (seen.has(key)) continue;
            const el = a.closest('.card, .item, li');
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
      detail: {
        match: /^https:\/\/trakt\.tv\/(movies|shows)\/[^/]+/,
        extract(url, doc) {
          const seg = url.match(/trakt\.tv\/(movies|shows)\//);
          if (!seg) return null;
          const link = doc.querySelector('a[href*="themoviedb.org/"]');
          const m = link && (link.href || link.getAttribute('href') || '').match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/);
          if (!m) return null; // no TMDb link on page, no button
          return { query: 'tmdb:' + m[1], mediaType: seg[1] === 'movies' ? 'movie' : 'tv' };
        },
        anchor(doc) {
          return doc.querySelector('.action-buttons') || doc.querySelector('h1');
        },
      },
      list: {
        match: /^https:\/\/trakt\.tv\/(users\/[^/]+\/(watchlist|lists)|movies|shows)\/?/,
        cards(doc) {
          const out = [];
          for (const el of doc.querySelectorAll('[data-tmdb-id][data-type]')) {
            const id = el.getAttribute('data-tmdb-id');
            const type = el.getAttribute('data-type');
            if (!id || (type !== 'movie' && type !== 'show')) continue;
            out.push({ el, query: 'tmdb:' + id, mediaType: type === 'show' ? 'tv' : 'movie' });
          }
          return out;
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

  const statusCache = makeCache({
    load: () => GM_getValue('seerr_cache', null),
    save: (d) => GM_setValue('seerr_cache', d),
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

  const sel = (options, value) => {
    const s = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.id);
      opt.textContent = o.name;
      s.appendChild(opt);
    }
    if (value !== undefined) s.value = String(value);
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
    const first = servers[0];
    return {
      available: servers.length > 0,
      server: sel(
        servers.length
          ? servers.map((s) => ({ id: s.server.id, name: s.server.name }))
          : [{ id: '', name: is4k ? 'No 4K server' : 'No server' }]
      ),
      profile: sel([auto, ...((first && first.profiles) || [])], ''),
      root: sel([{ id: '', name: 'Seerr default' }, ...((first && first.rootFolders) || []).map((f) => ({ id: f.path, name: f.path }))], ''),
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
      k4Label.append(k4, document.createTextNode('Request in 4K'));
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
        if (controls.profile.value && controls.server.value !== '') body.serverId = Number(controls.server.value);
        if (controls.root.value) body.rootFolder = controls.root.value;
        if (userInput.value) body.userId = Number(userInput.value);
        try {
          await client().request(body);
          closePanel();
          ctx.onDone(body);
        } catch (e) {
          goBtn.disabled = false;
          if (e.kind === 'duplicate') {
            closePanel();
            ctx.onDone(body, true);
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

  function cacheEntryFrom(result) {
    const mi = result.mediaInfo || {};
    const failed = (mi.requests || []).find((q) => q.status === 4 && !q.is4k);
    return {
      tmdbId: result.id,
      mediaType: result.mediaType,
      status: mi.status || 1,
      status4k: mi.status4k || 1,
      failedId: failed ? failed.id : null,
    };
  }

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

    const anchorEl = adapter.detail.anchor(document);
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

    const handlers = {
      async primary(state) {
        if (state.state === 'setup') return showSettings();
        if (state.state === 'retry') {
          try {
            await client().retry(state.requestId);
            statusCache.invalidate(key);
            toast('Retry sent');
            rerender({ configured: true, result: { ...result, mediaInfo: { status: 3 } } });
          } catch (e) {
            toastError(e);
          }
          return;
        }
        if (state.state !== 'request' || !result) return;
        if (result.mediaType === 'movie') {
          try {
            await client().request({ mediaType: 'movie', mediaId: result.id });
            statusCache.invalidate(key);
            toast('Requested ' + (result.title || 'movie'));
            rerender({ configured: true, result: { ...result, mediaInfo: { status: 2 } } });
          } catch (e) {
            if (e.kind === 'duplicate') {
              rerender({ configured: true, result: { ...result, mediaInfo: { status: 2 } } });
            } else {
              toastError(e);
            }
          }
        } else {
          // TV: seasons are a real decision — open the panel.
          openTvPanel(host.getBoundingClientRect());
        }
      },
      options(state, rect) {
        if (result.mediaType === 'tv') openTvPanel(rect);
        else showRequestPanel({ rect, result, tvDetails: null, onDone: done });
      },
    };

    const done = (body, wasDuplicate) => {
      statusCache.invalidate(key);
      if (!wasDuplicate) {
        toast(
          body.seasons
            ? 'Requested ' + body.seasons.length + ' season' + (body.seasons.length === 1 ? '' : 's')
            : 'Requested'
        );
      }
      rerender({ configured: true, result: { ...result, mediaInfo: { status: 2 } } });
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
    requested: { bg: '#d97706', label: 'Requested', click: false },
    failed:    { bg: '#dc2626', label: 'Retry', click: true },
    request:   { bg: '#2563eb', label: 'Request', click: true },
    busy:      { bg: '#6b7280', label: 'Requesting…', click: false },
  };
  const seenCards = new WeakSet();
  const lookupQueue = [];
  let inFlight = 0;
  const MAX_CONCURRENT = 4;

  function paintBadge(badge, state) {
    const s = BADGE_STYLES[state];
    badge.__state = state;
    badge.textContent = s.label;
    badge.style.background = s.bg;
    badge.style.pointerEvents = s.click ? 'auto' : 'none';
    badge.style.cursor = s.click ? 'pointer' : 'default';
    badge.title = s.click ? 'Click to ' + s.label.toLowerCase() + ' in Seerr' : s.label;
  }

  // One-click request straight from the list badge: movies fire immediately,
  // TV auto-requests all missing seasons (the season panel's default). The
  // detail page remains the place for season/profile fine-tuning.
  async function badgeAction(badge) {
    const prev = badge.__state;
    if (prev !== 'request' && prev !== 'failed') return;
    const entry = badge.__entry;
    paintBadge(badge, 'busy');
    const markRequested = () => {
      const updated = { ...entry, status: 2, failedId: null };
      statusCache.set(badge.__query, updated);
      badge.__entry = updated;
      paintBadge(badge, 'requested');
    };
    try {
      if (prev === 'failed') {
        await client().retry(entry.failedId);
        markRequested();
        toast('Retry sent');
      } else if (entry.mediaType === 'tv') {
        const tv = await client().details('tv', entry.tmdbId);
        const seasons = seasonDefaults(tv).filter((s) => s.checked).map((s) => s.n);
        if (!seasons.length) throw clientError('noseasons');
        await client().request({ mediaType: 'tv', mediaId: entry.tmdbId, seasons });
        markRequested();
        toast('Requested ' + seasons.length + ' season' + (seasons.length === 1 ? '' : 's'));
      } else {
        await client().request({ mediaType: 'movie', mediaId: entry.tmdbId });
        markRequested();
        toast('Requested');
      }
    } catch (e) {
      if (e.kind === 'duplicate') {
        markRequested();
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
      const cs = getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
      // Card containers are usually wrapped in the title link: stop the
      // badge click from also navigating to the title page.
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        badgeAction(badge);
      });
      el.appendChild(badge);
    }
    badge.__entry = entry;
    badge.__query = query;
    paintBadge(badge, dotStateFor(entry));
  }

  function pumpQueue() {
    while (inFlight < MAX_CONCURRENT && lookupQueue.length) {
      const { card } = { card: lookupQueue.shift() };
      inFlight++;
      client()
        .resolve(card.query, card.mediaType)
        .then((r) => {
          if (!r) return;
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
        const card = entry.target.__seerrCard;
        const cached = statusCache.get(card.query);
        if (cached) {
          renderDot(card.el, cached, card.query); // cache hit: zero calls
        } else {
          lookupQueue.push(card);
          pumpQueue();
        }
      }
    },
    { rootMargin: '100px' }
  );

  function listFlow(adapter) {
    if (!isConfigured(getCfg())) return;
    for (const card of safeCards(adapter, document)) {
      if (seenCards.has(card.el)) continue;
      seenCards.add(card.el);
      card.el.__seerrCard = card;
      cardObserver.observe(card.el);
    }
  }

  // --- route ---------------------------------------------------------

  // Test seam: a local harness page can simulate a site URL without
  // Tampermonkey. Never set on real sites.
  const hrefNow = () => window.__seerrHrefOverride || location.href;

  function route(force) {
    if (force) currentDetailKey = null;
    const href = hrefNow();
    for (const adapter of adapters) {
      if (adapter.detail && adapter.detail.match.test(href)) {
        detailFlow(adapter);
        return; // detail pages don't get list dots
      }
    }
    for (const adapter of adapters) {
      if (adapter.list && adapter.list.match.test(href)) {
        listFlow(adapter);
        return;
      }
    }
    currentDetailKey = null;
  }

  function boot() {
    GM_registerMenuCommand('Seerr settings', showSettings);
    // All four sites are SPAs: a one-shot mount dies on the first in-site
    // navigation. Observe, debounce, re-route; mounting is idempotent.
    new MutationObserver(debounce(() => route(false), 200)).observe(document.body, {
      childList: true,
      subtree: true,
    });
    route(false);
  }

  boot();
})();
