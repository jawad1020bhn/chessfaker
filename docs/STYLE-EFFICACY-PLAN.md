# Style Efficacy — Analysis & Plan (v13.1.0)

> **STATUS UPDATE (v13.2.0): Phase 1 and Phase 2 are IMPLEMENTED.**
> Measured with the same harness (`node scripts/style-efficacy-probe.mjs`):
>
> | Gate | Result |
> |---|---|
> | Opening sanity (O-O/d3/Nc3 class ≥ 80%) | **PASS** — ultra picks O-O; Ng5?! 0/24 across the whole opening sweep (was picked always) |
> | No uncompensated pick below −450cp | **PASS** — desperate −1050cp sac vetoed; a −140cp queen sac without a mechanism is vetoed too |
> | Persona preserved (Greek gift in equal positions) | **PASS** — Bxh7+ (−30cp, in-character) still chosen over quiet best |
> | Mate preservation / winning conversion | **PASS** — unchanged, all modes |
> | Strength slider 600 vs 1600 differentiation ≥ 4× | **PASS** — 8/24 vs 2/24 non-best (33%→8%, matching HumanForm's 38%/7% anchors; every slip is a sound 2cp Nc3) |
> | Persona active on single-line sources | **PASS** (service-worker verified) — styled routing puts multi-PV cloud-eval first; chess-api answers are widened with a local pool (`poolExpanded` flag + UI caption) |
>
> **Phase 3 completed (v13.6.0):** Auto aggression — the dial defaults to
> Auto and scales with the opponent rating detected by the board reader
> (<800 → III, ≤1200 → II, else I; fallback II); per-game "Aggression
> cost" telemetry (eval paid vs objective best + which principles fired)
> surfaced as a fact row and reset per game.
>
> **Six classical attacking principles (v13.5.0):** storm-with-tempo,
> storm-vs-uncastled, pawn-sac-for-initiative, castling denial (rook
> capture / path attack / check), line-opening trades, mobilize-when-
> stalled, and a hard no-queen-trades gate (conversion/mate/material
> escapes) — all detector+weight+regression-tested on legality-verified
> positions (tests/attack-principles.test.js).
>
> **Single-persona product (v13.4.0):** the Normal and Aggressive styles
> were removed from the product; Ultra Attack is the only style, scaled by a
> three-level aggression dial (I Sound Storm / II Ultra Attack / III Max
> Chaos) that adjusts risk budgets (×0.6 / ×1 / ×1.5), opening cost caps
> (30/40/60cp), variety and conversion onset. Aggressive's bequest was
> ported first: winning-conversion mode (counterplay trades become bonuses
> in won positions, hard-capped at 120cp and never leaving the winning
> class), a tighter winning budget (40cp), and `unsupportedAttack −30`.
> Verified: in a won position the persona now picks the −50cp killing trade
> and rejects the −250cp one; while equal it gives nothing away. The
> objective profile survives internally (`PLAYING_STYLES.normal.internal`)
> as the dormant low anchor. Legacy settings migrate (normal/aggressive →
> Level I). Phase 3's opponent-rating detection and aggression-cost readout
> remain open.
>
> **Phase 4 (pool quality) is also implemented (v13.3.0):** Masters/book
> PVs are tagged `scoreType: 'book'` and ranked in their own lane (a pure
> book pool ranks by curated order; in mixed pools the book lane is
> appended ineligible, so win-rate-derived scores can never outvote engine
> cp — verified: a fake +500 "book" score loses to a +30 engine line);
> sealing preserves the book type and its metadata. The local fallback
> engine gained a king-safety eval term (pawn shield + uncastled penalty,
> queen-gated) and honest PV replies (the opponent answer used to be an
> arbitrary first legal move). A hand-verified owned repertoire
> (`engine/attack-book.js`, 9 attacking lines, moves 1–6, every SAN/UCI
> pair machine-checked) now answers before the local engine when every
> cloud provider is silent and the Ultra persona is active — out of book
> or another style, it defers cleanly. Verified through the real service
> worker (masters→book lane; denial+ultra→`c3` Italian build-up; normal
> style→local engine).
>
> Implementation: ultra bonuses scaled ×0.125 with lossWeight 0.62→1.0;
> budgets 60/120/200/300/450 + verified-compensation escape (sacMechanism +
> mate/forcing, capped 450); class-collapse guard (≥2 classes); opening
> sanity window (moves ≤ 8, quiet positions, ≤40cp without a trap — Scholar/
> Legal/Lasker traps and the opted-in Early King Hunt are exempt); castling
> incentive + opening phase damping 1.25→0.6; `ownKingDanger` −5→−60;
> relative shortlist margins (max(absolute, 12% of top, 4× cap)). Phases 3–4
> remain open.


**Question:** does the extension deliver a *real* "Ultra Super Aggressive Attack", with
proper variation of strength and modes?

**Method:** the decision layer (`selectPVForStyle` + `styleSafetyAllows` +
`candidateStyleBonus`) was driven directly with python-chess-verified positions and
realistic candidate pools (simulated cloud multi-PV output), across all styles ×
human-mode ratings × add-ons. Reproduce with `node scripts/style-efficacy-probe.mjs`.
Code-level claims cite file/line evidence.

---

## 1. How the decision actually works

```
styleScore = attackBonus − evalLoss × lossWeight      (hint-engine.js:1632-1635)
lossWeight: normal 1.5 · aggressive 1.25 · ultra 0.62
eligibility: styleSafetyAllows → riskBudget gate      (:1441-1452, :1529-1542)
budget (ultra): winning 200 · advantage 350 · equal 600 · worse 850 · desperate 1200 cp
mate lock: if the objective best is a winning mate, only other mates are eligible ✓
```

## 2. Verified behavior (harness results)

| Scenario | normal | aggressive | ultra |
|---|---|---|---|
| Greek gift equal (best +40, Bxh7+ sac +10) | d4 (best) | **Bxh7+** (−30cp) | **Bxh7+** (−30cp) |
| Mate-in-2 vs +800 material | #2 ✓ | #2 ✓ | #2 ✓ |
| Won endgame: simplifying trade | trade ✓ | trade ✓ | trade ✓ |
| Italian opening (O-O +30, Ng5 −60) | O-O | Nc3 (−5cp) | **Ng5?! (−90cp)** |
| Desperate (best −350, unsound sac −1400) | defense | defense | **unsound sac (−1050cp)** |

Human-mode strength sweep (same pools): **600 / 1100 / 1600 pick identically,
24/24 positions, identical eval cost.** Early-King-Hunt add-on: no effect in
these positions (narrow gating by design).

## 3. What genuinely works

- **The style ladder is real** at the budget level: normal pays 0, aggressive
  pays ≤85cp for forcing play, ultra pays up to its budget. In equal middlegames
  with a genuine attack available, ultra *does* choose attractive, in-character
  attacking chess at a defensible ~30cp practical price (Bxh7+ over a quiet best).
- **Mate preservation is bulletproof** — all modes, including human slips.
- **Winning conversion is not sabotaged** by the simplification penalty (trades
  into won endgames still rank first).
- Safety gates (invalid, mate-lock, own-king-trap, budget) run *before* style.

## 4. What is broken (ranked by impact)

### F1 — P0: single-PV blackout silently disables the persona
From move six onward `chess-api` is the *first* engine source
(api-coordinator.js:92-94), and `normalizeChessApi` produces exactly one PV
(background.js:511+). `selectPVForStyle` with `pvs.length === 1` returns the raw
line — **no ranking, no annotation** (hint-engine.js:1562-1564). So in the exact
middlegame/endgame phases the persona is built for, the flagship style is usually
**off**, and it is on only when Lichess cloud-eval happens to cover the position
(multi-PV) — i.e. coverage is best in *popular* positions and worst in the
offbeat lines the persona itself creates. Self-amplifying degradation.

### F2 — P0: the strength slider is a placebo
HumanForm (600–1600) is carefully calibrated (margin/naturalness/slip), but the
shortlist it operates on is starved: `shortlistMargin = 90 × marginScale ≈
63–130` style-points, while ultra's bonus scale produces top-2 gaps of 500–2000+
(bonuses measured at 1008–2563 in the harness). Shortlist = 1 candidate → C2
slips can never fire. Measured: identical picks at every rating, 24/24.

### F3 — P0: bonus inflation makes the cost function meaningless for ultra
Ultra bonuses (engine adds + Chaos + phase caps that don't bind: synergyCap =
sacrificeTolerance×6 = 9000) run to ~1000–2500cp against `lossWeight 0.62`.
Eval loss is noise; the **budget is the only real brake**, and equal=600 /
worse=850 / desperate=1200 are poker-sized. Result: the −1050cp unsound sac in
the desperate scenario sailed through on generic "check + forcing + defender
removal" reasons — no compensation requirement.

### F4 — P1: opening play discredits the persona
`Ng5?!` (−60cp) chosen over O-O/d3 on move 4; `ownKingDanger` weight is **−5**
(the persona basically never values castling), opening phase damping is ~16%
only (phaseMult 0.8+base×0.3). The module's own manifesto ("sound setup first")
is not enforced.

### F5 — P1: no strength axis for the persona itself
"vs ≤1100" is hard-coded in persona flavor text. No dial for ultra-lite against
stronger opponents. Quality (fast/balanced/deep) and candidate-lines (3/5)
change *objectivity*, not aggression.

### F6 — P2: desperate mode is unbounded swindle
`sacMechanism` (deflect/lineOpen/tempo) classification exists but only
re-weights; it never vetoes. Combined with F3, "desperate" accepts any attack-flavored
move regardless of compensation.

### F7 — P2: pool conflation
Masters-explorer book win-rates are fed to the same ranker as engine cp evals
early in games; local fallback pools (depth 4–6 alpha-beta) have noisy evals the
style then confidently ranks.

## 5. Plan

### Phase 1 — Make the persona actually fire (P0)
1. **Styled routing**: when style ≠ normal, order engine sources
   `lichess-cloud → chess-api`; keep sequential failover. If the winner is
   single-PV chess-api anyway, (a) surface `limitedCandidates` in the panel
   ("Style paused — single analysis line"), and (b) expand the pool locally:
   take the chess-api move + top-K root moves from `local-engine.js` (already
   multi-PV capable, engine/local-engine.js:235) as a bounded *candidate*
   pool clearly tagged lower confidence.
2. **Un-starve the strength slider**: shortlist margin must be *relative*
   (e.g. top-2 gap ≤ max(120, 12% of |top styleScore|)) or styleScores must be
   normalized (rank/z-score) before HumanForm applies. Acceptance: 600 vs 1600
   produce measurably different slip rates (~35% vs ~7% non-best picks).
3. **Re-scale ultra bonuses** (÷8–10, into aggressive's magnitude) and raise
   `lossWeight` to ~1.0 so eval cost participates again. Budgets stay as the
   hard gate.

### Phase 2 — Chess sanity (P1)
4. **Budget reform + verified-compensation escape**: defaults
   winning 60 / advantage 120 / equal 200 / worse 300 / desperate 450; exceeding
   a budget is allowed *only* when the candidate carries a concrete sac mechanism
   (`sacMechanism ∈ deflect/lineOpen/tempo`) **and** a forced mate threat or
   winning continuation in its PV. Sound sacs pass (Bxh7+ with follow-up), unsound
   ones (the −1050cp case) don't.
5. **Class-drop guard**: never pick a move that drops the win-probability class
   (winning→equal, equal→worse) unless a forced continuation exists.
6. **Opening sanity**: `ownKingDanger −5 → −60` while uncastled; add a castling /
   quiet-development incentive for moves 1–8; opening phaseMult 0.8 → ~0.6.
   Acceptance: in the Italian pool, ultra chooses O-O/d3-class moves ≥ 80%.
7. **Desperate cap**: ≤450cp loss + mechanism requirement (kills blind sacs,
   keeps real swindles).

### Phase 3 — Real strength & mode variation (product)
8. **Persona strength dial**: Aggression I/II/III (or opponent-rating bands
   ≤900 / ≤1100 / ≤1400 / open) as one parameter table in the Chaos profile —
   scales budgets, phaseAggressionScale, diversity, sacrificeTolerance.
9. **Human × style combos verified**: naturalness must actually reorder ultra's
   shortlist (re-measure after #3); document each mode combination in the UI.
10. **Opponent-aware default**: read the opponent's rating (both sites expose it
    in DOM) and suggest the persona strength; per-game "aggression index" and
    "eval cost of style picks" in the diagnostics panel so the tradeoff is
    visible, closing the feedback loop.

### Phase 4 — Pool quality (P2)
11. Local fallback: iterative-deepening root scores with king-safety-aware eval
    so fallback pools are trustworthy enough to style-rank.
12. Tag masters/book PVs as `scoreType: 'book'` and rank them in a separate
    lane instead of mixing win%-derived cp with engine cp.
13. Optional mini-book of owned attacking lines for ultra openings (moves 1–8
    pre-solved, no cloud dependency).

### Acceptance gates (same harness)
- Ultra picks O-O/d3-class in opening pool ≥ 80% (was 0%).
- No pick worse than −450cp without sacMechanism + mate threat (was −1050cp).
- 600 vs 1600 slip-rate difference ≥ 4× (was 0).
- Middlegame positions: persona active (pool ≥ 3) in ≥ 90% of turns
  (currently only when cloud-eval covers the position).
