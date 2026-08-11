// ==UserScript==
// @name         Seerr - Hide Requested/Available Toggle
// @namespace    taznc.seerr-hide-toggle
// @version      1.6.0
// @description  Compact badge-replica toggles to hide requested, available, or deleted titles on Seerr's discover pages.
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

  // Deleted and blocklisted BOTH render bg-red in StatusBadgeMini; the
  // discriminator (from the class strings above) is text color: deleted
  // carries text-red-100, blocklisted carries text-white. A plain bg-red
  // match would wrongly hide blocklisted titles too. (Verified against a
  // live-instance DOM sample of the deleted badge, which matches the
  // source verbatim.)
  function isDeleted(card) {
    for (const badge of card.querySelectorAll('[class*="rounded-full"]')) {
      const cls = badge.getAttribute('class') || '';
      if (cls.includes('bg-red') && cls.includes('text-red-100')) return true;
    }
    return false;
  }

  function shouldHide(card, state) {
    return Boolean(
      (state.hideRequested && isRequested(card)) ||
        (state.hideAvailable && isAvailable(card)) ||
        (state.hideDeleted && isDeleted(card))
    );
  }

  // Content for the custom tooltip (native title tooltips are slow to
  // appear, tiny, and unstylable — the user-visible tooltip is our own).
  // Kept to a glance: big heading = which status, short detail = state.
  // The slash + count on the button itself already carry the rest.
  function tooltipContent(label, on, hiddenCount) {
    if (!on) return { heading: label, detail: 'Click to hide' };
    return hiddenCount > 0
      ? { heading: label, detail: `Hiding ${hiddenCount} — click to show` }
      : { heading: label, detail: 'Hiding — none here' };
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
      isDeleted,
      shouldHide,
      hasBadgeColor,
      tooltipContent,
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
    hideDeleted: GM_getValue('hideDeleted', false),
  };

  // Per-toggle counts from the last sweep, shown next to the icons. A card
  // hidden by more than one toggle counts toward each — every icon reports
  // what its own toggle is responsible for.
  const lastCounts = { hideRequested: 0, hideAvailable: 0, hideDeleted: 0 };
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
    lastCounts.hideDeleted = 0;

    const applyTo = (el) => {
      const requested = isRequested(el);
      const available = isAvailable(el);
      const deleted = isDeleted(el);
      const hide =
        (state.hideRequested && requested) ||
        (state.hideAvailable && available) ||
        (state.hideDeleted && deleted);
      if (hide) {
        if (state.hideRequested && requested) lastCounts.hideRequested++;
        if (state.hideAvailable && available) lastCounts.hideAvailable++;
        if (state.hideDeleted && deleted) lastCounts.hideDeleted++;
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
    // TrashIcon — the red DELETED badge (path diffed byte-for-byte against
    // upstream heroicons 24/solid AND a live-instance DOM sample; Seerr
    // uses the 24-viewBox icon for this one)
    trash:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12" aria-hidden="true"><path fill-rule="evenodd" d="M16.5 4.478v.227a48.816 48.816 0 0 1 3.878.512.75.75 0 1 1-.256 1.478l-.209-.035-1.005 13.07a3 3 0 0 1-2.991 2.77H8.084a3 3 0 0 1-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 0 1-.256-1.478A48.567 48.567 0 0 1 7.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 0 1 3.369 0c1.603.051 2.815 1.387 2.815 2.951Zm-6.136-1.452a51.196 51.196 0 0 1 3.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 0 0-6 0v-.113c0-.794.609-1.428 1.364-1.452Zm-.355 5.945a.75.75 0 1 0-1.5.058l.347 9a.75.75 0 1 0 1.499-.058l-.346-9Zm5.48.058a.75.75 0 1 0-1.498-.058l-.347 9a.75.75 0 0 0 1.5.058l.345-9Z" clip-rule="evenodd"/></svg>',
  };

  const TOGGLES = [
    {
      id: 'seerr-hide-requested-toggle',
      key: 'hideRequested',
      color: 'rgba(99,102,241,0.9)', // indigo-500, like the badge
      icon: ICONS.clock,
      label: 'Requested',
    },
    {
      id: 'seerr-hide-available-toggle',
      key: 'hideAvailable',
      color: 'rgba(34,197,94,0.9)', // green-500, like the badge
      icon: ICONS.check,
      label: 'Available',
    },
    {
      id: 'seerr-hide-deleted-toggle',
      key: 'hideDeleted',
      color: 'rgba(239,68,68,0.9)', // red-500, like the badge
      icon: ICONS.trash,
      label: 'Deleted',
    },
  ];

  // Custom tooltip: instant (no native ~1s title delay), large, and
  // shared — one element repositioned under whichever toggle is hovered.
  // pointer-events:none so it can never trap the cursor.
  let tooltipEl = null;
  let tooltipHeadingEl = null;
  let tooltipDetailEl = null;
  let tooltipFor = null; // toggle button the tooltip is currently shown for

  function ensureTooltip() {
    if (tooltipEl && tooltipEl.isConnected) return;
    tooltipEl = document.createElement('div');
    tooltipEl.setAttribute('data-seerr-tooltip', '');
    tooltipEl.style.cssText =
      'position:fixed;z-index:2147483647;display:none;pointer-events:none;white-space:nowrap;' +
      'background:rgba(17,24,39,0.97);border:1px solid #4b5563;border-radius:10px;' +
      'padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.5);text-align:center;';
    tooltipHeadingEl = document.createElement('div');
    tooltipHeadingEl.style.cssText = 'font-size:16px;font-weight:700;color:#fff;line-height:1.3;';
    tooltipDetailEl = document.createElement('div');
    tooltipDetailEl.style.cssText = 'font-size:13px;font-weight:500;color:#d1d5db;line-height:1.4;';
    tooltipEl.append(tooltipHeadingEl, tooltipDetailEl);
    document.body.appendChild(tooltipEl);
  }

  function showTooltip(btn, cfg) {
    ensureTooltip();
    tooltipFor = btn;
    const { heading, detail } = tooltipContent(cfg.label, state[cfg.key], lastCounts[cfg.key]);
    tooltipHeadingEl.textContent = heading;
    tooltipDetailEl.textContent = detail;
    tooltipEl.style.display = 'block';
    // Position under the button, centered, clamped to the viewport (the
    // toggles sit near the right edge, where naive centering overflows).
    const r = btn.getBoundingClientRect();
    const half = tooltipEl.offsetWidth / 2;
    let center = r.left + r.width / 2;
    center = Math.max(8 + half, Math.min(center, window.innerWidth - 8 - half));
    tooltipEl.style.left = `${center - half}px`;
    tooltipEl.style.top = `${r.bottom + 8}px`;
  }

  function hideTooltip() {
    tooltipFor = null;
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function makeToggle(cfg) {
    const { id, key, color, icon } = cfg;
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.setAttribute('data-seerr-toggle', ''); // marks it ours for the observer filter
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
    // Fixed-width slot, always in the layout: the toggle's footprint stays
    // identical whether a count is showing or not (counts up to 2 digits;
    // a 3-digit count widens that one toggle slightly rather than clipping).
    count.style.cssText =
      'display:inline-block;min-width:18px;text-align:center;' +
      'font-size:12px;font-weight:600;color:#e5e7eb;';

    btn.append(circle, count);

    function refresh() {
      const on = state[key];
      const n = lastCounts[key];
      slash.style.display = on ? '' : 'none';
      circle.style.opacity = on ? '1' : '0.45';
      btn.style.borderColor = on ? '#6366f1' : '#4b5563';
      btn.style.background = on ? 'rgba(67,56,202,0.35)' : 'rgba(31,41,55,0.8)';
      // Slot stays in the layout either way — only the text comes and goes.
      count.textContent = on && n > 0 ? String(n) : '';
      // No btn.title: the native tooltip is slow, tiny, and would double
      // up with the custom one. aria-label keeps the info for screen
      // readers; sighted users get the instant custom tooltip.
      const { heading, detail } = tooltipContent(cfg.label, on, n);
      btn.setAttribute('aria-label', `${heading}: ${detail}`);
      btn.setAttribute('aria-pressed', String(on));
      // State changed while the tooltip is up (a click): update it live.
      if (tooltipFor === btn) showTooltip(btn, cfg);
    }

    btn.addEventListener('click', () => {
      state[key] = !state[key];
      GM_setValue(key, state[key]);
      applyFilter(); // recomputes counts and refreshes every toggle
    });
    btn.addEventListener('mouseenter', () => showTooltip(btn, cfg));
    btn.addEventListener('mouseleave', hideTooltip);
    btn.addEventListener('focus', () => showTooltip(btn, cfg));
    btn.addEventListener('blur', hideTooltip);

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

  // Scroll-smoothness, same two levers that fixed the identical jank in
  // the seerr-request script:
  //
  // 1. Sweeps run at IDLE, never mid-scroll-frame. Seerr's infinite
  //    scroll + lazy images fire mutation bursts continuously while
  //    scrolling; a debounce alone still lands the sweep in the middle of
  //    scrolling. requestIdleCallback waits for a frame gap.
  // 2. Our own DOM work (buttons, empty-state notice, tooltip) doesn't
  //    schedule sweeps at all. Additions of our own elements are filtered
  //    out; element REMOVALS always re-route — asymmetric on purpose, so
  //    React stripping our buttons in a re-render still re-injects them.
  const whenIdle =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
      : (fn) => setTimeout(fn, 50);

  const scheduleRefresh = debounce(() => {
    whenIdle(() => {
      injectButton();
      applyFilter();
    });
  }, 150);

  const OUR_ATTRS = ['data-seerr-toggle', 'data-seerr-tooltip', 'data-seerr-hide-empty'];
  const isOurNode = (n) =>
    n.nodeType === 1 && OUR_ATTRS.some((a) => n.hasAttribute(a));

  const observer = new MutationObserver((records) => {
    let relevant = false;
    for (const r of records) {
      // Tooltip content churn happens on every hover and is entirely ours.
      if (tooltipEl && tooltipEl.contains(r.target)) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !isOurNode(n)) {
          relevant = true;
          break;
        }
      }
      if (!relevant) {
        for (const n of r.removedNodes) {
          if (n.nodeType === 1) {
            relevant = true;
            break;
          }
        }
      }
      if (relevant) break;
    }
    if (relevant) scheduleRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // First pass runs immediately — at document-idle Seerr's React tree may
  // not have rendered yet, but the observer catches that render when it
  // lands. (Replaces the old arbitrary 1000ms startup timeout.)
  injectButton();
  applyFilter();

  // Cross-tab sync: toggling in one Seerr tab updates any others live.
  // Guarded — Violentmonkey/older managers without this API just skip it.
  if (typeof GM_addValueChangeListener === 'function') {
    for (const key of ['hideRequested', 'hideAvailable', 'hideDeleted']) {
      GM_addValueChangeListener(key, (_name, _oldValue, newValue, remote) => {
        if (remote) {
          state[key] = Boolean(newValue);
          applyFilter();
        }
      });
    }
  }
})();
