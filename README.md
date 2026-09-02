# Chess Hint Assistant

A Manifest V3 Chrome side-panel extension that provides chess move hints on
chess.com and lichess.org by orchestrating five free cloud analysis sources:
chess-api.com, the Lichess cloud eval API, the Lichess Masters and player
opening explorers, and the Lichess tablebase.

> **EDUCATIONAL USE ONLY — FAIR-PLAY SAFE.** This project is a study/research
> tool for building a chess engine that can play in a variety of styles. It
> never assists a player in a rated or live online game, and it must not be
> used to gain an unfair advantage against human opponents. Using external
> assistance in rated games violates the terms of service of chess.com and
> lichess.org and can get accounts closed.

## Architecture

The extension is a three-process pipeline:

| Process | Entry point | Role |
| --- | --- | --- |
| Side panel | `sidepanel/sidepanel.html` → `sidepanel/sidepanel.js` | UI; also loads the whole hint engine in-page so stored analyses can be re-styled locally without a background round-trip |
| Service worker | `background.js` | Owns all network traffic; five cloud providers routed through a transport-only coordinator (`engine/api-coordinator.js`) that handles queuing, budgets, circuit breakers, negative caching, and stale-while-revalidate |
| Content script | `content.js` | Injected on demand into the active tab — first in the page's MAIN world (to reach the site's own game object), with an isolated-world fallback. Produces FEN + reliability flags |

### Engine modules (`engine/`)

| Module | Purpose |
| --- | --- |
| `core-utils.js` | Shared chess core: FEN parsing, move application, legality |
| `analysis-contract.js` | Analysis sealing/validation used by the worker and local engine |
| `analysis-policy.js` | Quality/multi-PV policy and legacy settings migration |
| `api-coordinator.js` | Rate limits, budgets, circuit breakers, caching, failover |
| `hint-engine.js` | Ranking path: legality validation, per-style scoring, safety gate, hint text |
| `chaos-attack.js` | The Aggressive persona's style engine (weights + motif detectors) |
| `early-king-hunt.js` | Early-king-hunt scoring add-on, folded into the Aggressive persona |
| `attack-candidates.js` | Generates extra attacking candidate moves (checks/captures/sacs/king-zone/pawn-storm) so the persona can pick a genuinely different move from the engine's top line |
| `attack-book.js` | Curated opening lines for the persona's attack lane |
| `local-engine.js` | Local alpha-beta fallback when every cloud source fails; also scores the generated attack candidates (`analyzeCandidates`) |
| `eco.json` | ECO opening database (async-loaded, 7-entry inline fallback) |

Script load order is encoded in the `<script>` tag order of
`sidepanel/sidepanel.html` (and `importScripts` in `background.js`) — the
modules are classic globals, not ES modules.

### Verified positions

DOM-scraped FENs are stamped `positionReliable: false`, and that flag gates
tablebase lookups, Masters-explorer routing, opening enrichment, and
exact-hint delivery end to end. This invariant is deliberate and load-bearing.

## Loading unpacked (development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository root
4. Open a game on chess.com or lichess.org, then click the toolbar icon to
   open the side panel

## Playing styles

The panel exposes exactly two styles, and the factory default is the
objective one. The settings surface is deliberately minimal — style and
theme only (Sparring / Human mode, the aggression dial, and the analysis
toggles were removed).

| Style | Behaviour |
| --- | --- |
| **Objective** (default) | The engine's own best move. A single-line source is passed through untouched; no persona machinery, no diversity swaps, no divergence premium. |
| **Aggressive** | A customized attacking persona that genuinely plays differently from the objective line: it generates its own attacking candidates (checks, captures, sacrifices, king-zone strikes, pawn storms) via `attack-candidates.js`, scores them on-device, and promotes one when a concrete attack exists inside its risk budget — a real divergence, never a relabelled engine move. Intensity auto-scales with the detected opponent rating (sound "fastest win" below 1000, the full persona at club level, sound again above ~1400). |

Both styles are locked to conversion above a clearly winning margin: the
win-probability class must not move and the winning-tier budget caps the
spend, so an attack can never be bought with a win that is already on the
board. A forced mate is never displaced by a non-mating line.

## Running the tests

The suites are self-contained plain-Node assert scripts — no framework, no
install:

```bash
npm test          # or: node scripts/run-tests.mjs
node tests/hint-engine.test.js   # any single suite directly
```

`npm run gates` runs the hint-quality acceptance gates
(`scripts/rescue-gates.mjs`): default-hint fidelity, win preservation, the
Auto ceiling, opening sanity, aggressive-vs-objective divergence, pool
integrity and the HumanEvaluator quarantine guard. `npm run probe` runs the
persona-efficacy probe, including a divergence check that confirms the
Aggressive persona makes a genuinely different move from the objective line.

CI is defined in `docs/ci-workflow.example.yml` and enabled by copying it to
`.github/workflows/ci.yml` (the command is at the top of that file).

## Lint & formatting

```bash
npm install
npm run lint      # ESLint (flat config in eslint.config.js)
npm run format    # Prettier (--write); see .prettierrc
```

## Building the store package

```bash
npm run package   # → dist/chess-hint-assistant-v<version>.zip
```

The packaging script ships only what the store needs (`manifest.json`,
`background.js`, `content.js`, `engine/`, `sidepanel/`, `icons/`).
`preview/`, `tests/`, docs, and tooling configs stay out of the zip.

## Dev preview harness

`preview/index.html` is a board-free mock page for iterating on the panel UI
without a live chess site. It is development-only and excluded from the
store package.

## License

MIT — see [LICENSE](LICENSE).
