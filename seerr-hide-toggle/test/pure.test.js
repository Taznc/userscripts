'use strict';
const test = require('node:test');
const assert = require('node:assert');

const S = require('../seerr-hide-toggle.user.js');

// Fixture elements expose getAttribute('class') like real DOM nodes — the
// implementation must use getAttribute, not .className (which is an
// SVGAnimatedString object on SVG elements; see the svg test below).
const badge = (cls) => ({
  getAttribute: (k) => (k === 'class' ? cls : null),
  className: cls,
});
// Mimics the real DOM: querySelectorAll('[class*="rounded-full"]') only
// returns elements whose class attribute actually contains that substring.
const card = (badges) => ({
  querySelectorAll: (sel) => {
    const needle = sel.match(/\[class\*="([^"]+)"\]/)[1];
    return badges.filter((b) => (b.getAttribute('class') || '').includes(needle));
  },
});

test('module loads under node without booting', () => {
  assert.equal(typeof S.isRequested, 'function');
  assert.equal(typeof S.isAvailable, 'function');
  assert.equal(typeof S.shouldHide, 'function');
  assert.equal(typeof S.isDeleted, 'function');
  assert.equal(typeof S.tooltipContent, 'function');
});

// Class strings below mirror seerr-team/seerr's StatusBadgeMini verbatim.

test('isRequested: matches processing (indigo, StatusBadgeMini shape)', () => {
  const c = card([badge('rounded-full shadow-md w-4 sm:w-5 border p-0 bg-indigo-500/80 border-indigo-400 ring-indigo-400 text-indigo-100')]);
  assert.equal(S.isRequested(c), true);
  assert.equal(S.isAvailable(c), false);
});

test('isRequested: matches pending (yellow) — the gap in the original script', () => {
  const c = card([badge('rounded-full shadow-md w-5 ring-1 p-0.5 bg-yellow-500/80 border-yellow-400 ring-yellow-400 text-yellow-100')]);
  assert.equal(S.isRequested(c), true);
});

test('isAvailable: matches green with either border shade (Mini uses -400, detail-page badge uses -500)', () => {
  const mini = card([badge('rounded-full bg-green-500/80 border-green-400 ring-green-400')]);
  const detail = card([badge('px-2 rounded-full bg-green-500/80 border border-green-500 !text-green-100')]);
  assert.equal(S.isAvailable(mini), true);
  assert.equal(S.isAvailable(detail), true);
  assert.equal(S.isRequested(mini), false);
});

test('no match: red badges (blocklisted/deleted) and unbadged cards are neither requested nor available', () => {
  const blocklisted = card([badge('rounded-full bg-red-500/80 border-white ring-white text-white')]);
  assert.equal(S.isRequested(blocklisted), false);
  assert.equal(S.isAvailable(blocklisted), false);
  const plain = card([]);
  assert.equal(S.isRequested(plain), false);
  assert.equal(S.isAvailable(plain), false);
});

test('isDeleted: matches the deleted badge but NOT the blocklist badge (both are red)', () => {
  // Verbatim StatusBadgeMini class strings (deleted string also confirmed
  // against a live-instance DOM sample): text color is the discriminator —
  // deleted = text-red-100, blocklisted = text-white.
  const deleted = card([badge('rounded-full shadow-md w-4 sm:w-5 border p-0 bg-red-500/80 border-red-400 ring-red-400 text-red-100')]);
  const blocklisted = card([badge('rounded-full shadow-md w-5 ring-1 p-0.5 bg-red-500/80 border-white ring-white text-white')]);
  assert.equal(S.isDeleted(deleted), true);
  assert.equal(S.isDeleted(blocklisted), false);
  assert.equal(S.isDeleted(card([])), false);
});

test('shouldHide: deleted toggle hides deleted only, never blocklisted', () => {
  const deleted = card([badge('rounded-full bg-red-500/80 border-red-400 text-red-100')]);
  const blocklisted = card([badge('rounded-full bg-red-500/80 border-white text-white')]);
  const on = { hideRequested: false, hideAvailable: false, hideDeleted: true };
  assert.equal(S.shouldHide(deleted, on), true);
  assert.equal(S.shouldHide(blocklisted, on), false);
  const off = { hideRequested: true, hideAvailable: true, hideDeleted: false };
  assert.equal(S.shouldHide(deleted, off), false);
});

test('no match: media-type pill (bg-blue/bg-purple, rounded-full) never false-positives', () => {
  const moviePill = card([badge('pointer-events-none z-40 self-start rounded-full border shadow-md border-blue-500 bg-blue-600/80')]);
  const tvPill = card([badge('pointer-events-none z-40 self-start rounded-full border shadow-md border-purple-600 bg-purple-600/80')]);
  assert.equal(S.isRequested(moviePill), false);
  assert.equal(S.isAvailable(moviePill), false);
  assert.equal(S.isRequested(tvPill), false);
  assert.equal(S.isAvailable(tvPill), false);
});

test('color match is scoped to rounded-full badges, ignoring unrelated colored elements', () => {
  const c = card([badge('poster-thumbnail bg-indigo-900 rounded-lg')]); // not a badge shape
  assert.equal(S.isRequested(c), false);
});

test('svg elements do not crash the sweep (className is not a string on svg)', () => {
  // Real SVG DOM: className is an SVGAnimatedString OBJECT — calling
  // .includes on it throws. getAttribute('class') is always a string.
  const svgLike = {
    className: { baseVal: 'rounded-full bg-indigo-500/80' }, // object, like real svg
    getAttribute: (k) => (k === 'class' ? 'rounded-full bg-indigo-500/80' : null),
  };
  const c = card([svgLike]);
  assert.doesNotThrow(() => S.isRequested(c));
  assert.equal(S.isRequested(c), true);
});

test('shouldHide: only hides per the active toggles', () => {
  const requested = card([badge('rounded-full bg-yellow-500/80')]);
  const available = card([badge('rounded-full bg-green-500/80')]);
  assert.equal(S.shouldHide(requested, { hideRequested: true, hideAvailable: false }), true);
  assert.equal(S.shouldHide(requested, { hideRequested: false, hideAvailable: true }), false);
  assert.equal(S.shouldHide(available, { hideRequested: true, hideAvailable: false }), false);
  assert.equal(S.shouldHide(available, { hideRequested: false, hideAvailable: true }), true);
  assert.equal(S.shouldHide(available, { hideRequested: false, hideAvailable: false }), false);
});

test('tooltipContent: glanceable heading + short state detail', () => {
  assert.deepEqual(S.tooltipContent('Requested', false, 12), {
    heading: 'Requested',
    detail: 'Click to hide',
  });
  assert.deepEqual(S.tooltipContent('Requested', true, 12), {
    heading: 'Requested',
    detail: 'Hiding 12 — click to show',
  });
  assert.deepEqual(S.tooltipContent('Blocklisted', true, 0), {
    heading: 'Blocklisted',
    detail: 'Hiding — none here',
  });
});

const fakeButton = (hasSvg, text) => ({
  querySelector: (sel) => (sel === 'svg' && hasSvg ? {} : null),
  textContent: text,
});
const fakeDoc = (buttons) => ({ querySelectorAll: () => buttons });

test('findFilterButton: requires both an svg child and "filter" in its text', () => {
  const doc = fakeDoc([
    fakeButton(false, 'Sign In'),
    fakeButton(true, 'Play on Plex'), // has an icon, but not a filter button
    fakeButton(true, '2 Active Filters'),
  ]);
  assert.equal(S.findFilterButton(doc).textContent, '2 Active Filters');
});

test('findFilterButton: text alone without an icon does not match (avoids stray text mentions)', () => {
  const doc = fakeDoc([fakeButton(false, 'Clear all filters')]);
  assert.equal(S.findFilterButton(doc), null);
});

test('findFilterButton: no buttons at all -> null, not a throw', () => {
  assert.equal(S.findFilterButton(fakeDoc([])), null);
});

test('debounce: only the last call in a burst runs, after the delay', () => {
  let calls = 0;
  const fn = S.debounce(() => calls++, 10);
  fn();
  fn();
  fn();
  assert.equal(calls, 0, 'nothing runs synchronously');
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(calls, 1, 'exactly one call after the debounce window');
      resolve();
    }, 30);
  });
});
