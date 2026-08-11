// ==UserScript==
// @name         Seerr - Hide Requested/Available Toggle
// @namespace    taznc.seerr-hide-toggle
// @version      1.4.0
// @description  Toggle buttons to hide already-requested or already-available titles on Seerr's discover pages.
// @author       joshashworth
// @match        https://your-seerr-domain.example/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @updateURL    https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-hide-toggle/seerr-hide-toggle.user.js
// @downloadURL  https://raw.githubusercontent.com/Taznc/userscripts/main/seerr-hide-toggle/seerr-hide-toggle.user.js
// @supportURL   https://github.com/Taznc/userscripts/issues
// ==/UserScript==

// The @match above is a placeholder on purpose — do not edit it in place.
// Tampermonkey's auto-update replaces the ENTIRE script file, metadata
// included, on every version bump (confirmed against Tampermonkey's own
// issue tracker: github.com/Tampermonkey/tampermonkey/issues/2405), so an
// edit made directly to this line would silently revert to the placeholder
// on the next update and the script would stop running with no warning.
//
// Instead: Dashboard -> click this script's name -> Settings tab -> "User
// matches" -> add your real Seerr URL there. That list is Tampermonkey's
// own per-installation storage, layered on top of (not overwritten by) the
// script body, so it survives updates. It also means the script is never
// injected into other pages at all — not "runs but does nothing", simply
// not present — unlike a broad @match with a runtime host check.

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Pure core — exported for node --test, must stay free of GM_*/DOM
  // globals beyond querySelectorAll on the passed-in element.
  // ------------------------------------------------------------------

  // Seerr renders card status through StatusBadgeMini (seerr-team/seerr,
  // src/components/Common/StatusBadgeMini) — a DIFFERENT component from
  // the StatusBadge used on detail pages. Confirmed against the project's
  // actual source:
  //   PROCESSING          -> bg-indigo-500/80 border-indigo-400
  //   PENDING             -> bg-yellow-500/80 border-yellow-400
  //   AVAILABLE / PARTIAL -> bg-green-500/80  border-green-400
  //   BLOCKLISTED         -> bg-red-500/80    border-white
  //   DELETED             -> bg-red-500/80    border-red-400
  // (Detail pages' StatusBadge uses the same bg families with border-*-500
  // — same colors, different shade suffix. Matching by color FAMILY prefix
  // covers both components and won't regress if either shifts a shade.)
  //
  // The original version of this script only matched indigo, so
  // newly-requested-but-not-yet-processing (PENDING, yellow) items were
  // never hidden by "Hide Requested". Both are matched now.
  //
  // Matching is scoped to 'rounded-full' elements: StatusBadgeMini's badge
  // is rounded-full, while the card's hover controls (request/watchlist
  // buttons) are rounded-md and the media-type pill is bg-blue/bg-purple —
  // all confirmed against TitleCard source — so neither can false-match.
  const REQUESTED_COLORS = ['bg-indigo', 'bg-yellow']; // processing, pending
  const AVAILABLE_COLORS = ['bg-green']; // available, partially available

  function hasBadgeColor(card, colorPrefixes) {
    for (const badge of card.querySelectorAll('[class*="rounded-full"]')) {
      // getAttribute, not .className: on SVG elements className is an
      // SVGAnimatedString object and .includes() would throw, aborting the
      // whole filter sweep. getAttribute is always a string (or null).
      const cls = badge.getAttribute('class') || '';
      if (colorPrefixes.some((p) => cls.includes(p))) return true;
    }
    return false;
  }

  const isRequested = (card) => hasBadgeColor(card, REQUESTED_COLORS);
  const isAvailable = (card) => hasBadgeColor(card, AVAILABLE_COLORS);

  function shouldHide(card, state) {
    return (state.hideRequested && isRequested(card)) || (state.hideAvailable && isAvailable(card));
  }

  // Button label with live hidden-count feedback, e.g.
  // "Hide Requested: ON (12 hidden)". Count only shows when ON and > 0.
  function buttonLabel(label, on, hiddenCount) {
    if (!on) return `${label}: OFF`;
    return hiddenCount > 0 ? `${label}: ON (${hiddenCount} hidden)` : `${label}: ON`;
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

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
    module.exports = {
      isRequested,
      isAvailable,
      shouldHide,
      hasBadgeColor,
      buttonLabel,
      debounce,
      findFilterButton,
    };
    return;
  }

  // ------------------------------------------------------------------
  // Boot — DOM only, runs under a userscript manager. No host check
  // needed here: Tampermonkey's own match filtering (see the comment
  // above the metadata block) already guarantees this only runs on the
  // page(s) you've configured.
  // ------------------------------------------------------------------

  const state = {
    hideRequested: GM_getValue('hideRequested', false),
    hideAvailable: GM_getValue('hideAvailable', false),
  };

  // Per-toggle counts from the last sweep, shown in the button labels. A
  // card hidden by both toggles at once counts toward both — each label
  // reports what its own toggle is responsible for.
  const lastCounts = { hideRequested: 0, hideAvailable: 0 };
  const buttonRefreshers = [];
  const refreshButtons = () => buttonRefreshers.forEach((fn) => fn());

  const EMPTY_ATTR = 'data-seerr-hide-empty';

  // When the toggles hide every card in a vertical grid, the page would
  // just look broken (a silently blank grid) — show a notice instead.
  // Idempotent both ways so our own insert/remove settling through the
  // MutationObserver converges instead of looping.
  function updateEmptyState(ul, allHidden) {
    const next = ul.nextElementSibling;
    const existing = next && next.hasAttribute(EMPTY_ATTR) ? next : null;
    if (allHidden && !existing) {
      const div = document.createElement('div');
      div.setAttribute(EMPTY_ATTR, '');
      div.textContent = 'Everything here is hidden by the Hide Requested / Hide Available toggles.';
      div.style.cssText =
        'margin:1rem 0;padding:1.5rem;text-align:center;color:#9ca3af;font-size:0.875rem;' +
        'border:1px dashed #4b5563;border-radius:0.75rem;';
      ul.insertAdjacentElement('afterend', div);
    } else if (!allHidden && existing) {
      existing.remove();
    }
  }

  function applyFilter() {
    lastCounts.hideRequested = 0;
    lastCounts.hideAvailable = 0;

    const applyTo = (el) => {
      const requested = isRequested(el);
      const available = isAvailable(el);
      const hide = (state.hideRequested && requested) || (state.hideAvailable && available);
      if (hide) {
        if (state.hideRequested && requested) lastCounts.hideRequested++;
        if (state.hideAvailable && available) lastCounts.hideAvailable++;
      }
      // Idempotent write: re-setting the same display value on hundreds of
      // cards per sweep is pointless CSSOM churn.
      const want = hide ? 'none' : '';
      if (el.style.display !== want) el.style.display = want;
      return hide;
    };

    // Vertical grid cards (discover pages; also cast/crew grids, where no
    // card has a status badge so the sweep is a no-op)
    document.querySelectorAll('ul.cards-vertical').forEach((ul) => {
      let total = 0;
      let hidden = 0;
      ul.querySelectorAll(':scope > li').forEach((li) => {
        total++;
        if (applyTo(li)) hidden++;
      });
      updateEmptyState(ul, total > 0 && hidden === total);
    });

    // Horizontal slider cards (home page)
    document.querySelectorAll('.inline-block.px-2.align-top').forEach(applyTo);

    refreshButtons();
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
      btn.textContent = buttonLabel(label, on, lastCounts[key]);
    }

    btn.addEventListener('click', () => {
      state[key] = !state[key];
      GM_setValue(key, state[key]);
      applyFilter(); // recomputes counts and refreshes every button label
    });

    buttonRefreshers.push(refresh);
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
    // Buttons were destroyed (React re-render) or never created: reset the
    // refresher registry so it doesn't accumulate refs to dead buttons.
    buttonRefreshers.length = 0;

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
  // retrigger this observer the way DOM insertions did there. (The
  // empty-state insert/remove and button injection DO retrigger it, but
  // both are idempotent, so the follow-up sweep settles immediately.)
  const scheduleRefresh = debounce(() => {
    injectButton();
    applyFilter();
  }, 150);

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

  // First pass runs immediately — at document-idle Seerr's React tree may
  // not have rendered yet, but the observer catches that render when it
  // lands. (Replaces the old arbitrary 1000ms startup timeout.)
  injectButton();
  applyFilter();

  // Cross-tab sync: toggling in one Seerr tab updates any others live.
  // Guarded — Violentmonkey/older managers without this API just skip it.
  if (typeof GM_addValueChangeListener === 'function') {
    for (const key of ['hideRequested', 'hideAvailable']) {
      GM_addValueChangeListener(key, (_name, _oldValue, newValue, remote) => {
        if (remote) {
          state[key] = Boolean(newValue);
          applyFilter();
        }
      });
    }
  }
})();
