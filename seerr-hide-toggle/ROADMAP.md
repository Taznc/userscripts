# Roadmap

Not built yet — ideas surfaced while reviewing the script, kept here rather
than implemented unprompted since they're taste calls, not bugs.

- [x] **Hidden-count feedback.** ~~Buttons currently show `Hide Requested:
      ON` / `OFF`.~~ Shipped in v1.4.0: buttons show
      `Hide Requested: ON (12 hidden)` with live per-toggle counts.

- [x] **Empty-state message.** ~~If the active toggle combination hides
      every card on the current page, the grid just goes blank with no
      explanation.~~ Shipped in v1.4.0: a dashed-border notice appears
      under any vertical grid whose cards are all hidden by the toggles.

- [x] **Third toggle for Blocklisted items.** Shipped in v1.5.0: hides
      `BLOCKLISTED` (red badge) titles, discriminated from `DELETED`
      (also red) via the `text-white` class only the blocklist badge
      carries in `StatusBadgeMini`.

- [x] **Match Seerr's own button styling.** Addressed in v1.5.0 by the
      icon redesign: each toggle is now a replica of the exact
      `StatusBadgeMini` badge it hides — same status colors
      (indigo/green/red at the badge's own values) and the same heroicons
      Seerr uses (clock, check, eye-slash), with a slash struck through
      when hiding is on.
