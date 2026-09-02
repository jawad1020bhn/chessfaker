'use strict';
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// Phase 2 + Phase 4 regression suite.
//
// Phase 2 — the attack lane must earn its slot: generated candidates need a
// concrete point, bare pawn pushes are gone, and a shallow local search may no
// longer out-bid a deep cloud line by accident.
// Phase 4 — divergence is a function of opponent strength: full persona at
// club level, a narrow window at 1400-1700, objective play above that.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sandbox = {
  window: {},
  chrome: { runtime: { getURL: (value) => value } },
  fetch: () => Promise.reject(new Error('offline test')),
  console: { log() {}, warn() {}, error() {} },
  Math, Promise, setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['core-utils.js', 'analysis-contract.js', 'analysis-policy.js',
  'attack-candidates.js', 'chaos-attack.js', 'early-king-hunt.js', 'hint-engine.js']) {
  vm.runInContext(fs.readFileSync(require.resolve(`../engine/${file}`), 'utf8'), sandbox, { filename: file });
}
const engine = sandbox.window.ChessHintEngine;
const policy = sandbox.AnalysisPolicy;
const candidates = sandbox.AttackCandidates;

// ── Phase 2: the lane ─────────────────────────────────────────────────────
// The position after 13. f4 from the reported C41 loss. The generator used to
// answer with h7h6, h7h5, f6f5, g6g5 — four pawn pushes bucketed as "storm"
// purely because they sit near the enemy king's files.
const AFTER_F4 = 'r3kbnr/pp2q2p/2np1pp1/2p1p3/P1B1PP1Q/2PPB3/1P1N2PP/R4RK1 b kq f3 0 13';
const lane = candidates.rootCandidates({ fen: AFTER_F4, playerColor: 'b', cloudMoves: [] });
const laneMoves = lane.map((c) => c.uci);
for (const spam of ['h7h6', 'h7h5', 'f6f5', 'g6g5']) {
  assert.ok(!laneMoves.includes(spam), `${spam} is not a storm — it must not enter the attack lane`);
}
assert.ok(!lane.some((c) => c.kind === 'storm'), 'no bare pawn push survives as a "storm" here');
assert.ok(laneMoves.includes('e5f4'), 'the real capture still reaches the lane');

// A genuine storm — a pawn advancing onto the king's shelter — still enters.
const stormFen = '6k1/5pp1/8/6P1/8/8/8/6K1 w - - 0 1';
const stormLane = candidates.rootCandidates({ fen: stormFen, playerColor: 'w', cloudMoves: [] });
assert.ok(stormLane.some((c) => c.uci === 'g5g6' && c.kind === 'storm'),
  'g5-g6, which hits f7/h7, is still generated as a storm');

// A move that simply hangs a piece next to the king is not an "attack idea".
const hangFen = '6k1/5ppp/8/8/8/8/8/3Q2K1 w - - 0 1';
const hangLane = candidates.rootCandidates({ fen: hangFen, playerColor: 'w', cloudMoves: [] });
assert.ok(!hangLane.some((c) => c.uci === 'd1d7'),
  'Qd7, hanging the queen to nothing, is not a king-zone strike');

// ── Phase 2: depth-gap pricing ────────────────────────────────────────────
// A depth-5 generated extra that ties a depth-18 cloud line on score must not
// take the primary slot: its uncertainty is now priced by the depth gap.
const poolFen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
const withShallowExtra = engine.selectPVForStyle(
  [
    { score: 20, scoreType: 'cp', depth: 18, pv: ['e1g1', 'e8g8'] },
    { score: 20, scoreType: 'cp', depth: 5, pv: ['f3g5', 'd7d5'], attackCandidate: true, candidateKind: 'kingzone' }
  ],
  poolFen, 'super_ultra_aggressive', 'w', { opponentRating: 1150 }
);
assert.equal(withShallowExtra[0].pv[0], 'e1g1',
  'a depth-5 generated extra cannot out-bid a depth-18 line on an equal reported score');

// ── Phase 4: the strength gate ────────────────────────────────────────────
assert.equal(policy.divergencePolicyFor(900).band, 'novice');
assert.equal(policy.divergencePolicyFor(1200).band, 'club');
assert.equal(policy.divergencePolicyFor(1380).band, 'sound');
assert.equal(policy.divergencePolicyFor(1500).band, 'strong');
assert.equal(policy.divergencePolicyFor(1900).band, 'expert');
assert.equal(policy.divergencePolicyFor(1900).objectiveOnly, true);
// An unknown rating must make the hint SAFER, not wilder.
assert.equal(policy.divergencePolicyFor(null).band, 'sound');
assert.equal(policy.divergencePolicyFor(null).attackLane, false);
assert.equal(policy.divergencePolicyFor(undefined).divergenceScale, 0.35);
// The lane is only built for the bands that can afford it.
assert.equal(policy.divergencePolicyFor(900).attackLane, true);
assert.equal(policy.divergencePolicyFor(1200).attackLane, true);
assert.equal(policy.divergencePolicyFor(1380).attackLane, false);
assert.equal(policy.divergencePolicyFor(1500).attackLane, false);

// Same position, same pool, three opponents: the persona converges as the
// opposition gets stronger. The attacking line costs 50cp here.
const gateFen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const gatePool = () => [
  { score: 80, scoreType: 'cp', depth: 22, pv: ['d2d3', 'f8c5'] },
  { score: 30, scoreType: 'cp', depth: 22, pv: ['d1h5', 'g7g6'] }
];
const atClub = engine.selectPVForStyle(gatePool(), gateFen, 'super_ultra_aggressive', 'w', { opponentRating: 1150 });
assert.equal(atClub[0].pv[0], 'd1h5', 'at club level the persona still plays its own attacking move');
for (const rating of [1380, 1500, 1900]) {
  const ranked = engine.selectPVForStyle(gatePool(), gateFen, 'super_ultra_aggressive', 'w', { opponentRating: rating });
  assert.equal(ranked[0].pv[0], 'd2d3',
    `at ${rating} a 50cp donation is outside the band — the persona plays the objective move`);
}

// Above 1700 the persona IS the engine, and says so honestly.
const expert = engine.selectPVForStyle(gatePool(), gateFen, 'super_ultra_aggressive', 'w', { opponentRating: 1900 });
assert.equal(expert[0]._styleAnalysis.objectiveOnly, true);
assert.equal(expert[0]._styleAnalysis.divergenceBand, 'expert');
assert.ok(/objective best play/.test(expert[0]._styleAnalysis.reasons[0]),
  'the expert band states plainly that it is playing the engine move');

// An unknown opponent rating behaves like the sound band, not like chaos.
const unknown = engine.selectPVForStyle(gatePool(), gateFen, 'super_ultra_aggressive', 'w', {});
assert.equal(unknown[0].pv[0], 'd2d3', 'with no rating scraped the persona does not gamble');
assert.equal(unknown[0]._styleAnalysis.divergenceBand, 'sound');

// A cheap divergence still survives the gate at 1500: this is the ~15cp window,
// not a blanket ban on ever differing.
const cheapPool = [
  { score: 40, scoreType: 'cp', depth: 22, pv: ['d2d3', 'f8c5'] },
  { score: 32, scoreType: 'cp', depth: 22, pv: ['f3g5', 'd7d5'] }
];
const strongBand = engine.selectPVForStyle(cheapPool, gateFen, 'super_ultra_aggressive', 'w', { opponentRating: 1500 });
assert.ok(strongBand.some((pv) => pv._styleAnalysis.eligible && pv._styleAnalysis.evalLoss <= 15),
  'an 8cp alternative is still inside the 1400-1700 window');

console.log('attack lane + strength gate (Phase 2/4) regression tests passed');
