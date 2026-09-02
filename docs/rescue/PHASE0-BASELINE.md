# Phase 0 baseline — measured, not guessed

Generated with `scripts/strength-harness.mjs` on 2026-09-02. Two snapshots:
the tree at `1d02885` (**before** the Phase 1 vocabulary rewrite) and the same
harness on the current branch (**after**).

> **Read the caveats in §3 before quoting any number.** The self-play tables
> are a smoke baseline at n=2 games per cell; the *fixture* tables are the
> deterministic evidence.

---

## 1. Fixture — position after `13. f4` (Black to move)

```
r3kbnr/pp2q2p/2np1pp1/2p1p3/P1B1PP1Q/2PPB3/1P1N2PP/R4RK1 b kq f3 0 13
```

### Before (`node scripts/strength-harness.mjs --mode fixtures` @ 1d02885)

| move | storm | penet | kingPr | overload | reasons |
| --- | --- | --- | --- | --- | --- |
| exf4 | 1 | 1 | 0.0 | 1 | 1-ply forcing sequence \| penetrates the opponent half \| **drives a pawn storm toward the king** \| raises the structural complexity |
| g5 | 0 | 0 | 0.0 | 1 | gains tempo on a major piece \| **exploits overloaded defenders near the king** \| **the pawn storm advances with tempo** \| snaps up a piece the opponent left undefended |
| h6 | 0 | 0 | 0.0 | 1 | **exploits overloaded defenders near the king** |
| h5 | 0 | 0 | 0.0 | 1 | **exploits overloaded defenders near the king** |
| f5 | 0 | 0 | 0.0 | 1 | raises the structural complexity \| **exploits overloaded defenders near the king** \| **the pawn storm advances with tempo** \| unveils a discovered attack |
| Nd4 | 0 | 1 | 0.0 | 1 | penetrates the opponent half \| **exploits overloaded defenders near the king** |

Every single legal move earned an overload point, and a plain center recapture
was described as a pawn storm.

### After (current branch)

| move | storm | penet | kingPr | overload | reasons |
| --- | --- | --- | --- | --- | --- |
| exf4 | 0 | 1 | 0.0 | 0 | 1-ply forcing sequence \| penetrates the opponent half \| raises the structural complexity |
| g5 | 0 | 0 | 0.0 | 0 | gains tempo on a major piece \| snaps up a piece the opponent left undefended |
| h6 | 0 | 0 | 0.0 | 0 | — |
| h5 | 0 | 0 | 0.0 | 0 | — |
| f5 | 0 | 0 | 0.0 | 0 | raises the structural complexity \| unveils a discovered attack |
| Nd4 | 0 | 0 | 0.0 | 0 | — |

`...exf4` keeps only what is true (it is a capture that threatens the e3 bishop
from the enemy half); `...g5` keeps only its genuine tempo hit on the queen;
`...h6`/`...h5` are correctly described as nothing at all.

**Still broken (Phase 2, unchanged by Phase 1):** the attack-candidate
generator still produces `exf4(capture), h6(storm), h5(storm), f5(storm),
g5(storm)` — the lane buckets pawn moves by file proximity, so the h6/h5/g5
spam is still *generated*, it just no longer gets applauded.

---

## 2. Self-play smoke baseline

`node scripts/strength-harness.mjs --mode selfplay --games 2 --bands 1200,1500,1800 --max-plies 80`

### Before (@ 1d02885)

| style | band | W | D | L | mean donation | divergence | avg plies |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 1200 | 1 | 1 | 0 | 0.0cp | 0.0% | 79 |
| normal | 1500 | 0 | 1 | 1 | 0.0cp | 0.0% | 75 |
| normal | 1800 | 0 | 1 | 1 | 0.0cp | 0.0% | 56 |
| aggressive | 1200 | 1 | 1 | 0 | 4.4cp | 50.0% | 70 |
| aggressive | 1500 | 0 | 2 | 0 | 4.7cp | 32.4% | 69 |
| aggressive | 1800 | 0 | 2 | 0 | 7.6cp | 52.2% | 70 |

### After (current branch)

| style | band | W | D | L | mean donation | divergence | avg plies |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 1200 | 2 | 0 | 0 | 0.0cp | 0.0% | 78 |
| normal | 1500 | 0 | 1 | 1 | 0.0cp | 0.0% | 61 |
| normal | 1800 | 0 | 1 | 1 | 0.0cp | 0.0% | 56 |
| aggressive | 1200 | 1 | 1 | 0 | 6.2cp | 38.6% | 70 |
| aggressive | 1500 | 2 | 0 | 0 | 1.5cp | 50.0% | 36 |
| aggressive | 1800 | 0 | 2 | 0 | 9.6cp | 46.3% | 80 |

The one number that matters for the plan is the last column but one:
**divergence stays at 32–52% in every band, including 1800.** That is exactly
the failure Phase 4 exists to fix — the persona currently re-rolls the dice
against strong opposition just as freely as against weak opposition.

---

## 3. Caveats (do not skip)

1. **n = 2 games per cell.** Nothing in the W/D/L columns is significant. The
   before/after difference in the `normal` rows — whose code path Phase 1 does
   not touch — is proof of that: it is noise.
2. **The searches are time-bounded** (`Date.now() + timeMs` inside
   `local-engine.js`), so results depend on machine load and are not bit-exact
   reproducible even with a fixed seed. A node-budgeted deterministic mode is
   the right follow-up if the harness is to gate CI.
3. **The objective reference is the on-device alpha-beta**, not an 18-ply cloud
   line. Absolute donation figures are a floor, not a verdict; the harness is a
   comparison instrument between builds, not an absolute strength meter.
4. Phase 1's evidence is therefore the **fixture diff** in §1 plus
   `tests/attack-vocabulary.test.js`, not the self-play table.

## 4. Re-running

```bash
npm run harness -- --mode fixtures
npm run harness -- --mode replay
npm run harness -- --mode selfplay --games 6 --bands 1500 --max-plies 100
```

Budget roughly 0.7s per persona ply on a warm laptop: a 80-ply game is about a
minute, so a 6-game band is ~6 minutes.


---

## 5. After Phases 2 + 4 (the reported A00 loss)

`node scripts/strength-harness.mjs --mode replay --pgn tests/fixtures/game-a00-1380.pgn --rating 1380`

| | before Phase 2/4 | after |
| --- | --- | --- |
| divergence from own objective move | **53.1%** | **9.4%** |
| mean donation | 3.5cp | 1.7cp |
| picks taken from the generated lane | 14 of 32 | **0** |
| opening moves 2–8 | c6, e6, f6, g6 (lane pawn moves) | Nc6, Nf6, Nd7 (development) |

Self-play, same command as §2, with the gate live:

| style | band | W | D | L | mean donation | divergence |
| --- | --- | --- | --- | --- | --- | --- |
| normal | 1200 | 0 | 2 | 0 | 0.0cp | 0.0% |
| normal | 1500 | 2 | 0 | 0 | 0.0cp | 0.0% |
| normal | 1800 | 0 | 2 | 0 | 0.0cp | 0.0% |
| aggressive | 1200 | 2 | 0 | 0 | 2.9cp | 41.2% |
| aggressive | 1500 | 0 | 2 | 0 | 1.0cp | 23.9% |
| aggressive | 1800 | 1 | 1 | 0 | **0.0cp** | **0.0%** |

The divergence profile is now the shape the plan asks for: a real persona at
club level, a narrow window at 1500, and literally the engine's move at 1800
(0.0% divergence, 0.0cp donated). The residual 23.9% at 1500 is *free*
divergence — mean donation 1.0cp — i.e. choosing among moves the pool scores
as equal, not buying a different move with eval.

Still open, and visible in the same replay: the objective column itself
contains weak moves (`Ke7`, `Kf7`) because the harness's reference is the
on-device depth-5 search. In production that column comes from the cloud
engine at depth 12–18. Opening quality (Phase 5) is a separate lane and is
not fixed by Phases 2/4.
