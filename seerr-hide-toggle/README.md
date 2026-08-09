# Seerr - Hide Requested/Available Toggle

Two small toggle buttons injected into [Seerr](https://github.com/seerr-team/seerr)'s
discover/home pages: **Hide Requested** and **Hide Available**. Flip one on
and matching cards disappear from the grid — useful for browsing only what
you don't already have.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open `seerr-hide-toggle.user.js` — drag it into the browser, or paste it
   into Tampermonkey → Create new script.
3. Visit your Seerr instance. Click the Tampermonkey icon → **"Set this
   site as my Seerr instance"** → confirm the prompted hostname → reload.

The script matches every site (`@match *://*/*`) but only Tampermonkey's
menu command actually configures where it does anything — your real
hostname is stored in Tampermonkey's own storage, never in the script file.
This is deliberate: Tampermonkey overwrites the *entire* script, metadata
included, on every auto-update
([confirmed behavior](https://github.com/Tampermonkey/tampermonkey/issues/2405)),
so a hardcoded personal domain would get silently wiped back to a
placeholder the next time this repo pushes an update. On every other site
the script does one hostname check and exits — negligible cost, no UI, no
observer.

Two buttons appear next to the filter bar (or in the search bar on pages
without one) once you're on the configured host.

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

## Roadmap

Not-yet-built ideas live in [ROADMAP.md](ROADMAP.md).

## Development

```
node --test 'test/*.test.js'
```

12 unit tests cover the color-matching logic, the host-gate, the filter-
button finder, and the debounce helper, no
DOM or browser needed. There's no browser harness for this script (unlike
`seerr-request/`) — it manipulates your own private, authenticated Seerr
instance, which isn't something to script fetches against from outside.
