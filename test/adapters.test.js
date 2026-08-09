'use strict';
const test = require('node:test');
const assert = require('node:assert');

const S = require('../seerr-request.user.js');

const byName = Object.fromEntries(S.adapters.map((a) => [a.name, a]));

// Minimal stub-doc factory. selectors maps a selector string to a canned
// element (or array for querySelectorAll). No jsdom — the no-dependency rule.
function stubDoc(selectors) {
  return {
    querySelector: (sel) => {
      const v = selectors[sel];
      return Array.isArray(v) ? v[0] ?? null : v ?? null;
    },
    querySelectorAll: (sel) => {
      const v = selectors[sel];
      return v == null ? [] : Array.isArray(v) ? v : [v];
    },
  };
}

const el = (props) => ({ getAttribute: (k) => props[k] ?? null, ...props });

// ---------------------------------------------------------------- imdb

test('imdb: movie detail from URL + json-ld', () => {
  const doc = stubDoc({
    'script[type="application/ld+json"]': el({
      textContent: JSON.stringify({ '@type': 'Movie', name: 'The Shawshank Redemption' }),
    }),
  });
  const out = byName.imdb.detail.extract('https://www.imdb.com/title/tt0111161/', doc);
  assert.deepEqual(out, { query: 'imdb:tt0111161', mediaType: null });
});

test('imdb: detail match regex', () => {
  assert.ok(byName.imdb.detail.match.test('https://www.imdb.com/title/tt0111161/'));
  assert.ok(byName.imdb.detail.match.test('https://imdb.com/title/tt0903747/?ref_=hm'));
  assert.ok(!byName.imdb.detail.match.test('https://www.imdb.com/name/nm0000151/'));
  assert.ok(!byName.imdb.detail.match.test('https://www.imdb.com/find/?q=heat'));
});

test('imdb: episode page resolves parent series tt', () => {
  const doc = stubDoc({
    'script[type="application/ld+json"]': el({
      textContent: JSON.stringify({
        '@type': 'TVEpisode',
        partOfSeries: { url: 'https://www.imdb.com/title/tt0903747/' },
      }),
    }),
  });
  const out = byName.imdb.detail.extract('https://www.imdb.com/title/tt1054724/', doc);
  assert.equal(out.query, 'imdb:tt0903747');
});

test('imdb: episode page with no parent falls back to own tt', () => {
  const doc = stubDoc({
    'script[type="application/ld+json"]': el({
      textContent: JSON.stringify({ '@type': 'TVEpisode' }),
    }),
  });
  const out = byName.imdb.detail.extract('https://www.imdb.com/title/tt1054724/', doc);
  assert.equal(out.query, 'imdb:tt1054724');
});

test('imdb: malformed json-ld still yields URL tt', () => {
  const doc = stubDoc({
    'script[type="application/ld+json"]': el({ textContent: '{not json' }),
  });
  const out = byName.imdb.detail.extract('https://www.imdb.com/title/tt0111161/', doc);
  assert.equal(out.query, 'imdb:tt0111161');
});

test('imdb: list match covers search, charts, lists, and what-to-watch', () => {
  const m = byName.imdb.list.match;
  assert.ok(m.test('https://www.imdb.com/search/title/?genres=drama'));
  assert.ok(m.test('https://www.imdb.com/chart/top/'));
  assert.ok(m.test('https://www.imdb.com/what-to-watch/popular/?ref_=watch_wls_tb'));
  assert.ok(m.test('https://www.imdb.com/user/ur12345/watchlist'));
  assert.ok(!m.test('https://www.imdb.com/title/tt0111161/'));
});

test('imdb: list cards dedupe by tt id', () => {
  const item = (tt, withContainer = true) =>
    el({
      href: `/title/${tt}/?ref_=sr`,
      closest: () => (withContainer ? el({ tag: 'li', id: 'card-' + tt }) : null),
    });
  const doc = stubDoc({
    'a[href*="/title/tt"]': [item('tt1'), item('tt1'), item('tt2'), item('tt3', false)],
  });
  const cards = byName.imdb.list.cards(doc);
  assert.deepEqual(cards.map((c) => c.query), ['imdb:tt1', 'imdb:tt2']);
  assert.ok(cards[0].el);
});

// ---------------------------------------------------------------- letterboxd

test('letterboxd: tmdb id from body data attribute', () => {
  const doc = stubDoc({ body: el({ 'data-tmdb-id': '278', 'data-tmdb-type': 'movie' }) });
  doc.body = doc.querySelector('body');
  const out = byName.letterboxd.detail.extract('https://letterboxd.com/film/the-shawshank-redemption/', doc);
  assert.deepEqual(out, { query: 'tmdb:278', mediaType: 'movie' });
});

test('letterboxd: no tmdb id -> null (no fuzzy fallback)', () => {
  const doc = stubDoc({ body: el({}) });
  doc.body = doc.querySelector('body');
  const out = byName.letterboxd.detail.extract('https://letterboxd.com/film/some-film/', doc);
  assert.equal(out, null);
});

// ---------------------------------------------------------------- tmdb

test('tmdb: movie and tv from URL, slug tolerated', () => {
  assert.deepEqual(
    byName.tmdb.detail.extract('https://www.themoviedb.org/movie/278-the-shawshank-redemption', stubDoc({})),
    { query: 'tmdb:278', mediaType: 'movie' }
  );
  assert.deepEqual(
    byName.tmdb.detail.extract('https://www.themoviedb.org/tv/1396-breaking-bad?language=en', stubDoc({})),
    { query: 'tmdb:1396', mediaType: 'tv' }
  );
});

// ---------------------------------------------------------------- trakt

test('trakt: tmdb id from external link, type from URL segment', () => {
  const doc = stubDoc({
    'a[href*="themoviedb.org/"]': el({ href: 'https://www.themoviedb.org/movie/278' }),
  });
  const out = byName.trakt.detail.extract('https://trakt.tv/movies/the-shawshank-redemption-1994', doc);
  assert.deepEqual(out, { query: 'tmdb:278', mediaType: 'movie' });
});

test('trakt: shows map to tv', () => {
  const doc = stubDoc({
    'a[href*="themoviedb.org/"]': el({ href: 'https://www.themoviedb.org/tv/1396' }),
  });
  const out = byName.trakt.detail.extract('https://trakt.tv/shows/breaking-bad', doc);
  assert.deepEqual(out, { query: 'tmdb:1396', mediaType: 'tv' });
});

test('trakt: no tmdb link -> null', () => {
  const out = byName.trakt.detail.extract('https://trakt.tv/movies/x', stubDoc({}));
  assert.equal(out, null);
});

// ---------------------------------------------------------------- containment

const bomb = {
  querySelector: () => {
    throw new Error('site redesigned');
  },
  querySelectorAll: () => {
    throw new Error('site redesigned');
  },
};

test('safeExtract: adapter throw is contained to null (trakt has no inner catch)', () => {
  const out = S.safeExtract(byName.trakt, 'https://trakt.tv/movies/heat-1995', bomb);
  assert.equal(out, null); // logged, not thrown
});

test('imdb extract survives a hostile doc via the URL-derived id', () => {
  const out = S.safeExtract(byName.imdb, 'https://www.imdb.com/title/tt0111161/', bomb);
  assert.deepEqual(out, { query: 'imdb:tt0111161', mediaType: null });
});

test('safeCards: adapter throw is contained to empty list', () => {
  assert.deepEqual(S.safeCards(byName.imdb, bomb), []);
});
