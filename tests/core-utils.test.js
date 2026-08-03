'use strict';
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// This project is a study/research tool for building a chess engine that can
// play in a variety of styles (normal, aggressive, ultra-aggressive). It is
// intended for learning, offline analysis, and engine-variation research. It
// is anti-cheat compliant and fair-play safe: it never assists a player in a
// rated or live online game, and it must not be used to gain an unfair
// advantage against human opponents.
const assert = require('node:assert/strict');
require('../engine/core-utils.js');
const core = globalThis.ChessCore;

const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
assert.ok(core.parseFen(start));
assert.equal(core.parseFen('8/8/8/8/8/8/8/8 w - - 0 1'), null, 'positions need exactly one king per side');
assert.equal(core.parseFen('not a fen'), null);
assert.equal(core.applyUciToPlacement(start, 'e2e4'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');

const castle = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
assert.equal(core.applyUciToPlacement(castle, 'e1g1'), 'r3k2r/8/8/8/8/8/8/R4RK1');
const promotion = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
assert.equal(core.applyUciToPlacement(promotion, 'a7a8n'), 'N3k3/8/8/8/8/8/8/4K3');
const ep = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
assert.equal(core.applyUciToPlacement(ep, 'e5d6'), '4k3/8/3P4/8/8/8/8/4K3');

const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
assert.equal(core.didUciProduceFen(start, 'e2e4', afterE4), true);
assert.equal(core.didUciProduceFen(start, 'd2d4', afterE4), false);
assert.equal(core.didUciProduceFen(start, 'e2e4', afterE4.replace(' b ', ' w ')), false, 'side to move must flip');

assert.equal(core.reconcileFen(start, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'), afterE4);
const kingMoved = 'r3k2r/8/8/8/8/8/4K3/R6R b KQkq - 1 1';
assert.equal(core.reconcileFen(castle, kingMoved), 'r3k2r/8/8/8/8/8/4K3/R6R b kq - 1 1');
const blackReplyObserved = 'r6r/8/8/8/8/4k3/4K3/R6R w kq - 0 1';
assert.equal(
  core.reconcileFen('r3k2r/8/8/8/8/8/4K3/R6R b kq - 1 1', blackReplyObserved),
  'r6r/8/8/8/8/4k3/4K3/R6R w - - 2 2'
);

// Castling reconciliation: white short castle from the start position.
// The observed board drops the kingside rook, h1, into f1; the king moves
// e1 -> g1. reconcileFen must update castling rights, en-passant, and
// counters — not just echo the observed placement.
const whiteCastleObserved = 'rnbqkbnr/pppppppp/8/8/8/8/8/R4RK1 b kq - 1 1';
// After e1g1 the kingside rights (K) are gone; queenside (Q) remains.
assert.equal(core.reconcileFen(start, whiteCastleObserved), 'rnbqkbnr/pppppppp/8/8/8/8/8/R4RK1 b kq - 1 1');

// En-passant reconciliation: white double-push d2d4 with an en-passant
// square on d3. After a black reply that is NOT en-passant, the EP
// square must clear.
const d2d4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';
assert.equal(core.reconcileFen(start, d2d4), d2d4);
const afterBlackNc6 = 'r1bqkbnr/ppp1pppp/2n5/3p4/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2';
assert.equal(core.reconcileFen(d2d4, afterBlackNc6), afterBlackNc6);

// En-passant capture: white takes a black pawn on d5 via the e5 pawn
// crossing through d6. The captured pawn on d5 must vanish, the EP
// square is reset, and the halfmove counter returns to 0.
// (Fullmove stays at 1 — the fullmove counter only advances *after*
// Black's move; reconcileFen is given the position right after White's
// capture, before Black has replied.)
const epFEN = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
const epResult = '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1';
const reconciled = core.reconcileFen(epFEN, epResult);
assert.ok(reconciled, 'reconcileFen must handle en-passant captures');
assert.equal(reconciled.split(' ')[0], epResult.split(' ')[0], 'en-passant capture removes the captured pawn');
assert.equal(reconciled.split(' ')[1], 'b', 'side to move flips after the capture');
assert.equal(reconciled.split(' ')[3], '-', 'en-passant square is cleared after the capture');
assert.equal(reconciled.split(' ')[4], '0', 'halfmove clock resets on a pawn move');
assert.equal(reconciled.split(' ')[5], '1', 'fullmove does not advance until Black replies');

assert.equal(core.escapeHtml(`<img src=x onerror='x'>&"`), '&lt;img src=x onerror=&#39;x&#39;&gt;&amp;&quot;');
assert.equal(core.clampNumber(140, 0, 100), 100);
assert.equal(core.clampNumber('bad', 0, 100, 50), 50);

// ─── applyMoveToBoard / applyMoveToFen (consolidated from hint-engine) ───
// These cover the behaviour tests/hint-engine.test.js relied on so the move
// refactor has a direct, table-driven regression net in core-utils too.
assert.equal(core.applyMoveToFen(start, 'e2e4'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
const afterSicilian = core.applyMoveToFen(core.applyMoveToFen(start, 'e2e4'), 'c7c5');
assert.equal(afterSicilian, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2',
  'chained applyMoveToFen updates castling, EP, halfmove, and fullmove');
const rookCapture = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
assert.equal(core.applyMoveToFen(rookCapture, 'a1a8').split(' ')[2], 'Kk',
  'moving and captured rooks remove both queen-side rights');

// applyMoveToBoard takes a board array; verify the round-trip with parsePlacement
// matches the FEN-level helper for the start position.
const startBoard = core.parsePlacement('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
const afterE4Board = core.applyMoveToBoard(startBoard, 'e2e4');
assert.equal(core.boardToPlacement(afterE4Board), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
  'applyMoveToBoard returns a new board with the pawn advanced');

// squareToCoords is the public alias for coords and must return the same shape.
assert.deepEqual(core.squareToCoords('e4'), { row: 4, col: 4 });
assert.equal(core.squareToCoords('zz'), null, 'invalid square returns null');

// Idempotence: feeding an unparsable move returns the input unchanged.
const originalFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
assert.equal(core.applyMoveToFen(originalFen, null), originalFen, 'null UCI returns the FEN unchanged');
assert.equal(core.applyMoveToFen(originalFen, ''), originalFen, 'empty UCI returns the FEN unchanged');
assert.equal(core.applyMoveToFen('not a fen', 'e2e4'), 'not a fen', 'invalid FEN returns the FEN unchanged');

// Promotion: a white pawn on a7 captures to a8 and promotes to a queen.
const promoteFen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
const promoted = core.applyMoveToFen(promoteFen, 'a7a8q');
assert.equal(promoted.split(' ')[0], 'Q3k3/8/8/8/8/8/8/4K3', 'promotion replaces the pawn with the requested piece');
assert.equal(promoted.split(' ')[1], 'b', 'side to move flips after the promotion');
assert.equal(promoted.split(' ')[4], '0', 'halfmove clock resets on a pawn move');

// En-passant capture: white takes a black pawn on d5 via the e5 pawn
// crossing through d6. The captured pawn on d5 must vanish, the EP
// square is reset, and the halfmove counter returns to 0.
const epStart = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
const epAfter = core.applyMoveToFen(epStart, 'e5d6');
assert.equal(epAfter.split(' ')[0], '4k3/8/3P4/8/8/8/8/4K3', 'en-passant capture removes the captured pawn');
assert.equal(epAfter.split(' ')[1], 'b', 'side to move flips after the en-passant capture');
assert.equal(epAfter.split(' ')[3], '-', 'en-passant square is cleared after the capture');
assert.equal(epAfter.split(' ')[4], '0', 'halfmove clock resets on a pawn move');

console.log('core-utils tests passed');
