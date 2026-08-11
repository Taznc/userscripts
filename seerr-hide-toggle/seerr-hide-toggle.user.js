// ==UserScript==
// @name         Seerr - Hide Requested/Available Toggle
// @namespace    taznc.seerr-hide-toggle
// @version      1.5.0
// @description  Compact badge-replica toggles to hide requested, available, or blocklisted titles on Seerr's discover pages.
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
  //   PROCESSING          -> bg-indigo-500/80 border-indigo-400 text-indigo-100
  //   PENDING             -> bg-yellow-500/80 border-yellow-400 text-yellow-100
  //   AVAILABLE / PARTIAL -> bg-green-500/80  border-green-400  text-green-100
  //   BLOCKLISTED         -> bg-red-500/80    border-white      text-white
  //   DELETED             -> bg-red-500/80    border-red-400    text-red-100
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

  // Blocklisted and deleted BOTH render bg-red in StatusBadgeMini; the
  // discriminator (from the class strings above) is that only the
  // blocklist badge carries text-white. A plain bg-red match would wrongly
  // hide deleted titles too.
  function isBlocklisted(card) {
    for (const badge of card.querySelectorAll('[class*="rounded-full"]')) {
      const cls = badge.getAttribute('class') || '';
      if (cls.includes('bg-red') && cls.includes('text-white')) return true;
    }
    return false;
  }

  function shouldHide(card, state) {
    return Boolean(
      (state.hideRequested && isRequested(card)) ||
        (state.hideAvailable && isAvailable(card)) ||
        (state.hideBlocklisted && isBlocklisted(card))
    );
  }

  // Tooltip / accessible label for an icon toggle. The icons are compact,
  // so this carries the full explanation.
  function toggleTitle(nounPlural, on, hiddenCount) {
    if (!on) return `Click to hide ${nounPlural}`;
    return hiddenCount > 0
      ? `Hiding ${nounPlural} — ${hiddenCount} hidden on this page. Click to show them.`
      : `Hiding ${nounPlural} — none on this page right now. Click to turn off.`;
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
      isBlocklisted,
      shouldHide,
      hasBadgeColor,
      toggleTitle,
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
    hideBlocklisted: GM_getValue('hideBlocklisted', false),
  };

  // Per-toggle counts from the last sweep, shown next to the icons. A card
  // hidden by more than one toggle counts toward each — every icon reports
  // what its own toggle is responsible for.
  const lastCounts = { hideRequested: 0, hideAvailable: 0, hideBlocklisted: 0 };
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
      div.textContent = 'Everything here is hidden by your hide toggles.';
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
    lastCounts.hideBlocklisted = 0;

    const applyTo = (el) => {
      const requested = isRequested(el);
      const available = isAvailable(el);
      const blocklisted = isBlocklisted(el);
      const hide =
        (state.hideRequested && requested) ||
        (state.hideAvailable && available) ||
        (state.hideBlocklisted && blocklisted);
      if (hide) {
        if (state.hideRequested && requested) lastCounts.hideRequested++;
        if (state.hideAvailable && available) lastCounts.hideAvailable++;
        if (state.hideBlocklisted && blocklisted) lastCounts.hideBlocklisted++;
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

  // Each toggle is a replica of the exact StatusBadgeMini badge it hides —
  // same color, same heroicon (paths taken verbatim from heroicons 20/solid,
  // the set Seerr itself uses) — so no new iconography to learn. Hiding ON
  // is shown by a white slash struck through the badge plus the hidden
  // count; OFF dims the badge. Tooltips carry the full explanation.
  const ICONS = {
    // ClockIcon — the indigo PROCESSING badge (also covers yellow PENDING)
    clock:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clip-rule="evenodd"/></svg>',
    // CheckIcon — the green AVAILABLE badge
    check:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd"/></svg>',
    // EyeSlashIcon — the red BLOCKLISTED badge
    eyeSlash:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true"><path fill-rule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clip-rule="evenodd"/><path d="m10.748 13.93 2.523 2.523a9.987 9.987 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z"/></svg>',
  };

  const TOGGLES = [
    {
      id: 'seerr-hide-requested-toggle',
      key: 'hideRequested',
      color: 'rgba(99,102,241,0.9)', // indigo-500, like the badge
      icon: ICONS.clock,
      noun: 'requested titles',
    },
    {
      id: 'seerr-hide-available-toggle',
      key: 'hideAvailable',
      color: 'rgba(34,197,94,0.9)', // green-500, like the badge
      icon: ICONS.check,
      noun: 'available titles',
    },
    {
      id: 'seerr-hide-blocklisted-toggle',
      key: 'hideBlocklisted',
      color: 'rgba(239,68,68,0.9)', // red-500, like the badge
      icon: ICONS.eyeSlash,
      noun: 'blocklisted titles',
    },
  ];

  function makeToggle({ id, key, color, icon, noun }) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:5px;border:1px solid #4b5563;border-radius:8px;' +
      'padding:5px 8px;background:rgba(31,41,55,0.8);cursor:pointer;margin-left:8px;' +
      'transition:background 0.15s,border-color 0.15s,opacity 0.15s;';

    const circle = document.createElement('span');
    circle.style.cssText =
      'position:relative;width:20px;height:20px;border-radius:9999px;display:inline-flex;' +
      'align-items:center;justify-content:center;color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);' +
      'background:' + color + ';transition:opacity 0.15s;';
    circle.innerHTML = icon; // static, script-authored SVG — no user data

    const slash = document.createElement('span');
    slash.style.cssText =
      'position:absolute;top:50%;left:50%;width:26px;height:2px;border-radius:1px;background:#fff;' +
      'box-shadow:0 0 0 1px rgba(17,24,39,0.85);transform:translate(-50%,-50%) rotate(-45deg);';
    circle.appendChild(slash);

    const count = document.createElement('span');
    count.style.cssText = 'font-size:12px;font-weight:600;color:#e5e7eb;';

    btn.append(circle, count);

    function refresh() {
      const on = state[key];
      const n = lastCounts[key];
      slash.style.display = on ? '' : 'none';
      circle.style.opacity = on ? '1' : '0.45';
      btn.style.borderColor = on ? '#6366f1' : '#4b5563';
      btn.style.background = on ? 'rgba(67,56,202,0.35)' : 'rgba(31,41,55,0.8)';
      count.textContent = on && n > 0 ? String(n) : '';
      count.style.display = on && n > 0 ? '' : 'none';
      const title = toggleTitle(noun, on, n);
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.setAttribute('aria-pressed', String(on));
    }

    btn.addEventListener('click', () => {
      state[key] = !state[key];
      GM_setValue(key, state[key]);
      applyFilter(); // recomputes counts and refreshes every toggle
    });

    buttonRefreshers.push(refresh);
    refresh();
    return btn;
  }

  function createButtons() {
    const frag = document.createDocumentFragment();
    for (const cfg of TOGGLES) frag.appendChild(makeToggle(cfg));
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
    for (const key of ['hideRequested', 'hideAvailable', 'hideBlocklisted']) {
      GM_addValueChangeListener(key, (_name, _oldValue, newValue, remote) => {
        if (remote) {
          state[key] = Boolean(newValue);
          applyFilter();
        }
      });
    }
  }
})();
