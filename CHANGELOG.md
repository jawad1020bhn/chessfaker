# Changelog

## 14.0.0 — 2026-09 (hint-quality rescue: the objective baseline is back)

Executed from the hint-quality rescue brief (`docs/rescue/`). The persona
work through 13.6.1 was sound; what the product had lost was its objective
default. Findings F1–F4 are fixed, F5–F7 are recorded with their
dispositions, and the acceptance gates are in CI.

### Restored the objective baseline (F1)
- **Normal and Aggressive are selectable again, and Normal is the factory
  default.** The hard-coded `STYLE = 'super_ultra_aggressive'` /
  `normalizeStyle = () => STYLE` pair is replaced by a real normalizer; a
  three-way segmented control returns to the settings sheet.
- **Unknown and stale styles degrade to Normal**, at a single
  `resolveStyleProfile()` call site instead of three scattered fallbacks to
  Ultra. Retired persona ids (Kamikaze, Berserker, …) still land on Ultra so
  a stored preference is not deleted.
- **The Aggressive profile is back verbatim**: budget 35/85/140,
  sacrificeTolerance 90, kingHuntBonus 55, lossWeight 1.25, and the full
  sound-attack weight table (speculative sacrifices −55, unsupported attacks
  −30, own-king danger −32).
- Normal's `evalLoss` metadata is mate-disciplined: a +900 cp line next to a
  forced mate no longer reports "costs nothing".
- The Early King Hunt add-on is persona-scoped again, so the objective styles
  stay immune to persona machinery.
- `background.js` no longer overwrites a stored style with the default.

### Made the persona winnable (F2, F3)
- **Auto aggression inverted**: below 1000 → Level I, 1000–1400 → Level II,
  above 1400 → Level I. Auto never returns Max Chaos — chaos pays only when
  the defender's mistakes convert the attack, so the hint must not donate the
  compensation first.
- **Win-preservation gate**: above +200 cp the win-probability class must not
  move at all, and the winning-tier budget caps the spend even when verified
  compensation fires. Level II now converts from +120.
- **No variety while winning**: the diversity swap is gated on
  `objectiveBest.score <= 100`.
- **Sparring fixed where it hurt most**: the winning clause now makes slips
  *rarer* as a position gets more won (was ×1.5), and above +250 cp the form
  model gets no reorder and no slip roll at all. A new "Never loosen a
  winning position" switch extends that lock to any advantage.
- The sparring caption now says plainly that the mode plays deliberately
  weaker.

### Pool integrity (F4)
- `localPool` extras appended to a single-line chess-api result may inform
  the contest and fill the display list, but can never take the primary slot
  while a cloud PV is present. Budgets, the mate lock and the win gate are
  all measured against the cloud line. Sole exception: cloud depth < 12,
  local depth ≥ 5, agreement within 30 cp.

### Safety net (F7) and CI
- New coverage: style resolution and the fallback rule, Normal semantics,
  mate discipline in all styles, win preservation, the Auto ceiling, pool
  order including the depth-exception, the book-first preference,
  `localPool` survival through sealing, and the restored panel controls.
- `npm run gates` (`scripts/rescue-gates.mjs`) asserts G0–G2 on the fixed
  probe set, loading exactly the sidepanel's module set.
- **CI still needs one human command to switch on.** The GitHub App token
  that edits this repo has no `workflows` permission, so a push adding
  `.github/workflows/ci.yml` is rejected. `docs/ci-workflow.example.yml`
  carries the complete, tested workflow (suites, gates, probe, lint,
  package) and the copy-and-push command to enable it.
- `docs/rescue/` carries the anchor table, the new-findings register and the
  assumption ledger.

### Product polish
- "Book-first openings" toggle: master theory may take the primary slot
  within 50 cp of the engine's choice — always on for Normal, opt-in for the
  attack styles.
- The "Aggression cost" row becomes actionable: past the level's budget it
  offers a one-click step down to Level I or Normal.

### Not applicable in this tree
- **F5/F6** (`engine/human-evaluator.js` pool replacement; `planAttack`
  hard-coding the move number): the module does not exist here and nothing
  references it. Both are pinned by a guard assertion so re-introducing a
  pool-replacing path fails CI.
- **F7's premise** ("`tests/` deleted, runner broken") is false here — 12
  suites were live and green. The real gap was missing coverage, now added.


## 13.6.1 — 2026-08 (M3 Expressive polish of the changed UI)

- **Persona chip on the hero**: the live aggression level now rides the
  hero meta row as a tonal M3E pill — `Auto · II` or `II · Ultra`,
  level-tinted (I secondary / II primary / III tertiary containers), with
  a spring pop (spatial motion token, reduced-motion safe) whenever the
  resolution changes; tooltip carries the full resolution + opponent
  rating.
- **"Why this move" rail**: new `context` caption kind (neutral tonal —
  candidate-pool notices) and `book` kind (secondary container + a proper
  book icon) so theory/pool notes read as system context, not style ideas.
- **Settings**: the Aggression segmented control wraps gracefully at
  narrow widths; the live description is a polite live region with
  reserved height (no layout jump on Auto ↔ level swaps); the Early King
  Hunt row ships visible and enabled (it is always applicable now) with
  refreshed copy.
- Removed the orphaned `md-choice-stack` component (JS binding + CSS)
  left behind by the style-selector removal.

## 13.6.0 — 2026-08 (opponent-aware Auto aggression + per-game cost readout)

Phase 3 of the style-efficacy plan, completed.

### Auto aggression
- The Aggression dial gains an **Auto** level (and becomes the default): it
  scales with the detected opponent rating — below ~800 → III · Max Chaos,
  the club band through ~1200 → II · Ultra Attack, stronger opposition →
  I · Sound Storm; unknown ratings fall back to II.
- `content.js` extracts the opponent rating conservatively on both sites
  (lichess `.ruser-*` pods / `.rp`, chess.com player pods with
  `[data-elo]` / rating tags / parenthesised text), orientation-aware,
  strictly range-checked; a miss simply yields null. The settings
  description shows the live resolution ("Auto → I (opponent 1750)").

### Per-game aggression telemetry
- New "Aggression cost" fact row: eval the style has paid versus the
  objective best move this game (`−1.8p over 14 picks`), plus the
  principles that fired (storms, sacs, castling denied, lines opened,
  mobilized) and a red cue past −6 pawns. Resets with the game.

## 13.5.0 — 2026-08 (the six classical attacking principles)

The Ultra persona now explicitly implements the six core attacking
principles, each with a detector, a weight, and a regression test on a
legality-verified position (tests/attack-principles.test.js):

1. **Pawn storms** — new `stormWithTempo` (the storm pawn attacks a piece
   from its new square — time, not just space) and `stormVsUncastled`
   (the storm rolls while the enemy king is still stuck in the centre).
2. **Pawn sacrifices** — new `pawnSacInitiative`: a pawn-scale material
   drop (≤150cp) bought with a check, an opened king line, tempo, or
   castling denial; distinct from the big-piece sacrifice machinery.
3. **Prevent castling** — new `deniesCastling` with three concrete
   mechanisms: capturing the castling rook, attacking a king-crossing
   square (castling becomes illegal right now), and checking the
   uncastled king. `punishUncastled` (the reactive clause) is unchanged.
4. **Open key lines** — new `lineOpeningTrade`: an equal-value trade on
   the king's file or an adjacent one that leaves no enemy pawn keeping
   the file shut.
5. **Bring more pieces** — new `mobilize`: when the attack has stalled
   (no checks on the line, low sustained pressure), development and rook
   lifts are paid as first-class attacking moves.
6. **Do not trade queens** — a HARD eligibility gate in `styleSafetyAllows`:
   queen trades are vetoed while a weak enemy king is under fire. Escapes:
   winning-conversion mode (technique decides once clearly won), forced
   mates in the PV, and materially-winning trades. A soft score penalty
   proved insufficient — the trade move itself collects too much
   check/defender geometry.

Fixed on the way: when every candidate is vetoed, the objective-best
fallback no longer also renders in the ineligible tail (duplicate).

## 13.4.0 — 2026-08 (single persona: styles removed, aggression dial added)

### Aggressive's bequest, ported before deletion
- **Winning-conversion mode**: with a clear advantage the persona switches
  to the retired style's "fastest sound win" discipline — trades that remove
  the opponent's last counterplay flip from a penalty into a bonus
  (capped, and only while the position stays clearly winning; a −50cp
  killing trade is chosen, a −250cp one is rejected), and mate-speed
  urgency is rewarded. Level I converts from +120, II/III from +200.
- Winning risk budget tightened 60 → 40cp (ahead = precision).
- `unsupportedAttack` weight −5 → −30 (an unsupported attacking piece is
  the unsound setup the persona's own manifesto forbids).

### One style, three intensities
- Normal and Aggressive are gone from the product; **Ultra Attack** is the
  single persona, scaled by an **Aggression dial**: I · Sound Storm
  (budgets ×0.6, opening cap 30cp, no variety — Aggressive's soul),
  II · Ultra Attack (the signature persona, unchanged numbers),
  III · Max Chaos (budgets ×1.5, opening cap 60cp, more variety).
- The objective ranking path survives internally
  (`PLAYING_STYLES.normal.internal`) as the dormant low anchor for future
  strictness controls.
- Settings migration: legacy normal/aggressive intents land on Level I;
  multi-line routing, pool widening, EKH gating and quality escalation now
  apply unconditionally to the persona.

## 13.3.0 — 2026-08 (pool quality: book lane, king-safety eval, owned repertoire)

Phase 4 of the style-efficacy plan (docs/STYLE-EFFICACY-PLAN.md).

### Book lane separation
- Masters-explorer PVs are now tagged `scoreType: 'book'`: their scores are
  win-rate mappings, not engine evaluations, and the ranker keeps them out
  of the cp lane. Pure book pools rank inside the lane (curated order with
  master-game counts in the reasons); mixed pools append the book lane
  after the engine ranking, ineligible for the style pick — a +500
  "book" score can no longer outvote a +30 engine line.
- Sealing preserves the book type and carries `_bookLine` / `localPool`
  metadata through to the UI; the hero shows an "Opening book — theory,
  not an engine evaluation" caption for book picks.

### Local fallback the style can trust
- King-safety evaluation term (pawn-shield count, uncastled penalty after
  move 8, queen-gated so queenless endgames stay unbiased): stripped-shield
  positions now evaluate measurably worse, so fallback pools correlate with
  the attack features the ranker scores.
- Honest PV replies: each line's opponent answer comes from a shallow
  search instead of the first legal move (sacrifice detection reads pv[1]).

### Owned attacking repertoire
- `engine/attack-book.js`: 9 hand-authored attacking lines (moves 1–6,
  both colors — Italian c3-d4, Fried Liver, Morra, Milner-Barry setup,
  Caro attack, Pirc storm; Dragon, King's Indian, reversed dragon), every
  SAN/UCI pair machine-verified. When every cloud provider is silent and
  the Ultra persona is active, the book answers before the local engine;
  any deviation from theory means "no coverage" and the caller falls
  through. Normal style never touches it.

New suite: tests/attack-book.test.js (11 suites total).

## 13.2.0 — 2026-08 (style efficacy: the persona actually plays)

Phase 1+2 of the style-efficacy plan (docs/STYLE-EFFICACY-PLAN.md).

### The persona now acts on every move
- **Styled routing**: with a non-normal style (or human-like sparring)
  active, the multi-PV Lichess cloud eval is preferred over the single-line
  chess-api source; sequential failover is untouched.
- **Single-line pool widening**: when chess-api still wins the race, its one
  authoritative line is widened with fast local multi-PV alternatives so the
  style ranker has a pool. The result carries `poolExpanded` and the hero
  explains it ("lower confidence" extras).

### Chess sanity
- **Budget reform (ultra)**: 60/120/200/300/450cp by position class (was
  200/350/600/850/1200). Over-budget picks now require *verified
  compensation*: a classified sacrifice mechanism plus a mate in the PV or a
  forcing sequence, hard-capped at 450cp.
- **Class-collapse guard**: no style pick may throw away two+ win-probability
  classes without that same compensation.
- **Opening sanity**: moves 1–8 in quiet positions pay ≤40cp without a
  concrete trap — the persona castles and develops first (Scholar/Legal/
  Lasker trap patterns and the opted-in Early King Hunt are exempt).
- **Bonus rescale**: the ultra vocabulary is scaled ×0.125 into aggressive's
  magnitude and its eval-loss weight raised 0.62→1.0, so objective cost
  participates again. Opening phase amplification (×1.25) became damping
  (×0.6); `ownKingDanger` weight −5→−60; early castling is explicitly paid.

### Strength variation that varies
- Human-mode shortlist margins are now relative (12% of the top style score,
  capped), so the 600–1600 rating slider actually changes play: measured
  33% harmless-slip rate at 600 vs 8% at 1600, exactly matching the form
  model's calibration anchors.

### Verified by
`node scripts/style-efficacy-probe.mjs` (all acceptance gates PASS) and the
ten suites (one assertion updated: an uncompensated −140cp queen sac is now
intentionally vetoed).

## 13.1.0 — 2026-08 (code-quality review pass)

Applied findings of the v13 module-by-module code-quality review.

### Fixed — verified defects

- **D1** Hero card no longer loses its `md-hero__stage` layout class when JS
  rewrites `className` on first render (z-index / min-height regression).
- **D2** Global keyboard shortcuts now ignore modified keys (`Ctrl/Cmd+R`,
  `Ctrl+S`, … are no longer intercepted while the panel is focused).
- **D3** `attackMomentum` is computed before the Chaos delegation, so the
  siege-continuity bonus actually scales instead of being pinned to its 0.6
  floor (`undefined` at read time).
- **D4** `onMessage` now validates the sender (own extension id, no tab
  context): foreign extensions and injected content contexts can no longer
  drive privileged operations (`clear_caches`, `read_board`, correlation
  poisoning).
- **D5** Mate suffixes: the legal-reply check now covers en passant captures
  (with correct discovered-check simulation) and castling, so a position
  whose only escape is an e.p. capture is labelled `+`, not `#`.
- **D6** The `request_analysis` result chain has a `.catch`: if the workflow
  throws, the panel now receives `analysis_error` instead of silently going
  stale.
- **D7** Ephemeral service-worker state (correlation maps, last analyzed FEN,
  per-game position tokens) is mirrored to `chrome.storage.session`, so an
  SW recycle mid-game no longer mints a new game id and wipes coach stats.
- **D8** Retry backoff uses half-base + half-jitter (no more ~0 ms retries),
  and priority preemption no longer aborts jobs that already hold a provider
  rate reservation (no more silent budget double-spend).
- **D9** The analysis single-flight dedupe key includes refresh semantics —
  Refresh while a workflow is in flight no longer piggybacks silently.
- **D10** The side panel awaits the full ECO table before its first opening
  detection (cold start previously matched only the 7-entry fallback).

### Removed — dead code and shipped bloat

- Deleted the dead `engine/cloud-engine.js` module and its script tags.
- Removed the unused `analysis-contract.js` include from the panel page.
- Removed six write-only turn-state fields and the dead `activeColor` local
  in `normalizeChessApi`.
- Removed the hint-level stubs (`effectiveHintLevel`, the one-entry
  `HINT_LEVELS` table, the forced override in `generateHints`).
- Removed dead exports (`firedMotifs`, `fragilityMultiplier`, `isChaos`,
  `CANDIDATE_IDS`) and the empty `resetSacrificeHistory` stub + call site.
- Deleted eight verified-dead CSS blocks (~6% of the stylesheet), keeping
  `.status-dot.offline` which is now wired.
- Consolidated the duplicated `super_ultra_aggressive` weight table: the
  engine now references Chaos's live profile (the stale copy had drifted and
  was missing the V2 keys).
- Store packaging excludes `preview/`, `tests/`, and docs (38 files / 793 KB
  less in the shipped zip).

### Added — missing foundations

- Project infrastructure: `README.md`, `LICENSE` (MIT), `CHANGELOG.md`,
  `package.json` with a test script, `.gitignore`.
- CI (GitHub Actions): bare-Node test run, ESLint, store-zip build artifact.
- ESLint + Prettier configs; cited formatting debris fixed.
- Panel hardening: message-send failures are surfaced instead of swallowed;
  a crashed/recycled service worker now shows the offline status dot
  (distinguishable from "no internet").
- Manual theme override (System / Light / Dark) in settings — both schemes
  already shipped in CSS; the stale "dark only" comment is gone.

### Changed — quality wins

- Tablebase picker chooses the fastest mate (best DTM, tie-broken by DTZ)
  instead of the first winning move.
- a11y: toast host is a proper polite `role="status"`; visually-hidden native
  form controls are removed from the tab order (their segmented/switch
  counterparts are the keyboard interface).
- `chrome.storage` call style unified on promises in `background.js` and the
  panel settings loader.
- The two identical APG roving-keydown handlers are deduplicated into one
  helper.

## 13.0.0 — "M3 Expressive — depth pass"

Initial public shape of the extension as reviewed: Manifest V3 side panel,
five cloud analysis sources behind the API coordinator, verified-position
handling, Ultra Super Aggressive Attack style ranking, opening explorer,
tablebases, human-like mode, and the Expressive panel redesign.
