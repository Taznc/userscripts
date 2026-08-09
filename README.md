# userscripts

Personal collection of browser userscripts (Tampermonkey/Violentmonkey). Each
lives in its own folder with its own README, tests, and history.

No script in this repo ever stores credentials, tokens, or API keys in
source. Anything that needs one (an API URL, a key) is entered at runtime
through the script's own settings UI and kept in the userscript manager's
local storage on your machine — never committed here.

## Scripts

- [`seerr-request/`](seerr-request/) — request movies & TV in
  Overseerr/Jellyseerr/Seerr directly from IMDb, TMDb, and Trakt, with
  library status badges, one-click request/cancel, and season pickers for TV.
- [`seerr-hide-toggle/`](seerr-hide-toggle/) — toggle buttons on
  [Seerr](https://github.com/seerr-team/seerr)'s own discover pages to hide
  already-requested or already-available titles.

## Adding a new script

Give it its own folder (`your-script/your-script.user.js`, plus whatever
tests/docs make sense for it). No shared build step or dependency between
scripts — each folder is self-contained and installable on its own.
