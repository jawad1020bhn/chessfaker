'use strict';
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
//
// Phase 4 pool-quality coverage:
//   1. AttackBook.lookup  — prefix matching, parity guard, depth cap, no-coverage
//   2. Book lane ranking  — pure book pools rank in-lane; mixed pools never
//                           let win-rate-derived scores outvote engine cp
//   3. Sealing            — scoreType 'book' survives finalizeAnalysis
//   4. Local engine       — king-safety eval term + honest PV replies
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const loadSandbox = () => {
  const sandbox = {
    window: {},
    chrome: { runtime: { getURL: value => value } },
    fetch: () => Promise.reject(new Error('offline test')),
    console: { log() {}, warn() {}, error() {} },
    Math, Promise, setTimeout, clearTimeout, performance: { now: () => Date.now() }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
};

// ── 1. AttackBook ──
const sandbox = loadSandbox();
for (const file of ['engine/chaos-attack.js', 'engine/early-king-hunt.js', 'engine/hint-engine.js', 'engine/attack-book.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
const AB = sandbox.AttackBook;
const engine = sandbox.window.ChessHintEngine;
assert.equal(typeof AB.lookup, 'function');

// White to move at the start: the repertoire opens with 1.e4.
assert.equal(AB.lookup({ moveHistory: [], playerColor: 'w' }).pvs[0].uci, 'e2e4');
// Two Knights shape: the book raids with Ng5 (Fried Liver).
const friedLiver = AB.lookup({ moveHistory: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], playerColor: 'w' });
assert.equal(friedLiver.pvs[0].san, 'Ng5');
assert.match(friedLiver.name, /Fried Liver/);
// Black vs 1.e4 and vs 1.d4 gets its own attacking setups.
assert.equal(AB.lookup({ moveHistory: ['e4'], playerColor: 'b' }).pvs[0].san, 'c5');
assert.equal(AB.lookup({ moveHistory: ['d4'], playerColor: 'b' }).pvs[0].san, 'Nf6');
assert.equal(AB.lookup({ moveHistory: ['d4', 'Nf6', 'c4'], playerColor: 'b' }).pvs[0].san, 'g6');
// Sicilian as White: the Morra Gambit line is offered.
assert.equal(AB.lookup({ moveHistory: ['e4', 'c5'], playerColor: 'w' }).pvs[0].san, 'd4');
// Out-of-book → no suggestion (caller falls through to the local engine).
assert.equal(AB.lookup({ moveHistory: ['d4', 'd5'], playerColor: 'w' }), null);
// Parity guard: it is not Black's move at an even ply count.
assert.equal(AB.lookup({ moveHistory: [], playerColor: 'b' }), null);
// Depth cap: no book claims beyond the pre-solved window.
assert.equal(AB.lookup({ moveHistory: Array(12).fill('e4'), playerColor: 'w' }), null);
// Alternates are deduped and capped.
const startPvs = AB.lookup({ moveHistory: [], playerColor: 'w' }).pvs;
assert.equal(new Set(startPvs.map(p => p.uci)).size, startPvs.length);
assert.ok(startPvs.length <= 3);

// ── 2. Book lane ranking ──
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const bookPool = [
  { scoreType: 'book', score: 45, depth: 0, pv: ['d2d4'], _masterData: { totalGames: 12000, whiteWinPct: '55.0' } },
  { scoreType: 'book', score: 60, depth: 0, pv: ['e2e4'], _masterData: { totalGames: 9000, whiteWinPct: '58.0' } }
];
const bookRanked = engine.selectPVForStyle(bookPool, start, 'super_ultra_aggressive', 'w', false, {});
assert.equal(bookRanked[0].pv[0], 'e2e4', 'pure book pools rank by curated score inside the lane');
assert.equal(bookRanked[0]._styleAnalysis.mode, 'book');
assert.equal(bookRanked[0]._styleAnalysis.eligible, true);

const italianFen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const mixedPool = [
  { scoreType: 'cp', score: 30, depth: 25, pv: ['e1g1', 'g8f8'] },
  { scoreType: 'book', score: 500, depth: 0, pv: ['f3g5', 'g7g6'] }
];
const mixed = engine.selectPVForStyle(mixedPool, italianFen, 'super_ultra_aggressive', 'w', false, {});
assert.equal(mixed[0].pv[0], 'e1g1', 'engine lane wins a mixed pool');
assert.equal(mixed[1]._styleAnalysis.bookLane, true);
assert.equal(mixed[1]._styleAnalysis.eligible, false, 'book entries cannot win the style pick in a mixed pool');

// ── 3. Sealing preserves the book type ──
const contractSandbox = loadSandbox();
for (const file of ['engine/core-utils.js', 'engine/analysis-contract.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), contractSandbox, { filename: file });
}
const contract = contractSandbox.AnalysisContract;
const sealed = contract.finalizeAnalysis(
  { fen: start, pvs: [{ scoreType: 'book', score: 40, depth: 0, pv: ['e2e4'] }], bestMove: 'e2e4' },
  start,
  { source: 'attack-book' }
);
assert.equal(sealed.pvs[0].scoreType, 'book', "finalizeAnalysis must not coerce 'book' into 'cp'");

// ── 4. Local engine: king-safety eval + honest PV replies ──
const localSandbox = loadSandbox();
for (const file of ['engine/core-utils.js', 'engine/analysis-contract.js', 'engine/local-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), localSandbox, { filename: file });
}
const LocalEngine = localSandbox.LocalEngine;
// Both positions verified legal externally. White king g1 with a full
// f2/g2/h2 shield vs the same position with f2/g2 stripped.
const castled = 'rnbq1rk1/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQ1RK1 w - - 6 4';
const stripped = 'rnbq1rk1/pppp1ppp/8/4p3/4P3/8/PPPP3P/RNBQ1RK1 w - - 6 4';
const delta = LocalEngine.evaluateWhite(stripped) - LocalEngine.evaluateWhite(castled);
assert.ok(delta < -8, `a stripped king shield must evaluate worse for White (delta ${delta})`);
const localOut = LocalEngine.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { multiPv: 3, maxDepth: 3, timeMs: 300 });
for (const pvEntry of localOut.pvs) {
  for (const uci of pvEntry.pv) {
    assert.match(uci, /^[a-h][1-8][a-h][1-8]/, 'PV entries are UCI moves');
  }
}

console.log('attack-book + book-lane + local-eval tests passed');
