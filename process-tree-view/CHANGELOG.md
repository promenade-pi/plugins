# Changelog

## 0.1.5 — 2026-08-23

- Replaced "Show silent steps" (hide tau leaves entirely) with "Compact
  silent steps" (shrink and mute them instead). A tau leaf is what makes an
  XOR branch optional or a loop 0..* vs 1..* rather than mandatory —
  removing it left the operator with one child and no visual trace anything
  was hidden, silently misrepresenting the model's actual language rather
  than just decluttering the drawing.

## 0.1.4 — 2026-08-17

- Renamed the view "Process tree" → "Process Tree", matching the artifact
  type's own casing — the two sat right next to each other in the tree,
  reading as two different things.

## 0.1.3 — 2026-08-16

- Ships this changelog as its own tab in the plugin's detail panel.

## 0.1.2 and earlier

Version history before this file was introduced is not tracked.
