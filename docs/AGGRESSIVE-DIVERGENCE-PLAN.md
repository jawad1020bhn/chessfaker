# Aggressive Divergence, Human-Mode Removal & Settings Slimdown — Analysis & Plan

> **Scope:** turn the "aggressive" style from a *re-ranker of Stockfish's own
> moves* into a *move generator with an attacking objective* — so its hints are
> genuinely different from standard engine play — then retire Human/Sparring
> mode (redundant once divergence is real) and cut the settings surface down to
> almost nothing.
>
> **Status:** analysis + plan only. No code changed yet. Files referenced by
> symbol and line at the time of writing (v14.0.0 tree, `main` @ `0c26a3d`).

---

## 0. TL;DR — the three decisions

1. **Why it "still gives Stockfish moves":** the style layer is a *filter*, not
   a *generator*. It can only re-rank the ≤5 lines the cloud engine returns
   (`selectPVForStyle` → `selectEngineLane`, `engine/hint-engine.js:1820/1838`).
   Moves Stockfish would never surface in its top lines (h4/g4 pawn storms,
   Ng5 raids, Greek-gift sacs) are simply **not in the pool**, so no amount of
   bonus tuning can select them. The fix is to **generate attacking candidates
   ourselves** (style-directed local search + attack book + legal-move
   sweep) and let the *existing, already-gated* safety layer decide how far we
   may diverge. The aggressive style becomes a real search objective, not a
   re-score.

2. **Human/Sparring mode becomes redundant → remove it.** Its only job was to
   make an otherwise-Stockfish engine feel weaker/more human. Once the
   aggressive style is deliberately *different* (not weaker), the Engine/Human
   switch, Sparring-strength slider, sparring strictness, the `HumanForm`
   module and the correlation "copying" machinery are all deleted. One style
   axis survives: **Objective vs Aggressive**.

3. **Settings shrink to the minimum.** The user-facing sheet goes from ~18
   controls to **Style (2 options) + Theme + read-only provider pulse**. The
   aggression dial, Early King Hunt, book-first, quality, candidate-lines,
   threat/critical-moment and source toggles become internal, always-on
   behaviors.

---

## 1. Diagnosis — the root-cause chain (why it's still Stockfish)

Traced end-to-end, the reason is structural, not a matter of weight tuning:

1. **The decision layer only ever sees engine outputs.**
   `generateHints` → `selectPVForStyle` → `selectEngineLane`
   (`engine/hint-engine.js:1820,1838`) operate exclusively on the `pvs` array
   the provider returned. `analyzeCandidate` (`:1217`) only *annotates* moves
   already in that list; nothing in the pipeline **generates** a move. The
   style is defined by `candidateStyleBonus` (`:1420`) — an additive score over
   features of an existing candidate.

2. **The candidate universe is the engine's top-5.**
   `clampMultiPvForSource` caps every source at 5 (`background.js:1029`):
   chess-api `variants` (`:604`), lichess cloud-eval `multiPv` (`:714`),
   masters `moves` (`:789`). Stockfish's top-5 lines at depth are almost always
   a tight cluster around the best (quiet central) move. "Most aggressive of
   the top-5" therefore collapses to "the best, or the second-best" — which is
   exactly the user's report: *aggressive == stockfish with a different
   caption*.

3. **Single-PV sources short-circuit the whole style.**
   `selectEngineLane` early-returns the raw line when `pvs.length === 1`
   (`:1841`), so a chess-api answer disables the persona outright. The
   mitigation (`widenSingleLinePool`, `background.js:1125`) fills the pool with
   **local-engine top-K** — but the local engine is *also* objective
   (`engine/local-engine.js`: material + PST + king-safety, iterative deepening,
   returns objective top-K). So even the widened pool is another cluster around
   the best move.

4. **The owned attack book is only a last-resort fallback.**
   `buildAttackBookResult` (`background.js:1071`) fires *only when every cloud
   source is silent*, and only covers moves 1–6. Its genuinely attacking lines
   (Fried Liver, Smith-Morra, Milner-Barry, …) never participate when the
   cloud is up — which is precisely when the user is playing.

5. **Historical pendulum explains the current tame default.** The earlier
   efficacy plan (`docs/STYLE-EFFICACY-PLAN.md`) fought bonus inflation that let
   a −1050cp sac through; the rescue (v14) re-scaled bonuses to ×0.125,
   `lossWeight` to 1.0 and tightened budgets to 40/120/200/300/450. Net effect:
   the safety layer is excellent and well-tested (`styleSafetyAllows`,
   `:1575`), **but it now has nothing real to approve** — the pool it gates was
   already the engine's own top-5. Safe, but indistinguishable.

**Conclusion:** every safety mechanism we need already exists and is tested.
The missing piece is a *source of legitimately different candidates*. That is
a smaller, safer change than any further weight tuning.

---

## 2. Target behavior — what "aggressive & different" must mean

Concrete, testable definition:

- **Divergent, not random.** In positions where a *sound* attacking move exists
  inside the risk budget, the aggressive style must frequently pick a move the
  cloud engine did not put first (or in its top lines at all), and must say
  *why* (the concrete attacking reason, surfaced in the caption rail).
- **Never dumb.** The existing invariants remain non-negotiable and become
  acceptance gates:
  - forced mate on the board → always take it (mate lock);
  - clearly won position → convert, never gamble the win class (win
    preservation, `styleSafetyAllows` F3/G1);
  - unsound sacrifices (no mechanism, no forcing continuation) → vetoed
    (desperate cap + `verifiedCompensation`, `:1557`);
  - own king boxed in → vetoed; opening quiet positions → develop/castle, not
    `Ng5?!` on move four.
- **Deterministic.** Same FEN + same settings → same hint. Divergence is a
  scored *property of the move*, never a random roll. (This is what finally
  separates "aggressive" from "sparring": sparring was *random weaker play*;
  aggressive is *deterministic different play*.)
- **Bounded cost, shown honestly.** The "Objective cost" caption already
  reports evalLoss vs the strongest line; it now also reports when the pick is
  deliberately *not* the engine's top move, so the divergence is legible.

---

## 3. Design — make the style a search objective

### 3.1 New module: `engine/attack-candidates.js`

A pure, dependency-light generator (classic global + CommonJS export, like
`chaos-attack.js`), loaded by the service worker. Input: FEN + player color +
opponent rating. Output: an ordered list of **root candidate moves with a
cheap feature tag** (`{ uci, tag, kind }`), deduped, capped (~12):

1. **Forcing moves** — every legal check and every capture (full enumeration
   via `AnalysisContract.generateLegalMoves`, already available).
2. **King-zone moves** — moves that land a piece within Chebyshev ≤2 of the
   enemy king, or that open a line to it.
3. **Storm moves** — pawn advances on the king-side files toward the enemy king
   (the h/g pawn pushes Stockfish rarely tops), and pawn advances that attack
   an enemy piece with tempo.
4. **Sacrifices** — captures with negative material where the target sits near
   the king zone (candidates for Greek gift / exchange sac / deflection).
5. **Fill** — the objective top moves from the cloud PVs (always included, so
   the lane can never *omit* the engine best; it can only *add*).

The tag (`check`, `capture`, `storm`, `kingzone`, `sac`, `dev`) drives both the
later scoring and the caption text. Nothing here is new chess knowledge —
every primitive (`generateLegalMoves`, `isSquareAttacked`,
`pieceAttacksSquare`) already exists in the tree.

### 3.2 Style-directed local search

Extend `engine/local-engine.js` with an **optional eval hook** so the same
alpha-beta can rank a candidate set by *aggression* instead of raw material:

- `analyze(fen, { multiPv, maxDepth, timeMs, style: 'attack' })` — when
  `style === 'attack'`, order/score leaf evals with an attack bias (the king-
  safety terms already in `local-engine.js` get an extra weight toward enemy-
  king pressure; a small bonus per our-check in the PV; a penalty for
  self-weakening unless it creates a threat). Crucially this is the *ranking*
  of the already-generated attack candidates, so it picks the most promising
  attacking line among them — it is not asked to be a full Stockfish.

- For each attack-lane candidate we get three numbers the safety layer needs:
  `evalLoss` (vs the cloud best, from the objective search), `forcingPly`
  (consecutive checks/captures in its PV), and the feature set (already
  produced by `analyzeCandidate`/`chaos-attack.js`). The objective search still
  exists untouched for the Normal lane and for eval-loss anchoring.

### 3.3 Attack-lane assembly (`background.js`)

In `_performCloudAnalysisInternal`, after the cloud result is sealed and
*before* returning it (i.e. only when `style === 'aggressive'`):

```
cloudPvs            ← sealed cloud result (objective reference, always first)
styledCandidates    ← AttackCandidates.rootCandidates(fen, color, rating)
                       each searched by LocalEngine.analyze(..., style:'attack')
bookHits            ← AttackBook.lookup(...)          (beyond the silent fallback)
lane                ← dedupe by uci: cloudPvs + bookHits + styledCandidates
result.pvs          ← lane, each tagged { _styleAnalysis: { … , candidateKind } }
result.poolExpanded ← true when styledCandidates contributed new moves
```

- **Normal mode is untouched** (spec 2.2.1 pass-through): no lane is built, no
  local search runs — the objective baseline stays exactly as gated today.
- The cloud line always stays `pv[0]` in the raw pool, so the eval bar, move
  classification and `objectiveBest` reference (`selectEngineLane`) are
  unchanged. The lane only *adds* options; it never reorders objective
  authority.
- Extra CPU is bounded and local (no new cloud calls; rate-limit posture is
  unchanged). The styled search runs with the same time/depth clamps the local
  engine already respects (`timeMs ≤ 1200`, `maxDepth ≤ 8`).

### 3.4 Selection change (`engine/hint-engine.js`) — bounded divergence

Two changes to `selectEngineLane`/`candidateStyleBonus`, kept small:

1. **Divergence premium.** Add one term to `candidateStyleBonus`, gated on
   concrete attacking evidence (never bare difference):

   ```
   divergence = (candidate first move != objectiveBest first move)
                AND candidate has ≥1 attacking feature
                (givesCheck | tempoThreatCount>0 | kingPressureDelta>0 |
                 pawnStormDelta>0 | sac-with-mechanism)
   → + weights.divergence  (same magnitude class as the other attack weights)
   ```

   The premium only helps a move that is *already* safe and already attacking;
   it tips a near-tie toward the attacking alternative, which is exactly the
   "customized, different" behavior asked for. It can never out-vote the hard
   gates (`styleSafetyAllows` runs first and is unchanged).

2. **Normalized cost so divergence can't inflate.** Replacing raw bonus
   magnitudes with a dimensionless trade-off avoids re-creating the old F3
   "bonus inflation makes evalLoss noise" failure:

   ```
   styleScore = wA · (attackBonus / max(1, |attackBonus|_norm))
              − wE · (evalLoss / budget)
   ```

   (`budget` = the tier budget from `riskBudgetFor`; the two terms now live on
   the same 0..1-ish scale, so "more attacking" and "more expensive" are
   directly comparable inside the budget window, and *outside* the budget the
   move is already vetoed by `styleSafetyAllows`.) Calibration is done once in
   the probe harness, not by hand-waving.

Everything else — `analyzeCandidate`, `styleSafetyAllows`,
`verifiedCompensation`, `riskBudgetFor`, the opening-sanity window, the
queen-trade veto, the mate lock — **stays as-is**. The aggressive style keeps
all the safety that v14 built; it just finally has real candidates to spend it
on.

### 3.5 Honest surface

- New caption kind `divergence`: "Not the engine's top move — X instead
  (costs Y cp), because <attacking reason>." Rendered in the existing
  "Why this move" rail (`sidepanel.js` caption pipeline is already generic).
- `poolExpanded` caption is reused to say "attack line included — style
  generated moves beyond the engine's top lines".

---

## 4. Human / Sparring mode — removal (complete)

Once aggressive is a deterministic *style* rather than weaker play, the whole
"play human" concept is redundant. Delete (not just hide) the following.

| Area | Remove |
| --- | --- |
| `engine/human-form.js` | **delete file** (form/rating/slip model) |
| `engine/hint-engine.js` | `humanLikeMode` param on `generateHints`/`selectPVForStyle`/`selectEngineLane`; `humanNaturalness` (`:1638`); the entire human-like shortlist/slip block in `selectEngineLane` (margin/`formParams`/slip roll/winning-lock-for-sparring); `naturalnessScore`/`planContinuity`/`humanSummary`/`humanReasons`/`humanRisks` consumers; `sparringStrictness` context |
| `engine/analysis-policy.js` | `humanLikeMode` branches in `resolveQuality` (`:98`), `resolveMultiPv` (`:111`), `shouldReplaceHumanWithEngine` (`:185`); delete `isSparringRangeFen` (`:205`) |
| `background.js` | `humanLikeMode`/`sparringStrength`/`sparringStrictness` in defaults + normalize + migration; `getFormSession`; `sparringHuman` branches; `recordHumanRecommendation`/`humanMoveByFen` and their session-state plumbing; `HumanForm` `importScripts` |
| `sidepanel.html` | Engine/Human segmented control; Sparring-strength slider; sparring-strictness row; human-mode note; `<script src="human-form.js">` |
| `sidepanel.js` | `humanLikeMode`/`sparringStrength`/`sparringStrictness` state + wiring; `humanPlanState`; `record_human_recommendation` send; `human-mode` card class |
| Tests/probes | `tests/human-form.test.js` (delete); human branches in `tests/hint-engine.test.js`, `tests/panel-wiring.test.js`, `tests/background-smoke.test.js`; sections C/D of `scripts/style-efficacy-probe.mjs`; slip/sparring gates in `scripts/rescue-gates.mjs` |

**Keep** the engine-correlation tracker in `background.js`, but reduced to its
standard semantics ("did you play the suggested move") — it feeds the
"Sensible moves" fact row, which is informational, not a setting.

---

## 5. Settings — slim down to the minimum

### 5.1 Style model collapses from 3 styles + dial to 2 styles

| Before | After |
| --- | --- |
| Normal · Aggressive · Ultra Super Aggressive | **Objective** · **Aggressive** |
| Aggression dial Auto / I / II / III | gone — intensity auto-scales with detected opponent rating (`suggestAggressionLevel`, rating already read in `content.js:372-450`) |
| Early King Hunt toggle | folded into Aggressive's always-on behavior |
| Book-first openings toggle | always on, bounded (existing ≤50cp promote, never over a winning mate) |
| Play human (Engine/Human) | **removed** (see §4) |
| Sparring strength slider | **removed** |
| Sparring strictness | **removed** |

The retired style ids (`super_ultra_aggressive`, `aggressive`, and the old
persona names) migrate to `aggressive`; unknown ids still degrade to
`normal` (keep the "safer, not wilder" fallback rule).

### 5.2 Everything else becomes internal

| Before | After |
| --- | --- |
| Analysis quality Auto/Fast/Balanced/Deep | internal `auto` (the auto profile + the aggressive depth escalation `analysis-policy.js:90-103` already cover it) |
| Candidate lines Auto/3/5 | internal — always the style-appropriate width |
| Analyze on my turn | always on |
| Threat alerts / Critical moments | always on |
| Source toggles (chess-api / lichess / masters) | internal `true` — providers already self-heal via circuit breakers |

### 5.3 Resulting settings sheet

```
Style        [ Objective | Aggressive ]     ← the one thing that matters
Theme        [ System | Light | Dark ]      ← appearance only
Provider pulse (read-only) + Clear caches   ← informational, not a setting
```

That is the whole sheet. The `DEFAULT_SETTINGS` object in `background.js` and
the panel `settings` object shrink to match; the migration in
`normalizeSettings`/`onInstalled` deletes the dead keys so old profiles come
back clean.

---

## 6. Migration & sequencing (phases)

**Phase 0 — Guard rails first (no behavior change).** Add the new acceptance
probe (below) with the *current* code pinned as the failing baseline, so the
divergence work is measured, not vibes. Extend `tests/` with the
"HumanEvaluator stays absent" style of guard for any new generator.

**Phase 1 — Candidate generation.** Ship `engine/attack-candidates.js` +
`local-engine.js` style hook + attack-lane assembly in `background.js`
(§3.1–3.3). At this point the pool *contains* attacking alternatives but the
old scoring may still pick the engine move — pool-building is exercised by a
new test, and `poolExpanded` shows in the UI.

**Phase 2 — Selection.** Add the divergence premium + normalized cost (§3.4)
and calibrate on the probe corpus until the divergence gate passes without any
safety-gate regression.

**Phase 3 — Retire human mode (§4).** Independent of Phases 1–2 but sequenced
after them because §4's rationale ("aggressive is now genuinely different")
is what Phase 2 establishes. Delete the module, plumbing, UI and tests in one
commit; run the suite and `rescue-gates` minus the sparring gates.

**Phase 4 — Settings slimdown (§5).** Collapse the style model and remove the
internal toggles from the sheet. Bump `version`/`version_name`, update
README/CHANGELOG/`sidepanel/DESIGN.md`, and remove the now-dead CSS blocks
(`.human-mode*`, slider rows).

---

## 7. Acceptance gates (measurable, dependency-free)

New harness `scripts/aggression-probe.mjs` (same vm/Node approach as
`style-efficacy-probe.mjs`, no install), driven on verified FENs:

| # | Gate | Pass criteria |
| --- | --- | --- |
| D1 | **Divergence** | Across a corpus of "attackable" positions (each containing a sound attacking alternative inside budget), Aggressive picks a move ≠ cloud-best in ≥ **50%**; Normal picks cloud-best in ≥ **98%**. |
| D2 | **Soundness invariant** | No aggressive pick ever exceeds its tier budget without `verifiedCompensation`; the −1050cp desperate sac stays vetoed (existing gate, re-asserted). |
| D3 | **Mate lock** | Forced mate on the board → mate taken, all modes. |
| D4 | **Win preservation** | In a clearly-won position, the win-probability class never moves (existing F3/G1). |
| D5 | **Opening sanity** | In quiet openings (≤8 moves) the aggressive style still develops/castles; `Ng5?!`-class picks stay 0/24. |
| D6 | **Determinism** | Same FEN + settings → same pick across repeated calls (no hidden randomness). |
| D7 | **Honest caption** | Every divergent pick carries the `divergence` caption with cost + reason. |
| D8 | **Regression suite** | `node scripts/run-tests.mjs` exits 0; `npm run gates` passes with the sparring/slip gates removed. |

Corpus construction: reuse the verified positions already in
`style-efficacy-probe.mjs` (Greek gift, Italian, mate-in-2, winning endgame,
desperate) and add a small set of pawn-storm / open-king / sacrifice
positions, each with its expected attacking move hand-checked.

---

## 8. Risks & open questions

1. **Local eval is weaker than Stockfish.** The attack candidates' `evalLoss`
   comes from our depth-≤8 search, which can misjudge a sacrifice's soundness.
   *Mitigation:* the hard gates (budget + `verifiedCompensation` + forcing-PV
   requirement) are the final arbiter, not the local score; when the cloud
   multiPV *does* contain the candidate we use the cloud eval. A candidate the
   local search can't prove forcing is simply not eligible — conservative, and
   consistent with the repo's history (never let an unexplained sac through).
2. **Divergence vs soundness pendulum.** This repo has swung between "tame"
   and "wild" before. The plan keeps divergence strictly *inside* the existing
   safety layer and pins it with D1–D6, so "different" can never regress to
   "unsound."
3. **Is 50% divergence the right number?** D1's threshold is a starting point,
   not gospel. It's cheap to re-measure in the probe; the user-facing promise
   ("aggressive ≠ stockfish") is what it protects.
4. **One open product call:** whether to keep the *option* of a manual
   intensity dial for Aggressive (e.g. a 2-step "Aggressive / Max Aggression")
   or go fully automatic by opponent rating. Recommendation: **fully
   automatic** (matches "less settings the better"); revisit only if
   playtesting shows the auto band is wrong.
5. **Normal's role is preserved intentionally.** Objective remains the factory
   default and the safe fallback; Aggressive is the flagship the user asked
   to make genuinely different.

---

## 9. Files touched (map)

| File | Change |
| --- | --- |
| `engine/attack-candidates.js` | **new** — legal-move attacking candidate generator |
| `engine/local-engine.js` | style hook (`style:'attack'`) for candidate ranking |
| `background.js` | attack-lane assembly; remove human/sparring plumbing; slim `DEFAULT_SETTINGS` |
| `engine/hint-engine.js` | divergence premium + normalized cost; remove human branches |
| `engine/analysis-policy.js` | remove `humanLikeMode`/`isSparringRangeFen`; auto-only quality |
| `engine/human-form.js` | **delete** |
| `sidepanel/sidepanel.html` | 2-option style control; remove human/sparring/quality/candidates/sources controls |
| `sidepanel/sidepanel.js` | settings model, wiring, divergence caption |
| `sidepanel/sidepanel.css` | remove `.human-mode*` / slider rows |
| `tests/*` | drop human-form suite; add attack-candidates + divergence tests; update wiring/engine tests |
| `scripts/aggression-probe.mjs` | **new** acceptance harness (D1–D8) |
| `scripts/rescue-gates.mjs`, `scripts/style-efficacy-probe.mjs` | remove sparring/slip gates; pin divergence baseline |
| `README.md`, `CHANGELOG.md`, `sidepanel/DESIGN.md`, `docs/*` | document the new style model + slimmed settings |
