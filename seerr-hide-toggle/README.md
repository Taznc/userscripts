# Seerr - Hide Requested/Available Toggle

Two small toggle buttons injected into [Seerr](https://github.com/seerr-team/seerr)'s
discover/home pages: **Hide Requested** and **Hide Available**. Flip one on
and matching cards disappear from the grid — useful for browsing only what
you don't already have.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open `seerr-hide-toggle.user.js` — drag it into the browser, or paste it
   into Tampermonkey → Create new script.
3. In Tampermonkey's Dashboard, click the script's name to open it, switch
   to the **Settings** tab, and add your real Seerr URL (e.g.
   `https://seerr.example.com/*`) under **User matches**.
4. Reload your Seerr instance. Two buttons appear next to the filter bar
   (or in the search bar on pages without one).

**Don't edit the `@match` line in the script itself** — it ships with a
placeholder domain on purpose. Tampermonkey's auto-update replaces the
*entire* script file, metadata included, on every version bump
([confirmed behavior](https://github.com/Tampermonkey/tampermonkey/issues/2405)),
so an in-place edit would silently revert to the placeholder on the next
update and the script would stop running with no warning. "User matches"
(step 3) is Tampermonkey's own per-installation setting, layered on top of
the script rather than living inside it, so it survives updates. It also
means the script is genuinely never injected into any other page — not
"runs but does nothing," simply not present there at all.

*(Violentmonkey users: look for the equivalent per-script include/match
override in its own script-settings UI — the exact location differs from
Tampermonkey's, but the same "don't hardcode it in the script body"
reasoning applies.)*

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

11 unit tests cover the color-matching logic, the filter-button finder, and
the debounce helper, no DOM or browser needed. There's no browser harness for this script (unlike
`seerr-request/`) — it manipulates your own private, authenticated Seerr
instance, which isn't something to script fetches against from outside.
