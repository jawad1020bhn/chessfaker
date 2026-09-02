/*
 * On-device alpha-beta fallback. Not Stockfish, but a legal MultiPV searcher
 * that keeps the coach useful when cloud providers are silent.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 */
(function (root) {
  'use strict';

  const PIECE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const PST = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0
    ],
    n: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50
    ],
    b: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20
    ],
    r: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0
    ],
    q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20
    ],
    k: [
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      20, 20, 0, 0, 0, 0, 20, 20,
      20, 30, 10, 0, 0, 10, 30, 20
    ]
  };

  function contract() {
    return root.AnalysisContract;
  }

  function pstValue(type, row, col, white) {
    const table = PST[type];
    if (!table) return 0;
    const index = white ? row * 8 + col : (7 - row) * 8 + col;
    return table[index] || 0;
  }

  // King safety, symmetric. Material+PST alone cannot see that a stripped
  // pawn shield in front of a queen-on-board king is worth real centipawns,
  // which made local fallback pools untrustworthy for style ranking (attack
  // features did not correlate with scores). Terms, white-relative:
  //   shield  : +8 per pawn on the three files around the king, 1-2 ranks in
  //             front (max 3 counted); a bare king loses ~30
  //   exposed : king still on its original e-file/rank block after move 8
  //             with queens on the board: -20
  // Only applied while at least one queen is present — in queenless
  // endgames a central king is an asset, not a liability (the PST already
  // handles middlegame king placement).
  function kingSafetyWhite(parsed, fen, queens) {
    if (!queens) return 0;
    const fullmove = parseInt(fen.split(' ')[5], 10) || 1;
    let score = 0;
    for (const white of [true, false]) {
      const kingChar = white ? 'K' : 'k';
      const pawnChar = white ? 'P' : 'p';
      let kingRow = -1, kingCol = -1;
      for (let row = 0; row < 8 && kingRow === -1; row++) {
        for (let col = 0; col < 8; col++) {
          if (parsed.board[row][col] === kingChar) { kingRow = row; kingCol = col; break; }
        }
      }
      if (kingRow === -1) continue;
      const forward = white ? -1 : 1; // toward the opponent
      let shield = 0;
      for (let dc of [-1, 0, 1]) {
        const col = kingCol + dc;
        if (col < 0 || col > 7) continue;
        for (let step = 1; step <= 2; step++) {
          const row = kingRow + forward * step;
          if (row < 0 || row > 7) continue;
          if (parsed.board[row][col] === pawnChar) { shield++; break; }
        }
      }
      const homeRow = white ? 7 : 0;
      const uncastled = kingRow === homeRow && kingCol === 4 && fullmove > 8;
      let term = Math.min(shield, 3) * 8 - 20; // bare king ≈ -20, full shield ≈ +4
      if (uncastled) term -= 20;
      score += white ? term : -term;
    }
    return score;
  }

  function evaluateWhite(fen) {
    const parsed = root.ChessCore.parseFen(fen);
    if (!parsed) return 0;
    let score = 0;
    let queens = false;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = parsed.board[row][col];
        if (!piece) continue;
        const type = piece.toLowerCase();
        if (type === 'q') queens = true;
        const white = piece === piece.toUpperCase();
        const value = (PIECE[type] || 0) + pstValue(type, row, col, white);
        score += white ? value : -value;
      }
    }
    score += kingSafetyWhite(parsed, fen, queens);
    return score;
  }

  function mvvLva(fen, uci) {
    const parsed = root.ChessCore.parseFen(fen);
    if (!parsed) return 0;
    const fromCol = uci.charCodeAt(0) - 97;
    const fromRow = 8 - Number(uci[1]);
    const toCol = uci.charCodeAt(2) - 97;
    const toRow = 8 - Number(uci[3]);
    const mover = parsed.board[fromRow][fromCol];
    const captured = parsed.board[toRow][toCol];
    if (!captured || !mover) return 0;
    return (PIECE[captured.toLowerCase()] || 0) * 10 - (PIECE[mover.toLowerCase()] || 0);
  }

  function orderedMoves(fen) {
    const moves = contract().generateLegalMoves(fen);
    return moves.sort((left, right) => mvvLva(fen, right) - mvvLva(fen, left));
  }

  function isCaptureOrPromo(fen, uci) {
    const parsed = root.ChessCore.parseFen(fen);
    if (!parsed) return Boolean(uci[4]);
    const toCol = uci.charCodeAt(2) - 97;
    const toRow = 8 - Number(uci[3]);
    return Boolean(uci[4] || parsed.board[toRow][toCol]);
  }

  function search(fen, depth, alpha, beta, maximizing, deadline, state) {
    if (state.nodes++ % 64 === 0 && Date.now() >= deadline) {
      state.timedOut = true;
      return evaluateWhite(fen);
    }
    const moves = orderedMoves(fen);
    if (!moves.length) {
      const parsed = root.ChessCore.parseFen(fen);
      const white = parsed?.parts[1] === 'w';
      if (parsed && contract().kingInCheck(parsed.board, white)) {
        return white ? -100000 + state.ply : 100000 - state.ply;
      }
      return 0;
    }
    if (depth <= 0) return quiesce(fen, alpha, beta, maximizing, deadline, state, 2);

    if (maximizing) {
      let best = -Infinity;
      for (const move of moves) {
        const next = contract().applyMoveToFen(fen, move);
        if (!next) continue;
        state.ply++;
        const score = search(next, depth - 1, alpha, beta, false, deadline, state);
        state.ply--;
        if (score > best) best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta || state.timedOut) break;
      }
      return best;
    }
    let best = Infinity;
    for (const move of moves) {
      const next = contract().applyMoveToFen(fen, move);
      if (!next) continue;
      state.ply++;
      const score = search(next, depth - 1, alpha, beta, true, deadline, state);
      state.ply--;
      if (score < best) best = score;
      if (score < beta) beta = score;
      if (alpha >= beta || state.timedOut) break;
    }
    return best;
  }

  function quiesce(fen, alpha, beta, maximizing, deadline, state, qDepth) {
    const stand = evaluateWhite(fen);
    if (qDepth <= 0 || state.timedOut) return stand;
    if (maximizing) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    } else {
      if (stand <= alpha) return stand;
      if (stand < beta) beta = stand;
    }
    const noisy = orderedMoves(fen).filter(move => isCaptureOrPromo(fen, move));
    for (const move of noisy) {
      const next = contract().applyMoveToFen(fen, move);
      if (!next) continue;
      const score = quiesce(next, alpha, beta, !maximizing, deadline, state, qDepth - 1);
      if (maximizing) {
        if (score > alpha) alpha = score;
        if (alpha >= beta) return alpha;
      } else {
        if (score < beta) beta = score;
        if (alpha >= beta) return beta;
      }
    }
    return maximizing ? alpha : beta;
  }

  function analyze(fen, options = {}) {
    const api = contract();
    if (!api || !root.ChessCore?.parseFen(fen)) return null;
    const multiPv = Math.max(1, Math.min(5, Number(options.multiPv) || 1));
    const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth) || 4));
    const timeMs = Math.max(40, Math.min(1200, Number(options.timeMs) || 180));
    const deadline = Date.now() + timeMs;
    const rootMoves = api.generateLegalMoves(fen);
    if (!rootMoves.length) return null;

    const whiteToMove = fen.split(' ')[1] !== 'b';
    let ranked = rootMoves.map(move => ({ move, score: 0, pv: [move] }));
    let reached = 1;
    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextRanked = [];
      for (const entry of ranked) {
        const child = api.applyMoveToFen(fen, entry.move);
        if (!child) continue;
        const state = { nodes: 0, ply: 1, timedOut: false };
        const score = search(child, depth - 1, -Infinity, Infinity, !whiteToMove, deadline, state);
        nextRanked.push({
          move: entry.move,
          score,
          pv: [entry.move],
          nodes: state.nodes,
          timedOut: state.timedOut
        });
        if (Date.now() >= deadline) break;
      }
      if (!nextRanked.length) break;
      nextRanked.sort((left, right) => whiteToMove ? right.score - left.score : left.score - right.score);
      ranked = nextRanked;
      reached = depth;
      if (Date.now() >= deadline) break;
    }

    // The opponent's answer in each PV used to be the FIRST legal move —
    // an arbitrary reply that fed wrong tactical context to the style
    // ranker (sacrifice detection reads pv[1]). Spend a shallow search per
    // line to report their best answer instead, time permitting.
    const bestReply = (childFen) => {
      if (!childFen || Date.now() >= deadline + timeMs) return null;
      const moves = orderedMoves(childFen);
      const childWhite = childFen.split(' ')[1] !== 'b';
      let bestMove = null;
      let bestScore = childWhite ? -Infinity : Infinity;
      for (const move of moves) {
        const grandchild = api.applyMoveToFen(childFen, move);
        if (!grandchild) continue;
        const state = { nodes: 0, ply: 1, timedOut: false };
        const score = quiesce(grandchild, -Infinity, Infinity, !childWhite, deadline + timeMs, state, 2);
        if (childWhite ? score > bestScore : score < bestScore) {
          bestScore = score;
          bestMove = move;
        }
      }
      return bestMove;
    };

    const selected = ranked.slice(0, multiPv);
    const pvs = selected.map((entry, index) => {
      const child = api.applyMoveToFen(fen, entry.move);
      const reply = index < 3 ? (child ? bestReply(child) : null) : null;
      return {
        multipv: index + 1,
        scoreType: Math.abs(entry.score) >= 90000 ? 'mate' : 'cp',
        score: Math.abs(entry.score) >= 90000
          ? (entry.score > 0 ? Math.max(1, 8 - reached) : -Math.max(1, 8 - reached))
          : entry.score,
        depth: reached,
        seldepth: reached,
        pv: reply ? [entry.move, reply] : [entry.move],
        nodes: entry.nodes || 0,
        nps: 0,
        time: timeMs
      };
    });

    return {
      fen,
      source: 'local-engine',
      pvs,
      bestMove: pvs[0]?.pv[0] || null,
      depth: reached,
      scorePerspective: 'white',
      isLocalEngine: true,
      timestamp: Date.now()
    };
  }

  // ─── Style-directed candidate search ────────────────────────────────
  // Ranks a small set of generated attacking candidates (from
  // engine/attack-candidates.js) instead of the full legal-move set. For each
  // candidate it reports the three numbers the safety layer needs:
  //   score  — the OBJECTIVE white-relative eval from the same shallow search
  //            `analyze` uses (so evalLoss vs the cloud best stays honest);
  //   pv     — [candidate, best shallow reply] (so sacrifice detection and
  //            forcing-PV counting read a real opponent answer, not the first
  //            arbitrary legal move);
  //   attackValue — a cheap attack bias (check / capture value / proximity to
  //            the enemy king) used only to ORDER the candidates here. The
  //            style ranker decides eligibility and final order downstream.
  // This is the `style: 'attack'` search hook: the objective search in
  // `analyze` is untouched, and the attack bias never leaks into scores.
  function analyzeCandidates(fen, candidates, options = {}) {
    const api = contract();
    if (!api || !root.ChessCore || !root.ChessCore.parseFen(fen)) return [];
    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length) return [];
    const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth) || 4));
    const timeMs = Math.max(40, Math.min(1200, Number(options.timeMs) || 180));
    const deadline = Date.now() + timeMs;
    const whiteToMove = fen.split(' ')[1] !== 'b';
    const parsed = root.ChessCore.parseFen(fen);
    const enemyIsWhite = !whiteToMove;
    const enemyKing = api.findKing(parsed.board, enemyIsWhite);

    const out = [];
    for (const cand of list) {
      const uci = cand && cand.uci;
      if (!uci || Date.now() >= deadline) break;
      const child = api.applyMoveToFen(fen, uci);
      if (!child) continue;
      const childParsed = root.ChessCore.parseFen(child);
      const childBoard = childParsed && childParsed.board;
      const state = { nodes: 0, ply: 1, timedOut: false };
      const score = search(child, maxDepth - 1, -Infinity, Infinity, !whiteToMove, deadline, state);

      // Best shallow reply, so a two-ply PV exists for the ranker's
      // sacrifice/forcing classification.
      let reply = null;
      const childWhite = child.split(' ')[1] !== 'b';
      for (const move of orderedMoves(child)) {
        const grandchild = api.applyMoveToFen(child, move);
        if (!grandchild) continue;
        const rstate = { nodes: 0, ply: 1, timedOut: false };
        const rscore = quiesce(grandchild, -Infinity, Infinity, !childWhite, deadline + timeMs, rstate, 2);
        if (childWhite ? rscore > (reply ? reply.score : -Infinity) : rscore < (reply ? reply.score : Infinity)) {
          reply = { move, score: rscore };
        }
        if (Date.now() >= deadline + timeMs) break;
      }

      let attackValue = childBoard && api.kingInCheck(childBoard, enemyIsWhite) ? 4 : 0;
      const fromCol = uci.charCodeAt(0) - 97;
      const fromRow = 8 - Number(uci[1]);
      const toCol = uci.charCodeAt(2) - 97;
      const toRow = 8 - Number(uci[3]);
      const captured = parsed.board[toRow][toCol];
      if (captured) attackValue += (PIECE[captured.toLowerCase()] || 0) / 100;
      if (enemyKing) attackValue += Math.max(0, 2 - Math.max(Math.abs(toRow - enemyKing.row), Math.abs(toCol - enemyKing.col)));

      out.push({
        uci,
        kind: cand.kind || 'candidate',
        tag: cand.tag || 'attack line',
        scoreType: Math.abs(score) >= 90000 ? 'mate' : 'cp',
        score: Math.abs(score) >= 90000 ? (score > 0 ? 1 : -1) : score,
        depth: maxDepth,
        pv: reply ? [uci, reply.move] : [uci],
        attackValue
      });
    }
    out.sort((a, b) =>
      (b.attackValue - a.attackValue) ||
      (whiteToMove ? (b.score - a.score) : (a.score - b.score)));
    return out;
  }

  const exported = { analyze, analyzeCandidates, evaluateWhite };
  root.LocalEngine = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
