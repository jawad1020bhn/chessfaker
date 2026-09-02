/*
 * Attack-candidate generator — the source of genuinely different moves.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 * This module only enumerates and classifies legal root moves; it never makes
 * a move, injects input, or interacts with a live game. It is intentionally
 * dependency-light: it reads the legal-move set from AnalysisContract and the
 * board geometry from ChessCore, both of which are already shipped.
 *
 * Why it exists: the style layer used to be a *filter* over the cloud engine's
 * own top-5 lines, so moves Stockfish would never surface (h4/g4 pawn storms,
 * Ng5 raids, Greek-gift sacrifices) were simply never in the candidate pool.
 * This module *generates* attacking candidates from the full legal-move set so
 * the style has something real to rank. The existing safety gates
 * (styleSafetyAllows / verifiedCompensation / risk budgets) remain the final
 * arbiter of how far the style may diverge.
 */
(function (root) {
  'use strict';

  const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const TAG_NAMES = {
    check: 'forcing check',
    capture: 'winning capture',
    sac: 'sacrifice idea',
    kingzone: 'king-zone strike',
    storm: 'pawn storm'
  };

  function helpers() {
    return {
      core: root && root.ChessCore,
      contract: root && root.AnalysisContract
    };
  }

  // Public API. Input: FEN + player color + the cloud's own first moves
  // (always kept in the pool, never re-emitted here). Output: an ordered,
  // deduped, capped list of { uci, kind, tag }.
  function rootCandidates(opts = {}) {
    const { core, contract } = helpers();
    if (!core || !contract || typeof contract.generateLegalMoves !== 'function') return [];
    const fen = opts && opts.fen;
    const playerColor = opts && opts.playerColor;
    const cloudMoves = Array.isArray(opts && opts.cloudMoves) ? opts.cloudMoves : [];
    const maxCandidates = Math.max(1, Math.min(24, Number(opts.maxCandidates) || 12));
    if (!fen || !playerColor) return [];
    const parsed = core.parseFen(fen);
    if (!parsed) return [];
    if (parsed.parts[1] !== playerColor) return [];
    const board = parsed.board;
    const enemyIsWhite = playerColor !== 'w';
    const enemyKing = contract.findKing(board, enemyIsWhite);
    const excluded = new Set(cloudMoves.filter(Boolean));
    const legal = contract.generateLegalMoves(fen);
    const seen = new Set();
    const buckets = { check: [], capture: [], sac: [], kingzone: [], storm: [] };

    // ── Phase 2 helpers: a candidate must have a POINT ───────────────────
    const value = (piece) => (piece ? (PIECE_VALUES[piece.toLowerCase()] || 0) : 0);
    const zoneSquares = [];
    if (enemyKing) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = enemyKing.row + dr, c = enemyKing.col + dc;
        if (r >= 0 && r < 8 && c >= 0 && c < 8) zoneSquares.push([r, c]);
      }
    }
    const pawnHits = (row, col) => {
      const dr = playerColor === 'w' ? -1 : 1;
      return [[row + dr, col - 1], [row + dr, col + 1]].filter(([r, c]) => r >= 0 && r < 8 && c >= 0 && c < 8);
    };
    // A storming pawn attacks the king's shelter: a king-zone square, or a
    // shield pawn within two squares of the king. File proximity is not a
    // storm — that rule is what generated the h6/h5/g5 spam.
    const pawnStormsShelter = (board2, row, col) => {
      if (!enemyKing) return false;
      for (const [r, c] of pawnHits(row, col)) {
        if (zoneSquares.some(([zr, zc]) => zr === r && zc === c)) return true;
        const target = board2[r][c];
        if (target && target.toLowerCase() === 'p' &&
            (target === target.toUpperCase()) === enemyIsWhite &&
            Math.max(Math.abs(r - enemyKing.row), Math.abs(c - enemyKing.col)) <= 2) return true;
      }
      return false;
    };
    for (const uci of legal) {
      if (excluded.has(uci) || seen.has(uci)) continue;
      const fromCol = uci.charCodeAt(0) - 97;
      const fromRow = 8 - Number(uci[1]);
      const toCol = uci.charCodeAt(2) - 97;
      const toRow = 8 - Number(uci[3]);
      if (fromRow < 0 || fromRow > 7 || fromCol < 0 || fromCol > 7 ||
          toRow < 0 || toRow > 7 || toCol < 0 || toCol > 7) continue;
      const piece = board[fromRow][fromCol];
      if (!piece) continue;
      const type = piece.toLowerCase();
      const captured = board[toRow][toCol];

      let nextBoard = null;
      let givesCheck = false;
      try {
        const nextFen = contract.applyMoveToFen(fen, uci);
        const next = nextFen ? core.parseFen(nextFen) : null;
        nextBoard = next ? next.board : null;
        givesCheck = Boolean(nextBoard && contract.kingInCheck(nextBoard, enemyIsWhite));
      } catch (_) { givesCheck = false; nextBoard = null; }
      if (!nextBoard) continue;

      const target = { row: toRow, col: toCol };
      const attackedByEnemy = contract.attacksSquare(nextBoard, target, enemyIsWhite);
      const defendedByUs = contract.attacksSquare(nextBoard, target, !enemyIsWhite);
      // Material exposure of the landing square, in pawns. Positive means the
      // move hangs something for nothing.
      const exposure = attackedByEnemy && !defendedByUs
        ? value(piece) - value(captured)
        : Math.max(0, value(piece) - value(captured) - (defendedByUs ? value(piece) : 0));

      const kingDist = enemyKing
        ? Math.max(Math.abs(toRow - enemyKing.row), Math.abs(toCol - enemyKing.col))
        : 99;

      let kind = null;
      if (givesCheck) {
        // A check that simply hangs the checking piece is not an attack idea.
        kind = exposure <= 0 || attackedByEnemy === false ? 'check' : (kingDist <= 2 ? 'sac' : null);
      } else if (captured) {
        const net = value(captured) - (attackedByEnemy && !defendedByUs ? value(piece) : 0);
        if (net >= 0) kind = 'capture';
        // A losing capture is only interesting as a sacrifice with a point:
        // it must land in the king's neighbourhood.
        else if (kingDist <= 2) kind = 'sac';
      } else if (type === 'p') {
        // Phase 2: pawn pushes enter ONLY as real storms — the pawn has to hit
        // the king's shelter. A storm pawn is ALLOWED to be capturable (the
        // classic h/g-pawn sacrifice opens the lines); the shallow-search
        // verification and the band ceiling downstream price that risk.
        if (pawnStormsShelter(nextBoard, toRow, toCol)) kind = 'storm';
      } else if (kingDist <= 2 && !(attackedByEnemy && !defendedByUs)) {
        kind = 'kingzone';
      }
      if (!kind) continue;
      seen.add(uci);
      buckets[kind].push({ uci, kind, tag: TAG_NAMES[kind] || 'attack line' });
    }

    const result = [];
    for (const kind of ['check', 'capture', 'sac', 'kingzone', 'storm']) {
      for (const entry of buckets[kind]) {
        result.push(entry);
        if (result.length >= maxCandidates) return result;
      }
    }
    return result;
  }

  const exported = { rootCandidates };
  root.AttackCandidates = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
