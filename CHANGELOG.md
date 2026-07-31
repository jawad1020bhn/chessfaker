# Changelog

## 9.2.1 — Chaos Attack Berserker vocabulary

### Chaos Attack style
- Grafted the Berserker aggression vocabulary into the principled feature-delta model:
  - **Attack Unit System** (A1): king-zone attacker quality weighted by piece type with an S-curve bonus, plus an `attackUnitDelta` feature.
  - **Practical chances** (A2): reward moves that out-number the enemy defenders in the king zone.
  - **Structural complexity** (A3): bonus for sacrifices and central pawn advances, penalty for even minor/rook trades.
  - **Greek Gift** (A4): explicit `Bxh7+`/`Bxh2+` recognition near a castled king.
  - **Draw contempt** (A5): penalize near-equal (±50cp) calm positions to seek complications.
  - **Overload exploitation** (A6): capture a king defender or land where enemy pieces cluster.
  - **Tempo-with-threats** (A7): develop-with-attack and multi-threat tempo counting.
  - **Phase-aware scaling** (A8): `phaseAggressionScale` multiplies the Chaos budget by middlegame/opening/endgame phase.
  - **Bonus cap** (A9): a hard secondary ceiling (`6 × sacrificeTolerance`) so a stacked move can't run away with the score.
- Two-phase selection (C1): budget-eligible Chaos candidates are tie-broken by concrete attack facts (king pressure + penetration + pawn storm) before human-naturalness.
- Added Chaos-only annotations: `greek gift`, `overload`, `practical chances`, `storm the king`.
- All additions feed the existing `chaosSacrificeTrigger` gate and risk budget — no guardrail bypass.

### Fixes (deep-scan review)
- **Lichess Cloud eval normalization**: cloud-eval `cp`/`mate` is reported relative to the
  side to move (UCI convention), but the pipeline treats every `pv.score` as White-relative.
  Black-to-move positions had inverted evaluations, eval-bar, move ranking, and move
  classification. Scores are now flipped to White's perspective on import.
- **Chess-API mate consistency**: chess-api.com reports `eval`/`centipawns`/`mate` from
  White's perspective, but the mate path was re-flipped for black-to-move while the
  centipawn path was not. The mate path now stays White-relative and matches the
  centipawn path and the rest of the pipeline.
- **Greek Gift (Black)**: the Black `Bxh2+` detection tested the enemy king for a
  queenside column, so a Black Greek gift against a White king castled on g1/h1 was
  never recognized. Both colors now detect the castled-kingside pattern correctly.

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
