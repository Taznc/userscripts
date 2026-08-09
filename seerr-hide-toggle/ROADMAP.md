# Roadmap

Not built yet — ideas surfaced while reviewing the script, kept here rather
than implemented unprompted since they're taste calls, not bugs.

- [ ] **Hidden-count feedback.** Buttons currently show `Hide Requested: ON`
      / `OFF`. Show how many cards are actually hidden, e.g.
      `Hide Requested: ON (12 hidden)`, so the toggle's effect is visible
      even on pages where it's not obvious at a glance.

- [ ] **Empty-state message.** If the active toggle combination hides every
      card on the current page, the grid just goes blank with no
      explanation. Show a small message instead (e.g. "Nothing to show —
      try turning off a filter").

- [ ] **Third toggle for Blocklisted items.** Seerr has a `BLOCKLISTED`
      media status (red badge) that neither existing toggle touches —
      found while reading `StatusBadge`/`Badge` source for the color-match
      fix. Only worth adding if blocklisting is something you actually use.

- [ ] **Match Seerr's own button styling.** The toggle buttons use
      hardcoded `rgba()` colors rather than Seerr's actual design tokens.
      Lower priority — needs more source digging to get the exact values
      right, and the current styling already looks reasonable against
      Seerr's dark theme.
