'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sandbox = {
  window: {},
  chrome: { runtime: { getURL: value => value } },
  fetch: () => Promise.reject(new Error('offline test')),
  console: { log() {}, warn() {}, error() {} },
  Math, Promise, setTimeout, clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require.resolve('../engine/hint-engine.js'), 'utf8'), sandbox);
const engine = sandbox.window.ChessHintEngine;

const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
assert.equal(engine.uciToSan('e2e4', start), 'e4');
assert.equal(engine.applyMoveToFen(start, 'e2e4'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
const morra = engine.OPENING_REPERTOIRES.white_smith_morra;
const morraStart = engine.repertoireState(start, morra, 'w');
assert.deepEqual(JSON.parse(JSON.stringify(morraStart.nextMoves)), ['e2e4']);
const afterSicilian = engine.applyMoveToFen(engine.applyMoveToFen(start, 'e2e4'), 'c7c5');
const morraReply = engine.repertoireState(afterSicilian, morra, 'w');
assert.ok(morraReply.nextMoves.includes('d2d4'), 'repertoire matches a known branch from the current FEN');
assert.equal(engine.repertoireState(afterSicilian, morra, 'b'), null, 'a White repertoire never activates for Black');
const repertoirePvs = [
  { score: 30, scoreType: 'cp', depth: 20, pv: ['d2d4'] },
  { score: 10, scoreType: 'cp', depth: 20, pv: ['e2e4'] }
];
const repertoireRanked = engine.selectPVForStyle(repertoirePvs, start, 'normal', 'w', false, { repertoire: morraStart });
assert.equal(repertoireRanked[0].pv[0], 'e2e4', 'a repertoire move within the half-pawn safety budget is preferred');

const castleCheck = '5k2/8/8/8/8/8/8/4K2R w K - 0 1';
assert.equal(engine.uciToSan('e1g1', castleCheck), 'O-O+');

const pinnedDisambiguation = 'k3r3/8/8/8/8/2N1N3/8/4K3 w - - 0 1';
assert.equal(engine.uciToSan('c3d5', pinnedDisambiguation), 'Nd5', 'a pinned alternate mover must not force SAN disambiguation');
const scholarsMate = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
assert.equal(engine.uciToSan('h5f7', scholarsMate), 'Qxf7#');

const rookCapture = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
assert.equal(engine.applyMoveToFen(rookCapture, 'a1a8').split(' ')[2], 'Kk', 'moving and captured rooks remove both queen-side rights');

assert.equal(engine.formatScorePlayerPerspective(150, 'cp', 'w'), '+1.5 (clear edge)');
assert.equal(engine.formatScorePlayerPerspective(150, 'cp', 'b'), '-1.5 (clear edge)');
assert.equal(engine.formatScorePlayerPerspective(-4, 'mate', 'b'), '+M4 (you)');

// Rebuilt three-mode style engine.
assert.deepEqual(Object.keys(engine.PLAYING_STYLES), ['normal', 'aggressive', 'super_ultra_aggressive']);
const attackFen = '4k3/8/8/8/8/8/8/3Q2K1 w - - 0 1';
const quiet = { score: 50, scoreType: 'cp', depth: 25, pv: ['d1d2'] };
const forcingCheck = { score: 20, scoreType: 'cp', depth: 25, pv: ['d1h5'] };
assert.equal(engine.selectPVForStyle([quiet, forcingCheck], attackFen, 'normal', 'w')[0].pv[0], 'd1d2');
assert.equal(engine.selectPVForStyle([quiet, forcingCheck], attackFen, 'aggressive', 'w')[0].pv[0], 'd1h5', 'Aggressive should prefer a sound forcing route to a faster win');
assert.deepEqual(
  JSON.parse(JSON.stringify(engine.selectPVForStyle([quiet, forcingCheck], attackFen, 'super_ultra_aggressive', 'w'))),
  JSON.parse(JSON.stringify(engine.selectPVForStyle([quiet, forcingCheck], attackFen, 'super_ultra_aggressive', 'w'))),
  'style scoring must be deterministic and free of candidate-history mutation'
);

const clearlyWinningQuiet = { ...quiet, score: 300 };
const costlyCheck = { ...forcingCheck, score: 220 };
assert.equal(engine.selectPVForStyle([clearlyWinningQuiet, costlyCheck], attackFen, 'aggressive', 'w')[0].pv[0], 'd1d2', 'Aggressive must not spend outside its tighter winning budget');

const fastestMate = { score: 2, scoreType: 'mate', depth: 30, pv: ['d1h5'] };
const slowerMate = { score: 5, scoreType: 'mate', depth: 30, pv: ['d1d2'] };
const hugeCp = { score: 900, scoreType: 'cp', depth: 30, pv: ['d1d3'] };
for (const style of Object.keys(engine.PLAYING_STYLES)) {
  assert.equal(engine.selectPVForStyle([hugeCp, slowerMate, fastestMate], attackFen, style, 'w')[0].score, 2, `${style} must preserve the fastest forced mate`);
}

const sacrificeFen = '6k1/7p/8/8/8/3Q4/8/6K1 w - - 0 1';
const realSac = engine.analyzeCandidate(sacrificeFen, ['d3h7', 'g8h7'], 'w', -40, 'cp', 24);
const fakeSac = engine.analyzeCandidate(sacrificeFen, ['d3h7', 'g8f8'], 'w', -40, 'cp', 24);
assert.equal(realSac.sacrifice, true, 'material must actually disappear after the reply');
assert.equal(fakeSac.sacrifice, false, 'an expensive piece capturing a pawn is not automatically a sacrifice');
const safeQueenMove = { score: 100, scoreType: 'cp', depth: 24, pv: ['d3d2'] };
const speculativeQueenSac = { score: -40, scoreType: 'cp', depth: 24, pv: ['d3h7', 'g8h7'] };
const superUltraChoice = engine.selectPVForStyle([safeQueenMove, speculativeQueenSac], sacrificeFen, 'super_ultra_aggressive', 'w')[0];
assert.equal(superUltraChoice.pv[0], 'd3h7');
assert.equal(superUltraChoice._styleAnalysis.sacrificeSoundness, 'speculative');

const aggressiveHint = engine.generateHints({ fen: attackFen, pvs: [quiet, forcingCheck], moveHistory: [] }, 5, 'w', 'aggressive', 'none');
assert.match(aggressiveHint.main, /Aggressive choice: Qh5\+/);
assert.match(aggressiveHint.main, /Fast-win idea:/);
assert.equal(aggressiveHint.pvs[0].pv[0], 'd1h5');

const legacyLevelHint = engine.generateHints({ fen: attackFen, pvs: [quiet], moveHistory: [] }, 1, 'w', 'normal', 'none');
assert.equal(legacyLevelHint.level, 5, 'exact-only mode normalizes legacy level requests');
assert.match(legacyLevelHint.main, /^Best:/, 'legacy level requests still receive the exact move');
assert.ok(legacyLevelHint.bestMoveFromTo?.includes('d1 → d2'));

// Human-like mode stays inside objective/style budgets but prefers natural plans.
const naturalFen = '4k3/8/8/8/8/8/8/3QK1N1 w - - 0 1';
const engineQueenMove = { score: 20, scoreType: 'cp', depth: 24, pv: ['d1d2'] };
const naturalDevelopment = { score: 10, scoreType: 'cp', depth: 24, pv: ['g1f3'] };
assert.equal(engine.selectPVForStyle([engineQueenMove, naturalDevelopment], naturalFen, 'normal', 'w', false)[0].pv[0], 'd1d2');
const humanNormal = engine.selectPVForStyle(
  [engineQueenMove, naturalDevelopment],
  naturalFen,
  'normal',
  'w',
  true,
  { activePlan: 'complete development' }
);
assert.equal(humanNormal[0].pv[0], 'g1f3');
assert.match(humanNormal[0]._styleAnalysis.humanSummary, /develops a new piece naturally/);
assert.equal(humanNormal[0]._styleAnalysis.planContinuity, true);
assert.equal(
  engine.selectPVForStyle([quiet, forcingCheck], attackFen, 'aggressive', 'w', true)[0].pv[0],
  'd1h5',
  'human-like Aggressive must preserve the fastest sound forcing route'
);

for (const style of Object.keys(engine.PLAYING_STYLES)) {
  assert.equal(
    engine.selectPVForStyle([hugeCp, slowerMate, fastestMate], attackFen, style, 'w', true)[0].score,
    2,
    `human-like ${style} must preserve the fastest forced mate`
  );
}

const onePvHumanHint = engine.generateHints({ fen: naturalFen, pvs: [naturalDevelopment], moveHistory: [] }, 5, 'w', 'normal', 'none', true);
assert.match(onePvHumanHint.main, /^Human choice:/);
assert.match(onePvHumanHint.main, /Human plan:/);
assert.equal(onePvHumanHint.styleAnalysis.limitedCandidates, true);
// A repertoire preference must never replace a forced mate with a non-mating line.
const forcedMateFen = '6k1/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const forcedMatePv = { score: 1, scoreType: 'mate', depth: 28, pv: ['f7g7'] };
const highCpRepertoirePv = { score: 900, scoreType: 'cp', depth: 28, pv: ['f7f8'] };
const mateSafeRepertoire = engine.selectPVForStyle(
  [forcedMatePv, highCpRepertoirePv], forcedMateFen, 'normal', 'w', false,
  { repertoire: { nextMoves: ['f7f8'] } }
);
assert.equal(mateSafeRepertoire[0].pv[0], 'f7g7', 'a repertoire line cannot displace a forced mate');

// Chaos Attack should recognize concrete attack features instead of only checks.
const stormFen = '6k1/6pp/6P1/5P2/8/8/6PP/6K1 w - - 0 1';
const stormAnalysis = engine.analyzeCandidate(stormFen, ['f5f6'], 'w', 10, 'cp', 20);
assert.ok(stormAnalysis.penetration >= 2, 'advanced attacking pieces count as enemy-half penetration');
assert.ok(stormAnalysis.pawnStorm >= 2, 'pawns advancing on the enemy king wing count as a pawn storm');
const pawnStormAdvance = engine.analyzeCandidate('6k1/8/8/8/6P1/8/8/6K1 w - - 0 1', ['g4g5'], 'w', 10, 'cp', 20);
assert.equal(pawnStormAdvance.pawnStormDelta, 1, 'only a new pawn-storm advance receives the style bonus');
const invade = engine.analyzeCandidate('6k1/8/8/8/8/5N2/8/6K1 w - - 0 1', ['f3g5'], 'w', 10, 'cp', 20);
assert.equal(invade.penetrationDelta, 1, 'only a move entering enemy territory receives penetration credit');
console.log('hint-engine tests passed');
console.log('chaos-style regression tests passed');
