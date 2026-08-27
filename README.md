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
| `chaos-attack.js` | The `super_ultra_aggressive` style engine (weights + motif detectors) |
| `early-king-hunt.js` | Opt-in early-king-hunt scoring add-on |
| `human-form.js` | Human-like move selection vocabulary |
| `local-engine.js` | Local alpha-beta fallback when every cloud source fails |
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

## Running the tests

The ten suites are self-contained plain-Node assert scripts — no framework,
no install:

```bash
npm test          # or: node scripts/run-tests.mjs
node tests/hint-engine.test.js   # any single suite directly
```

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
