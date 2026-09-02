# Attack strength plan — "no real attack, and it can't win at 1500+"

Status: **Phase 0 and Phase 1 are IMPLEMENTED.** Phases 2–6 are still planning
only. Scope: the Aggressive persona plays useless or absent attacks and loses
to 1500+ opposition. This plan is grounded in the actual losing game posted
(C41 Philidor, White 1524 vs Black 1490) and in the current code, not in
theory.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Self-play harness + replay + baseline | **done** — `scripts/strength-harness.mjs` |
| 1 | Kill the false-positive attack vocabulary | **done** — `tests/attack-vocabulary.test.js` |
| 2 | Attack lane must earn its slot | planned |
| 3 | Re-wire plan continuity | planned |
| 4 | Strength-gate the divergence | planned |
| 5 | Opening quality | planned |
| 6 | Per-game eval ledger | planned |

---

## 1. What the game actually shows

```
1. e4 d6 2. Nf3 e5 3. Bc4 c6 4. a4 Bg4 5. d3 Qa5+ 6. c3 Qc7 7. Be3 Bxf3
8. Qxf3 f6 9. Qh5+ g6 10. Qh4 Qe7 11. Nd2 c5 12. O-O Nc6 13. f4 g5?!
14. Qh5+ Kd8 … 35. Qg7+ 1-0
```

Three separate facts with different causes and different fixes:

### 1a. The opening was already lost before "style" ever mattered

`...Bg4`/`...Bxf3` (bishop pair + open g-file for free), `...f6` (voluntary
king weakness) and `...Qa5+`/`...Qc7` (two queen moves that win nothing) put
Black a pawn down with a wrecked kingside by move 10. No style layer rescues a
position its own earlier hints already lost. Phase 5.

### 1b. `...g5` is the smoking gun for "useless attack"

Black answers the f4-thrust by pushing a kingside pawn; it helps nothing and
loses by force to `14. Qh5+`. This is the persona choosing a generated
pawn-storm candidate over the objective move. Phases 1 + 2.

### 1c. No follow-through

Real attacks win by accumulation. The engine re-rolled the dice every position,
so the attack never accumulated. Phase 3.

---

## 2. Why the code produced this (verified, then fixed in Phase 1)

Everything below was **reproduced with the harness**, not guessed:

```
$ node scripts/strength-harness.mjs --mode fixtures
```

**Before Phase 1**, in the position after `13. f4`
(`r3kbnr/pp2q2p/2np1pp1/2p1p3/P1B1PP1Q/2PPB3/1P1N2PP/R4RK1 b kq f3 0 13`):

| move | storm | penet | kingPr | overload | reasons |
| --- | --- | --- | --- | --- | --- |
| exf4 | 1 | 1 | 0.0 | 1 | *"drives a pawn storm toward the king"*, *"exploits overloaded defenders near the king"* |
| g5 | 0 | 0 | 0.0 | 1 | *"exploits overloaded defenders near the king"*, *"the pawn storm advances with tempo"* |
| h6 | 0 | 0 | 0.0 | 1 | *"exploits overloaded defenders near the king"* |
| h5 | 0 | 0 | 0.0 | 1 | *"exploits overloaded defenders near the king"* |

Every legal move scored an overload point, and a plain center recapture was a
"pawn storm". **After Phase 1** the same command prints `storm 0 / penet 1 /
kingPr 0.0 / overload 0` for `...exf4` with no storm or overload language, and
`...g5` keeps only its genuine tempo credit against the queen on h4.

Root causes, by file:

- `engine/hint-engine.js` — `kingZonePressure` counted **any** piece attacking
  **any** of the 9 squares around the enemy king (a bishop on the far side of
  the board earned pressure); `attackTerrain.pawnStorm` counted any pawn on the
  king's wing files in the enemy half; `penetration` counted any piece in the
  enemy half; `overloadScoreOf` fired on any cluster of ≥3 defenders around
  their own castled king; `structuralComplexityOf` fired on any central pawn
  advance.
- `engine/chaos-attack.js` — `stormWithTempo` fired for any pawn move attacking
  any piece from anywhere; `pawnWedge` for any pawn within manhattan 4 of the
  king; `undefendedDefenderHit` / `positionalHangingHit` fired even when the
  "undefended" target could simply capture the attacker back.
- `engine/attack-candidates.js` — a pawn move is bucketed `storm` on file
  proximity alone (Phase 2).
- `candidateStyleBonus` — `siegeContinuity` is gated on `context.activePlan`,
  which nothing passes any more (Phase 3).
- `styleSafetyAllows` — per-position budget only, no per-game ledger (Phase 6).
- The honest ceiling: at 1500+ divergence and winning are in direct conflict
  (Phase 4).

---

## 3. The plan

### Phase 0 — Reproduce before touching anything ✅ implemented

`scripts/strength-harness.mjs` (with `scripts/lib/engine-sandbox.mjs`,
`scripts/lib/persona.mjs`, `scripts/lib/game-driver.mjs`) drives the **real**
decision layer — `LocalEngine.analyze` → attack lane → `selectPVForStyle` —
exactly as `background.js` assembles it.

```bash
npm run harness -- --mode fixtures                     # vocabulary read-out on the 13. f4 position
npm run harness -- --mode replay                       # persona vs the moves actually played in the posted game
npm run harness -- --mode selfplay --games 2 --bands 1200,1500,1800
```

`--mode selfplay` reports, per style and per rating band: win/draw/loss, mean
per-move eval donation (objective best − played, cp) and divergence rate
(share of moves where played ≠ objective top move). Opponent bands are the
on-device engine throttled by depth plus a band-dependent slip rate; games are
seeded, so runs are reproducible.

**Acceptance for the whole plan (unchanged):** Aggressive ≥ Objective win rate
at 1500+, with measurable divergence only at ≤1300.

Caveat to keep honest: the harness's objective reference is the on-device
alpha-beta, not an 18-ply cloud line, so absolute donation numbers are a floor,
not a verdict. It is a *comparison* instrument between builds.

### Phase 1 — Kill the false-positive attack vocabulary ✅ implemented

New threat-grounded primitives in `engine/hint-engine.js`
(`concreteZoneAttack`, `pieceHasConcreteThreat`, `pawnStormsKing`) and
`engine/chaos-attack.js` (`pawnHitsKingShelter`):

- **pawnStorm** — a pawn counts only when it attacks a square inside the enemy
  king zone or a shield pawn within two squares of the king. Wing-file
  proximity buys nothing; `...exf4` gets zero storm credit.
- **penetration** — a piece in the enemy half counts only when it threatens an
  enemy piece or a king-zone square. Standing there is not penetration.
- **kingPressure** — the raw delta is preserved as `kingPressureDeltaRaw`, but
  the *scored* `kingPressureDelta` is zero unless the move created a concrete
  threat (`concreteKingThreat`: check, defender removed, line opened, the mover
  itself bearing on the zone, or a new attacker joining it). A long-range sweep
  of an empty king-zone square from the far corner is no longer pressure.
- **attack units** — same concreteness rule, so the A1 unit count and its
  S-curve no longer inflate on distant sweeps.
- **overload** — the "defenders clustered near the king" clause now requires us
  to actually be pressing that zone (≥3 attack units *and* this move adding
  units). A castled king with three pieces around it is not an overload.
- **complexity** — a central pawn advance raises structural complexity only
  inside a forcing line or when it attacks a piece.
- **stormWithTempo / pawnWedge** — both now require the pawn to hit the king's
  shelter, not merely to attack something or stand nearby.
- **undefended-piece clauses** — no credit when the "undefended" target can
  simply capture the attacker back.

Regression suite: `tests/attack-vocabulary.test.js` (12 assertions, including
positive controls so the fix cannot degenerate into switching the vocabulary
off). One pre-existing assertion in `tests/hint-engine.test.js` was updated to
the new semantics (`g4-g5` on an empty board is not a storm; `g5-g6` is).

### Phase 2 — Make the attack lane earn its slot (next)

In `attack-candidates.js` / `local-engine.js`:

- a generated candidate enters the pool only with a concrete point — mate
  threat, winning capture, forcing check, or tempo threat against a major
  piece;
- drop the `storm` bucket unless the pawn hits the shelter (reuse the Phase 1
  `pawnStormsKing` rule — the fixture output shows the lane still generates
  `h6, h5, f5, g5` as "storm", which Phase 1 alone does not stop);
- verify the survivors with a deeper search and admit only the top 1–2;
- replace the flat `ATTACK_CANDIDATE_PENALTY_CP = 40` with a function of the
  depth gap between the cloud line (18) and the local extra (5).

### Phase 3 — Organize the attack (plan continuity without human mode)

Re-wire `siegeContinuity`: the side panel tracks the persona's last emitted
`plan` and passes it as `activePlan` on the next hint. Only moves advancing the
active plan get the bonus; abandoning it mid-attack is penalized. (The harness
already threads `activePlan` between plies, so the effect will be measurable
the moment the panel does.)

### Phase 4 — Strength-gate the divergence

Re-map the auto dial in `analysis-policy.js` so the persona collapses toward
objective as strength rises: `<1100` full chaos, `1100–1400` sound aggression,
`1400–1700` a ~10–15cp window with the attack lane off, `>1700` objective.
Scale `DIVERGENCE_PREMIUM`, the risk budgets and the attack-lane flag with
opponent rating; gate with a hard test on probe positions.

### Phase 5 — Opening quality

Make the opening lane authoritative for the first 6–8 moves (book-first,
quality-filtered by masters statistics) so the persona stops entering 1500
games a pawn down.

### Phase 6 — Per-game cost ledger

Track eval spent on style per game in `background.js`; once past a band cap,
force objective play for the rest of the game.

---

## 4. What this plan deliberately does NOT do

- It does not promise "win at 1500+ with a visibly different attacking style" —
  that is contradictory. It promises: **win at 1500+ by converging to
  objective**, and **be a real, organized attacker at club level and below**.
- It does not add settings. Every knob is internal and automatic.
- It does not touch the fair-play scope. Self-play harness only; no rated or
  live assistance.

## 5. Order of execution and checkpoints

1. ✅ Phase 0 harness + replay (ground truth).
2. ✅ Phase 1 vocabulary rewrite + regression tests → "no more false attacks."
3. Phase 2 lane hardening → "no more h6/h5/g5 spam."
4. Phase 3 plan continuity → "attacks now follow through."
5. Phase 4 strength gate → "wins at 1500+."
6. Phase 5/6 → "stops losing the opening; stops bleeding eval across a game."

Each phase ships with its own test/gate and is measured against the Phase 0
baseline, so progress is numbers, not vibes.
