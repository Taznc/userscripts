'use strict';
const test = require('node:test');
const assert = require('node:assert');

const S = require('../seerr-hide-toggle.user.js');

const badge = (className) => ({ className });
// Mimics the real DOM: querySelectorAll('[class*="rounded-full"]') only
// returns elements whose className actually contains that substring.
const card = (badges) => ({
  querySelectorAll: (sel) => {
    const needle = sel.match(/\[class\*="([^"]+)"\]/)[1];
    return badges.filter((b) => (b.className || '').includes(needle));
  },
});

test('module loads under node without booting', () => {
  assert.equal(typeof S.isRequested, 'function');
  assert.equal(typeof S.isAvailable, 'function');
  assert.equal(typeof S.shouldHide, 'function');
});

test('isRequested: matches processing (indigo)', () => {
  const c = card([badge('px-2 rounded-full bg-indigo-500/80 border border-indigo-500')]);
  assert.equal(S.isRequested(c), true);
  assert.equal(S.isAvailable(c), false);
});

test('isRequested: matches pending (yellow) — the gap in the original script', () => {
  const c = card([badge('px-2 rounded-full bg-yellow-500/80 border border-yellow-500')]);
  assert.equal(S.isRequested(c), true);
});

test('isAvailable: matches success green regardless of exact shade/border', () => {
  const c = card([badge('px-2 rounded-full bg-green-500 bg-opacity-80 border border-green-400')]);
  assert.equal(S.isAvailable(c), true);
  assert.equal(S.isRequested(c), false);
});

test('no match: danger (red/deleted) and default (unstyled) card are neither requested nor available', () => {
  const c = card([badge('px-2 rounded-full bg-red-600/80 border border-red-500')]);
  assert.equal(S.isRequested(c), false);
  assert.equal(S.isAvailable(c), false);
  const plain = card([]);
  assert.equal(S.isRequested(plain), false);
  assert.equal(S.isAvailable(plain), false);
});

test('color match is scoped to rounded-full badges, ignoring unrelated colored elements', () => {
  const c = card([badge('poster-thumbnail bg-indigo-900 rounded-lg')]); // not a badge shape
  assert.equal(S.isRequested(c), false);
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
