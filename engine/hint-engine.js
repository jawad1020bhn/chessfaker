/**
 * Chess Hint Assistant — Three-Mode Hint Engine v9.2.0
 *
 * v9.2.0: Chaos Attack redesign with feature-delta scoring, attack explanations, and Safe/Bold/Wild comparison metadata.
 * v9.1.0: Updated version metadata for the DGT Slate & Tournament Obsidian redesign.
 *
 * Modes:
 *  - Normal: objective best play and reliable conversion.
 *  - Aggressive: fastest sound win through forcing play and initiative.
 *  - Chaos Attack: bold sacrifices, penetration, pawn storms, and maximum concrete pressure.
 *
 * Candidate selection is mate-safe, evaluation-budgeted, stateless, and based
 * on before/after board features plus the supplied principal variation.
 */

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────
  const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  // v8.5.0: Removed unused PIECE_UNICODE constant.

  // Exact-move-only product: all primary hints use this single level.
  const EXACT_HINT_LEVEL = 5;
  const HINT_LEVELS = {
    [EXACT_HINT_LEVEL]: { name: 'Exact Move', desc: 'Shows the selected move with SAN, squares, style, and plan' }
  };

  // ─── Playing Styles (v7.3 — 6 styles, incl. Berserker from v7.3) ──
  const PLAYING_STYLES = {
    normal: {
      id: 'normal',
      name: 'Normal',
      desc: 'Objective best play with reliable conversion and resilient defense.',
      riskBudget: { winning: 15, equal: 20, worse: 30 },
      sacrificeTolerance: 0,
      kingHuntBonus: 0,
      diversity: 0,
      weights: {}
    },
    aggressive: {
      id: 'aggressive',
      name: 'Aggressive',
      desc: 'Win as quickly as possible through sound forcing play, initiative, and king pressure.',
      riskBudget: { winning: 35, equal: 85, worse: 140 },
      sacrificeTolerance: 90,
      kingHuntBonus: 55,
      diversity: 0,
      weights: {
        check: 75,
        forcingPly: 24,
        kingPressure: 22,
        defenderRemoval: 28,
        tempo: 26,
        development: 16,
        openKingFile: 30,
        sustainedAttack: 38,
        soundSacrifice: 45,
        speculativeSacrifice: -55,
        simplification: -12,
        ownKingDanger: -32,
        unsupportedAttack: -30
      }
    },
    super_ultra_aggressive: {
      id: 'super_ultra_aggressive',
      name: 'Chaos Attack (vs <=1100)',
      desc: 'Fearless direct attack tailored for <=1100 opponents: hunt the king, launch pawn storms, sacrifice fearlessly, and overwhelm the defense with relentless tactical pressure.',
      // These are objective-evaluation budgets in centipawns, not a claim that
      // every sacrificed pawn is compensated. They widen as a position worsens.
      riskBudget: { winning: 200, advantage: 350, equal: 600, worse: 850, desperate: 1200 },
      sacrificeTolerance: 1500,
      kingHuntBonus: 260,
      diversity: 0.18,
      weights: {
        check: 280,
        doubleCheck: 190,
        forcingPly: 80,
        kingPressure: 120,
        defenderRemoval: 130,
        tempo: 80,
        development: 35,
        openKingFile: 160,
        sustainedAttack: 190,
        soundSacrifice: 300,
        speculativeSacrifice: 180,
        penetration: 95,
        deepPenetration: 140,
        pawnStorm: 120,
        passedPawnPush: 60,
        complexity: 80,
        simplification: -160,
        ownKingDanger: -5,
        unsupportedAttack: -5
      }
    }
  };

  // ─── Attacking Opening Repertoires ───────────────────────────────────
  // Every module is a curated, side-specific move tree. A repertoire is a
  // preference inside the engine/style safety budget, never a forced move.
  const OPENING_REPERTOIRES = {
    none: { id: 'none', name: 'No Preference', side: null, risk: 'none', lines: [], plan: '' },
    white_scotch_evans: { id: 'white_scotch_evans', name: 'Scotch / Evans Gambit', side: 'w', risk: 'sharp', plan: 'Develop rapidly, open the centre, and pressure f7 before Black completes development.', lines: [
      ['e2e4','e7e5','g1f3','b8c6','d2d4','e5d4','f1c4'],
      ['e2e4','e7e5','g1f3','b8c6','f1c4','f8c5','b2b4']
    ]},
    white_smith_morra: { id: 'white_smith_morra', name: 'Smith–Morra Gambit', side: 'w', risk: 'sharp', plan: 'Open the d-file, finish development quickly, and attack d6 and f7 with active pieces.', lines: [
      ['e2e4','c7c5','d2d4','c5d4','c2c3']
    ]},
    white_milner_barry: { id: 'white_milner_barry', name: 'Milner–Barry Gambit', side: 'w', risk: 'sharp', plan: 'Use the advanced centre to gain tempi, mobilise the kingside, and attack before Black can unwind.', lines: [
      ['e2e4','e7e6','d2d4','d7d5','b1c3','g8f6','e4e5','f6d7','f2f4']
    ]},
    white_panov: { id: 'white_panov', name: 'Panov Attack', side: 'w', risk: 'sound-aggressive', plan: 'Create active isolated-queen-pawn play: develop fast, pressure d5, and use e4 breaks.', lines: [
      ['e2e4','c7c6','d2d4','d7d5','e4d5','c6d5','c2c4']
    ]},
    white_austrian: { id: 'white_austrian', name: 'Austrian Attack', side: 'w', risk: 'sound-aggressive', plan: 'Claim kingside space with f4, restrict central counterplay, then build toward f5 and a direct attack.', lines: [
      ['e2e4','d7d6','d2d4','g8f6','b1c3','g7g6','f2f4'],
      ['e2e4','g7g6','d2d4','f8g7','b1c3','d7d6','f2f4']
    ]},
    black_najdorf: { id: 'black_najdorf', name: 'Sicilian Najdorf', side: 'b', risk: 'sharp', plan: 'Counterattack with ...a6 and ...b5, retain central flexibility, and challenge White’s kingside initiative.', lines: [
      ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','a7a6']
    ]},
    black_dragon: { id: 'black_dragon', name: 'Sicilian Dragon', side: 'b', risk: 'sharp', plan: 'Fianchetto the dark bishop, prepare ...d5, and generate counterplay against White’s attack.', lines: [
      ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','g7g6']
    ]},
    black_kings_indian: { id: 'black_kings_indian', name: 'King’s Indian Defense', side: 'b', risk: 'sharp', plan: 'Let White build a centre, then strike with ...e5 and a prepared kingside ...f5 break.', lines: [
      ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7']
    ]},
    black_benoni: { id: 'black_benoni', name: 'Modern Benoni', side: 'b', risk: 'sharp', plan: 'Use an asymmetric structure, pressure White’s centre, and create counterplay with ...b5 or ...f5.', lines: [
      ['d2d4','g8f6','c2c4','c7c5','d4d5','e7e6']
    ]},
    black_dutch: { id: 'black_dutch', name: 'Dutch Leningrad', side: 'b', risk: 'sharp', plan: 'Build the Leningrad structure, contest e4, and develop kingside pressure with ...e5 and ...f4 ideas.', lines: [
      ['d2d4','f7f5'], ['c2c4','f7f5']
    ]}
  };
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function repertoireState(fen, repertoire, playerColor) {
    if (!repertoire || repertoire.id === 'none' || repertoire.side !== playerColor || !fen) return null;
    const target = fen.split(' ').slice(0, 4).join(' ');
    const nextMoves = new Set();
    let matchedPly = 0;
    for (const line of repertoire.lines || []) {
      let cursor = START_FEN;
      if (cursor.split(' ').slice(0, 4).join(' ') === target && line[0]) nextMoves.add(line[0]);
      for (let index = 0; index < line.length; index++) {
        cursor = applyMoveToFen(cursor, line[index]);
        if (!cursor) break;
        if (cursor.split(' ').slice(0, 4).join(' ') === target) {
          matchedPly = Math.max(matchedPly, index + 1);
          const next = line[index + 1];
          if (next) nextMoves.add(next);
        }
      }
    }
    return matchedPly || nextMoves.size ? { id: repertoire.id, name: repertoire.name, plan: repertoire.plan, risk: repertoire.risk, matchedPly, nextMoves: [...nextMoves] } : null;
  }

  // ─── ECO Opening Database (v8.5.0 Enhancement J — externalised) ────
  // Loaded asynchronously from engine/eco.json. Falls back to a minimal
  // inline set if the fetch fails (e.g. CSP, dev environment).
  const ECO_FALLBACK = [
    { eco: 'B20', name: 'Sicilian Defense', moves: 'e4 c5' },
    { eco: 'C00', name: 'French Defense', moves: 'e4 e6' },
    { eco: 'C20', name: 'King Pawn Game', moves: 'e4 e5' },
    { eco: 'C50', name: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4' },
    { eco: 'C60', name: 'Ruy Lopez', moves: 'e4 e5 Nf3 Nc6 Bb5' },
    { eco: 'D06', name: "Queen's Gambit", moves: 'd4 d5 c4' },
    { eco: 'E60', name: "King's Indian Defense", moves: 'd4 Nf6 c4 g6' }
  ];
  let ECO_OPENINGS = ECO_FALLBACK;
  let ecoLoadPromise = null;

  function loadEcoDatabase() {
    if (ecoLoadPromise) return ecoLoadPromise;
    ecoLoadPromise = fetch(chrome.runtime.getURL('engine/eco.json'))
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          ECO_OPENINGS = data;
          console.log(`[HintEngine] Loaded ${data.length} ECO openings from eco.json`);
        }
      })
      .catch((e) => {
        console.warn('[HintEngine] eco.json load failed, using fallback:', e?.message || e);
      });
    return ecoLoadPromise;
  }
  // Kick off the load immediately — non-blocking, used whenever detectOpening runs.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    loadEcoDatabase();
  }

  // v8.5.0: Removed dead helpers getPieceOwnerLabel() and validateMoveSide()
  //         — neither was called anywhere; call sites do inline piece-side checks.

  // ─── Board Utilities ───────────────────────────────────────────────
  function parseFENPlacement(placement) {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    const rows = placement.split('/');
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') { c += parseInt(ch); }
        else { board[r][c] = ch; c++; }
      }
    }
    return board;
  }

  function squareName(row, col) {
    return String.fromCharCode(97 + col) + (8 - row);
  }

  function squareToCoords(sq) {
    return { row: 8 - parseInt(sq[1]), col: sq.charCodeAt(0) - 97 };
  }

  function getPieceAt(board, sq) {
    const { row, col } = squareToCoords(sq);
    return (row >= 0 && row < 8 && col >= 0 && col < 8) ? board[row][col] : null;
  }

  // ─── Apply UCI Move to Board (for progressive PV analysis) ────────
  function applyMoveToBoard(board, uci) {
    if (!uci || uci.length < 4) return board;
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promo = uci.length > 4 ? uci[4] : null;
    const fromCoords = squareToCoords(from);
    const toCoords = squareToCoords(to);

    // Deep copy the board
    const newBoard = board.map(row => [...row]);
    const piece = newBoard[fromCoords.row][fromCoords.col];
    if (!piece) return newBoard;

    // Move the piece
    newBoard[toCoords.row][toCoords.col] = piece;
    newBoard[fromCoords.row][fromCoords.col] = null;

    // Handle promotion
    if (promo) {
      const isWhite = piece === piece.toUpperCase();
      newBoard[toCoords.row][toCoords.col] = isWhite ? promo.toUpperCase() : promo.toLowerCase();
    }

    // Handle castling: move the rook too
    const pieceType = piece.toLowerCase();
    if (pieceType === 'k') {
      if (from === 'e1' && to === 'g1') { newBoard[7][5] = newBoard[7][7]; newBoard[7][7] = null; }
      if (from === 'e1' && to === 'c1') { newBoard[7][3] = newBoard[7][0]; newBoard[7][0] = null; }
      if (from === 'e8' && to === 'g8') { newBoard[0][5] = newBoard[0][7]; newBoard[0][7] = null; }
      if (from === 'e8' && to === 'c8') { newBoard[0][3] = newBoard[0][0]; newBoard[0][0] = null; }
    }

    // Handle en passant capture
    if (pieceType === 'p' && from[0] !== to[0] && !board[toCoords.row][toCoords.col]) {
      const capturedRow = fromCoords.row;
      newBoard[capturedRow][toCoords.col] = null;
    }

    return newBoard;
  }

  // ─── Apply UCI Move to FEN ─────────────────────────────────────────
  function applyMoveToFen(fen, uci) {
    if (!fen || !uci || uci.length < 4) return fen;
    const parts = fen.split(' ');
    let placement = parts[0];
    let activeColor = parts[1] || 'w';
    let castling = parts[2] || '-';
    let epSquare = parts[3] || '-';
    let halfmove = parseInt(parts[4]) || 0;
    let fullmove = parseInt(parts[5]) || 1;

    const board = parseFENPlacement(placement);
    const newBoard = applyMoveToBoard(board, uci);

    // Rebuild placement string
    let newPlacement = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        if (newBoard[r][c]) {
          if (empty > 0) { newPlacement += empty; empty = 0; }
          newPlacement += newBoard[r][c];
        } else {
          empty++;
        }
      }
      if (empty > 0) newPlacement += empty;
      if (r < 7) newPlacement += '/';
    }

    const newActiveColor = activeColor === 'w' ? 'b' : 'w';

    // Update castling rights
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    if (from === 'e1') castling = castling.replace(/[KQ]/g, '');
    if (from === 'e8') castling = castling.replace(/[kq]/g, '');
    if (from === 'h1') castling = castling.replace(/K/g, '');
    if (from === 'a1') castling = castling.replace(/Q/g, '');
    if (from === 'h8') castling = castling.replace(/k/g, '');
    if (from === 'a8') castling = castling.replace(/q/g, '');
    // Capturing a rook on its original square also permanently removes that right.
    const capturedOnTarget = board[squareToCoords(to).row][squareToCoords(to).col];
    if (capturedOnTarget === 'R' && to === 'h1') castling = castling.replace(/K/g, '');
    if (capturedOnTarget === 'R' && to === 'a1') castling = castling.replace(/Q/g, '');
    if (capturedOnTarget === 'r' && to === 'h8') castling = castling.replace(/k/g, '');
    if (capturedOnTarget === 'r' && to === 'a8') castling = castling.replace(/q/g, '');
    if (!castling) castling = '-';

    // Update en passant square
    const piece = board[squareToCoords(from).row][squareToCoords(from).col];
    const pieceType = piece ? piece.toLowerCase() : '';
    if (pieceType === 'p' && Math.abs(parseInt(from[1]) - parseInt(to[1])) === 2) {
      const epRow = (parseInt(from[1]) + parseInt(to[1])) / 2;
      epSquare = from[0] + epRow;
    } else {
      epSquare = '-';
    }

    // Update halfmove clock
    const isCapture = board[squareToCoords(to).row][squareToCoords(to).col] !== null;
    const isEpCapture = pieceType === 'p' && from[0] !== to[0] && !board[squareToCoords(to).row][squareToCoords(to).col];
    if (pieceType === 'p' || isCapture || isEpCapture) { halfmove = 0; } else { halfmove++; }

    // Update fullmove number
    if (activeColor === 'b') fullmove++;

    return `${newPlacement} ${newActiveColor} ${castling} ${epSquare} ${halfmove} ${fullmove}`;
  }

  // ─── Proper UCI-to-SAN Conversion ─────────────────────────────────
  function uciToSan(uci, fen) {
    if (!uci || uci.length < 4) return uci || '???';

    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promo = uci.length > 4 ? uci[4] : null;

    const parts = (fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').split(' ');
    const placement = parts[0];
    const board = parseFENPlacement(placement);

    const piece = getPieceAt(board, from);
    if (!piece) return from + '-' + to;

    const pieceType = piece.toLowerCase();
    const targetPiece = getPieceAt(board, to);
    const isEnPassant = pieceType === 'p' && from[0] !== to[0] && targetPiece === null;
    const isCapture = targetPiece !== null || isEnPassant;

    // Castling still needs a check/checkmate suffix (for example O-O+).
    if (pieceType === 'k') {
      let castle = null;
      if ((from === 'e1' && to === 'g1') || (from === 'e8' && to === 'g8')) castle = 'O-O';
      if ((from === 'e1' && to === 'c1') || (from === 'e8' && to === 'c8')) castle = 'O-O-O';
      if (castle) return castle + computeCheckOrMateSuffix(uci, fen);
    }

    let san = '';
    if (pieceType !== 'p') san += piece.toUpperCase();

    // Disambiguation
    if (pieceType !== 'p' && pieceType !== 'k') {
      const sameType = findPiecesOfType(board, piece, piece === piece.toUpperCase());
      const ambiguous = sameType.filter(sq => {
        if (sq === from) return false;
        const isWhitePiece = piece === piece.toUpperCase();
        return canPieceReachSquare(board, sq, to, pieceType, isWhitePiece) &&
          moveLeavesOwnKingSafe(board, sq, to, isWhitePiece);
      });
      if (ambiguous.length > 0) {
        const fromCol = from[0], fromRow = from[1];
        const sameFile = ambiguous.some(sq => sq[0] === fromCol);
        const sameRank = ambiguous.some(sq => sq[1] === fromRow);
        if (!sameFile) san += fromCol;
        else if (!sameRank) san += fromRow;
        else san += fromCol + fromRow;
      }
    }

    if (pieceType === 'p' && isCapture) san += from[0];
    if (isCapture) san += 'x';
    san += to;
    if (promo) san += '=' + promo.toUpperCase();

    // v8.5.0: Append check (+) / checkmate (#) suffixes per SAN standard.
    // We apply the move to a board copy, then test if the opponent's king
    // is in check; if so, test if they have any legal reply (mate).
    const suffix = computeCheckOrMateSuffix(uci, fen);
    if (suffix) san += suffix;

    return san;
  }

  // v8.5.0: Returns '+' for check, '#' for checkmate, '' otherwise.
  // Lightweight — applies the move, then does a square-attack test on
  // the opponent king. Mate detection uses a simplified legal-move check
  // (no castling/en-passant edge cases — rare in PV continuation contexts).
  function computeCheckOrMateSuffix(uci, fen) {
    if (!uci || uci.length < 4 || !fen) return '';
    try {
      const parts = fen.split(' ');
      const placement = parts[0];
      const activeColor = parts[1] || 'w';
      const board = parseFENPlacement(placement);
      const newBoard = applyMoveToBoard(board, uci);
      // The side just moved was `activeColor`; opponent is the other.
      const opponentColor = activeColor === 'w' ? 'b' : 'w';
      const oppKing = opponentColor === 'w' ? 'K' : 'k';
      let kingPos = null;
      for (let r = 0; r < 8 && !kingPos; r++) {
        for (let c = 0; c < 8 && !kingPos; c++) {
          if (newBoard[r][c] === oppKing) kingPos = { row: r, col: c };
        }
      }
      if (!kingPos) return '';
      // v8.5.0 bugfix: attacker is the side that just moved (activeColor),
      // NOT the opponent. The opponent's king is in check if attacked by
      // the just-moved side's pieces.
      const inCheck = isSquareAttacked(newBoard, kingPos, activeColor);
      if (!inCheck) return '';
      // Check if opponent has any legal move → if not, it's mate.
      const hasMove = hasAnyLegalMove(newBoard, opponentColor);
      return hasMove ? '+' : '#';
    } catch (_) {
      return '';
    }
  }

  function isSquareAttacked(board, target, byColor) {
    // byColor = side doing the attacking
    const isWhite = byColor === 'w';
    // Pawn attacks (pawn attacks diagonally forward)
    const pawn = isWhite ? 'P' : 'p';
    const pawnDir = isWhite ? 1 : -1; // white pawn at row+1 attacks upward (row decreasing in FEN), so pawn dir = +1 means defender is one row lower
    // Actually in our board[0]=rank8 convention, white pawns move up = row decreasing.
    // A white pawn on square (r+1, c±1) attacks (r, c).
    const attackerPawnRow = target.row + (isWhite ? 1 : -1);
    for (const dc of [-1, 1]) {
      const c = target.col + dc;
      if (attackerPawnRow >= 0 && attackerPawnRow < 8 && c >= 0 && c < 8) {
        if (board[attackerPawnRow][c] === pawn) return true;
      }
    }
    // Knight attacks
    const knight = isWhite ? 'N' : 'n';
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const r = target.row + dr, c = target.col + dc;
      if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === knight) return true;
    }
    // King attacks
    const king = isWhite ? 'K' : 'k';
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = target.row + dr, c = target.col + dc;
        if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === king) return true;
      }
    }
    // Sliding: bishop/queen (diagonal)
    const bishop = isWhite ? 'B' : 'b';
    const queen = isWhite ? 'Q' : 'q';
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      let r = target.row + dr, c = target.col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        if (board[r][c]) {
          if (board[r][c] === bishop || board[r][c] === queen) return true;
          break;
        }
        r += dr; c += dc;
      }
    }
    // Sliding: rook/queen (orthogonal)
    const rook = isWhite ? 'R' : 'r';
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      let r = target.row + dr, c = target.col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        if (board[r][c]) {
          if (board[r][c] === rook || board[r][c] === queen) return true;
          break;
        }
        r += dr; c += dc;
      }
    }
    return false;
  }

  function moveLeavesOwnKingSafe(board, fromSq, toSq, isWhite) {
    const target = getPieceAt(board, toSq);
    // Kings are never captured in legal chess; checkmate is no legal escape.
    if (target && target.toLowerCase() === 'k') return false;
    const newBoard = applyMoveToBoard(board, fromSq + toSq);
    const kingChar = isWhite ? 'K' : 'k';
    let kingPos = null;
    for (let r = 0; r < 8 && !kingPos; r++) {
      for (let c = 0; c < 8 && !kingPos; c++) {
        if (newBoard[r][c] === kingChar) kingPos = { row: r, col: c };
      }
    }
    return Boolean(kingPos) && !isSquareAttacked(newBoard, kingPos, isWhite ? 'b' : 'w');
  }

  function hasAnyLegalMove(board, color) {
    const isWhite = color === 'w';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p) continue;
        const pieceIsWhite = p === p.toUpperCase();
        if (pieceIsWhite !== isWhite) continue;
        const type = p.toLowerCase();
        // Try every candidate destination square — just need one legal move.
        for (let tr = 0; tr < 8; tr++) {
          for (let tc = 0; tc < 8; tc++) {
            if (tr === r && tc === c) continue;
            const target = board[tr][tc];
            if (target && (target === target.toUpperCase()) === isWhite) continue; // can't capture own piece
            const dr = tr - r, dc = tc - c;
            let reachable = false;
            if (type === 'p') {
              const forward = isWhite ? -1 : 1;
              if (dc === 0 && dr === forward && !target) reachable = true;
              if (dc === 0 && dr === 2 * forward && !target && !board[r + forward][c]) {
                if ((isWhite && r === 6) || (!isWhite && r === 1)) reachable = true;
              }
              if (Math.abs(dc) === 1 && dr === forward && target) reachable = true;
            } else if (type === 'n') {
              if ((Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2)) reachable = true;
            } else if (type === 'k') {
              if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1) reachable = true;
            } else if (type === 'b') {
              if (Math.abs(dr) === Math.abs(dc) && dr !== 0 && isPathClear(board, r, c, tr, tc)) reachable = true;
            } else if (type === 'r') {
              if ((dr === 0 || dc === 0) && (dr !== 0 || dc !== 0) && isPathClear(board, r, c, tr, tc)) reachable = true;
            } else if (type === 'q') {
              const isDiag = Math.abs(dr) === Math.abs(dc) && dr !== 0;
              const isStraight = (dr === 0 || dc === 0) && (dr !== 0 || dc !== 0);
              if ((isDiag || isStraight) && isPathClear(board, r, c, tr, tc)) reachable = true;
            }
            if (!reachable) continue;
            // Simulate the move and check if own king is left in check.
            const fromSq = squareName(r, c);
            const toSq = squareName(tr, tc);
            if (moveLeavesOwnKingSafe(board, fromSq, toSq, isWhite)) return true;
          }
        }
      }
    }
    return false;
  }

  function findPiecesOfType(board, pieceSymbol, isWhite) {
    const squares = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c] === pieceSymbol) squares.push(squareName(r, c));
      }
    }
    return squares;
  }

  function canPieceReachSquare(board, fromSq, toSq, pieceType, isWhite) {
    const from = squareToCoords(fromSq);
    const to = squareToCoords(toSq);
    const dr = to.row - from.row;
    const dc = to.col - from.col;
    if (pieceType === 'n') return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);
    if (pieceType === 'b') { if (Math.abs(dr) !== Math.abs(dc) || dr === 0) return false; return isPathClear(board, from.row, from.col, to.row, to.col); }
    if (pieceType === 'r') { if (dr !== 0 && dc !== 0) return false; return isPathClear(board, from.row, from.col, to.row, to.col); }
    if (pieceType === 'q') { const isDiag = Math.abs(dr) === Math.abs(dc) && dr !== 0; const isStraight = (dr === 0 || dc === 0) && (dr !== 0 || dc !== 0); if (!isDiag && !isStraight) return false; return isPathClear(board, from.row, from.col, to.row, to.col); }
    if (pieceType === 'k') return Math.abs(dr) <= 1 && Math.abs(dc) <= 1;
    return false;
  }

  function isPathClear(board, fromRow, fromCol, toRow, toCol) {
    const dr = Math.sign(toRow - fromRow);
    const dc = Math.sign(toCol - fromCol);
    let r = fromRow + dr, c = fromCol + dc;
    while (r !== toRow || c !== toCol) {
      if (r < 0 || r >= 8 || c < 0 || c >= 8) return false;
      if (board[r][c]) return false;
      r += dr; c += dc;
    }
    return true;
  }

  // ─── Move Classification ───────────────────────────────────────────
  function classifyMove(evalBefore, evalAfter) {
    const diff = evalAfter - evalBefore;
    if (diff >= 60) return { label: 'Brilliant', symbol: '!!', color: '#26cad4' };
    if (diff >= 30) return { label: 'Great', symbol: '!', color: '#5aade0' };
    if (diff >= -10) return { label: 'Best', symbol: '', color: '#97af8b' };
    if (diff >= -40) return { label: 'Good', symbol: '', color: '#97af8b' };
    if (diff >= -90) return { label: 'Inaccuracy', symbol: '?!', color: '#f7c631' };
    if (diff >= -200) return { label: 'Mistake', symbol: '?', color: '#e6923a' };
    return { label: 'Blunder', symbol: '??', color: '#ca3531' };
  }

  // ─── Position Assessment ───────────────────────────────────────────
  function assessPosition(fen) {
    if (!fen || typeof fen !== 'string') {
      return {
        material: { whiteVal: 0, blackVal: 0, balance: 0, description: 'No position', whitePieces: {}, blackPieces: {}, bishopPairWhite: false, bishopPairBlack: false, totalPieces: 0 },
        kingSafety: { issues: [], wKingPos: null, bKingPos: null },
        pawnStructure: { issues: [], whitePassedPawns: 0, blackPassedPawns: 0 },
        pieceActivity: { issues: [], developed: 0 },
        threats: []
      };
    }
    const parts = fen.split(' ');
    const placement = parts[0];
    const activeColor = parts[1] || 'w';
    const board = parseFENPlacement(placement);
    const material = assessMaterial(board);
    const kingSafety = assessKingSafety(board);
    const pawnStructure = assessPawnStructure(board);
    const pieceActivity = assessPieceActivity(board, activeColor);
    const threats = detectTacticalPatterns(board, activeColor);
    return { material, kingSafety, pawnStructure, pieceActivity, threats };
  }

  function assessMaterial(board) {
    let whiteVal = 0, blackVal = 0;
    const whitePieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const blackPieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;
        const type = piece.toLowerCase();
        const isWhite = piece === piece.toUpperCase();
        const val = PIECE_VALUES[type] || 0;
        if (isWhite) { whiteVal += val; if (type !== 'k') whitePieces[type]++; }
        else { blackVal += val; if (type !== 'k') blackPieces[type]++; }
      }
    }
    const balance = whiteVal - blackVal;
    let description = '';
    if (balance > 5) description = 'Decisive material advantage for White';
    else if (balance > 2) description = 'White has a significant material advantage';
    else if (balance > 0) description = 'White has a slight material edge';
    else if (balance === 0) description = 'Material is equal';
    else if (balance > -2) description = 'Black has a slight material edge';
    else if (balance > -5) description = 'Black has a significant material advantage';
    else description = 'Decisive material advantage for Black';
    return { whiteVal, blackVal, balance, description, whitePieces, blackPieces, bishopPairWhite: whitePieces.b >= 2, bishopPairBlack: blackPieces.b >= 2, totalPieces: Object.values(whitePieces).reduce((a, b) => a + b, 0) + Object.values(blackPieces).reduce((a, b) => a + b, 0) };
  }

  function assessKingSafety(board) {
    const issues = [];
    let wKingPos = null, bKingPos = null;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { if (board[r][c] === 'K') wKingPos = { row: r, col: c }; if (board[r][c] === 'k') bKingPos = { row: r, col: c }; }
    [{ pos: wKingPos, color: 'w', pawn: 'P', backRank: 7 }, { pos: bKingPos, color: 'b', pawn: 'p', backRank: 0 }].forEach(({ pos, color, pawn, backRank }) => {
      if (!pos) return;
      const forward = color === 'w' ? -1 : 1;
      let shieldMissing = 0;
      for (let dc = -1; dc <= 1; dc++) { const r = pos.row + forward, c = pos.col + dc; if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] !== pawn) shieldMissing++; }
      if (shieldMissing >= 2) issues.push({ color, issue: `${color === 'w' ? 'White' : 'Black'} king pawn shield is broken`, severity: 'high' });
      else if (shieldMissing === 1) issues.push({ color, issue: `${color === 'w' ? 'White' : 'Black'} king pawn shield has a gap`, severity: 'medium' });
      for (let f = Math.max(0, pos.col - 1); f <= Math.min(7, pos.col + 1); f++) {
        let hasPawn = false;
        for (let r = 0; r < 8; r++) { if (board[r][f] === pawn) { hasPawn = true; break; } }
        if (!hasPawn) issues.push({ color, issue: `Open ${String.fromCharCode(97 + f)}-file near ${color === 'w' ? 'White' : 'Black'} king`, severity: 'medium' });
      }
    });
    return { issues, wKingPos, bKingPos };
  }

  function assessPawnStructure(board) {
    const issues = [];
    let whitePassedPawns = 0, blackPassedPawns = 0;
    for (let c = 0; c < 8; c++) {
      let wCount = 0, bCount = 0;
      for (let r = 0; r < 8; r++) {
        if (board[r][c] === 'P') { wCount++; if (isPassedPawn(board, r, c, 'w')) whitePassedPawns++; }
        if (board[r][c] === 'p') { bCount++; if (isPassedPawn(board, r, c, 'b')) blackPassedPawns++; }
      }
      const fn = String.fromCharCode(97 + c);
      if (wCount >= 2) issues.push({ color: 'w', issue: `Doubled pawns on ${fn}-file`, severity: 'low' });
      if (bCount >= 2) issues.push({ color: 'b', issue: `Doubled pawns on ${fn}-file`, severity: 'low' });
    }
    if (whitePassedPawns > 0) issues.push({ color: 'w', issue: `White has ${whitePassedPawns} passed pawn(s)`, severity: 'high' });
    if (blackPassedPawns > 0) issues.push({ color: 'b', issue: `Black has ${blackPassedPawns} passed pawn(s)`, severity: 'high' });
    return { issues, whitePassedPawns, blackPassedPawns };
  }

  function isPassedPawn(board, row, col, color) {
    const enemyPawn = color === 'w' ? 'p' : 'P';
    const forward = color === 'w' ? -1 : 1;
    for (let r = row + forward; r >= 0 && r < 8; r += forward) for (let dc = -1; dc <= 1; dc++) { const cc = col + dc; if (cc >= 0 && cc < 8 && board[r][cc] === enemyPawn) return false; }
    return true;
  }

  function assessPieceActivity(board, activeColor) {
    const issues = [];
    const isW = activeColor === 'w';
    const backRank = isW ? 7 : 0;
    let developed = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = board[r][c]; if (!p) continue; const isWhite = p === p.toUpperCase(); if (isWhite !== isW) continue; const type = p.toLowerCase(); if ((type === 'n' || type === 'b') && r !== backRank) developed++; }
    if (developed < 2) issues.push({ color: activeColor, issue: 'Develop minor pieces before attacking', severity: 'medium' });
    return { issues, developed };
  }

  function detectTacticalPatterns(board, activeColor) {
    const patterns = [];
    const isW = activeColor === 'w';
    const enemyPieces = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = board[r][c]; if (!p) continue; const isWhite = p === p.toUpperCase(); if (isWhite !== isW) enemyPieces.push({ type: p.toLowerCase(), row: r, col: c }); }
    for (const enemy of enemyPieces) {
      if (enemy.type === 'k') continue;
      if (!isDefended(board, enemy, !isW ? 'w' : 'b')) {
        patterns.push({ type: 'hanging-piece', description: `Undefended ${PIECE_NAMES[enemy.type]} on ${squareName(enemy.row, enemy.col)}`, severity: enemy.type === 'q' ? 'high' : 'medium', issue: `Undefended ${PIECE_NAMES[enemy.type]} on ${squareName(enemy.row, enemy.col)}` });
      }
    }
    return patterns;
  }

  function isDefended(board, piece, byColor) {
    const isW = byColor === 'w';
    const pawn = isW ? 'P' : 'p', knight = isW ? 'N' : 'n', bishop = isW ? 'B' : 'b', rook = isW ? 'R' : 'r', queen = isW ? 'Q' : 'q', king = isW ? 'K' : 'k';
    const pawnDir = isW ? 1 : -1;
    for (const dc of [-1, 1]) { const pr = piece.row + pawnDir, pc = piece.col + dc; if (pr >= 0 && pr < 8 && pc >= 0 && pc < 8 && board[pr][pc] === pawn) return true; }
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const nr = piece.row + dr, nc = piece.col + dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === knight) return true; }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (dr === 0 && dc === 0) continue; const kr = piece.row + dr, kc = piece.col + dc; if (kr >= 0 && kr < 8 && kc >= 0 && kc < 8 && board[kr][kc] === king) return true; }
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) { let r = piece.row + dr, c = piece.col + dc; while (r >= 0 && r < 8 && c >= 0 && c < 8) { if (board[r][c]) { if (board[r][c] === bishop || board[r][c] === queen) return true; break; } r += dr; c += dc; } }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) { let r = piece.row + dr, c = piece.col + dc; while (r >= 0 && r < 8 && c >= 0 && c < 8) { if (board[r][c]) { if (board[r][c] === rook || board[r][c] === queen) return true; break; } r += dr; c += dc; } }
    return false;
  }

  // ─── Opening Detection ─────────────────────────────────────────────
  function detectOpening(moveHistory) {
    if (!moveHistory || moveHistory.length === 0) return null;
    const movesStr = moveHistory.join(' ');
    let bestMatch = null, bestMatchLength = 0;
    for (const opening of ECO_OPENINGS) {
      if (movesStr.startsWith(opening.moves) || opening.moves.startsWith(movesStr.substring(0, opening.moves.length))) {
        if (opening.moves.split(' ').length > bestMatchLength) { bestMatch = opening; bestMatchLength = opening.moves.split(' ').length; }
      }
    }
    return bestMatch;
  }

  // ─── Game Phase Detection ──────────────────────────────────────────
  function detectGamePhase(fen) {
    if (!fen || typeof fen !== 'string') return 'opening';
    const parts = fen.split(' ');
    const board = parseFENPlacement(parts[0]);
    const fullmove = parseInt(parts[5], 10) || 1;
    let phaseMaterial = 0, queens = 0, pawns = 0, undevelopedMinors = 0;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const type = piece.toLowerCase();
      if (type === 'p') pawns++;
      if (type === 'q') { queens++; phaseMaterial += 4; }
      if (type === 'r') phaseMaterial += 2;
      if (type === 'n' || type === 'b') {
        phaseMaterial += 1;
        const white = piece === piece.toUpperCase();
        if (row === (white ? 7 : 0)) undevelopedMinors++;
      }
    }
    if (phaseMaterial <= 8 || (queens === 0 && phaseMaterial <= 12) || pawns <= 6) return 'endgame';
    if (fullmove <= 10 && undevelopedMinors >= 2 && phaseMaterial >= 18) return 'opening';
    return 'middlegame';
  }

  // ─── Winning Plan Generation ───────────────────────────────────────
  function generateWinningPlan(evalScore, scoreType, position, playerColor, fen, style) {
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (scoreType === 'mate') {
      if (evalScore > 0) return `Force checkmate in ${Math.abs(evalScore)} move${Math.abs(evalScore) !== 1 ? 's' : ''}!`;
      return `Stop the forced mate — use every check, tempo, and escape square available.`;
    }

    const phase = detectGamePhase(fen);
    if (currentStyle.id === 'aggressive') {
      if (evalScore > 150) return 'Convert fast: keep the initiative, force concessions, and choose the shortest sound route to the king or material gain.';
      if (evalScore > -80) return 'Seize the initiative now: improve attackers with tempo and force the opponent to react.';
      return 'Create active counterplay immediately — checks, threats, and tempo are more valuable than passive defense.';
    }
    if (currentStyle.id === 'super_ultra_aggressive') {
      if (evalScore > 100) return 'Finish fast: swarm the enemy king, maintain relentless attack, and force immediate tactical collapse.';
      if (evalScore > -100) return 'Direct attack vs <=1100: open lines, launch pawn storms, and sacrifice material fearlessly to overwhelm their defense.';
      return 'Fearless counter-attack: launch checks, deep invasions, and aggressive sacrifices. Apply maximum pressure until they crack!';
    }

    if (evalScore > 300) {
      const balance = playerColor === 'w' ? position.material.balance : -position.material.balance;
      if (balance > 0) return 'Convert reliably: trade pieces, preserve pawns, and remove counterplay.';
      return phase === 'endgame' ? 'Activate your king and advance passed pawns.' : 'Consolidate the advantage before beginning the final attack.';
    }
    if (evalScore > 100) return 'Improve the least active piece and increase pressure without allowing counterplay.';
    if (evalScore > -100) return 'Maintain flexibility, improve piece activity, and play against the clearest weakness.';
    if (evalScore > -300) return 'Defend actively and create counterplay rather than waiting passively.';
    return 'Maximize resistance: preserve material, seek tactical resources, and simplify only when it improves survival chances.';
  }

  // ─── Candidate analysis and style scoring ─────────────────────────
  // Retained as a compatibility hook; the rebuilt scorer is intentionally stateless.
  function resetSacrificeHistory() {}

  // Style scoring is pure: hypothetical candidates never mutate game history.
  function findKing(board, isWhite) {
    const symbol = isWhite ? 'K' : 'k';
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      if (board[row][col] === symbol) return { row, col };
    }
    return null;
  }

  function materialForSide(board, isWhite) {
    let value = 0;
    for (const row of board) for (const piece of row) {
      if (piece && (piece === piece.toUpperCase()) === isWhite) value += (PIECE_VALUES[piece.toLowerCase()] || 0) * 100;
    }
    return value;
  }

  function pieceAttacksSquare(board, row, col, targetRow, targetCol) {
    const piece = board[row]?.[col];
    if (!piece || (row === targetRow && col === targetCol)) return false;
    const type = piece.toLowerCase();
    const isWhite = piece === piece.toUpperCase();
    const dr = targetRow - row, dc = targetCol - col;
    if (type === 'p') return dr === (isWhite ? -1 : 1) && Math.abs(dc) === 1;
    if (type === 'n') return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);
    if (type === 'k') return Math.max(Math.abs(dr), Math.abs(dc)) === 1;
    if (type === 'b' && Math.abs(dr) === Math.abs(dc)) return isPathClear(board, row, col, targetRow, targetCol);
    if (type === 'r' && (dr === 0 || dc === 0)) return isPathClear(board, row, col, targetRow, targetCol);
    if (type === 'q' && (dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc))) return isPathClear(board, row, col, targetRow, targetCol);
    return false;
  }

  function kingZonePressure(board, attackerIsWhite, kingPos) {
    if (!kingPos) return { attackers: 0, pressure: 0, attackedSquares: 0 };
    const attackingPieces = new Set();
    const attackedZone = new Set();
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || (piece === piece.toUpperCase()) !== attackerIsWhite) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const tr = kingPos.row + dr, tc = kingPos.col + dc;
        if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
        if (pieceAttacksSquare(board, row, col, tr, tc)) {
          attackingPieces.add(`${row},${col}`);
          attackedZone.add(`${tr},${tc}`);
        }
      }
    }
    let pressure = 0;
    for (const key of attackingPieces) {
      const [row, col] = key.split(',').map(Number);
      pressure += ({ p: 1, n: 2, b: 2, r: 3, q: 5, k: 1 })[board[row][col].toLowerCase()] || 0;
    }
    return { attackers: attackingPieces.size, pressure, attackedSquares: attackedZone.size };
  }

  function attackersToSquare(board, target, attackerIsWhite) {
    if (!target) return 0;
    let count = 0;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && (piece === piece.toUpperCase()) === attackerIsWhite &&
          pieceAttacksSquare(board, row, col, target.row, target.col)) count++;
    }
    return count;
  }

  function countPieces(board) {
    let count = 0;
    for (const row of board) for (const piece of row) if (piece) count++;
    return count;
  }

  function isDevelopingMove(piece, from) {
    if (!piece || !['n', 'b'].includes(piece.toLowerCase())) return false;
    const isWhite = piece === piece.toUpperCase();
    return squareToCoords(from).row === (isWhite ? 7 : 0);
  }

  function moveAttacksHighValuePiece(board, to, playerIsWhite) {
    const pos = squareToCoords(to);
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const target = board[row][col];
      if (!target || (target === target.toUpperCase()) === playerIsWhite) continue;
      if (['q', 'r'].includes(target.toLowerCase()) && pieceAttacksSquare(board, pos.row, pos.col, row, col)) return true;
    }
    return false;
  }

  function attackTerrain(board, playerIsWhite, opponentKing) {
    const isEnemyHalf = row => playerIsWhite ? row <= 3 : row >= 4;
    const isDeepEnemyHalf = row => playerIsWhite ? row <= 1 : row >= 6;
    const attackFiles = opponentKing?.col >= 4 ? [5, 6, 7] : [0, 1, 2];
    let penetration = 0, deepPenetration = 0, pawnStorm = 0, advancedPawns = 0;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || (piece === piece.toUpperCase()) !== playerIsWhite || piece.toLowerCase() === 'k') continue;
      if (isEnemyHalf(row)) penetration++;
      if (isDeepEnemyHalf(row)) deepPenetration++;
      if (piece.toLowerCase() === 'p') {
        if (attackFiles.includes(col) && isEnemyHalf(row)) pawnStorm++;
        if (playerIsWhite ? row <= 2 : row >= 5) advancedPawns++;
      }
    }
    return { penetration, deepPenetration, pawnStorm, advancedPawns };
  }

  function analyzeCandidate(fen, pv, playerColor, rawScore, scoreType, depth = 0) {
    const line = Array.isArray(pv) ? pv.filter(Boolean).slice(0, 8) : [];
    const board = parseFENPlacement((fen || '').split(' ')[0]);
    const playerIsWhite = playerColor === 'w';
    const first = line[0] || '';
    const from = first.slice(0, 2), to = first.slice(2, 4);
    const piece = first ? getPieceAt(board, from) : null;
    const captured = first ? getPieceAt(board, to) : null;
    if (!piece) return { rawScore, scoreType, depth, invalid: true, reasons: [], risks: [] };

    const opponentKingBefore = findKing(board, !playerIsWhite);
    const ownKingBefore = findKing(board, playerIsWhite);
    const pressureBefore = kingZonePressure(board, playerIsWhite, opponentKingBefore);
    const ownDangerBefore = kingZonePressure(board, !playerIsWhite, ownKingBefore);
    const materialBefore = materialForSide(board, playerIsWhite);
    const piecesBefore = countPieces(board);
    const after = applyMoveToBoard(board, first);
    const opponentKingAfter = findKing(after, !playerIsWhite);
    const ownKingAfter = findKing(after, playerIsWhite);
    const pressureAfter = kingZonePressure(after, playerIsWhite, opponentKingAfter);
    const ownDangerAfter = kingZonePressure(after, !playerIsWhite, ownKingAfter);
    const givesCheck = opponentKingAfter ? isSquareAttacked(after, opponentKingAfter, playerColor) : false;
    const destination = squareToCoords(to);
    const defended = isSquareAttacked(after, destination, playerColor);

    let currentFen = fen;
    let currentBoard = board;
    let forcingPly = 0;
    let playerForcingMoves = 0;
    let boardAfterReply = after;
    for (let i = 0; i < line.length; i++) {
      const move = line[i];
      const target = getPieceAt(currentBoard, move.slice(2, 4));
      const movedBoard = applyMoveToBoard(currentBoard, move);
      const movingColor = (currentFen.split(' ')[1] || 'w');
      const enemyKing = findKing(movedBoard, movingColor === 'w' ? false : true);
      const checks = enemyKing ? isSquareAttacked(movedBoard, enemyKing, movingColor) : false;
      if (checks || target) {
        forcingPly++;
        if (movingColor === playerColor) playerForcingMoves++;
      } else if (i > 0) break;
      currentBoard = movedBoard;
      currentFen = applyMoveToFen(currentFen, move);
      if (i === 1) boardAfterReply = currentBoard;
    }

    const materialAfterReply = materialForSide(boardAfterReply, playerIsWhite);
    const materialDelta = materialAfterReply - materialBefore;
    const movingPieceSurvives = Boolean(getPieceAt(boardAfterReply, to)) &&
      (getPieceAt(boardAfterReply, to) === getPieceAt(boardAfterReply, to).toUpperCase()) === playerIsWhite;
    const sacrifice = materialDelta <= -180 && !movingPieceSurvives;
    const defenderRemoval = captured && opponentKingBefore
      ? Math.max(Math.abs(destination.row - opponentKingBefore.row), Math.abs(destination.col - opponentKingBefore.col)) <= 2
      : false;
    const opensKingFile = opponentKingAfter && ['r', 'q'].includes(piece.toLowerCase()) &&
      (destination.row === opponentKingAfter.row || destination.col === opponentKingAfter.col) &&
      pieceAttacksSquare(after, destination.row, destination.col, opponentKingAfter.row, opponentKingAfter.col);
    const closeToKing = opponentKingAfter
      ? Math.max(Math.abs(destination.row - opponentKingAfter.row), Math.abs(destination.col - opponentKingAfter.col)) <= 2
      : false;
    const attackersOnKing = attackersToSquare(after, opponentKingAfter, playerIsWhite);
    // Style preferences must reward what the candidate *creates*, rather than
    // repeatedly rewarding an attack that was already on the board.
    const terrainBefore = attackTerrain(board, playerIsWhite, opponentKingBefore);
    const terrainAfter = attackTerrain(after, playerIsWhite, opponentKingAfter);
    const penetrationDelta = terrainAfter.penetration - terrainBefore.penetration;
    const deepPenetrationDelta = terrainAfter.deepPenetration - terrainBefore.deepPenetration;
    const pawnStormDelta = terrainAfter.pawnStorm - terrainBefore.pawnStorm;
    const passedPawnPush = terrainAfter.advancedPawns > terrainBefore.advancedPawns;

    const features = {
      rawScore, scoreType, depth, first, from, to, piece, captured,
      givesCheck,
      doubleCheck: givesCheck && attackersOnKing >= 2,
      attackersOnKing,
      penetration: terrainAfter.penetration,
      penetrationDelta,
      deepPenetration: terrainAfter.deepPenetration,
      deepPenetrationDelta,
      pawnStorm: terrainAfter.pawnStorm,
      pawnStormDelta,
      passedPawnPush,
      winningMate: scoreType === 'mate' && rawScore > 0,
      losingMate: scoreType === 'mate' && rawScore < 0,
      forcingPly,
      playerForcingMoves,
      kingPressureDelta: (pressureAfter.pressure - pressureBefore.pressure) +
        (pressureAfter.attackedSquares - pressureBefore.attackedSquares) * 0.5,
      attackersAfter: pressureAfter.attackers,
      ownKingDangerDelta: (ownDangerAfter.pressure - ownDangerBefore.pressure) +
        (ownDangerAfter.attackedSquares - ownDangerBefore.attackedSquares) * 0.5,
      defenderRemoval,
      tempo: moveAttacksHighValuePiece(after, to, playerIsWhite),
      development: isDevelopingMove(piece, from),
      opensKingFile,
      sustainedAttack: playerForcingMoves >= 2 || (pressureAfter.attackers >= 3 && pressureAfter.pressure > pressureBefore.pressure),
      sacrifice,
      // A speculative sacrifice must create an immediate attacking fact, not
      // merely lose material. This is a gate for Chaos Attack's bonus.
      chaosSacrificeTrigger: sacrifice && (givesCheck || opensKingFile || defenderRemoval || terrainAfter.pawnStorm >= 2 || terrainAfter.penetration >= 4),
      materialDelta,
      movingPieceSurvives,
      simplification: piecesBefore - countPieces(boardAfterReply),
      complexity: Math.max(0, forcingPly - 1) + Math.max(0, pressureAfter.attackers - 1),
      unsupportedAttack: closeToKing && !defended && !givesCheck,
      castling: piece.toLowerCase() === 'k' && Math.abs(squareToCoords(from).col - destination.col) === 2,
      centralMove: destination.row >= 2 && destination.row <= 5 && destination.col >= 2 && destination.col <= 5,
      earlyQueenMove: piece.toLowerCase() === 'q' && detectGamePhase(fen) === 'opening',
      edgePawnMove: piece.toLowerCase() === 'p' && (destination.col === 0 || destination.col === 7),
      supportedDestination: defended,
      calculationBurden: Math.max(0, line.length * 1.2 + (sacrifice ? 3 : 0) + Math.max(0, ownDangerAfter.pressure - ownDangerBefore.pressure) - forcingPly * 0.65),
      followUpUci: line[2] || null,
      masterGames: 0,
      plan: givesCheck || pressureAfter.pressure > pressureBefore.pressure
        ? (opponentKingAfter?.col >= 4 ? 'kingside attack' : 'queenside attack')
        : isDevelopingMove(piece, from) ? 'complete development'
        : piecesBefore - countPieces(boardAfterReply) > 1 ? 'force a favorable simplification'
        : captured ? 'win material with tempo'
        : 'improve piece activity',
      humanReasons: [], humanRisks: [],
      reasons: [], risks: []
    };
    return features;
  }

  function candidateStyleBonus(candidate, style) {
    const weights = style.weights || {};
    let bonus = 0;
    const add = (condition, key, amount, reason) => {
      if (!condition || !amount) return;
      bonus += amount;
      if (amount > 0 && reason) candidate.reasons.push(reason);
      if (amount < 0 && reason) candidate.risks.push(reason);
    };
    add(candidate.givesCheck, 'check', weights.check, 'forces a check');
    add(candidate.doubleCheck, 'doubleCheck', weights.doubleCheck, 'forces a double check');
    add(candidate.forcingPly > 0, 'forcingPly', weights.forcingPly * Math.min(candidate.forcingPly, 4), `${candidate.forcingPly}-ply forcing sequence`);
    add(candidate.kingPressureDelta > 0, 'kingPressure', weights.kingPressure * Math.min(candidate.kingPressureDelta, 6), 'increases concrete king pressure');
    add(candidate.defenderRemoval, 'defenderRemoval', weights.defenderRemoval, 'removes a king defender');
    add(candidate.tempo, 'tempo', weights.tempo, 'gains tempo on a major piece');
    add(candidate.development, 'development', weights.development, 'develops with attacking purpose');
    add(candidate.opensKingFile, 'openKingFile', weights.openKingFile, 'opens a direct line to the king');
    add(candidate.sustainedAttack, 'sustainedAttack', weights.sustainedAttack, 'keeps the attack forcing');
    add(candidate.penetrationDelta > 0, 'penetration', weights.penetration * Math.min(candidate.penetrationDelta, 2), 'penetrates the opponent half');
    add(candidate.deepPenetrationDelta > 0, 'deepPenetration', weights.deepPenetration * Math.min(candidate.deepPenetrationDelta, 2), 'establishes a deep invading piece');
    add(candidate.pawnStormDelta > 0, 'pawnStorm', weights.pawnStorm * Math.min(candidate.pawnStormDelta, 2), 'drives a pawn storm toward the king');
    add(candidate.passedPawnPush, 'passedPawnPush', weights.passedPawnPush, 'creates a dangerous advanced pawn');
    if (candidate.sacrifice) {
      // Up to one pawn of objective cost is treated as sound compensation;
      // larger eligible sacrifices are explicitly speculative.
      const sound = candidate.winningMate || candidate.evalLoss <= 100;
      const withinSacrificeTolerance = Math.abs(candidate.materialDelta || 0) <= (style.sacrificeTolerance || 0);
      add(sound, 'soundSacrifice', weights.soundSacrifice, 'offers material with concrete compensation');
      add(!sound && withinSacrificeTolerance && candidate.chaosSacrificeTrigger, 'speculativeSacrifice', weights.speculativeSacrifice, 'opens immediate chaos around the king');
      add(!sound && (!withinSacrificeTolerance || !candidate.chaosSacrificeTrigger), 'speculativeSacrifice', -Math.abs(weights.speculativeSacrifice || 0),
        withinSacrificeTolerance ? 'sacrifice lacks an immediate attacking trigger' : 'sacrifice exceeds the Chaos Attack material limit');
      candidate.sacrificeSoundness = sound ? 'sound' : (withinSacrificeTolerance && candidate.chaosSacrificeTrigger ? 'speculative' : 'unsound');
    }
    add(candidate.complexity > 0, 'complexity', weights.complexity * Math.min(candidate.complexity, 4), 'creates practical complexity');
    add(candidate.simplification > 1, 'simplification', weights.simplification * Math.min(candidate.simplification - 1, 3), 'simplifies the attack');
    add(candidate.ownKingDangerDelta > 0, 'ownKingDanger', weights.ownKingDanger * Math.min(candidate.ownKingDangerDelta, 5), 'weakens your own king');
    add(candidate.unsupportedAttack, 'unsupportedAttack', weights.unsupportedAttack, 'attacking piece lacks support');
    return bonus;
  }

  function scoreMoveForStyle(uci, fen, rawScore, scoreType, style, playerColor) {
    const profile = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (profile.id === 'normal') return rawScore;
    const candidate = analyzeCandidate(fen, [uci], playerColor, rawScore, scoreType);
    candidate.evalLoss = 0;
    return rawScore + candidateStyleBonus(candidate, profile);
  }

  function humanNaturalness(candidate, profile, context = {}, bestScore = 0) {
    let score = 0;
    const reward = (condition, amount, reason) => {
      if (!condition) return;
      score += amount;
      if (reason) candidate.humanReasons.push(reason);
    };
    const penalize = (condition, amount, reason) => {
      if (!condition) return;
      score -= amount;
      if (reason) candidate.humanRisks.push(reason);
    };

    reward(candidate.castling, 38, 'gets the king safe with a familiar plan');
    reward(candidate.development, 30, 'develops a new piece naturally');
    reward(candidate.centralMove, 10, 'improves central influence');
    reward(candidate.tempo, 24, 'creates an easy-to-follow tempo threat');
    reward(candidate.supportedDestination, 12, 'places the piece on a supported square');
    reward(candidate.givesCheck && candidate.forcingPly >= 2, 18, 'starts a clear forcing sequence');
    reward(candidate.sustainedAttack, 24, 'keeps a coherent attack going');
    reward(context.activePlan && candidate.plan === context.activePlan, 28, `continues the ${candidate.plan} plan`);
    if (candidate.masterGames > 0) {
      const popularity = Math.min(28, Math.log10(candidate.masterGames + 1) * 8);
      reward(true, popularity, `has practical master-game experience (${candidate.masterGames} games)`);
    }

    if (profile.id !== 'super_ultra_aggressive') {
      penalize(candidate.earlyQueenMove && !candidate.givesCheck && !candidate.tempo, 28, 'moves the queen early without a forcing gain');
      penalize(candidate.edgePawnMove && candidate.kingPressureDelta <= 0, 16, 'pushes an edge pawn without immediate purpose');
      penalize(candidate.unsupportedAttack, 30, 'leaves the attacking piece hard to support');
      penalize(candidate.ownKingDangerDelta > 1.5, Math.min(30, candidate.ownKingDangerDelta * 5), 'makes your own king harder to handle');
      penalize(candidate.calculationBurden > 7, Math.min(24, (candidate.calculationBurden - 7) * 3), 'requires a long precise continuation');
    }

    if (profile.id === 'normal') {
      reward(bestScore > 180 && candidate.simplification > 1, 18, 'converts the advantage with a simpler position');
      penalize(candidate.sacrifice, 26, 'introduces unnecessary material risk');
    } else if (profile.id === 'aggressive') {
      reward(candidate.playerForcingMoves >= 2, 25, 'renews the threat on consecutive moves');
      reward(candidate.development && candidate.kingPressureDelta > 0, 20, 'develops directly into the attack');
      penalize(candidate.sacrificeSoundness === 'speculative', 35, 'the fastest-looking attack is not fully forced');
    } else {
      reward(candidate.doubleCheck, 55, 'delivers a devastating double check');
      reward(candidate.givesCheck && candidate.forcingPly >= 1, 45, 'launches a direct, relentless attack');
      reward(candidate.kingPressureDelta > 0, Math.min(70, Math.round(candidate.kingPressureDelta * 22)), 'swarms the enemy king with relentless pressure');
      reward(candidate.penetrationDelta > 0, Math.min(60, candidate.penetrationDelta * 25), 'invades deep into enemy territory');
      reward(candidate.deepPenetrationDelta > 0, Math.min(70, candidate.deepPenetrationDelta * 30), 'establishes a terrifying deep-invasion attacking piece');
      reward(candidate.pawnStormDelta > 0, Math.min(65, candidate.pawnStormDelta * 28), 'drives a ruthless pawn storm straight at the enemy king');
      reward(candidate.sacrifice, candidate.sacrificeSoundness === 'sound' ? 80 : 50,
        candidate.sacrificeSoundness === 'sound' ? 'executes a sound, game-ending sacrifice' : 'launches a fearless speculative sacrifice to shatter the defense');
      reward(candidate.complexity >= 2, 40, 'creates maximum tactical chaos');
      reward(candidate.opensKingFile, 45, 'rips open direct attack lines straight at the king');
    }

    candidate.naturalnessScore = Math.round(score);
    candidate.planContinuity = Boolean(context.activePlan && candidate.plan === context.activePlan);
    candidate.humanSummary = candidate.humanReasons.slice(0, 3).join(', ');
    return score;
  }

  function playerScore(pv, playerColor) {
    const score = Number(pv?.score) || 0;
    return playerColor === 'w' ? score : -score;
  }

  function objectiveUtility(pv, playerColor) {
    const score = playerScore(pv, playerColor);
    if (pv?.scoreType === 'mate') {
      if (score > 0) return 1000000 - Math.min(Math.abs(score), 9999);
      if (score < 0) return -1000000 + Math.min(Math.abs(score), 9999);
    }
    return score;
  }

  function riskBudgetFor(style, bestScore) {
    // Chaos Attack deliberately scales risk by the practical need to create
    // chances. The other profiles retain their original compact policy.
    if (style.id === 'super_ultra_aggressive') {
      if (bestScore > 200) return style.riskBudget.winning;
      if (bestScore > 50) return style.riskBudget.advantage;
      if (bestScore > -50) return style.riskBudget.equal;
      if (bestScore > -200) return style.riskBudget.worse;
      return style.riskBudget.desperate;
    }
    if (bestScore > 150) return style.riskBudget.winning;
    if (bestScore < -100) return style.riskBudget.worse;
    return style.riskBudget.equal;
  }

  function stableFenFraction(fen, salt = '') {
    let hash = 2166136261;
    for (const ch of `${fen}|${salt}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
  }

  // Returns PVs in style order. Each PV receives non-invasive _styleAnalysis
  // metadata used to keep hints, candidates, and explanations synchronized.
  function selectPVForStyle(pvs, fen, style, playerColor, humanLikeMode = false, context = {}) {
    if (!Array.isArray(pvs) || pvs.length === 0) return [];
    const profile = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (pvs.length === 1) {
      if (!humanLikeMode) return pvs;
      const only = pvs[0];
      const score = playerScore(only, playerColor);
      const meta = analyzeCandidate(fen, only.pv || [], playerColor, score, only.scoreType, only.depth || 0);
      meta.evalLoss = 0;
      meta.objectiveRank = 1;
      meta.styleRank = 1;
      meta.mode = profile.id;
      meta.humanLikeMode = true;
      meta.limitedCandidates = true;
      meta.masterGames = Number(only._masterData?.totalGames || context.openingData?.moves?.find(move => move.uci === only.pv?.[0])?.total || 0);
      candidateStyleBonus(meta, profile);
      humanNaturalness(meta, profile, context, score);
      return [{ ...only, _styleAnalysis: meta }];
    }
    const objective = pvs.map((pv, index) => ({ pv, index, utility: objectiveUtility(pv, playerColor), score: playerScore(pv, playerColor) }))
      .sort((a, b) => b.utility - a.utility);
    const objectiveBest = objective[0];

    if (profile.id === 'normal' && !humanLikeMode) {
      const repertoireMoves = new Set(context.repertoire?.nextMoves || []);
      const bestScore = objectiveBest.score;
      const bestIsWinningMate = objectiveBest.pv.scoreType === 'mate' && bestScore > 0;
      // Repertoire moves are a soft preference only when they remain within
      // half a pawn of the engine choice. A repertoire can never displace a
      // forced mate with a centipawn line; among mating lines, keep the fastest.
      const isSafeRepertoireMove = (entry) => {
        if (!repertoireMoves.has(entry.pv.pv?.[0])) return false;
        if (bestIsWinningMate) {
          return entry.pv.scoreType === 'mate' && entry.score > 0 && Math.abs(entry.score) <= Math.abs(bestScore);
        }
        return bestScore - entry.score <= 50;
      };
      const ordered = repertoireMoves.size
        ? [...objective].sort((left, right) => {
            const leftPreferred = isSafeRepertoireMove(left);
            const rightPreferred = isSafeRepertoireMove(right);
            return Number(rightPreferred) - Number(leftPreferred) || right.utility - left.utility;
          })
        : objective;
      return ordered.map((entry, rank) => ({
        ...entry.pv,
        _styleAnalysis: {
          objectiveRank: objective.findIndex(candidate => candidate.index === entry.index) + 1,
          styleRank: rank + 1,
          evalLoss: Math.max(0, bestScore - entry.score),
          reasons: repertoireMoves.has(entry.pv.pv?.[0]) ? ['matches the active repertoire'] : ['objective best play'],
          risks: [], mode: profile.id,
          repertoireMove: repertoireMoves.has(entry.pv.pv?.[0])
        }
      }));
    }

    const bestIsWinningMate = objectiveBest.pv.scoreType === 'mate' && objectiveBest.score > 0;
    const budget = riskBudgetFor(profile, objectiveBest.score);
    const candidates = objective.map((entry, rank) => {
      let evalLoss;
      if (bestIsWinningMate) {
        evalLoss = entry.pv.scoreType === 'mate' && entry.score > 0 ? Math.max(0, Math.abs(entry.score) - Math.abs(objectiveBest.score)) : Infinity;
      } else if (entry.pv.scoreType === 'mate') {
        evalLoss = entry.score > 0 ? 0 : Infinity;
      } else if (objectiveBest.pv.scoreType === 'mate') {
        evalLoss = Infinity;
      } else {
        evalLoss = Math.max(0, objectiveBest.score - entry.score);
      }
      const analysis = analyzeCandidate(fen, entry.pv.pv || [], playerColor, entry.score, entry.pv.scoreType, entry.pv.depth || 0);
      const firstMove = entry.pv.pv?.[0];
      const openingMove = context.openingData?.moves?.find(move => move.uci === firstMove);
      analysis.masterGames = Number(entry.pv._masterData?.totalGames || openingMove?.total || 0);
      analysis.evalLoss = evalLoss;
      analysis.objectiveRank = rank + 1;
      analysis.mode = profile.id;
      const eligible = Number.isFinite(evalLoss) && (bestIsWinningMate ? evalLoss === 0 : evalLoss <= budget);
      const bonus = eligible ? candidateStyleBonus(analysis, profile) : -Infinity;
      // Aggressive is especially focused on converting quickly: objective cost
      // remains expensive, while checks and sustained forcing play can overcome it.
      const lossWeight = profile.id === 'normal' ? 1.5 : (profile.id === 'aggressive' ? 1.25 : 0.62);
      const repertoireBonus = context.repertoire?.nextMoves?.includes(firstMove) ? 45 : 0;
      const styleScore = eligible ? bonus - evalLoss * lossWeight + repertoireBonus : -Infinity;
      analysis.repertoireMove = repertoireBonus > 0;
      return { ...entry, analysis, eligible, bonus: bonus + repertoireBonus, styleScore };
    });

    let eligible = candidates.filter(candidate => candidate.eligible);
    if (!eligible.length) eligible = [candidates.find(candidate => candidate.index === objectiveBest.index) || candidates[0]];
    eligible.sort((a, b) => b.styleScore - a.styleScore || b.utility - a.utility);
    if (humanLikeMode && eligible.length > 0 && !bestIsWinningMate) {
      const standardBest = eligible[0].styleScore;
      const shortlistMargin = profile.id === 'normal' ? 32 : (profile.id === 'aggressive' ? 70 : 90);
      const shortlist = eligible.filter(candidate => standardBest - candidate.styleScore <= shortlistMargin);
      for (const candidate of shortlist) {
        const naturalness = humanNaturalness(candidate.analysis, profile, context, objectiveBest.score);
        const humanWeight = profile.id === 'normal' ? 0.8 : (profile.id === 'aggressive' ? 0.65 : 0.52);
        candidate.humanScore = candidate.styleScore + naturalness * humanWeight;
      }
      shortlist.sort((a, b) => b.humanScore - a.humanScore || b.styleScore - a.styleScore || b.utility - a.utility);
      const shortlisted = new Set(shortlist);
      eligible = [...shortlist, ...eligible.filter(candidate => !shortlisted.has(candidate))];
    }


    // Stable, tightly controlled variety for Chaos Attack only. It never applies
    // to mate lines and only considers a near-tied second attacking candidate.
    if (!humanLikeMode && profile.diversity > 0 && !bestIsWinningMate && eligible.length > 1 &&
        eligible[0].styleScore - eligible[1].styleScore <= 18 &&
        stableFenFraction(fen, profile.id) < profile.diversity) {
      [eligible[0], eligible[1]] = [eligible[1], eligible[0]];
    }

    const ineligible = candidates.filter(candidate => !candidate.eligible).sort((a, b) => b.utility - a.utility);
    return [...eligible, ...ineligible].map((candidate, styleRank) => ({
      ...candidate.pv,
      _styleAnalysis: {
        ...candidate.analysis,
        styleRank: styleRank + 1,
        styleBonus: Number.isFinite(candidate.bonus) ? Math.round(candidate.bonus) : 0,
        riskBudget: budget,
        eligible: candidate.eligible,
        humanLikeMode,
        humanScore: Number.isFinite(candidate.humanScore) ? Math.round(candidate.humanScore) : null
      }
    }));
  }

  // ─── Style-Aware Move Annotation ───────────────────────────────────
  // v6.2: Enhanced with pawn storm, exchange sacrifice, outpost, prophylactic annotations
  function annotateMoveForStyle(uci, fen, style, evalScore, styleAnalysis = null) {
    const profile = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (profile.id === 'normal') return [];
    const analysis = styleAnalysis || analyzeCandidate(fen, [uci], (fen.split(' ')[1] || 'w'), evalScore, 'cp');
    const annotations = [];
    if (analysis.givesCheck) annotations.push('forcing check');
    if (analysis.sustainedAttack) annotations.push('sustained attack');
    if (analysis.kingPressureDelta > 0) annotations.push('king pressure');
    if (analysis.defenderRemoval) annotations.push('removes defender');
    if (analysis.tempo) annotations.push('tempo');
    if (analysis.development) annotations.push('active development');
    if (analysis.opensKingFile) annotations.push('open king line');
    if (analysis.sacrifice) annotations.push(analysis.sacrificeSoundness === 'sound' ? 'sound sacrifice' : (analysis.sacrificeSoundness === 'speculative' ? 'speculative sacrifice' : 'unsound sacrifice'));
    if (profile.id === 'super_ultra_aggressive') annotations.push('chaos attack');
    else annotations.push('aggressive');
    return [...new Set(annotations)];
  }

  // ─── Generate Hints (Main Entry) ───────────────────────────────────
  function generateHints(analysisData, hintLevel, playerColor, style, openingRepertoire, humanLikeMode = false, humanContext = {}) {
    hintLevel = EXACT_HINT_LEVEL;
    const { fen, pvs, bestMove, source, tablebaseData, openingData } = analysisData;
    const position = assessPosition(fen);
    const isWhite = playerColor === 'w';
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    const currentRepertoire = OPENING_REPERTOIRES[openingRepertoire] || OPENING_REPERTOIRES.none;

    // Apply the rebuilt, mate-safe style ranking. Normal also receives objective
    // metadata, while one-PV sources remain unchanged and are explained honestly.
    let rankedPVs = pvs?.[0]?._styleAnalysis
      ? pvs
      : (pvs && pvs.length > 1 ? selectPVForStyle(pvs, fen, style, playerColor, humanLikeMode, { ...humanContext, openingData, repertoire: repertoireState(fen, currentRepertoire, playerColor) }) : (pvs || []));
    if (humanLikeMode && rankedPVs.length === 1 && !rankedPVs[0]._styleAnalysis) {
      const only = rankedPVs[0];
      const score = playerScore(only, playerColor);
      const meta = analyzeCandidate(fen, only.pv || [], playerColor, score, only.scoreType, only.depth || 0);
      meta.evalLoss = 0;
      meta.objectiveRank = 1;
      meta.styleRank = 1;
      meta.mode = currentStyle.id;
      meta.humanLikeMode = true;
      meta.limitedCandidates = true;
      candidateStyleBonus(meta, currentStyle);
      humanNaturalness(meta, currentStyle, { ...humanContext, openingData, repertoire: repertoireState(fen, currentRepertoire, playerColor) }, score);
      rankedPVs = [{ ...only, _styleAnalysis: meta }];
    }
    const bestPV = rankedPVs.length > 0 ? rankedPVs[0] : null;
    // All scores are normalized to White's perspective.
    const evalScore = bestPV ? (isWhite ? bestPV.score : -bestPV.score) : 0;
    const scoreType = bestPV ? bestPV.scoreType : 'cp';

    // Determine whose turn it is from the FEN
    const activeColor = (fen && typeof fen === 'string') ? (fen.split(' ')[1] || 'w') : 'w';
    const isAssistedPlayerTurn = activeColor === playerColor;

    const hints = {
      level: hintLevel,
      levelName: HINT_LEVELS[hintLevel]?.name || 'Unknown',
      main: '',
      threat: '',
      positionAssessment: position,
      pvs: formatPVs(rankedPVs, isWhite, hintLevel, fen),
      bestMove: formatMove(bestPV && bestPV.pv && bestPV.pv.length > 0 ? bestPV.pv[0] : bestMove, fen),
      bestMoveFromTo: '',
      continuation: [],
      moveClassification: null,
      opening: null,
      winningPlan: '',
      styleAnnotation: '',
      styleName: currentStyle.name,
      humanLikeMode,
      selectionMode: humanLikeMode ? 'human-like' : 'standard',
      source: source || 'unknown',
      // Expose turn info for UI rendering
      isAssistedPlayerTurn,
      activeColor,
      playerColor
    };

    // If not the assisted player's turn, show side-specific opponent analysis
    if (!isAssistedPlayerTurn && bestPV) {
      generateOpponentTurnHints(hints, bestPV, rankedPVs, evalScore, scoreType, position, playerColor, activeColor, fen || '', hintLevel, currentStyle);
      return hints;
    }

    // Tablebase hint override
    if (tablebaseData && tablebaseData.isTablebase) {
      hints.main = generateTablebaseHint(tablebaseData, playerColor, fen || '');
      if (bestPV && bestPV.pv && bestPV.pv.length > 0) {
        const uci = bestPV.pv[0];
        const from = uci.substring(0, 2);
        const to = uci.substring(2, 4);
        const board = fen ? parseFENPlacement(fen.split(' ')[0]) : null;
        const piece = board ? getPieceAt(board, from) : null;
        const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
        // v5.4.0: Use actual piece color
        const isPieceWhite = piece && piece === piece.toUpperCase();
        const sideLabel = isPieceWhite ? 'White' : 'Black';
        hints.bestMoveFromTo = `${sideLabel}: ${pieceName}: ${from} \u2192 ${to}`;
      }
      hints.winningPlan = generateTablebasePlan(tablebaseData, playerColor);
      if (humanLikeMode) {
        const category = tablebaseData.category || 'unknown';
        hints.main += category === 'draw'
          ? ' Human plan: keep the position active and preserve the drawing setup; avoid unnecessary pawn moves.'
          : category === 'win' || category === 'syzygy-win'
            ? ' Human plan: improve the king, restrict counterplay, and convert one clear step at a time.'
            : ' Human plan: make the opponent prove the win and keep creating practical obstacles.';
      }
      return hints;
    }

    // Exact-move-only primary hint.
    hints.main = generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle, currentRepertoire, analysisData.moveHistory);
    hints.fairPlayWarning = 'Using exact move hints frequently may cause your moves to match engine recommendations, which fair play systems can detect.';

    // Explain why the selected move fits the requested mode. This keeps lower
    // hint levels educational and gives exact/deep hints concrete compensation.
    if (bestPV?._styleAnalysis) {
      const meta = bestPV._styleAnalysis;
      hints.styleAnalysis = meta;
      if (humanLikeMode) {
        if (hintLevel === EXACT_HINT_LEVEL) {
          hints.main = hints.main.replace(/^Best:/, 'Human choice:')
            .replace(/^Aggressive choice:/, 'Human Aggressive choice:')
            .replace(/^Chaos Attack choice:/, 'Human Chaos Attack choice:');
        }
        const humanReasons = (meta.humanReasons || []).slice(0, 3);
        const humanRisks = [...(meta.humanRisks || []), ...(meta.risks || [])].slice(0, 2);
        hints.main += ` Human plan: ${meta.plan || 'improve the position with a clear purpose'}.`;
        if (humanReasons.length) hints.main += ` Why it feels natural: ${humanReasons.join(', ')}.`;
        if (hintLevel === EXACT_HINT_LEVEL && meta.followUpUci && bestPV.pv?.length >= 3) {
          let followFen = fen;
          followFen = applyMoveToFen(followFen, bestPV.pv[0]);
          if (bestPV.pv[1]) followFen = applyMoveToFen(followFen, bestPV.pv[1]);
          hints.main += ` If the expected reply comes, continue with ${uciToSan(meta.followUpUci, followFen)}.`;
        }
        if (hintLevel === EXACT_HINT_LEVEL && humanRisks.length) hints.main += ` Practical risk: ${humanRisks.join(', ')}.`;
      } else if (currentStyle.id !== 'normal') {
        const reasons = (meta.reasons || []).slice(0, 3);
        const risks = (meta.risks || []).slice(0, 2);
        if (reasons.length) {
          const prefix = currentStyle.id === 'aggressive' ? 'Fast-win idea' : 'Maximum-pressure idea';
          hints.main += ` ${prefix}: ${reasons.join(', ')}.`;
        }
        if (hintLevel === EXACT_HINT_LEVEL && Number.isFinite(meta.evalLoss) && meta.evalLoss > 0) {
          hints.main += ` Objective cost: ${(meta.evalLoss / 100).toFixed(1)} pawn${meta.evalLoss === 100 ? '' : 's'}.`;
        }
        if (hintLevel === EXACT_HINT_LEVEL && risks.length) hints.main += ` Risk: ${risks.join(', ')}.`;
      }
      if (hintLevel === EXACT_HINT_LEVEL && Number.isFinite(meta.evalLoss) && meta.evalLoss > 0 && humanLikeMode) {
        hints.main += ` Objective cost: ${(meta.evalLoss / 100).toFixed(1)} pawn${meta.evalLoss === 100 ? '' : 's'}.`;
      }
    }

    // From-to square notation — always show actual piece color
    if (hintLevel === EXACT_HINT_LEVEL && bestPV && bestPV.pv && bestPV.pv.length > 0) {
      const uci = bestPV.pv[0];
      const from = uci.substring(0, 2);
      const to = uci.substring(2, 4);
      const board = fen ? parseFENPlacement(fen.split(' ')[0]) : null;
      const piece = board ? getPieceAt(board, from) : null;
      const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
      // v5.4.0: Use actual piece color — uppercase = White, lowercase = Black
      const isPieceWhite = piece && piece === piece.toUpperCase();
      const sideLabel = isPieceWhite ? 'White' : 'Black';
      hints.bestMoveFromTo = `${sideLabel}: ${pieceName}: ${from} \u2192 ${to}`;
    }

    // Threat hint
    if (rankedPVs && rankedPVs.length > 0) {
      hints.threat = generateThreatHint(rankedPVs[0], position, playerColor, fen || '');
    }

    // Continuation
    if (bestPV && bestPV.pv) {
      hints.continuation = formatContinuation(bestPV.pv, hintLevel, isWhite, fen || '');
    }

    // Move classification
    if (analysisData.prevEval !== undefined && analysisData.currEval !== undefined) {
      hints.moveClassification = classifyMove(analysisData.prevEval, analysisData.currEval);
    }

    // Winning plan (style-aware)
    hints.winningPlan = generateWinningPlan(evalScore, scoreType, position, playerColor, fen || '', style);

    // Style annotation for exact-move hints
    if (hintLevel === EXACT_HINT_LEVEL && bestPV && bestPV.pv && bestPV.pv.length > 0 && fen) {
      const annotations = annotateMoveForStyle(bestPV.pv[0], fen, style, evalScore, bestPV._styleAnalysis);
      if (annotations.length > 0) hints.styleAnnotation = annotations.join(', ');
    }

    // v6.0.0: Depth-aware hint quality indicator
    if (bestPV && bestPV.depth >= 40) {
      hints.depthQuality = 'deep';
    } else if (bestPV && bestPV.depth >= 20) {
      hints.depthQuality = 'standard';
    } else if (bestPV) {
      hints.depthQuality = 'basic';
    }

    // Opening detection
    if (openingData && openingData.opening) {
      hints.opening = { name: openingData.opening, eco: '' };
    } else if (analysisData.moveHistory) {
      hints.opening = detectOpening(analysisData.moveHistory);
    }

    return hints;
  }

  // ─── Tablebase Hints ───────────────────────────────────────────────
  function generateTablebaseHint(tbData, playerColor, fen) {
    const cat = tbData.category || 'unknown';

    let bestMove = null;
    for (const m of (tbData.moves || [])) {
      if (m.category === 'win' || m.category === 'syzygy-win' || m.category === 'variant-win') { bestMove = m; break; }
    }
    if (!bestMove && tbData.moves && tbData.moves.length > 0) {
      for (const m of tbData.moves) { if (m.category === 'draw') { bestMove = m; break; } }
    }
    if (!bestMove && tbData.moves && tbData.moves.length > 0) {
      bestMove = tbData.moves[0];
    }

    const board = fen ? parseFENPlacement(fen.split(' ')[0]) : null;
    const san = bestMove?.san || (bestMove?.uci || '???');
    const from = bestMove?.uci?.substring(0, 2) || '';
    const to = bestMove?.uci?.substring(2, 4) || '';

    if (cat === 'win' || cat === 'syzygy-win') {
      const dtm = bestMove?.dtm ? ` (mate in ${Math.abs(bestMove.dtm)})` : '';
      return `PERFECT PLAY: ${san} (${from} \u2192 ${to}) \u2014 Winning!${dtm}`;
    }
    if (cat === 'draw') {
      return `PERFECT PLAY: ${san} (${from} \u2192 ${to}) \u2014 Draw with best play`;
    }
    if (cat === 'loss' || cat === 'syzygy-loss') {
      return `Best defense: ${san} (${from} \u2192 ${to}) \u2014 Losing position`;
    }
    return `Tablebase: ${san} (${from} \u2192 ${to})`;
  }

  function generateTablebasePlan(tbData, playerColor) {
    const cat = tbData.category || 'unknown';
    if (cat === 'win' || cat === 'syzygy-win') return 'Perfect endgame play \u2014 follow tablebase moves to win';
    if (cat === 'draw') return 'Hold the draw \u2014 follow tablebase moves precisely';
    if (cat === 'loss') return 'Defend stubbornly \u2014 opponent needs perfect play to win';
    return 'Endgame position \u2014 tablebase analysis available';
  }

  // ─── Exact Move Hint (Player-First) ───────────────────────────────
  function generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen, style, repertoire, moveHistory) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) return 'Analysis in progress...';
    if (!fen) return 'Waiting for position...';

    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
    const san = uciToSan(uci, fen);
    const isWhite = playerColor === 'w';
    const playerLabel = isWhite ? 'White' : 'Black';
    // v5.4.0: Use ACTUAL piece color from the board, not assumed ownership.
    // A piece on e7 with lowercase letter is Black's piece regardless of
    // which side the user is assisting.
    const isPieceWhite = piece && piece === piece.toUpperCase();
    const pieceSideLabel = isPieceWhite ? 'White' : 'Black';
    const currentStyle = style || PLAYING_STYLES.normal;

    // uciToSan already includes the promotion suffix.
    const moveStr = san;
    const choiceLabel = currentStyle.id === 'normal' ? 'Best' : `${currentStyle.name} choice`;
    let hint = `${choiceLabel}: ${moveStr}  (${pieceSideLabel}: ${pieceName}: ${from} \u2192 ${to})`;

    if (scoreType === 'mate') {
      hint += ` \u2014 MATE IN ${Math.abs(evalScore)}`;
    } else {
      const evalPawns = (evalScore / 100).toFixed(1);
      hint += evalScore > 0 ? `  eval: +${evalPawns}` : `  eval: ${evalPawns}`;
    }

    if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isOppPiece = isWhite ? (captured === captured.toLowerCase()) : (captured === captured.toUpperCase());
      // Sacrifice annotation comes from PV-validated material loss.
      if (isOppPiece) {
        if (bestPV._styleAnalysis?.sacrifice) {
          hint += ` | ${bestPV._styleAnalysis.sacrificeSoundness === 'sound' ? 'Sound' : (bestPV._styleAnalysis.sacrificeSoundness === 'speculative' ? 'Speculative' : 'Unsound')} sacrifice: takes opponent's ${capturedName}`;
        } else {
          hint += ` | Captures opponent's ${capturedName}`;
        }
      } else {
        hint += ` | Captures ${capturedName}`;
      }
    }

    // Style-specific annotation for aggressive styles
    if (currentStyle.kingHuntBonus > 0 && !captured) {
      const oppKingColor = isWhite ? 'k' : 'K';
      let oppKingPos = null;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if (board[r][c] === oppKingColor) oppKingPos = { row: r, col: c };
      }
      if (oppKingPos) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
        if (distToKing <= 2) hint += ' | King hunt!';
      }
    }

    const state = repertoireState(fen, repertoire, playerColor);
    if (state) {
      const inBook = state.nextMoves.includes(uci);
      hint += ` | ${inBook ? state.name + ' move' : state.name + ' plan'}: ${state.plan}`;
    }

    return hint;
  }

  // ─── Opponent's Turn Hints (Player-First Design) ─────────────────
  // When it's the opponent's turn, the PRIMARY hint is always the
  // assisted player's best response move. The opponent's expected
  // move is shown as secondary context.
  //
  // Design principle: The user chose to assist Black → show Black's
  // moves as primary, not White's expectations.
  function generateOpponentTurnHints(hints, bestPV, pvs, evalScore, scoreType, position, playerColor, activeColor, fen, hintLevel, style) {
    if (!fen) return;
    const board = parseFENPlacement(fen.split(' ')[0]);
    const isWhite = playerColor === 'w';
    const oppColor = isWhite ? 'Black' : 'White';
    const playerLabel = isWhite ? 'White' : 'Black';

    // 1. Opponent's expected move (pv[0]) — secondary context
    const oppMoveUci = bestPV.pv && bestPV.pv.length > 0 ? bestPV.pv[0] : null;
    let oppMoveHint = '';
    if (oppMoveUci) {
      const san = uciToSan(oppMoveUci, fen);
      const from = oppMoveUci.substring(0, 2);
      const to = oppMoveUci.substring(2, 4);
      const piece = getPieceAt(board, from);
      const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
      // Determine the actual side of the piece on the from-square
      const isWhitePiece = piece && piece === piece.toUpperCase();
      const oppPieceLabel = isWhitePiece ? 'White' : 'Black';
      oppMoveHint = `${oppPieceLabel}'s ${pieceName} ${from} \u2192 ${to} (${san})`;
    }

    // 2. Assisted player's best response (pv[1]) — PRIMARY hint
    const responseUci = bestPV.pv && bestPV.pv.length > 1 ? bestPV.pv[1] : null;
    let responseHint = '';
    let responseFromToHint = '';
    if (responseUci) {
      const boardAfterOppMove = applyMoveToBoard(board, oppMoveUci);
      const from = responseUci.substring(0, 2);
      const to = responseUci.substring(2, 4);
      const piece = getPieceAt(boardAfterOppMove, from);
      const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
      const fenAfterOppMove = applyMoveToFen(fen, oppMoveUci);
      const responseSan = uciToSan(responseUci, fenAfterOppMove);
      // Determine the actual side of the response piece
      const isRespWhitePiece = piece && piece === piece.toUpperCase();
      const respPieceLabel = isRespWhitePiece ? 'White' : 'Black';
      responseHint = `${respPieceLabel}: ${pieceName} ${from} \u2192 ${to} (${responseSan})`;
      responseFromToHint = `${respPieceLabel}: ${pieceName}: ${from} \u2192 ${to}`;
    }

    // Build main hint — PLAYER-FIRST design:
    // Always lead with the player's best response.
    // Opponent's expected move is contextual/secondary.
    let mainHint = '';
    if (responseUci) {
      // PRIMARY: Show the player's best response
      mainHint = responseHint;
      if (evalScore > 100) mainHint += ` \u2014 You're better!`;
      else if (evalScore > 0) mainHint += ` \u2014 Slight advantage for you`;
      else if (evalScore < -100) mainHint += ` \u2014 Be careful!`;
      else if (evalScore < 0) mainHint += ` \u2014 Slight disadvantage`;
      else mainHint += ` \u2014 Equal position`;
      // SECONDARY: Opponent's expected move as context
      if (oppMoveHint) {
        mainHint += `. If ${oppColor} plays ${oppMoveHint}`;
      }
    } else if (oppMoveUci) {
      // No response PV line available — still show player-focused message
      mainHint = `Waiting for ${oppColor}'s move. Expect: ${oppMoveHint}`;
      if (evalScore > 100) mainHint += ` \u2014 You're better!`;
      else if (evalScore > 0) mainHint += ` \u2014 Slight advantage for you`;
      else if (evalScore < -100) mainHint += ` \u2014 Be careful!`;
      else if (evalScore < 0) mainHint += ` \u2014 Slight disadvantage`;
    } else {
      mainHint = `Waiting for ${oppColor} to move`;
    }
    hints.main = mainHint;

    // From-to notation — ALWAYS show the PLAYER'S response move
    // Never show opponent's move as the primary from-to hint
    if (hintLevel === EXACT_HINT_LEVEL) {
      if (responseUci) {
        hints.bestMoveFromTo = responseFromToHint;
      } else {
        // No response available yet — show waiting state, NOT opponent's move
        hints.bestMoveFromTo = `Waiting for ${oppColor}'s move...`;
      }
    }

    // Winning plan from assisted player's perspective (style-aware)
    hints.winningPlan = generateWinningPlan(evalScore, scoreType, position, playerColor, fen, style ? style.name ? Object.keys(PLAYING_STYLES).find(k => PLAYING_STYLES[k] === style) || 'normal' : 'normal' : 'normal');

    // Threat hint — shows opponent's threat with player's best defense
    if (oppMoveUci) {
      hints.threat = generateOpponentThreatHint(oppMoveUci, responseUci, position, playerColor, fen);
    }

    // Continuation
    if (bestPV.pv) {
      hints.continuation = formatContinuation(bestPV.pv, hintLevel, isWhite, fen);
    }
  }

  // ─── Opponent Threat Hint (Player-First) ──────────────────────────
  function generateOpponentThreatHint(oppMoveUci, responseUci, position, playerColor, fen) {
    if (!fen || !oppMoveUci) return '';
    const board = parseFENPlacement(fen.split(' ')[0]);
    const isWhite = playerColor === 'w';
    const oppColor = isWhite ? 'Black' : 'White';
    const playerLabel = isWhite ? 'White' : 'Black';

    const from = oppMoveUci.substring(0, 2);
    const to = oppMoveUci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
    // v5.4.0: Use actual piece color from the board
    const isPieceWhite = piece && piece === piece.toUpperCase();
    const oppPieceSideLabel = isPieceWhite ? 'White' : 'Black';

    let threat = '';
    if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isPlayerPiece = isWhite ? (captured === captured.toUpperCase()) : (captured === captured.toLowerCase());
      if (isPlayerPiece) {
        threat = `${oppPieceSideLabel} threatens your ${capturedName} with ${pieceName} (${from} \u2192 ${to})`;
      } else {
        threat = `${oppPieceSideLabel}'s ${pieceName} moves ${from} \u2192 ${to}`;
      }
    } else {
      threat = `${oppPieceSideLabel}'s ${pieceName}: ${from} \u2192 ${to}`;
    }

    if (responseUci) {
      const boardAfterOppMove = applyMoveToBoard(board, oppMoveUci);
      const rFrom = responseUci.substring(0, 2);
      const rTo = responseUci.substring(2, 4);
      const rPiece = getPieceAt(boardAfterOppMove, rFrom);
      const rPieceName = rPiece ? PIECE_NAMES[rPiece.toLowerCase()] : 'piece';
      // v5.4.0: Use actual piece color for the response
      const isRWhite = rPiece && rPiece === rPiece.toUpperCase();
      const rSideLabel = isRWhite ? 'White' : 'Black';
      threat += `. ${rSideLabel}'s best reply: ${rPieceName} ${rFrom} \u2192 ${rTo}`;
    }

    return threat;
  }

  // ─── Threat Hint (Player's turn) ──────────────────────────────────
  function generateThreatHint(bestPV, position, playerColor, fen) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length < 2) return '';
    if (!fen) return '';

    const board = parseFENPlacement(fen.split(' ')[0]);
    const activeColor = fen.split(' ')[1] || 'w';
    const isAssistedPlayerTurn = activeColor === playerColor;
    const isWhite = playerColor === 'w';
    const oppColor = isWhite ? 'Black' : 'White';
    const playerLabel = isWhite ? 'White' : 'Black';

    // Determine which PV index is the player's move and which is the opponent's
    // pv[0] = side to move's move, pv[1] = other side's reply
    let playerMoveUci, oppMoveUci;
    if (isAssistedPlayerTurn) {
      playerMoveUci = bestPV.pv[0]; // Player moves first
      oppMoveUci = bestPV.pv[1];    // Opponent replies
    } else {
      playerMoveUci = bestPV.pv[1]; // Opponent moves first, player replies
      oppMoveUci = bestPV.pv[0];    // Opponent moves first
    }
    if (!oppMoveUci) return '';

    const boardAfterPlayerMove = playerMoveUci ? applyMoveToBoard(board, playerMoveUci) : board;
    const fenAfterPlayerMove = playerMoveUci ? applyMoveToFen(fen, playerMoveUci) : fen;

    const from = oppMoveUci.substring(0, 2);
    const to = oppMoveUci.substring(2, 4);
    const piece = getPieceAt(boardAfterPlayerMove, from);
    const captured = getPieceAt(boardAfterPlayerMove, to);
    const san = uciToSan(oppMoveUci, fenAfterPlayerMove);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';

    // v5.4.0: Use actual piece color from the board
    const isOppPieceWhite = piece && piece === piece.toUpperCase();
    const oppPieceSideLabel = isOppPieceWhite ? 'White' : 'Black';

    let threat = `After your move, ${oppColor}'s best reply: ${san} (${oppPieceSideLabel}'s ${pieceName}: ${from} \u2192 ${to})`;
    if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isPlayerPiece = isWhite ? (captured === captured.toUpperCase()) : (captured === captured.toLowerCase());
      if (isPlayerPiece) {
        threat += ` \u2014 threatens ${playerLabel.toLowerCase()} ${capturedName}`;
      }
    }

    return threat;
  }

  // ─── Format PVs ────────────────────────────────────────────────────
  function formatPVs(pvs, isWhite, hintLevel, fen) {
    if (!pvs || pvs.length === 0) return [];
    const safeFen = fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    return pvs.slice(0, 5).map((pv, idx) => {
      const score = isWhite ? pv.score : -pv.score;
      const scoreDisplay = pv.scoreType === 'mate'
        ? (score > 0 ? `+M${score}` : `-M${Math.abs(score)}`)
        : (score >= 0 ? `+${(score / 100).toFixed(1)}` : (score / 100).toFixed(1));

      const pvMoves = pv.pv || [];
      let currentFen = safeFen;
      const movesDisplay = pvMoves.slice(0, 12).map((uci, i) => {
        const san = uciToSan(uci, currentFen);
        currentFen = applyMoveToFen(currentFen, uci);
        return san;
      }).join(' ');

      return {
        index: idx + 1,
        multipv: pv.multipv || idx + 1,
        score,
        scoreType: pv.scoreType,
        scoreDisplay,
        depth: pv.depth || 0,
        pv: pv.pv || [],
        movesDisplay
      };
    });
  }

  // ─── Format Continuation ───────────────────────────────────────────
  function formatContinuation(pv, hintLevel, isWhite, fen) {
    if (!pv || pv.length === 0) return [];
    if (!fen) return [];

    const parts = fen.split(' ');
    const activeColor = parts[1] || 'w';
    let moveNumber = parseInt(parts[5]) || 1;

    const maxMoves = Math.min(pv.length, 18);
    const result = [];
    let currentFen = fen;
    let currentBoard = parseFENPlacement(fen.split(' ')[0]);

    for (let i = 0; i < maxMoves; i++) {
      const uci = pv[i];
      const from = uci.substring(0, 2);
      const to = uci.substring(2, 4);

      const san = uciToSan(uci, currentFen);
      const piece = getPieceAt(currentBoard, from);
      const isWhiteMove = (i % 2 === 0) === (activeColor === 'w');

      result.push({
        move: san,
        uci,
        from,
        to,
        isWhiteMove,
        moveNumber: isWhiteMove ? moveNumber : undefined,
        pieceName: piece ? PIECE_NAMES[piece.toLowerCase()] : null
      });

      if (!isWhiteMove) moveNumber++;

      currentBoard = applyMoveToBoard(currentBoard, uci);
      currentFen = applyMoveToFen(currentFen, uci);
    }

    return result;
  }

  // ─── Format Move ───────────────────────────────────────────────────
  function formatMove(uci, fen) {
    if (!uci) return null;
    return uciToSan(uci, fen);
  }

  // ─── Eval Display ──────────────────────────────────────────────────
  function describeEval(score, scoreType, isWhite, usePerspective) {
    const displayScore = isWhite ? score : -score;
    if (scoreType === 'mate') {
      if (displayScore > 0) return usePerspective ? `You can force mate in ${displayScore}` : `White mates in ${displayScore}`;
      if (displayScore < 0) return usePerspective ? `Opponent can force mate in ${Math.abs(displayScore)}` : `Black mates in ${Math.abs(displayScore)}`;
      return 'Checkmate';
    }
    const pawns = displayScore / 100;
    if (usePerspective) {
      if (pawns > 5) return 'You have a winning advantage';
      if (pawns > 2) return 'You have a decisive advantage';
      if (pawns > 0.5) return 'You have a clear advantage';
      if (pawns > 0) return 'You have a slight advantage';
      if (pawns === 0) return 'Position is equal';
      if (pawns > -0.5) return 'Opponent has a slight advantage';
      if (pawns > -2) return 'Opponent has a clear advantage';
      if (pawns > -5) return 'Opponent has a decisive advantage';
      return 'Opponent has a winning advantage';
    }
    if (pawns > 5) return 'White has a winning advantage';
    if (pawns > 2) return 'White has a decisive advantage';
    if (pawns > 0.5) return 'White has a clear advantage';
    if (pawns > 0) return 'White has a slight advantage';
    if (pawns === 0) return 'Position is equal';
    if (pawns > -0.5) return 'Black has a slight advantage';
    if (pawns > -2) return 'Black has a clear advantage';
    if (pawns > -5) return 'Black has a decisive advantage';
    return 'Black has a winning advantage';
  }

  function formatEvalBar(score, scoreType, isWhite) {
    const displayScore = isWhite ? score : -score;
    if (scoreType === 'mate') return displayScore > 0 ? 99 : 1;
    const winPct = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * displayScore)) - 1);
    return Math.max(2, Math.min(98, winPct));
  }

  // ─── Candidate Move Evaluation (Style-Aware) ──────────────────────
  function evaluateCandidateMoves(pvs, playerColor, fen) {
    if (!pvs || pvs.length === 0) return [];
    if (!fen) return [];
    const isWhite = playerColor === 'w';

    const fenParts = fen.split(' ');
    const activeColor = fenParts[1] || 'w';
    const isAssistedPlayerTurn = activeColor === playerColor;
    const isOpponentTurn = !isAssistedPlayerTurn;

    const bestScore = isWhite ? (pvs[0]?.score || 0) : -(pvs[0]?.score || 0);
    const bestScoreType = pvs[0]?.scoreType || 'cp';

    return pvs.slice(0, 5).map((pv, idx) => {
      const rawScore = isWhite ? pv.score : -pv.score;
      const delta = rawScore - bestScore;
      const absDelta = Math.abs(delta);

      let quality, qualityClass;
      const styleMeta = pv._styleAnalysis;
      if (idx === 0 && styleMeta?.objectiveRank > 1) {
        quality = `${styleMeta.humanLikeMode ? 'Human Choice' : 'Style Choice'} · objective #${styleMeta.objectiveRank}`;
        qualityClass = 'cm-best';
      } else if (idx === 0) {
        quality = styleMeta?.humanLikeMode ? 'Human + Objective Best' : 'Objective Best';
        qualityClass = 'cm-best';
      }
      else if (absDelta <= 10) { quality = 'Equal Best'; qualityClass = 'cm-best'; }
      else if (absDelta <= 30) { quality = 'Great'; qualityClass = 'cm-good'; }
      else if (absDelta <= 80) { quality = 'Good'; qualityClass = 'cm-good'; }
      else if (absDelta <= 200) { quality = 'Inaccuracy'; qualityClass = 'cm-ok'; }
      else { quality = 'Mistake'; qualityClass = 'cm-bad'; }

      let evalDisplay;
      if (pv.scoreType === 'mate') {
        evalDisplay = rawScore > 0 ? `+M${rawScore}` : `-M${Math.abs(rawScore)}`;
      } else {
        evalDisplay = rawScore >= 0 ? `+${(rawScore / 100).toFixed(1)}` : (rawScore / 100).toFixed(1);
      }

      let deltaDisplay = '';
      if (idx > 0) {
        if (pv.scoreType === 'mate' && bestScoreType === 'mate') {
          deltaDisplay = 'mate diff';
        } else {
          deltaDisplay = delta >= 0 ? `+${(delta / 100).toFixed(1)}` : (delta / 100).toFixed(1);
        }
      }

      const winPct = pv.scoreType === 'mate'
        ? (rawScore > 0 ? 99 : 1)
        : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * rawScore)) - 1);

      // v5.4.0 PLAYER-FIRST: When opponent's turn, show the PLAYER's best
      // response as the primary candidate move, with opponent's move as context.
      // When it's the player's turn, show their move directly.
      let candidateMoveUci, candidateMoveFen, opponentMoveUci, opponentMoveSan;
      const board = parseFENPlacement(fen.split(' ')[0]);

      if (isOpponentTurn && pv.pv && pv.pv.length > 1) {
        // Opponent moves first (pv[0]), player responds (pv[1])
        // v5.4.0: Show player's response as the PRIMARY candidate move
        opponentMoveUci = pv.pv[0];
        candidateMoveUci = pv.pv[1];
        const fenAfterOpp = applyMoveToFen(fen, opponentMoveUci);
        candidateMoveFen = fenAfterOpp;
        opponentMoveSan = uciToSan(opponentMoveUci, fen);
      } else if (isOpponentTurn && pv.pv && pv.pv.length === 1) {
        // Only opponent's move in PV — no player response available
        // Still show the opponent's move but label it clearly
        opponentMoveUci = pv.pv[0];
        candidateMoveUci = null;
        candidateMoveFen = fen;
        opponentMoveSan = uciToSan(opponentMoveUci, fen);
      } else {
        // Player's turn — show their move directly
        candidateMoveUci = pv.pv && pv.pv.length > 0 ? pv.pv[0] : null;
        candidateMoveFen = fen;
        opponentMoveUci = null;
        opponentMoveSan = null;
      }

      let fromTo = '';
      if (candidateMoveUci && candidateMoveUci.length >= 4) {
        const from = candidateMoveUci.substring(0, 2);
        const to = candidateMoveUci.substring(2, 4);
        const lookupBoard = isOpponentTurn && opponentMoveUci
          ? applyMoveToBoard(board, opponentMoveUci)
          : board;
        const piece = getPieceAt(lookupBoard, from);
        const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : '';
        // v5.4.0: Use ACTUAL piece color from the board
        const isPieceWhite = piece && piece === piece.toUpperCase();
        const sidePrefix = isPieceWhite ? 'White:' : 'Black:';
        fromTo = pieceName ? `${sidePrefix} ${from}\u2192${to}` : `${from}-${to}`;
      } else if (!candidateMoveUci && opponentMoveUci) {
        // No player response available — show opponent's move as context
        const from = opponentMoveUci.substring(0, 2);
        const to = opponentMoveUci.substring(2, 4);
        const piece = getPieceAt(board, from);
        const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : '';
        const isPieceWhite = piece && piece === piece.toUpperCase();
        const oppLabel = isPieceWhite ? 'White' : 'Black';
        fromTo = pieceName ? `${oppLabel}: ${from}\u2192${to}` : `${oppLabel}: ${from}-${to}`;
      }

      // v5.4.0: SAN display — show player's response move as primary
      let san;
      if (candidateMoveUci) {
        san = uciToSan(candidateMoveUci, candidateMoveFen);
        // When opponent's turn, prepend context about opponent's move
        if (isOpponentTurn && opponentMoveSan) {
          san = `${san} (if ${opponentMoveSan})`;
        }
      } else if (opponentMoveSan) {
        san = `Wait: ${opponentMoveSan}`;
      } else {
        san = '???';
      }

      return {
        rank: idx + 1,
        san,
        fromTo,
        evalDisplay,
        evalScore: rawScore,
        scoreType: pv.scoreType || 'cp',
        delta,
        deltaDisplay,
        quality,
        qualityClass,
        winPct: Math.max(2, Math.min(98, winPct)),
        depth: pv.depth || 0,
        pv: pv.pv || [],
        isOpponentTurn,
        opponentMoveSan,
        candidateMoveUci,
        objectiveRank: styleMeta?.objectiveRank || idx + 1,
        styleReason: styleMeta?.humanLikeMode
          ? (styleMeta?.humanReasons?.[0] || styleMeta?.reasons?.[0] || '')
          : (styleMeta?.reasons?.[0] || ''),
        styleRisk: styleMeta?.humanLikeMode
          ? (styleMeta?.humanRisks?.[0] || styleMeta?.risks?.[0] || '')
          : (styleMeta?.risks?.[0] || ''),
        naturalnessScore: styleMeta?.naturalnessScore ?? null,
        humanLikeMode: Boolean(styleMeta?.humanLikeMode),
        styleRank: styleMeta?.styleRank || idx + 1,
        sacrificeSoundness: styleMeta?.sacrificeSoundness || '',
        aggression: {
          check: Boolean(styleMeta?.givesCheck),
          sacrifice: Boolean(styleMeta?.sacrifice),
          kingPressureDelta: Number(styleMeta?.kingPressureDelta || 0),
          penetrationDelta: Number(styleMeta?.penetrationDelta || 0),
          pawnStormDelta: Number(styleMeta?.pawnStormDelta || 0),
          complexity: Number(styleMeta?.complexity || 0),
          evalLoss: Number(styleMeta?.evalLoss || 0),
          depth: Number(styleMeta?.depth || pv.depth || 0)
        }
      };
    });
  }

  // ─── Critical Moment Detection ─────────────────────────────────────
  function detectCriticalMoment(evalHistory, currentEval, currentScoreType, playerColor) {
    if (evalHistory.length < 2) return null;

    const prev = evalHistory[evalHistory.length - 2];
    const prevScore = prev.score || 0;
    const currentScore = currentEval || 0;
    const swing = currentScore - prevScore;

    const alerts = [];

    if (swing >= 150) {
      alerts.push({
        type: 'brilliant',
        severity: 'high',
        message: 'Brilliant opportunity! A great move can change the game',
        detail: `Eval swung +${(swing / 100).toFixed(1)} in your favor. Find the best move!`
      });
    }
    if (swing <= -150) {
      alerts.push({
        type: 'blunder_alert',
        severity: 'high',
        message: 'Danger! Position has worsened significantly',
        detail: `Eval dropped ${(swing / 100).toFixed(1)}. This is a critical defensive moment.`
      });
    }

    if (currentScoreType === 'mate' && prev.scoreType !== 'mate') {
      if (currentScore > 0) {
        alerts.push({
          type: 'mate_chance',
          severity: 'high',
          message: 'Checkmate is on the board!',
          detail: `You can force mate in ${Math.abs(currentScore)} move${Math.abs(currentScore) > 1 ? 's' : ''}. Precision required!`
        });
      } else {
        alerts.push({
          type: 'mate_threat',
          severity: 'high',
          message: 'Opponent has forced mate!',
          detail: `You are being mated in ${Math.abs(currentScore)} move${Math.abs(currentScore) > 1 ? 's' : ''}. Look for the best defense!`
        });
      }
    }

    if (prevScore > 50 && currentScore <= -50) {
      alerts.push({ type: 'turning_point', severity: 'high', message: 'Turning point! Position has flipped', detail: 'You went from advantage to disadvantage. Focus!' });
    }
    if (prevScore < -50 && currentScore >= 50) {
      alerts.push({ type: 'comeback', severity: 'high', message: 'Comeback chance! Position is now in your favor', detail: 'You turned the position around. Capitalize on it!' });
    }

    if (prevScore < 200 && currentScore >= 200) {
      alerts.push({ type: 'winning', severity: 'medium', message: 'Winning position! Convert carefully', detail: 'You have a decisive advantage. Avoid complications and simplify.' });
    }
    if (prevScore > -200 && currentScore <= -200) {
      alerts.push({ type: 'losing', severity: 'medium', message: 'Position is critical \u2014 fight on!', detail: 'You are losing but the game is not over. Create complications!' });
    }

    if (alerts.length === 0) return null;
    alerts.sort((a, b) => {
      const sev = { high: 3, medium: 2, low: 1 };
      return (sev[b.severity] || 0) - (sev[a.severity] || 0);
    });
    return alerts[0];
  }

  // ─── Endgame Technique Coaching ─────────────────────────────────────
  function generateEndgameCoach(fen, playerColor, tablebaseData, analysisData) {
    if (!fen || typeof fen !== 'string') return null;
    const phase = detectGamePhase(fen);
    if (phase !== 'endgame' && !tablebaseData) return null;

    const parts = fen.split(' ');
    const board = parseFENPlacement(parts[0]);
    const isWhite = playerColor === 'w';
    const position = assessPosition(fen);

    const coach = { phaseLabel: '', techniques: [], plan: '', steps: [] };

    const material = position.material;
    const totalMaterial = material.whiteVal + material.blackVal;

    if (tablebaseData && tablebaseData.isTablebase) {
      coach.phaseLabel = 'Tablebase Endgame \u2014 Perfect Play Available';
    } else if (totalMaterial <= 6) {
      coach.phaseLabel = 'Basic Endgame';
    } else if (totalMaterial <= 13) {
      coach.phaseLabel = 'Minor Piece Endgame';
    } else if (material.whitePieces?.q || material.blackPieces?.q) {
      coach.phaseLabel = 'Queen Endgame';
    } else {
      coach.phaseLabel = 'Rook Endgame';
    }

    const myPassedPawns = isWhite ? position.pawnStructure.whitePassedPawns : position.pawnStructure.blackPassedPawns;
    const oppPassedPawns = isWhite ? position.pawnStructure.blackPassedPawns : position.pawnStructure.whitePassedPawns;
    const myBishops = isWhite ? material.whitePieces.b : material.blackPieces.b;
    const oppBishops = isWhite ? material.blackPieces.b : material.whitePieces.b;
    const myRooks = isWhite ? material.whitePieces.r : material.blackPieces.r;
    const myKing = isWhite ? position.kingSafety.wKingPos : position.kingSafety.bKingPos;
    const oppKing = isWhite ? position.kingSafety.bKingPos : position.kingSafety.wKingPos;

    const kingRow = myKing ? myKing.row : -1;
    const kingCol = myKing ? myKing.col : -1;
    const isKingActive = isWhite ? (kingRow <= 4) : (kingRow >= 3);
    if (!isKingActive && totalMaterial <= 13) {
      coach.techniques.push({ icon: '\u265A', text: 'Activate your king! In endgames, the king should march to the center or toward key squares.' });
    }

    if (myPassedPawns > 0) {
      coach.techniques.push({ icon: '\u265F', text: `You have ${myPassedPawns} passed pawn${myPassedPawns > 1 ? 's' : ''}. Advance with king support ("king plus passed pawn = win").` });
    }

    if (totalMaterial <= 6 && myKing && oppKing) {
      const kingDistFile = Math.abs(kingCol - oppKing.col);
      const kingDistRank = Math.abs(kingRow - oppKing.row);
      if (kingDistFile <= 2 && kingDistRank <= 2 && kingDistFile === kingDistRank) {
        const opposition = (kingDistFile + kingDistRank) % 2 === 1;
        coach.techniques.push({
          icon: '\u2B50',
          text: opposition ? 'You have the opposition! Maintain it to outmaneuver the enemy king.' : 'Fight for the opposition! Try to get your king directly facing the enemy king with 1 square gap.'
        });
      }
    }

    if (myRooks > 0 && myPassedPawns > 0) {
      coach.techniques.push({ icon: '\u265C', text: 'Place your rook behind your passed pawn (on the same file). Rook + passed pawn is a powerful combination.' });
    }

    if (myRooks > 0 && oppBishops === 0 && (isWhite ? material.blackPieces.r : material.whitePieces.r) > 0 && myPassedPawns > 0 && totalMaterial <= 8) {
      const balance = isWhite ? material.balance : -material.balance;
      coach.techniques.push({
        icon: '\u265C',
        text: balance > 0 ? 'Rook + Pawn vs Rook: Build a "bridge" (Lucena) to shield your king from checks while promoting.' : 'Rook vs Rook+Pawn: Use Philidor defense \u2014 keep your rook on the 3rd rank until the pawn advances, then check from behind.'
      });
    }

    if (myBishops >= 1 && oppBishops >= 1 && totalMaterial <= 10) {
      coach.techniques.push({ icon: '\u265D', text: 'Opposite-colored bishops: Drawing chances are high if defending, but attacking with bishop + pawns can be decisive.' });
    }

    if (totalMaterial <= 8 && !tablebaseData) {
      coach.techniques.push({ icon: '\u26A0', text: 'Watch for zugzwang \u2014 a position where any move worsens your situation. Try to put your opponent in zugzwang first.' });
    }

    if (oppPassedPawns > 0) {
      coach.techniques.push({ icon: '\u25A2', text: `Enemy has ${oppPassedPawns} passed pawn${oppPassedPawns > 1 ? 's' : ''}. Use the "square of the pawn" rule to determine if your king can catch it.` });
    }

    if (tablebaseData) {
      const cat = tablebaseData.category || 'unknown';
      if (cat === 'win' || cat === 'syzygy-win') coach.plan = 'Follow tablebase moves precisely to convert the win. Every move matters!';
      else if (cat === 'draw') coach.plan = "Hold the draw with precise tablebase play. Stay active and don't passively defend.";
      else coach.plan = 'Defend stubbornly. In endgames, even losing positions require perfect play from the opponent.';
    } else {
      const evalScore = analysisData?.pvs?.[0];
      const score = evalScore ? (isWhite ? evalScore.score : -evalScore.score) : 0;
      if (score > 200) coach.plan = 'Simplify the position: trade pieces (not pawns), advance your passed pawns, activate your king.';
      else if (score > 50) coach.plan = 'Improve your position gradually. Activate your king, create a second weakness, then push.';
      else if (score > -50) coach.plan = 'Equal endgame. Focus on piece activity, king centralization, and small pawn advances.';
      else if (score > -200) coach.plan = "Defend actively. Look for counterplay, don't just sit passively. Create threats.";
      else coach.plan = 'Defend tenaciously. Create complications, set traps, and fight for every tempo.';
    }

    if (analysisData?.pvs?.[0]?.pv) {
      const pv = analysisData.pvs[0].pv;
      const activeColor = parts[1] || 'w';
      coach.steps = pv.slice(0, 6).map((uci, i) => {
        const from = uci.substring(0, 2);
        const to = uci.substring(2, 4);
        const piece = i === 0 ? getPieceAt(board, from) : null;
        const san = i === 0 ? uciToSan(uci, fen) : uci;
        const isPlayerMove = (activeColor === playerColor) ? (i % 2 === 0) : (i % 2 === 1);
        let desc = '';
        if (i === 0) { desc = piece ? `Move ${PIECE_NAMES[piece.toLowerCase()]} ${from}\u2192${to}` : `${from}\u2192${to}`; }
        else { desc = isPlayerMove ? 'Your reply' : "Opponent's expected move"; }
        return { num: i + 1, move: san, desc, isPlayerMove };
      });
    }

    if (tablebaseData?.moves?.length > 0) {
      const bestTbMove = tablebaseData.moves.find(m => m.category === 'win' || m.category === 'syzygy-win' || m.category === 'variant-win') || tablebaseData.moves.find(m => m.category === 'draw') || tablebaseData.moves[0];
      if (bestTbMove) {
        coach.steps.unshift({ num: 0, move: bestTbMove.san || bestTbMove.uci, desc: `Tablebase: ${bestTbMove.category} ${bestTbMove.dtm ? '(M' + Math.abs(bestTbMove.dtm) + ')' : ''}`, isPlayerMove: true });
      }
    }

    return coach;
  }

  // ─── v8.5.0 Enhancement D — Player-perspective score formatting ────
  // Returns a string like "+1.5 (you)" / "-0.8 (opp)" / "+M5 (you)" that
  // makes it obvious whose favour the eval is in, regardless of whether
  // the assisted player is White or Black. Used by the side panel for
  // candidate-move rows and eval-bar labels.
  function formatScorePlayerPerspective(score, scoreType, playerColor) {
    if (score === null || score === undefined || isNaN(score)) return '—';
    const isWhite = playerColor === 'w';
    // score is White-perspective; flip for Black-assist to get player-perspective
    const playerScore = isWhite ? score : -score;
    if (scoreType === 'mate') {
      if (playerScore > 0) return `+M${playerScore} (you)`;
      if (playerScore < 0) return `-M${Math.abs(playerScore)} (opp)`;
      return 'Mate';
    }
    const pawns = playerScore / 100;
    if (pawns > 5) return `+${pawns.toFixed(1)} (winning)`;
    if (pawns > 2) return `+${pawns.toFixed(1)} (decisive)`;
    if (pawns > 0.5) return `+${pawns.toFixed(1)} (clear edge)`;
    if (pawns > 0) return `+${pawns.toFixed(1)} (slight)`;
    if (pawns === 0) return '0.0 (equal)';
    if (pawns > -0.5) return `${pawns.toFixed(1)} (slight)`;
    if (pawns > -2) return `${pawns.toFixed(1)} (clear edge)`;
    if (pawns > -5) return `${pawns.toFixed(1)} (decisive)`;
    return `${pawns.toFixed(1)} (winning)`;
  }

  // ─── Public API ────────────────────────────────────────────────────
  window.ChessHintEngine = {
    generateHints,
    classifyMove,
    assessPosition,
    detectOpening,
    detectGamePhase,
    describeEval,
    formatEvalBar,
    formatPVs,
    formatContinuation,
    formatMove,
    uciToSan,
    evaluateCandidateMoves,
    detectCriticalMoment,
    generateEndgameCoach,
    scoreMoveForStyle,
    selectPVForStyle,
    analyzeCandidate,
    PLAYING_STYLES,
    OPENING_REPERTOIRES,
    repertoireState,
    HINT_LEVELS,
    EXACT_HINT_LEVEL,
    // v8.5.0
    resetSacrificeHistory,
    formatScorePlayerPerspective, // Enhancement D
    // Exposed for deterministic regression tests and progressive-PV consumers.
    applyMoveToFen,
    applyMoveToBoard
  };

})();
