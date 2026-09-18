# Changelog

## 0.2.3 — 2026-08-17

- Both actions now carry a `description` and agent notes (`whenToUse`,
  `notFor`, examples) in the manifest. The host forwards them to the
  Inspector's action tooltip and to `promenade_list_actions`, so an agent —
  or a reader hovering the row — learns what the miner is for and when it is
  the wrong choice, instead of inferring it from the label and the types.

- "Event limit"'s slider no longer goes up to 5,000,000 on a 561K-event log.
  It is now capped at whatever the selected log actually has, with a hint
  saying so — the old fixed ceiling had to be big enough for the largest log
  the host ever sees, which made it a meaningless upper bound on a smaller
  one (`maxFrom` in `ParamControls`).

## 0.2.2 — 2026-08-16

- Raised the "Event limit" safety ceiling (default 50,000 → 2,000,000, max
  500,000 → 5,000,000). At the old default, a log any larger than 50K events
  was silently mined from a truncated prefix — on a real-sized log this
  could drop an entire infrequent activity from the discovered model with no
  indication anything was cut.
- The result now says so when it happens: a truncated run is flagged
  (`truncated`, `totalEvents` in the artifact's stats), and the Inspector
  shows an explicit warning instead of a silently incomplete model.

## 0.2.1 — 2026-08-16

- Ships this changelog as its own tab in the plugin's detail panel.

## 0.2.0 and earlier

Version history before this file was introduced is not tracked.
