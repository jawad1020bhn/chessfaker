'use strict';
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// Phase 1 regression suite: the attack vocabulary must mean what it says.
//
// Before Phase 1 the detectors were proximity-based, so ordinary moves were
// labelled as attacks: in the posted C41 game the plain center recapture
// ...exf4 was credited with "drives a pawn storm toward the king" and
// "exploits overloaded defenders near the king", and EVERY legal move in that
// position scored an overload point. These tests pin the corrected semantics
// and keep genuine attacking moves credited (no null-the-vocabulary fix).
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
vm.createContext(sandbox);
for (const file of ['core-utils.js', 'analysis-contract.js', 'chaos-attack.js', 'early-king-hunt.js', 'hint-engine.js']) {
  vm.runInContext(fs.readFileSync(require.resolve(`../engine/${file}`), 'utf8'), sandbox);
}
const engine = sandbox.window.ChessHintEngine;
const ULTRA = engine.PLAYING_STYLES.super_ultra_aggressive;

const scored = (fen, uci, color = 'w', pv = null) => {
  const analysis = engine.analyzeCandidate(fen, pv || [uci], color, 0, 'cp', 5, { style: ULTRA.id });
  analysis.reasons = [];
  analysis.risks = [];
  engine.candidateStyleBonus(analysis, ULTRA, {});
  return analysis;
};
const reasonText = (analysis) => analysis.reasons.join(' | ').toLowerCase();

// ── Fixture: the posted game, position after 13. f4 (Black to move) ────────
const AFTER_F4 = 'r3kbnr/pp2q2p/2np1pp1/2p1p3/P1B1PP1Q/2PPB3/1P1N2PP/R4RK1 b kq f3 0 13';

// 1. ...exf4 — a plain center recapture. Zero storm, zero overload, zero
//    king-pressure credit, and no attack language in its reasons.
const exf4 = scored(AFTER_F4, 'e5f4', 'b');
assert.equal(exf4.pawnStormDelta, 0, '...exf4 is a center recapture, not a pawn storm');
assert.equal(exf4.overloadScore, 0, '...exf4 exploits no overloaded defender');
assert.equal(exf4.kingPressureDelta, 0, '...exf4 creates no concrete threat against the white king');
assert.equal(exf4.concreteKingThreat, false, '...exf4 carries no concrete king threat');
assert.ok(!/storm/.test(reasonText(exf4)), `...exf4 must not claim a pawn storm (got: ${reasonText(exf4)})`);
assert.ok(!/overload/.test(reasonText(exf4)), `...exf4 must not claim an overload (got: ${reasonText(exf4)})`);

// 2. ...g6-g5 — the "useless attack" move. It attacks the queen (real tempo),
//    but it storms nothing: g5 hits f4/h4, not the shelter of the g1 king.
const g5 = scored(AFTER_F4, 'g6g5', 'b');
assert.equal(g5.pawnStormDelta, 0, '...g5 attacks no square of the white king zone — not a storm');
assert.ok(!/storm/.test(reasonText(g5)), `...g5 must not claim a pawn storm (got: ${reasonText(g5)})`);

// 3. The overload clause used to fire for literally every legal move because
//    the defenders were clustered around their own castled king.
for (const uci of ['h7h6', 'h7h5', 'f6f5', 'c6d4', 'e8d8']) {
  const analysis = scored(AFTER_F4, uci, 'b');
  assert.equal(analysis.overloadScore, 0,
    `${uci}: a defended castled king is not an overload (got ${analysis.overloadScore})`);
}

// ── Positive controls: real attacks must still be credited ────────────────
// 4. A pawn that advances onto the king zone IS a storm.
const realStorm = scored('6k1/7p/8/6P1/8/8/8/6K1 w - - 0 1', 'g5g6');
assert.equal(realStorm.pawnStormDelta, 1, 'g5-g6 hits f7/h7 — a genuine storm advance');
assert.ok(/storm/.test(reasonText(realStorm)), 'a genuine storm advance is described as one');

// 5. A queen closing in on the king is concrete pressure.
const realPressure = scored('6k1/8/8/3Q4/8/8/8/6K1 w - - 0 1', 'd5d7');
assert.ok(realPressure.kingPressureDelta > 0, 'Qd7 increases concrete king pressure');
assert.equal(realPressure.concreteKingThreat, true, 'Qd7 is a concrete king threat');
assert.ok(realPressure.attackUnits > 0, 'a queen bearing on the king zone counts as attack units');
const givingCheck = scored('6k1/8/8/3Q4/8/8/8/6K1 w - - 0 1', 'd5e6');
assert.equal(givingCheck.concreteKingThreat, true, 'a check is always a concrete king threat');

// 6. A bishop sweeping an EMPTY king-zone square from the far corner is not
//    pressure — this was the "bishop on the other side of the board" bug.
const distant = scored('6k1/8/8/8/8/8/8/B5K1 w - - 0 1', 'a1b2');
assert.equal(distant.attackUnits, 0, 'a distant sweep of an empty king-zone square is not an attack unit');
assert.equal(distant.kingPressureDelta, 0, 'a distant sweep is not king pressure');

// ── Complexity must require a forcing point ───────────────────────────────
// 7. A bare central pawn advance raises no complexity...
const barePush = scored('4k3/8/8/8/8/4P3/8/4K3 w - - 0 1', 'e3e4');
assert.equal(barePush.structuralComplexity, 0, 'a bare central push is not "structural complexity"');
// ...but a central push that attacks a piece does.
const forcingPush = scored('4k3/8/8/3n4/8/4P3/8/4K3 w - - 0 1', 'e3e4');
assert.equal(forcingPush.structuralComplexity, 1, 'a central push that attacks a piece raises complexity');

// ── Penetration must threaten something ───────────────────────────────────
// 8. A rook stepping into the enemy half attacking nothing gets no credit;
//    the same rook hitting an enemy piece does.
const idlePenetration = scored('4k3/8/8/8/8/8/R7/4K3 w - - 0 1', 'a2a6');
assert.equal(idlePenetration.penetrationDelta, 0, 'standing in the enemy half is not penetration');
const realPenetration = scored('4k3/p7/8/8/8/8/R7/4K3 w - - 0 1', 'a2a6');
assert.ok(realPenetration.penetrationDelta > 0, 'a piece that threatens from the enemy half has penetrated');

// 9. The whole vocabulary is not simply switched off: at least one move in the
//    fixture position still earns concrete attacking credit (…g5 hits the queen).
assert.ok(/tempo/.test(reasonText(g5)), '...g5 still earns its genuine tempo credit against the queen');

console.log('attack vocabulary (Phase 1) regression tests passed');
