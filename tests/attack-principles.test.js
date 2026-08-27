'use strict';
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
//
// The six classical attacking principles, locked by regression tests.
// Every position below was machine-verified for legality (python-chess)
// before being encoded. Principle → implementation map:
//   1 Pawn storms      → stormWithTempo / stormVsUncastled detectors + weights
//   2 Pawn sacrifices  → pawnSacInitiative clause
//   3 Prevent castling → deniesCastling (rook capture / path attack / check)
//   4 Open key lines   → lineOpeningTrade (equal trade clearing a king file)
//   5 Bring more pieces→ mobilize (stalled attack + development/rook lift)
//   6 No queen trades  → hard eligibility gate in styleSafetyAllows
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sandbox = {
  window: {},
  chrome: { runtime: { getURL: value => value } },
  fetch: () => Promise.reject(new Error('offline test')),
  console: { log() {}, warn() {}, error() {} },
  Math, Promise, setTimeout, clearTimeout, performance: { now: () => Date.now() }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['engine/chaos-attack.js', 'engine/early-king-hunt.js', 'engine/hint-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
const engine = sandbox.window.ChessHintEngine;

const analyze = (fen, pv) => engine.analyzeCandidate(fen, pv, 'w', 0, 'cp', 25, { style: 'super_ultra_aggressive' });
const pick = (fen, pool, ctx = {}) =>
  engine.selectPVForStyle(pool.map(p => ({ ...p })), fen, 'super_ultra_aggressive', 'w', false, ctx);
const cp = (score, pv) => ({ scoreType: 'cp', score, depth: 25, pv });

// ── 1. Pawn storms: with tempo, against the uncastled king ──
const P1 = 'r3k2r/1pp2n2/8/5PPP/8/8/PPPPP3/RNBQK2R w KQ - 0 1';
const storm = analyze(P1, ['g5g6', 'b7b6']);
assert.equal(storm.stormWithTempo, true, 'g6 attacks the f7 knight — the storm gains tempo');
assert.equal(storm.stormVsUncastled, true, 'the storm rolls while the black king is still uncastled');
const stormPick = pick(P1, [cp(0, ['g5g6', 'b7b6']), cp(0, ['d2d3', 'b7b6'])]);
assert.equal(stormPick[0].pv[0], 'g5g6');
assert.match(stormPick[0]._styleAnalysis.reasons.join(' '), /tempo/);

// ── 2. Pawn sacrifices for initiative ──
const P2 = '5r1k/5ppp/8/5P2/8/8/8/6RK w - - 0 1';
const pawnSac = analyze(P2, ['f5f6', 'g7f6']);
assert.equal(pawnSac.materialDelta, -100, 'f6! gxf6 costs exactly one pawn');
assert.equal(pawnSac.stormWithTempo, true, 'the f6 pawn hits g7 — bought with tempo');
const sacPick = pick(P2, [cp(0, ['f5f6', 'g7f6']), cp(10, ['g1e1', 'f8e8'])]);
assert.equal(sacPick[0].pv[0], 'f5f6', 'the persona pays a pawn to rip open the king position');
assert.match(sacPick[0]._styleAnalysis.reasons.join(' '), /rip open lines/);

// ── 3. Prevent castling ──
const P3A = 'r3k2r/ppp4p/8/8/2B5/8/PP3PPP/RNBQK1NR w KQk - 0 1';
const deny = analyze(P3A, ['c4d5', 'b7b6']);
assert.equal(deny.castlePathDenied, true, 'Bd5 covers g8 — kingside castling is illegal right now');
assert.equal(deny.deniesCastling, true);
const denyPick = pick(P3A, [cp(0, ['c4d5', 'b7b6']), cp(0, ['a2a3', 'b7b6'])]);
assert.equal(denyPick[0].pv[0], 'c4d5');
assert.match(denyPick[0]._styleAnalysis.reasons.join(' '), /castling/);
const P3B = 'r3k2r/8/8/8/8/8/8/6KR w k - 0 1';
const rookCapture = analyze(P3B, ['h1h8', 'e8d7']);
assert.equal(rookCapture.capturedCastleRook, true, 'capturing the h8 rook erases the castling right');
assert.equal(rookCapture.deniesCastling, true);

// ── 4. Trades that open key files toward the king ──
const P4 = '5rk1/6pp/8/8/8/8/6PP/5RK1 w - - 0 1';
const trade = analyze(P4, ['f1f8', 'g8f8']);
assert.equal(trade.lineOpeningTrade, true, 'Rxf8+ Kxf8 clears the f-file at the king for an equal trade');
const tradePick = pick(P4, [cp(0, ['f1f8', 'g8f8']), cp(0, ['f1f4', 'h7h6'])]);
assert.equal(tradePick[0].pv[0], 'f1f8');
assert.match(tradePick[0]._styleAnalysis.reasons.join(' '), /key line/);

// ── 5. A stalled attack mobilizes the remaining pieces ──
const P5 = '2r3k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const mobilize = analyze(P5, ['a1a5', 'h7h6']);
assert.equal(mobilize.rookLiftMove, true);
assert.equal(mobilize.sustainedPressure, 0, 'no checks on the line — the attack has stalled');
const mobilizePick = pick(P5, [cp(0, ['a1a5', 'h7h6']), cp(0, ['f2f3', 'h7h6'])]);
assert.equal(mobilizePick[0].pv[0], 'a1a5');
assert.match(mobilizePick[0]._styleAnalysis.reasons.join(' '), /mobilizes the last pieces/);

// ── 6. Do not trade queens against a weak king (hard gate, three escapes) ──
const P6 = 'rnb1k2r/pppqpppp/8/8/2B5/3Q4/PPP1PPPP/RNB1K1NR w KQ - 0 1';
const equalScores = pick(P6, [cp(0, ['d3d7', 'e8d7']), cp(0, ['d3e4', 'a7a6'])]);
assert.equal(equalScores.find(p => p.pv[0] === 'd3d7')._styleAnalysis.eligible, false,
  'Qxd7+ is vetoed at equal evals while the uncastled king is under fire');
assert.equal(equalScores[0].pv[0], 'd3e4', 'the persona keeps its mating piece');
const conversion = pick(P6, [cp(400, ['d3e4', 'a7a6']), cp(390, ['d3d7', 'e8d7'])]);
assert.equal(conversion.find(p => p.pv[0] === 'd3d7')._styleAnalysis.eligible, true,
  'winning-conversion mode exempts the trade — technique decides');
const mateEscape = pick(P6, [cp(10, ['d3e4', 'a7a6']), { scoreType: 'mate', score: 3, depth: 25, pv: ['d3d7', 'e8d7', 'e4e8'] }]);
assert.equal(mateEscape.find(p => p.pv[0] === 'd3d7')._styleAnalysis.eligible, true,
  'a forced mate through the trade is always allowed');
assert.equal(mateEscape[0].pv[0], 'd3d7');

// ── No duplicates even when every candidate is vetoed ──
const allVetoed = pick(P6, [cp(0, ['d3d7', 'e8d7']), cp(-5, ['d3d7', 'e8f7'])]);
assert.equal(new Set(allVetoed.map(p => p.pv[0] + p._styleAnalysis.styleRank)).size, allVetoed.length,
  'each candidate appears exactly once');

console.log('attack-principles tests passed (six core principles verified)');
