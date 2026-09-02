# Rescue anchors — symbol → verified location in this tree

Verified 2026-09-02 against `arena/01a06220-chessfaker` @ `7f9d11f`
(manifest `13.6.1`). Line numbers are **pre-edit** positions of the tree as
received; they will drift as the phases land, so re-locate by symbol.

| Brief anchor | Brief says | Found at | Status |
|---|---|---|---|
| `const STYLE = 'super_ultra_aggressive'` | sidepanel.js 43–44 | `sidepanel/sidepanel.js:43–44` | **exact** |
| settings default `style:` | sidepanel.js ~64 | `sidepanel/sidepanel.js:64` | **exact** |
| `migrateLegacySettings` | sidepanel.js | **not in sidepanel.js** — lives in `engine/analysis-policy.js:66`; the style→dial collapse is `normalizeAggression()` at `sidepanel/sidepanel.js:45–49` and `normalizeSettings()` at `background.js:65–70` | **drift** |
| `PLAYING_STYLES[style] \|\| …super_ultra_aggressive` ×3 | hint-engine.js ~929, 1739, 1996 | `engine/hint-engine.js:913, 1723, 1958` (a 4th site at `:1921` already falls back to `normal`) | **drift (lines only)** |
| `PLAYING_STYLES` map | hint-engine.js | `engine/hint-engine.js:40` (`normal` at 45, `super_ultra_aggressive` at 56) | ok |
| `selectPVForStyle` / `selectEngineLane` | ~1737–1954 | `engine/hint-engine.js:1706` / `:1721` | **drift (lines only)** |
| `styleSafetyAllows` | hint-engine.js | `engine/hint-engine.js:1522` | ok |
| diversity swap block | ~1932–1938 | `engine/hint-engine.js:1893–1898` | **drift (lines only)** |
| slip block (HumanForm) | ~1905–1926 | `engine/hint-engine.js:1865–1889` | **drift (lines only)** |
| `globalThis.HumanEvaluator` branch / `enrichWithCloudBonus` | hint-engine.js ~1744–1762 | **absent — see below** | **NOT PRESENT** |
| `suggestAggressionLevel` | analysis-policy.js 127–133 | `engine/analysis-policy.js:121–127` | **drift (lines only)** |
| `resolveMultiPv` `style !== 'normal'` branch | ~110–120 | `engine/analysis-policy.js:114` | ok |
| `paramsFor` / `WIN_THRESHOLD` / `WIN_FULL` | human-form.js 119–139 | `engine/human-form.js:119`, `:130`, `:131` | **exact** |
| `widenSingleLinePool` | background.js ~1104–1150 | `background.js:1107` (caller `:1444–1450`) | ok |
| `const fullmove = 10; // Simplified` | human-evaluator.js 514 | **file does not exist** | **NOT PRESENT** |
| `generateScoredCandidates` | human-evaluator.js | **file does not exist** | **NOT PRESENT** |
| `tagBookLane` | ~1693–1715 | `engine/hint-engine.js:1677–1699` | ok |
| `run-tests.mjs` / "No test suites found" | scripts/run-tests.mjs | file exists; `tests/` holds **12** suites and the runner **exits 0** | **claim false here** |
| probe fixtures | scripts/style-efficacy-probe.mjs | exists, 5 gates all PASS pre-edit | ok |

## Drift conclusions

1. **`engine/human-evaluator.js` is not in this tree.** `grep -rn "HumanEvaluator"`
   over `*.js` / `*.html` returns zero hits; the file is absent from `engine/`.
   Findings **F5** and **F6** therefore have no code to act on. They are
   recorded as *not applicable* in `NEW-FINDINGS.md`, and the Phase 2 /
   Phase 3 work they implied is replaced by a **guard test** that fails if the
   module (or any pool-replacing branch in `selectEngineLane`) ever reappears.
2. **F7's premise is false in this tree.** `tests/` was not deleted — it holds
   12 suites and `node scripts/run-tests.mjs` exits 0. What *is* true is the
   substance behind it: no suite covered the style-resolution, win-preservation,
   auto-ceiling or pool-order invariants the brief lists. Phase 3 is therefore
   "extend the live suite", not "rebuild from scratch".
3. Every remaining anchor matched by symbol; only line numbers drifted (this
   tree is a few edits ahead of the 2026-09-02 extraction the brief was cut
   from).
