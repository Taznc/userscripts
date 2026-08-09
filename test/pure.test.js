'use strict';
const test = require('node:test');
const assert = require('node:assert');

const S = require('../seerr-request.user.js');

// ---------------------------------------------------------------- Task 1

test('module loads under node without booting', () => {
  assert.ok(S.VERSION, 'VERSION exported');
  assert.equal(typeof S.buttonState, 'function');
  assert.equal(typeof S.seasonDefaults, 'function');
  assert.equal(typeof S.makeCache, 'function');
  assert.equal(typeof S.makeClient, 'function');
  assert.ok(Array.isArray(S.adapters));
});

// ---------------------------------------------------------------- Task 2

const cfg = { url: 'https://seerr.example', key: 'k', userId: 3 };

test('buttonState: unconfigured wins over everything', () => {
  const b = S.buttonState({ configured: false, error: true, loading: true });
  assert.equal(b.state, 'setup');
  assert.equal(b.active, true);
});

test('buttonState: network error -> offline', () => {
  const b = S.buttonState({ configured: true, error: { kind: 'offline' } });
  assert.equal(b.state, 'offline');
  assert.equal(b.active, false);
});

test('buttonState: loading -> checking', () => {
  const b = S.buttonState({ configured: true, loading: true });
  assert.equal(b.state, 'checking');
  assert.equal(b.active, false);
});

test('buttonState: zero results -> notfound', () => {
  const b = S.buttonState({ configured: true, result: null });
  assert.equal(b.state, 'notfound');
  assert.equal(b.active, false);
});

test('buttonState: FAILED request on PROCESSING media -> retry (the trap)', () => {
  const b = S.buttonState({
    configured: true,
    result: {
      mediaType: 'movie',
      mediaInfo: {
        status: 3,
        requests: [{ id: 412, status: 4, is4k: false }],
      },
    },
  });
  assert.equal(b.state, 'retry');
  assert.equal(b.active, true);
  assert.equal(b.requestId, 412);
});

test('buttonState: 4k failed request does not trigger non-4k retry', () => {
  const b = S.buttonState({
    configured: true,
    result: {
      mediaType: 'movie',
      mediaInfo: { status: 2, requests: [{ id: 9, status: 4, is4k: true }] },
    },
  });
  assert.equal(b.state, 'requested');
});

test('buttonState: PENDING/PROCESSING -> requested, disabled', () => {
  for (const status of [2, 3]) {
    const b = S.buttonState({
      configured: true,
      result: { mediaType: 'movie', mediaInfo: { status } },
    });
    assert.equal(b.state, 'requested');
    assert.equal(b.active, false);
  }
});

test('buttonState: AVAILABLE -> available', () => {
  const b = S.buttonState({
    configured: true,
    result: { mediaType: 'tv', mediaInfo: { status: 5 } },
  });
  assert.equal(b.state, 'available');
  assert.equal(b.active, false);
});

test('buttonState: PARTIAL movie -> available, PARTIAL tv -> active request', () => {
  const movie = S.buttonState({
    configured: true,
    result: { mediaType: 'movie', mediaInfo: { status: 4 } },
  });
  assert.equal(movie.state, 'available');
  const tv = S.buttonState({
    configured: true,
    result: { mediaType: 'tv', mediaInfo: { status: 4 } },
  });
  assert.equal(tv.state, 'request');
  assert.equal(tv.active, true);
});

test('buttonState: absent/UNKNOWN/DELETED -> request', () => {
  for (const mediaInfo of [undefined, { status: 1 }, { status: 6 }]) {
    const b = S.buttonState({
      configured: true,
      result: { mediaType: 'movie', mediaInfo },
    });
    assert.equal(b.state, 'request');
    assert.equal(b.active, true);
  }
});

test('buttonState: requested with open request id -> active cancel', () => {
  const b = S.buttonState({
    configured: true,
    result: {
      mediaType: 'movie',
      mediaInfo: { status: 2, requests: [{ id: 55, status: 1, is4k: false }] },
    },
  });
  assert.equal(b.state, 'requested');
  assert.equal(b.active, true);
  assert.equal(b.cancelId, 55);
});

test('buttonState: requested without requests[] stays disabled', () => {
  const b = S.buttonState({
    configured: true,
    result: { mediaType: 'movie', mediaInfo: { status: 2 } },
  });
  assert.equal(b.state, 'requested');
  assert.equal(b.active, false);
  assert.equal(b.cancelId, undefined);
});

test('buttonState: request label names the media type', () => {
  const movie = S.buttonState({ configured: true, result: { mediaType: 'movie' } });
  assert.equal(movie.label, 'Request movie');
  const tv = S.buttonState({ configured: true, result: { mediaType: 'tv', mediaInfo: { status: 4 } } });
  assert.equal(tv.label, 'Request show');
});

test('cacheEntryFrom: extracts failedId and cancelId, skips 4k requests', () => {
  const entry = S.cacheEntryFrom({
    id: 278,
    mediaType: 'movie',
    mediaInfo: {
      status: 3,
      requests: [
        { id: 9, status: 2, is4k: true },
        { id: 12, status: 4, is4k: false },
        { id: 15, status: 1, is4k: false },
      ],
    },
  });
  assert.equal(entry.failedId, 12);
  assert.equal(entry.cancelId, 15);
  assert.equal(entry.tmdbId, 278);
});

test('client: cancel issues DELETE, 204 succeeds, 404 -> notfound', async () => {
  const t = fakeTransport([['/api/v1/request/55', { status: 204, json: null }]]);
  const c1 = S.makeClient({ cfg, transport: t });
  await c1.cancel(55);
  assert.equal(t.calls[0].method, 'DELETE');
  assert.ok(t.calls[0].url.endsWith('/api/v1/request/55'));
  const t2 = fakeTransport([['/api/v1/request/55', { status: 404, json: {} }]]);
  const c2 = S.makeClient({ cfg, transport: t2 });
  await assert.rejects(() => c2.cancel(55), (e) => e.kind === 'notfound');
});

test('buttonState: partial tv with exhausted seasons -> requested/available, never request (silo case)', () => {
  const withOpen = S.buttonState({
    configured: true,
    result: {
      mediaType: 'tv',
      seasonsExhausted: true,
      mediaInfo: { status: 4, requests: [{ id: 77, status: 2, is4k: false }] },
    },
  });
  assert.equal(withOpen.state, 'requested');
  assert.equal(withOpen.active, true);
  assert.equal(withOpen.cancelId, 77);
  const withoutOpen = S.buttonState({
    configured: true,
    result: { mediaType: 'tv', seasonsExhausted: true, mediaInfo: { status: 4 } },
  });
  assert.equal(withoutOpen.state, 'available');
});

test('client: resolve fetches details for partial tv and computes exhaustion', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: { results: [{ id: 125988, mediaType: 'tv', mediaInfo: { status: 4 } }] },
    }],
    ['/api/v1/tv/125988', {
      status: 200,
      json: {
        mediaInfo: {
          status: 4,
          seasons: [
            { seasonNumber: 1, status: 5 },
            { seasonNumber: 2, status: 5 },
            { seasonNumber: 3, status: 3 },
          ],
          requests: [{ id: 77, status: 2, is4k: false }],
        },
        seasons: [1, 2, 3].map((n) => ({ seasonNumber: n, episodeCount: 10 })),
      },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('imdb:tt14688458');
  assert.equal(t.calls.length, 2, 'details fetched for partial tv');
  assert.equal(r.seasonsExhausted, true);
  assert.equal(S.buttonState({ configured: true, result: r }).state, 'requested');
});

test('client: partial tv with an open season stays requestable', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: { results: [{ id: 1396, mediaType: 'tv', mediaInfo: { status: 4 } }] },
    }],
    ['/api/v1/tv/1396', {
      status: 200,
      json: {
        mediaInfo: { status: 4, seasons: [{ seasonNumber: 1, status: 5 }] },
        seasons: [1, 2].map((n) => ({ seasonNumber: n, episodeCount: 10 })),
      },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('tmdb:1396', 'tv');
  assert.equal(r.seasonsExhausted, false);
  assert.equal(S.buttonState({ configured: true, result: r }).state, 'request');
});

test('shouldHideCard: hides only owned states, only when toggled on', () => {
  assert.equal(S.shouldHideCard('available', true), true);
  assert.equal(S.shouldHideCard('requested', true), true);
  assert.equal(S.shouldHideCard('request', true), false);
  assert.equal(S.shouldHideCard('failed', true), false);
  assert.equal(S.shouldHideCard('busy', true), false);
  assert.equal(S.shouldHideCard('available', false), false);
  assert.equal(S.shouldHideCard('requested', false), false);
});

test('dotStateFor: exhausted partial tv -> requested (cancellable) or available', () => {
  assert.equal(S.dotStateFor({ status: 4, mediaType: 'tv', seasonsExhausted: true, cancelId: 77 }), 'requested');
  assert.equal(S.dotStateFor({ status: 4, mediaType: 'tv', seasonsExhausted: true }), 'available');
  assert.equal(S.dotStateFor({ status: 4, mediaType: 'tv', seasonsExhausted: false }), 'request');
});

test('dotStateFor: failed beats everything, request for absent/partial-tv', () => {
  assert.equal(S.dotStateFor({ failedId: 7, status: 3 }), 'failed');
  assert.equal(S.dotStateFor({ status: 5 }), 'available');
  assert.equal(S.dotStateFor({ status: 4, mediaType: 'movie' }), 'available');
  assert.equal(S.dotStateFor({ status: 4, mediaType: 'tv' }), 'request');
  assert.equal(S.dotStateFor({ status: 2 }), 'requested');
  assert.equal(S.dotStateFor({ status: 3 }), 'requested');
  assert.equal(S.dotStateFor({ status: 1 }), 'request');
  assert.equal(S.dotStateFor({ status: 6 }), 'request');
});

// ---------------------------------------------------------------- Task 3

test('seasonDefaults: mixed availability (breaking bad case)', () => {
  const out = S.seasonDefaults({
    seasons: [0, 1, 2, 3, 4, 5].map((n) => ({ seasonNumber: n, episodeCount: n === 0 ? 5 : 10 })),
    mediaInfo: {
      seasons: [
        { seasonNumber: 1, status: 5 },
        { seasonNumber: 2, status: 5 },
      ],
    },
  });
  assert.equal(out.length, 5, 'specials excluded');
  assert.deepEqual(
    out.map((s) => [s.n, s.checked, s.disabled, s.note]),
    [
      [1, false, true, 'in Plex'],
      [2, false, true, 'in Plex'],
      [3, true, false, null],
      [4, true, false, null],
      [5, true, false, null],
    ]
  );
});

test('seasonDefaults: requested seasons disabled with note', () => {
  const out = S.seasonDefaults({
    seasons: [{ seasonNumber: 1, episodeCount: 8 }, { seasonNumber: 2, episodeCount: 8 }],
    mediaInfo: { seasons: [{ seasonNumber: 1, status: 3 }] },
  });
  assert.deepEqual(out[0], { n: 1, checked: false, disabled: true, note: 'requested' });
  assert.equal(out[1].checked, true);
});

test('seasonDefaults: no mediaInfo -> everything checked', () => {
  const out = S.seasonDefaults({
    seasons: [{ seasonNumber: 1, episodeCount: 8 }],
  });
  assert.deepEqual(out, [{ n: 1, checked: true, disabled: false, note: null }]);
});

test('seasonDefaults: zero-episode seasons skipped', () => {
  const out = S.seasonDefaults({
    seasons: [
      { seasonNumber: 1, episodeCount: 0 },
      { seasonNumber: 2, episodeCount: 6 },
    ],
  });
  assert.deepEqual(out.map((s) => s.n), [2]);
});

// ---------------------------------------------------------------- Task 4

function memCache(opts = {}) {
  let store;
  let t = 1000;
  const c = S.makeCache({
    load: () => store,
    save: (v) => (store = v),
    now: () => t,
    cap: opts.cap ?? 500,
    ttlMs: opts.ttlMs ?? 3600e3,
  });
  return { c, tick: (ms) => (t += ms) };
}

test('cache: set/get roundtrip', () => {
  const { c } = memCache();
  c.set('imdb:tt1', { tmdbId: 278, status: 5 });
  assert.deepEqual(c.get('imdb:tt1'), { tmdbId: 278, status: 5 });
});

test('cache: expires after ttl', () => {
  const { c, tick } = memCache({ ttlMs: 100 });
  c.set('k', 1);
  tick(99);
  assert.equal(c.get('k'), 1);
  tick(2);
  assert.equal(c.get('k'), undefined);
});

test('cache: LRU eviction at cap, get refreshes recency', () => {
  const { c } = memCache({ cap: 3 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.get('a'); // refresh a
  c.set('d', 4); // evicts b
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('d'), 4);
});

test('cache: invalidate removes entry', () => {
  const { c } = memCache();
  c.set('k', 1);
  c.invalidate('k');
  assert.equal(c.get('k'), undefined);
});

// ---------------------------------------------------------------- Task 6

function fakeTransport(routes) {
  const calls = [];
  const fn = (method, url, body) => {
    calls.push({ method, url, body });
    for (const [pat, resp] of routes) {
      if (url.includes(pat)) {
        return typeof resp === 'function' ? resp() : Promise.resolve(resp);
      }
    }
    return Promise.reject(new Error('unrouted ' + url));
  };
  fn.calls = calls;
  return fn;
}

test('client: resolve is one call, uri-encoded prefixed query', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: { results: [{ id: 278, mediaType: 'movie', mediaInfo: { status: 5 } }] },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('imdb:tt0111161');
  assert.equal(r.id, 278);
  assert.equal(t.calls.length, 1);
  assert.ok(t.calls[0].url.includes('query=imdb%3Att0111161'));
});

test('client: resolve on PENDING media fetches details for requests[]', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: { results: [{ id: 60059, mediaType: 'tv', mediaInfo: { status: 3 } }] },
    }],
    ['/api/v1/tv/60059', {
      status: 200,
      json: { mediaInfo: { status: 3, requests: [{ id: 7, status: 4, is4k: false }] } },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('imdb:tt0903747');
  assert.equal(t.calls.length, 2);
  assert.equal(r.mediaInfo.requests[0].status, 4);
});

test('client: resolve honors mediaType hint (tmdb id collision)', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: {
        results: [
          { id: 278, mediaType: 'movie', mediaInfo: { status: 1 } },
          { id: 278, mediaType: 'tv', mediaInfo: { status: 1 } },
        ],
      },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('tmdb:278', 'tv');
  assert.equal(r.mediaType, 'tv');
});

test('client: resolve skips person results', async () => {
  const t = fakeTransport([
    ['/api/v1/search', {
      status: 200,
      json: {
        results: [
          { id: 1, mediaType: 'person' },
          { id: 2, mediaType: 'movie', mediaInfo: { status: 1 } },
        ],
      },
    }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  const r = await client.resolve('imdb:nm0000001');
  assert.equal(r.mediaType, 'movie');
});

test('client: fast-path body has userId, never profileId', async () => {
  const t = fakeTransport([
    ['/api/v1/request', { status: 201, json: { id: 1 } }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  await client.request({ mediaType: 'movie', mediaId: 278 });
  const body = t.calls[0].body;
  assert.equal(body.userId, 3);
  assert.ok(!('profileId' in body));
  assert.ok(!('serverId' in body));
  assert.ok(!('rootFolder' in body));
});

test('client: explicit options pass through', async () => {
  const t = fakeTransport([
    ['/api/v1/request', { status: 201, json: { id: 1 } }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  await client.request({ mediaType: 'tv', mediaId: 60059, seasons: [3, 4], profileId: 7, is4k: true });
  const body = t.calls[0].body;
  assert.equal(body.profileId, 7);
  assert.deepEqual(body.seasons, [3, 4]);
  assert.equal(body.is4k, true);
});

test('client: 202 is a noseasons FAILURE, not success', async () => {
  const t = fakeTransport([
    ['/api/v1/request', { status: 202, json: { message: 'No seasons available to request' } }],
  ]);
  const client = S.makeClient({ cfg, transport: t });
  await assert.rejects(
    () => client.request({ mediaType: 'tv', mediaId: 1, seasons: [1] }),
    (e) => e.kind === 'noseasons'
  );
});

test('client: 409 -> duplicate, 403 -> auth, transport reject -> offline', async () => {
  for (const [status, kind] of [[409, 'duplicate'], [403, 'auth'], [401, 'auth']]) {
    const t = fakeTransport([['/api/v1/request', { status, json: {} }]]);
    const client = S.makeClient({ cfg, transport: t });
    await assert.rejects(
      () => client.request({ mediaType: 'movie', mediaId: 1 }),
      (e) => e.kind === kind
    );
  }
  const t = fakeTransport([['/api/v1/request', () => Promise.reject(new Error('net'))]]);
  const client = S.makeClient({ cfg, transport: t });
  await assert.rejects(
    () => client.request({ mediaType: 'movie', mediaId: 1 }),
    (e) => e.kind === 'offline'
  );
});
