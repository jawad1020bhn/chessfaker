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
console.log('hint-engine tests passed');
