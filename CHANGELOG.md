# Changelog

## 9.2.0 — Chaos Attack

### Position integrity
- Prefer site-provided FEN data in the page main world and preserve authoritative state fields.
- Propagate position and turn reliability through the analysis workflow.
- Withhold automatic analysis when the active turn cannot be verified.

### Chaos Attack style
- Reworked the former Super Ultra Aggressive profile as **Chaos Attack**.
- Added attack-first scoring for forcing play, king pressure, deep penetration, pawn storms, and concrete sacrifices.
- Added dynamic risk budgets that expand when the evaluated position worsens.
- Added attack-feature deltas, so a move is rewarded for creating pressure rather than inheriting an existing attack.
- Preserved forced-mate priority and added a mate-safe repertoire preference regression test.

### Interface
- Added position source and turn-status context to the side panel.
- Added compact Chaos Attack risk and rationale explanations.
- Added Safe / Bold / Wild labels for available MultiPV candidate comparisons.
- Refined side-panel spacing, tabs, settings hierarchy, and responsive layout.

### Security and reliability
- Normalized persisted settings at the worker boundary.
- Removed unnecessary web-accessible resources.

## 9.1.0 — Tournament Obsidian
- DGT Slate visual redesign, evaluation gauge, and analytical UI updates.
