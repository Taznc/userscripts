// ==UserScript==
// @name         Seerr - Hide Requested/Available Toggle
// @namespace    taznc.seerr-hide-toggle
// @version      1.2.0
// @description  Toggle buttons to hide already-requested or already-available titles on Seerr's discover pages.
// @author       joshashworth
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-hide-toggle/seerr-hide-toggle.user.js
// @downloadURL  https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-hide-toggle/seerr-hide-toggle.user.js
// @supportURL   https://github.com/Taznc/userscripts/issues
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Pure core — exported for node --test, must stay free of GM_*/DOM
  // globals beyond querySelectorAll on the passed-in element.
  // ------------------------------------------------------------------

  // Seerr's StatusBadge (seerr-team/seerr, src/components/StatusBadge)
  // renders PROCESSING and PENDING as different badgeTypes — 'primary'
  // (indigo) vs 'warning' (yellow), confirmed against the project's actual
  // source. The original version of this script only matched indigo, so
  // newly-requested-but-not-yet-processing items were never hidden by
  // "Hide Requested". AVAILABLE and PARTIALLY_AVAILABLE both render green
  // ('success'), so "Hide Available" already covered both correctly.
  //
  // Matching is done by color-FAMILY prefix (e.g. 'bg-indigo') rather than
  // an exact class like 'bg-indigo-500/80', because the precise shade and
  // border color (seerr-team/seerr's Badge component uses border-*-500;
  // this script's original selectors expected border-*-400, suggesting a
  // fork/theme/version difference) can vary — a prefix match is a strict
  // superset of the old exact match, so this can only gain coverage, never
  // lose it. Matching is scoped to 'rounded-full' elements (Seerr's Badge
  // component always includes that class) to avoid false-matching an
  // unrelated colored element elsewhere in a card.
  const REQUESTED_COLORS = ['bg-indigo', 'bg-yellow']; // processing, pending
  const AVAILABLE_COLORS = ['bg-green']; // available, partially available

  function hasBadgeColor(card, colorPrefixes) {
    for (const badge of card.querySelectorAll('[class*="rounded-full"]')) {
      const cls = badge.className || '';
      if (colorPrefixes.some((p) => cls.includes(p))) return true;
    }
    return false;
  }

  const isRequested = (card) => hasBadgeColor(card, REQUESTED_COLORS);
  const isAvailable = (card) => hasBadgeColor(card, AVAILABLE_COLORS);

  function shouldHide(card, state) {
    return (state.hideRequested && isRequested(card)) || (state.hideAvailable && isAvailable(card));
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  // Tampermonkey's auto-update replaces the ENTIRE script file, metadata
  // included, on every version bump — confirmed against Tampermonkey's own
  // issue tracker (github.com/Tampermonkey/tampermonkey/issues/2405). A
  // hardcoded personal @match would silently revert to whatever ships in
  // this public repo on the next update, breaking the script with no
  // warning. So @match is intentionally '*://*/*' (matches everywhere) and
  // the actual target host is stored in GM storage instead, configured
  // once via the menu command below — update-proof by construction, since
  // nothing update-sensitive lives in the metadata block.
  const hostMatches = (configuredHost, hostname) => Boolean(configuredHost) && configuredHost === hostname;

  // The old selector (button[class*="bg-gray-800/80"]) matches Seerr's
  // generic default Button style, used by at least 6 unrelated components
  // (dropdowns, slideovers, GenreCard hover state, ...) — confirmed against
  // Seerr's own source. querySelector returns document order, so on some
  // pages this could silently grab the wrong button. The filter button is
  // specifically the one containing a FunnelIcon SVG *and* "filter" in its
  // own text (Seerr's own copy: "N Active Filter(s)") — combining shape and
  // text is meaningfully more specific than either alone, though it will
  // miss the filter button on a non-English Seerr locale (Seerr uses
  // react-intl; "filter" text won't match a translated label).
  function findFilterButton(doc) {
    for (const btn of doc.querySelectorAll('button')) {
      if (btn.querySelector('svg') && /filter/i.test(btn.textContent || '')) return btn;
    }
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isRequested, isAvailable, shouldHide, hasBadgeColor, debounce, hostMatches, findFilterButton };
    return;
  }

  // ------------------------------------------------------------------
  // Boot — DOM only, runs under a userscript manager
  // ------------------------------------------------------------------

  // Registered unconditionally (before the host check) so it's reachable
  // from Tampermonkey's menu on ANY page — including the first visit to
  // your Seerr instance, before it's configured.
  GM_registerMenuCommand('Set this site as my Seerr instance', () => {
    const current = GM_getValue('seerrHost', null);
    const next = window.prompt(
      "Enter this site's hostname to enable the hide-toggle buttons here (e.g. seerr.example.com):",
      current || location.hostname
    );
    if (next && next.trim()) {
      GM_setValue('seerrHost', next.trim());
      window.alert('Saved. Reload this page.');
    }
  });

  if (!hostMatches(GM_getValue('seerrHost', null), location.hostname)) {
    return; // not the configured Seerr host: do nothing further on this page
  }

  const state = {
    hideRequested: GM_getValue('hideRequested', false),
    hideAvailable: GM_getValue('hideAvailable', false),
  };

  function applyFilter() {
    // Vertical grid cards (discover pages)
    document.querySelectorAll('ul.cards-vertical > li').forEach((li) => {
      li.style.display = shouldHide(li, state) ? 'none' : '';
    });
    // Horizontal slider cards (home page)
    document.querySelectorAll('.inline-block.px-2.align-top').forEach((card) => {
      card.style.display = shouldHide(card, state) ? 'none' : '';
    });
  }

  function makeButton(id, label, key) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.style.cssText =
      'display:inline-flex;align-items:center;border:1px solid #4b5563;border-radius:6px;' +
      'padding:6px 12px;font-size:0.875rem;font-weight:500;cursor:pointer;white-space:nowrap;' +
      'transition:background 0.15s,color 0.15s;margin-left:8px;';

    function refresh() {
      const on = state[key];
      btn.style.background = on ? 'rgba(99,102,241,0.8)' : 'rgba(31,41,55,0.8)';
      btn.style.color = on ? '#fff' : '#d1d5db';
      btn.innerText = `${label}: ${on ? 'ON' : 'OFF'}`;
    }

    btn.addEventListener('click', () => {
      state[key] = !state[key];
      GM_setValue(key, state[key]);
      refresh();
      applyFilter();
    });

    refresh();
    return btn;
  }

  function createButtons() {
    const frag = document.createDocumentFragment();
    frag.appendChild(makeButton('seerr-hide-requested-toggle', 'Hide Requested', 'hideRequested'));
    frag.appendChild(makeButton('seerr-hide-available-toggle', 'Hide Available', 'hideAvailable'));
    return frag;
  }

  function injectButton() {
    if (document.getElementById('seerr-hide-requested-toggle')) return;

    // Try filter bar first (discover pages)
    const filterBtn = findFilterButton(document);
    if (filterBtn) {
      const container = filterBtn.closest('div');
      if (container) {
        container.appendChild(createButtons());
        return;
      }
    }

    // Fallback: inject into searchbar (home page and others)
    const searchbar = document.querySelector('.searchbar .flex');
    if (searchbar) {
      searchbar.appendChild(createButtons());
    }
  }

  // Debounced: Seerr's React app fires many childList mutations in a burst
  // on every navigation/search-result render. The original version ran a
  // full-page querySelectorAll sweep synchronously on every single one of
  // them — the same scroll/render-jank pattern found and fixed in the
  // seerr-request script. No self-mutation filtering is needed here: style
  // writes in applyFilter() don't set `attributes: true`, so they can't
  // retrigger this observer the way DOM insertions did there.
  const scheduleRefresh = debounce(() => {
    injectButton();
    applyFilter();
  }, 150);

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    injectButton();
    applyFilter();
  }, 1000);
})();
