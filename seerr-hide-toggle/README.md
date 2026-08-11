# Seerr - Hide Requested/Available Toggle

Three compact icon toggles injected into [Seerr](https://github.com/seerr-team/seerr)'s
discover/home pages: **Hide Requested**, **Hide Available**, and **Hide
Deleted**. Each toggle is a replica of the exact status badge it hides —
the same colored circle and icon Seerr puts on cards (indigo clock =
requested, green check = available, red trash = deleted) — with a white
slash struck through it while hiding is on, plus a live count in a
fixed-width slot so the toggles never change shape. Hovering shows an
instant, large tooltip (no native-tooltip delay). A notice appears if a grid ends up fully hidden, and toggling
in one Seerr tab syncs to any others.

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

Seerr renders card status through its `StatusBadgeMini` component: indigo =
processing, yellow = pending, green = available *and* partially available
(detail pages use a separate `StatusBadge` component with the same color
families but different border shades). This script matches by color
**family** (`bg-indigo`, `bg-yellow`, `bg-green`) rather than an exact
class name, which covers both components and can't regress if either
shifts a shade in a future Seerr version.

**Hide Requested** hides both processing and pending items (indigo or
yellow badge) — an earlier version of this script only matched indigo,
which silently missed anything that had been requested but wasn't yet
processing. **Hide Available** hides both fully- and partially-available
items (both render the same green badge in Seerr). **Hide Deleted** hides
red deleted badges only — blocklisted titles also render red, but the
deleted badge alone carries `text-red-100` (blocklist uses `text-white`),
which is the discriminator, so blocklisted items are never hidden by
mistake.

## Roadmap

Not-yet-built ideas live in [ROADMAP.md](ROADMAP.md).

## Development

```
node --test 'test/*.test.js'
```

16 unit tests cover the color-matching logic (with fixtures mirroring
Seerr's real `StatusBadgeMini`/`TitleCard` class strings verbatim),
deleted-vs-blocklisted discrimination, the tooltip text, the filter-button
finder, and the debounce helper, no DOM or browser needed. The embedded
heroicons SVG paths are diffed byte-for-byte against upstream heroicons.

`harness/index.html` is a static mock of Seerr's filter bar and card grid
(GM_* stubbed, badge class strings verbatim from `StatusBadgeMini`) for
eyeballing the toggles, tooltip, and hide behavior without touching a real
instance — serve the repo root over HTTP and open it. It never talks to a
Seerr server.
