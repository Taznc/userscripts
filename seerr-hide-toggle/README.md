# Seerr - Hide Requested/Available Toggle

Two small toggle buttons injected into [Seerr](https://github.com/seerr-team/seerr)'s
discover/home pages: **Hide Requested** and **Hide Available**. Flip one on
and matching cards disappear from the grid — useful for browsing only what
you don't already have.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open `seerr-hide-toggle.user.js` — drag it into the browser, or paste it
   into Tampermonkey → Create new script.
3. **Edit the `@match` line** to your own Seerr URL — it ships with a
   placeholder (`https://your-seerr-domain.example/*`) on purpose, since
   this repo is public and your instance's address isn't. In Tampermonkey's
   editor, replace that one line with your real domain, e.g.
   `@match https://seerr.example.com/*`, then save.
4. Reload Seerr. Two buttons appear next to the filter bar (or in the
   search bar on pages without one).

## How status is detected

Seerr renders a colored badge per title: indigo/primary = processing,
yellow/warning = pending, green/success = available *and* partially
available. This script matches by color **family** (`bg-indigo`,
`bg-yellow`, `bg-green`) rather than an exact class name, since the precise
shade and opacity-class syntax have varied across Seerr versions — a prefix
match can't regress when your instance updates, only gain coverage back if
something ever changes.

**Hide Requested** hides both processing and pending items (indigo or
yellow badge) — an earlier version of this script only matched indigo,
which silently missed anything that had been requested but wasn't yet
processing. **Hide Available** hides both fully- and partially-available
items (both render the same green badge in Seerr).

## Development

```
node --test 'test/*.test.js'
```

8 unit tests cover the color-matching logic and the debounce helper, no
DOM or browser needed. There's no browser harness for this script (unlike
`seerr-request/`) — it manipulates your own private, authenticated Seerr
instance, which isn't something to script fetches against from outside.
