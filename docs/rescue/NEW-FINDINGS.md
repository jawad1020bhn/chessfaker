# New findings & anchor dispositions

Register for defects found while executing the rescue brief, plus the
disposition of brief findings that do not apply to this tree. Rule 1.4.5:
nothing here was hot-fixed silently — each item names the phase that owns it.

## Brief findings that do NOT apply here

### F5 — HumanEvaluator pool replacement — **NOT PRESENT in this tree**
`engine/human-evaluator.js` does not exist, and `grep -rn "HumanEvaluator"`
across `*.js` and `*.html` returns no hits. `selectEngineLane`
(`engine/hint-engine.js:1721`) opens with `applyAggressionLevel(…)` and has no
pool-replacement branch. Nothing to quarantine.
**Disposition (Phase 2/3):** the danger is real if the module is ever
re-added, so instead of a code fix we ship a *guard*: `tests/hint-engine.test.js`
asserts (a) the file stays absent, and (b) no `HumanEvaluator` /
`generateScoredCandidates` reference appears in any shipped file. Re-introducing
the pool-replacing path now fails CI rather than silently collapsing hint
quality.

### F6 — `planAttack` hard-codes `fullmove = 10` — **NOT PRESENT**
Same file, same reason. No `scoreAttackMove` symbol exists in this tree.
**Disposition:** closed, folded into the F5 guard.

### F7 — "regression suite deleted, `run-tests.mjs` broken" — **premise false here**
`tests/` contains 12 suites; `node scripts/run-tests.mjs` prints
`All 12 test suites passed.` and exits 0 (verified pre-edit).
**Disposition:** the *substance* survives — none of the 12 covered style
resolution, Normal semantics, win preservation, the Auto ceiling, or pool
order. Phase 3 adds those assertions to the live suites rather than recreating
a deleted directory.

## New findings

Statuses: **fixed** = landed on this branch with a test; **guard** = pinned by
an assertion instead of a code change.


### N1 (P1, Phase 0) — **fixed** — `background.js` migration would erase a restored Normal preference
`background.js:68` sets `normalized.style = DEFAULT_SETTINGS.style`
unconditionally, and `background.js:2026–2032` already contains a *correct*
three-way style migration that `normalizeSettings()` then overwrites. Once
Normal is selectable again, the unconditional assignment would silently
convert every stored preference back to the factory default on each
normalization. **Fix:** honour a valid stored `normal` / `aggressive` /
`super_ultra_aggressive`, map the four retired style ids to Ultra, and fall
back to `normal` for anything else.

### N2 (P1, Phase 0) — **fixed** — Normal's `evalLoss` metadata was mate-blind
The `profile.id === 'normal'` branch in `selectEngineLane` computed
`evalLoss = max(0, objectiveBest.score - entry.score)` for *all* score types.
With a mate-in-2 best (`score = 2`) and a +800cp candidate, that yields
`evalLoss = 0` — i.e. "costs nothing" — and a cp line looked tied with the
mate. The brief's §2.2.4 mate discipline (non-mating candidates get
`evalLoss = Infinity`) is now applied on the Normal path too.

### N3 (P2, Phase 1) — **fixed** — `conversionFrom` is read only through `profile.aggression`
`selectEngineLane` reads `profile.aggression?.conversionFrom ?? 200`, and
`applyAggressionLevel` is the only thing that sets `profile.aggression` — and
it early-returns for non-ultra profiles. So the Normal and Aggressive profiles
could never enter conversion mode and were stuck on the 200cp default. Not a
regression (neither profile existed as a product before Phase 0), but it
matters now that they are selectable: **Fix:** `riskBudgetFor` / conversion
resolution now falls back to a profile-level `conversionFrom`, with the
profiles carrying 200 explicitly.

### N4 (P1, Phase 0) — **fixed** — `promoteBookWithinTolerance` crashed on a single-PV engine lane
Found by the new book-first test, not by reading. `selectEngineLane` returns
a one-PV pool **untouched** (spec 2.2.1 pass-through), so those PVs carry no
`_styleAnalysis` at all. `promoteBookWithinTolerance` read
`pv._styleAnalysis.eligible` unguarded, so a mixed pool of one chess-api line
plus Masters data — an ordinary position under Normal — would have thrown
inside `selectPVForStyle`.
**Fix:** optional chaining plus a `{}` spread default; regression test in
`tests/hint-engine.test.js` (book promotion with a single engine PV).

### N5 (P2, Phase 1) — **guard** — the first rescue harness measured the wrong thing
The initial `scripts/rescue-gates.mjs` counted "pick != engine top line" as a
sparring slip and reported 20/240 "slips while winning". Every one of the 20
was the persona's own budgeted style choice (≤ the winning-tier budget, class
preserved) — the metric was measuring the persona, not the form model.
**Fix:** a slip is now defined as deviation from the *non-sparring* pick for
the same style and dial. Cross-checked against the project's independent
probe: 8/24 at 600 and 2/24 at 1600, the same numbers
`scripts/style-efficacy-probe.mjs` reports. Logged as assumption A4.
