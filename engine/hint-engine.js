/**
 * Chess Hint Assistant — Three-Mode Hint Engine
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 * This project is a study/research tool for building a chess engine that can
 * play in a variety of styles (normal, aggressive, ultra-aggressive). It is
 * intended for learning, offline analysis, and engine-variation research. It
 * is anti-cheat compliant and fair-play safe: it never assists a player in a
 * rated or live online game, and it must not be used to gain an unfair
 * advantage against human opponents.
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

  // Exact-move-only product: all primary hints use this single level.
  const EXACT_HINT_LEVEL = 5;

  // Ultra Super Aggressive bonus scale. The raw Chaos vocabulary sums to
  // ~1000-2500 style-points, which dwarfs every other term in the ranking
  // (aggressive tops out around ~250) and reduces eval loss to noise. All
  // ultra bonuses are scaled into aggressive's magnitude so objective cost
  // participates again; the risk budget stays the hard gate.
  const ULTRA_BONUS_SCALE = 0.125;
  const EXACT_HINT_LEVEL_NAME = 'Exact Move';

  // ─── Divergence & generated-candidate pricing ────────────────────────
  // DIVERGENCE_PREMIUM — bounded reward for a SAFE, concretely-attacking
  // candidate whose first move differs from the objective best. Sized in the
  // post-scaling domain (see candidateStyleBonus) so it tips near-ties without
  // dwarfing the eval-loss term.
  const DIVERGENCE_PREMIUM = { aggressive: 45, super_ultra_aggressive: 45 };
  // ATTACK_CANDIDATE_PENALTY_CP — the objective cost of trusting a shallow
  // on-device search for a generated attack candidate. Added to evalLoss so a
  // weak local eval can never under-state the cost of diverging; the
  // divergence premium must genuinely overcome this uncertainty before a
  // generated move can take the primary slot.
  const ATTACK_CANDIDATE_PENALTY_CP = 40;

  // ─── Playing Styles ────────────────────────────────────────────────
  // Three user-selectable styles. `normal` is the factory default and the
  // objective baseline: it short-circuits the persona machinery entirely and
  // returns the engine's own order (see selectEngineLane). `aggressive` is
  // the "fastest sound win" middle of the strength axis. The Ultra persona
  // stays the opt-in flagship, scaled by the aggression dial.
  const PLAYING_STYLES = {
    normal: {
      id: 'normal',
      name: 'Normal',
      desc: 'Objective best play — the engine\'s own move order, with reliable conversion and resilient defense.',
      riskBudget: { winning: 15, equal: 20, worse: 30 },
      sacrificeTolerance: 0,
      kingHuntBonus: 0,
      diversity: 0,
      // Normal short-circuits before weights are read, so the table stays
      // empty by design.
      weights: {},
      lossWeight: 1.5,
      conversionFrom: 200
    },
    // "Fastest sound win": rewards checks, tempo, open king files and SOUND
    // sacrifices; penalizes speculation, unsupported attacks and own-king
    // danger. Its chess-sized budget (35/85/140) may spend ~1.4 pawns only
    // when already worse.
    aggressive: {
      id: 'aggressive',
      name: 'Aggressive',
      desc: 'The fastest sound win — relentless forcing play and clean conversion, with no gambling.',
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
      },
      lossWeight: 1.25,
      conversionFrom: 200
    },
    super_ultra_aggressive: {
      id: 'super_ultra_aggressive',
      name: 'Ultra Super Aggressive Attack',
      desc: 'A fearless, organized attack built on sound setup first, then a relentless break-through: develop into the enemy king\'s face, rip off the pawn shield, fork/pin/skewer the big pieces, strike the castled or uncastled king, and sacrifice boldly to finish games fast against <=1100 opponents.',
      // Objective-evaluation budgets in centipawns. Widening as a position
      // worsens is intentional (create chaos when worse), but the old
      // 600/850/1200 tiers let unsound 1000cp sacrifices through; exceeding
      // these tighter budgets now requires verified compensation.
      riskBudget: { winning: 40, advantage: 120, equal: 200, worse: 300, desperate: 450 },
      sacrificeTolerance: 1500,
      kingHuntBonus: 260,
      diversity: 0.18,
      // Single source of truth: the live weight table belongs to the style
      // itself in engine/chaos-attack.js (profile.weights). This used to be
      // a hand-copied duplicate that had already drifted (missing the V2
      // siege/sac-mechanism/quiet-phase keys Chaos scores with).
      get weights() {
        const chaos = getChaosEngine();
        return (chaos && chaos.profile && chaos.profile.weights) || {};
      },
      phaseAggressionScale: 1.5,
      // Preserved from the rebalancing work (see the Preserve List): eval
      // cost carries real weight at 1.0 with ULTRA_BONUS_SCALE 0.125, and
      // conversion mode engages from +200 at Level II/III.
      lossWeight: 1.0,
      conversionFrom: 200
    }
  };

  // ─── Aggression dial (the persona's strength axis) ──────────────────
  // One style, three intensities — this replaces the retired style
  // selector. Level I inherits the deleted Aggressive style's soul
  // ("fastest sound win"), II is the signature persona, III widens the
  // risk budgets for maximum chaos.
  const AGGRESSION_LEVELS = {
    1: {
      id: 1, name: 'Sound Storm', budgetScale: 0.6, diversity: 0,
      openingCostCap: 30, conversionFrom: 120,
      desc: 'Fastest sound win — relentless pressure and clean conversion, no gambling.'
    },
    2: {
      // conversionFrom 120 (was 200): the counterplay-trades-as-bonus and
      // finish-urgency vocabulary engages as soon as the position is clearly
      // won, instead of waiting for a near-decisive material edge.
      id: 2, name: 'Ultra Attack', budgetScale: 1, diversity: 0.18,
      openingCostCap: 40, conversionFrom: 120,
      desc: 'The signature persona — fearless, organized attack with verified compensation.'
    },
    3: {
      id: 3, name: 'Max Chaos', budgetScale: 1.5, diversity: 0.25,
      openingCostCap: 60, conversionFrom: 200,
      desc: 'Widest risk budgets and more variety — bring the storm.'
    }
  };

  function resolveAggressionLevel(value) {
    return value === 1 || value === 3 ? value : 2;
  }

  // Applies a dial level to the ultra profile (other profiles pass through).
  function applyAggressionLevel(profile, levelId) {
    if (!profile || profile.id !== 'super_ultra_aggressive') return profile;
    const cfg = AGGRESSION_LEVELS[resolveAggressionLevel(levelId)];
    const scaledBudget = {};
    for (const [tier, cap] of Object.entries(profile.riskBudget)) {
      scaledBudget[tier] = Math.max(20, Math.round(cap * cfg.budgetScale));
    }
    return { ...profile, riskBudget: scaledBudget, diversity: cfg.diversity, openingCostCap: cfg.openingCostCap, aggression: cfg };
  }

  // Single source of truth for style resolution (F1). An unknown, stale or
  // retired style id must degrade to the OBJECTIVE profile, never to the most
  // aggressive one: a settings blob written by an older build should make the
  // hint safer, not wilder. Every call site resolves through here so the
  // fallback is one assertion, not three.
  function resolveStyleProfile(style) {
    return PLAYING_STYLES[style] || PLAYING_STYLES.normal;
  }

  // ─── Ultra Super Aggressive Attack module integration -------------
  // The Ultra Super Aggressive Attack style lives in engine/chaos-attack.js
  // (loaded before this file). It owns computeFeatures / styleBonus /
  // humanFeel / annotate / choosePlan / winningPlan for the
  // super_ultra_aggressive profile, so future style enhancements never touch
  // this engine again. If the module is absent the engine keeps its own
  // inline fallbacks, so nothing breaks on a stale build.
  let chaosEngine = null;
  function getChaosEngine() {
    if (chaosEngine) return chaosEngine;
    const mod = (typeof globalThis !== 'undefined' && globalThis.ChaosAttack) || null;
    if (!mod || typeof mod.createEngine !== 'function') return null;
    chaosEngine = mod.createEngine({
      isSquareAttacked, findKing, pieceAttacksSquare, applyMoveToBoard,
      applyMoveToFen, getPieceAt, detectGamePhase, multiThreatCount, squareToCoords
    });
    return chaosEngine;
  }

  // Optional Early King Hunt integration. The module is intentionally separate
  // from Chaos Attack's always-on style motifs: a caller must pass the exact
  // Ultra Super Aggressive style id *and* the opt-in flag before it can affect
  // candidate scoring. If an older extension build does not include the module,
  // the existing style pipeline remains fully functional.
  let earlyKingHuntEngine = null;
  function getEarlyKingHuntEngine() {
    if (earlyKingHuntEngine) return earlyKingHuntEngine;
    const mod = (typeof globalThis !== 'undefined' && globalThis.EarlyKingHunt) || null;
    if (!mod || typeof mod.createEngine !== 'function') return null;
    earlyKingHuntEngine = mod.createEngine({
      isSquareAttacked, findKing, pieceAttacksSquare, detectGamePhase
    });
    return earlyKingHuntEngine;
  }

  function earlyKingHuntRequested(style, enabled) {
    // The add-on is a persona feature: it never runs for Normal, Aggressive
    // or an unknown/custom style id, even if a stale settings object still
    // carries `earlyKingHuntEnabled: true` (spec 2.2.7 — the objective
    // styles are immune to every persona mechanism).
    return style === 'super_ultra_aggressive' && enabled === true;
  }

  // Opening repertoires were removed. Style ranks legal engine candidates only.

  // ─── ECO Opening Database (externalised) ───────────────────────────
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

  // Resolves once eco.json has been fetched (or failed and fallen back).
  // Cold-start callers should await this before their first detectOpening,
  // otherwise only the 7-entry fallback table is matchable.
  function ensureEcoLoaded() {
    if (!ecoLoadPromise && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      loadEcoDatabase();
    }
    return ecoLoadPromise || Promise.resolve();
  }

  function loadEcoDatabase() {
    if (ecoLoadPromise) return ecoLoadPromise;
    ecoLoadPromise = fetch(chrome.runtime.getURL('engine/eco.json'))
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          ECO_OPENINGS = data;
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

    // Append check (+) / checkmate (#) suffixes per SAN standard.
    // We apply the move to a board copy, then test if the opponent's king
    // is in check; if so, test if they have any legal reply (mate).
    const suffix = computeCheckOrMateSuffix(uci, fen);
    if (suffix) san += suffix;

    return san;
  }

  // Returns '+' for check, '#' for checkmate, '' otherwise.
  // Applies the move, then does a square-attack test on the opponent
  // king. Mate detection includes the full legal-reply set: en-passant
  // captures and castling count as legal replies (a position whose only
  // escape is an e.p. capture is check, not mate).
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
      // Attacker is the side that just moved (activeColor), NOT the opponent.
      // The opponent's king is in check if attacked by the just-moved side's pieces.
      const inCheck = isSquareAttacked(newBoard, kingPos, activeColor);
      if (!inCheck) return '';
      // Context the opponent needs for their legal replies: the en-passant
      // target created by a double pawn push, and their surviving castling
      // rights (a rook captured on its home square removes the right).
      let epTarget = null;
      const fromSq = uci.slice(0, 2);
      const toSq = uci.slice(2, 4);
      const movedPiece = getPieceAt(board, fromSq);
      if (movedPiece && movedPiece.toLowerCase() === 'p') {
        const from = squareToCoords(fromSq);
        const to = squareToCoords(toSq);
        if (Math.abs(from.row - to.row) === 2) {
          epTarget = squareName((from.row + to.row) / 2, from.col);
        }
      }
      let castling = parts[2] && parts[2] !== '-' ? parts[2] : '';
      const rookSquaresLost = { K: 'h1', Q: 'a1', k: 'h8', q: 'a8' };
      for (const [right, sq] of Object.entries(rookSquaresLost)) {
        if (toSq === sq) castling = castling.replace(right, '');
      }
      // Check if opponent has any legal move → if not, it's mate.
      const hasMove = hasAnyLegalMove(newBoard, opponentColor, { epTarget, castling });
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

  function moveLeavesOwnKingSafe(board, fromSq, toSq, isWhite, removeSq) {
    const target = getPieceAt(board, toSq);
    // Kings are never captured in legal chess; checkmate is no legal escape.
    if (target && target.toLowerCase() === 'k') return false;
    let newBoard;
    if (removeSq) {
      // En passant: the captured pawn is NOT on the destination square, so
      // the generic applyMoveToBoard simulation would leave it on the board
      // and could mis-detect a discovered check.
      newBoard = board.map(row => row.slice());
      const from = squareToCoords(fromSq);
      const to = squareToCoords(toSq);
      const rem = squareToCoords(removeSq);
      newBoard[rem.row][rem.col] = null;
      newBoard[to.row][to.col] = newBoard[from.row][from.col];
      newBoard[from.row][from.col] = null;
    } else {
      newBoard = applyMoveToBoard(board, fromSq + toSq);
    }
    const kingChar = isWhite ? 'K' : 'k';
    let kingPos = null;
    for (let r = 0; r < 8 && !kingPos; r++) {
      for (let c = 0; c < 8 && !kingPos; c++) {
        if (newBoard[r][c] === kingChar) kingPos = { row: r, col: c };
      }
    }
    return Boolean(kingPos) && !isSquareAttacked(newBoard, kingPos, isWhite ? 'b' : 'w');
  }

  function hasAnyLegalMove(board, color, ctx) {
    const isWhite = color === 'w';
    const epTarget = ctx && typeof ctx.epTarget === 'string' ? ctx.epTarget : null;
    const castling = ctx && typeof ctx.castling === 'string' ? ctx.castling : '';
    // Castling is a legal reply in its own right (it also escapes checks the
    // king could not otherwise move out of). Verify rights, rook placement,
    // empty transit squares, and an unattacked king path.
    if (castling) {
      const home = isWhite ? 7 : 0;
      const kingChar = isWhite ? 'K' : 'k';
      const rookChar = isWhite ? 'R' : 'r';
      const opp = isWhite ? 'b' : 'w';
      if (board[home][4] === kingChar && !isSquareAttacked(board, { row: home, col: 4 }, opp)) {
        const kingside = isWhite ? 'K' : 'k';
        const queenside = isWhite ? 'Q' : 'q';
        if (castling.includes(kingside) && board[home][7] === rookChar &&
            !board[home][5] && !board[home][6] &&
            !isSquareAttacked(board, { row: home, col: 5 }, opp) &&
            !isSquareAttacked(board, { row: home, col: 6 }, opp)) {
          return true;
        }
        if (castling.includes(queenside) && board[home][0] === rookChar &&
            !board[home][1] && !board[home][2] && !board[home][3] &&
            !isSquareAttacked(board, { row: home, col: 3 }, opp) &&
            !isSquareAttacked(board, { row: home, col: 2 }, opp)) {
          return true;
        }
      }
    }
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
            let epCapture = false;
            if (type === 'p') {
              const forward = isWhite ? -1 : 1;
              if (dc === 0 && dr === forward && !target) reachable = true;
              if (dc === 0 && dr === 2 * forward && !target && !board[r + forward][c]) {
                if ((isWhite && r === 6) || (!isWhite && r === 1)) reachable = true;
              }
              if (Math.abs(dc) === 1 && dr === forward && target) reachable = true;
              // En passant: diagonal to an EMPTY square is legal iff it is the
              // ep target. The captured pawn sits beside, not on, that square.
              if (Math.abs(dc) === 1 && dr === forward && !target && squareName(tr, tc) === epTarget) {
                reachable = true;
                epCapture = true;
              }
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
            if (epCapture) {
              const capturedSq = squareName(tr + (isWhite ? 1 : -1), tc);
              if (moveLeavesOwnKingSafe(board, fromSq, toSq, isWhite, capturedSq)) return true;
            } else if (moveLeavesOwnKingSafe(board, fromSq, toSq, isWhite)) {
              return true;
            }
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

  // ─── Move Classification (win-probability model) ─────────────────
  // Rates the last move the way chess.com / Lichess do: convert the eval
  // swing into a change in win probability, then bucket by how much win
  // chance was lost (or gained). Centipawn thresholds alone mislead — a
  // 50cp swing in a dead-equal middlegame matters far more than the same
  // swing at +6, and mate scores are not comparable to cp at all.
  function classifyMove(evalBefore, evalAfter, opts = {}) {
    const moverColor = opts.moverColor === 'b' ? 'b' : 'w';
    const moverIsWhite = moverColor === 'w';
    const scoreTypeBefore = opts.scoreTypeBefore || 'cp';
    const scoreTypeAfter = opts.scoreTypeAfter || 'cp';

    // Convert mate distances to an extreme cp so the sigmoid saturates
    // (~100% / ~0% win chance) instead of treating "mate in 3" as cp=3.
    const toCp = (score, scoreType) => {
      if (scoreType === 'mate') {
        return score > 0 ? 1000000 - Math.min(Math.abs(score), 9999)
                         : -1000000 + Math.min(Math.abs(score), 9999);
      }
      return Number(score) || 0;
    };

    // Standardise both evals to White's perspective, then to the mover's.
    const beforeWhite = toCp(evalBefore, scoreTypeBefore);
    const afterWhite = toCp(evalAfter, scoreTypeAfter);
    const before = moverIsWhite ? beforeWhite : -beforeWhite;
    const after = moverIsWhite ? afterWhite : -afterWhite;

    // Lichess winning-chances sigmoid: +1 pawn ≈ +9% win chance.
    const winChance = (cp) => {
      const clamped = Math.max(-1200, Math.min(1200, cp));
      return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
    };

    const winBefore = winChance(before) / 100;
    const winAfter = winChance(after) / 100;
    const delta = winAfter - winBefore;    // + = improved for the mover
    const loss = Math.max(0, -delta);      // win % lost
    const gain = Math.max(0, delta);       // win % gained

    let label, symbol, color;
    if (gain >= 0.18)      { label = 'Brilliant';  symbol = '!!'; color = '#26cad4'; }
    else if (gain >= 0.05) { label = 'Great';      symbol = '!';  color = '#5aade0'; }
    else if (loss <= 0.005) { label = 'Best';      symbol = '';   color = '#97af8b'; }
    else if (loss <= 0.015) { label = 'Excellent'; symbol = '';   color = '#97af8b'; }
    else if (loss <= 0.05) { label = 'Good';       symbol = '';   color = '#97af8b'; }
    else if (loss <= 0.10) { label = 'Inaccuracy'; symbol = '?!'; color = '#f7c631'; }
    else if (loss <= 0.18) { label = 'Mistake';    symbol = '?';  color = '#e6923a'; }
    else                   { label = 'Blunder';    symbol = '??'; color = '#ca3531'; }

    const accuracy = Math.max(0, Math.min(100, Math.round(100 * (1 - loss))));

    return {
      label,
      symbol,
      color,
      accuracy,
      evalDiff: after - before,
      winChanceLost: Math.round(loss * 100),
      winChanceGained: Math.round(gain * 100),
      moverColor
    };
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

  // ─── FEN Move Count ────────────────────────────────────────────────
  function parseMoveCount(fen) {
    if (!fen || typeof fen !== 'string') return 1;
    return parseInt(fen.split(' ')[5], 10) || 1;
  }

  // ─── Winning Plan Generation ───────────────────────────────────────
  function generateWinningPlan(evalScore, scoreType, position, playerColor, fen, style, earlyKingHuntEnabled = false) {
    const currentStyle = resolveStyleProfile(style);
    if (scoreType === 'mate') {
      if (evalScore > 0) return `Force checkmate in ${Math.abs(evalScore)} move${Math.abs(evalScore) !== 1 ? 's' : ''}!`;
      return `Stop the forced mate — use every check, tempo, and escape square available.`;
    }

    const phase = detectGamePhase(fen);
    // Level I ("Sound Storm") inherits the retired Aggressive style's
    // convert-fast doctrine for its winning plans.
    if (currentStyle.aggression?.id === 1 && evalScore > 150) {
      return 'Convert fast: keep the initiative, force concessions, and choose the shortest sound route to the king or material gain.';
    }
    if (currentStyle.id === 'super_ultra_aggressive' && earlyKingHuntEnabled && phase !== 'endgame') {
      return 'Early King Hunt active: open lines, deploy attackers with tempo, and keep forcing the opponent to defend before the king can consolidate.';
    }
    if (currentStyle.id === 'super_ultra_aggressive') {
      const chaosW = getChaosEngine();
      if (chaosW) {
        const plan = chaosW.winningPlan(evalScore, phase);
        if (plan) return plan;
      }
      if (evalScore > 100) return phase === 'endgame'
        ? 'Finish fast in the endgame: activate the king, march it toward the enemy king, and hunt every check and capture — the endgame is where your opponent blunders most.'
        : 'Finish fast: count the attackers on the king\'s mating squares, spring the classic opening trap if it is still on the board, fork or pin the big pieces, and ride the forced mate sequence until the position collapses.';
      if (evalScore > -100) return 'Ultra aggressive attack vs <=1100: open lines, launch pawn storms, chase the king out of its castle, and sacrifice fearlessly to overwhelm their defense.';
      return 'Fearless counter-attack: hunt the exposed king, hit every defender, and trade wood for time until their position cracks!';
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
  // ── Phase 1 vocabulary: threat-grounded primitives ────────────────────
  // These three helpers exist so "storm", "penetration" and "pressure" can
  // only be claimed when something is actually threatened. Before Phase 1 the
  // counters were proximity-based, so a bishop on the far side of the board
  // earned "king pressure" and a center recapture earned "pawn storm".
  const KING_ZONE_STRIKE_RANGE = 3;

  function chebyshev(aRow, aCol, bRow, bCol) {
    return Math.max(Math.abs(aRow - bRow), Math.abs(aCol - bCol));
  }

  function kingZoneSquares(kingPos) {
    const zone = [];
    if (!kingPos) return zone;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const tr = kingPos.row + dr, tc = kingPos.col + dc;
      if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) zone.push([tr, tc]);
    }
    return zone;
  }

  // A zone attack is CONCRETE when it hits the king itself, hits a piece that
  // is standing in the zone (a defender or shield pawn the defender must
  // answer for), or comes from genuine striking range. A long-range sweep of
  // an empty zone square from the other end of the board is not pressure.
  function concreteZoneAttack(board, row, col, targetRow, targetCol, kingPos) {
    if (!pieceAttacksSquare(board, row, col, targetRow, targetCol)) return false;
    if (targetRow === kingPos.row && targetCol === kingPos.col) return true;
    if (board[targetRow][targetCol]) return true;
    return chebyshev(row, col, kingPos.row, kingPos.col) <= KING_ZONE_STRIKE_RANGE;
  }

  // Does this piece threaten anything at all — an enemy piece, or a square in
  // the enemy king's zone? Used to qualify "penetration".
  function pieceHasConcreteThreat(board, row, col, attackerIsWhite, enemyKing) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const target = board[r][c];
      if (!target || (target === target.toUpperCase()) === attackerIsWhite) continue;
      if (pieceAttacksSquare(board, row, col, r, c)) return true;
    }
    if (!enemyKing) return false;
    for (const [tr, tc] of kingZoneSquares(enemyKing)) {
      if (concreteZoneAttack(board, row, col, tr, tc, enemyKing)) return true;
    }
    return false;
  }

  // A storming pawn must hit the king's shelter: a square inside the king zone,
  // or a shield pawn within two squares of the king. A pawn that merely stands
  // on a wing file, or that captures toward the center, is not a storm.
  function pawnStormsKing(board, row, col, attackerIsWhite, enemyKing) {
    if (!enemyKing) return false;
    for (const [tr, tc] of kingZoneSquares(enemyKing)) {
      if (pieceAttacksSquare(board, row, col, tr, tc)) return true;
    }
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const target = board[r][c];
      if (!target || target.toLowerCase() !== 'p') continue;
      if ((target === target.toUpperCase()) === attackerIsWhite) continue;
      if (chebyshev(r, c, enemyKing.row, enemyKing.col) > 2) continue;
      if (pieceAttacksSquare(board, row, col, r, c)) return true;
    }
    return false;
  }

  function kingZonePressure(board, attackerIsWhite, kingPos) {
    if (!kingPos) return { attackers: 0, pressure: 0, attackedSquares: 0 };
    const attackingPieces = new Set();
    const attackedZone = new Set();
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || (piece === piece.toUpperCase()) !== attackerIsWhite) continue;
      for (const [tr, tc] of kingZoneSquares(kingPos)) {
        if (concreteZoneAttack(board, row, col, tr, tc, kingPos)) {
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

  // Terrain counters, Phase 1 semantics. A piece is only counted as having
  // "penetrated" when it threatens something from the enemy half, and a pawn
  // is only counted as "storming" when it hits the king's shelter. Proximity
  // alone buys nothing.
  function attackTerrain(board, playerIsWhite, opponentKing) {
    const isEnemyHalf = row => playerIsWhite ? row <= 3 : row >= 4;
    const isDeepEnemyHalf = row => playerIsWhite ? row <= 1 : row >= 6;
    let penetration = 0, deepPenetration = 0, pawnStorm = 0, advancedPawns = 0;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || (piece === piece.toUpperCase()) !== playerIsWhite || piece.toLowerCase() === 'k') continue;
      if (isEnemyHalf(row) && pieceHasConcreteThreat(board, row, col, playerIsWhite, opponentKing)) {
        penetration++;
        if (isDeepEnemyHalf(row)) deepPenetration++;
      }
      if (piece.toLowerCase() === 'p') {
        if (pawnStormsKing(board, row, col, playerIsWhite, opponentKing)) pawnStorm++;
        if (playerIsWhite ? row <= 2 : row >= 5) advancedPawns++;
      }
    }
    return { penetration, deepPenetration, pawnStorm, advancedPawns };
  }

  // ─── Chaos Attack feature primitives (grafted from the Berserker vocabulary) ──
  // Each helper is a pure, stateless board computation so the rebuilt scorer keeps
  // its "hypothetical candidates never mutate game history" invariant.

  // A1 — Attack Unit System: king-zone attacker quality weighted by piece type
  // (N/B = 2, R = 3, Q = 5) rather than raw attacker count. Phase 1: only
  // CONCRETE zone attacks count (see concreteZoneAttack), so a distant sweep
  // of an empty zone square no longer adds units.
  function countAttackUnits(board, attackerIsWhite, kingPos) {
    if (!kingPos) return 0;
    let units = 0;
    const zone = kingZoneSquares(kingPos);
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || (piece === piece.toUpperCase()) !== attackerIsWhite) continue;
      for (const [tr, tc] of zone) {
        if (concreteZoneAttack(board, row, col, tr, tc, kingPos)) {
          units += ({ p: 1, n: 2, b: 2, r: 3, q: 5, k: 0 })[piece.toLowerCase()] || 0;
          break;
        }
      }
    }
    return units;
  }

  // A1 — S-curve: diminishing returns on a couple of units, then accelerating as
  // the king-zone attacker mass becomes a genuine mating net.
  function attackUnitsToBonus(units) {
    if (units <= 0) return 0;
    if (units <= 4) return units * 0.7;      // build-up phase (diminishing-ish)
    if (units <= 8) return 2.8 + (units - 4) * 1.3; // acceleration
    return 8 + (units - 8) * 1.6;            // full swarm
  }

  // A2 — Practical chances: how many of our pieces bear on the enemy king zone
  // versus how many enemy pieces can answer in their own king zone.
  function countPiecesInZone(board, colorIsWhite, kingPos) {
    if (!kingPos) return 0;
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = kingPos.row + dr, c = kingPos.col + dc;
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      const piece = board[r][c];
      if (piece && (piece === piece.toUpperCase()) === colorIsWhite) count++;
    }
    return count;
  }

  // A3 — Structural complexity: sacs and FORCING central pawn advances raise
  // it, equal minor/rook trades (simplification) lower it. Signed value.
  // Phase 1: a bare central push (nothing attacked, nothing forced) is not
  // complexity — it is just a pawn move, and it used to earn credit.
  function structuralComplexityOf(candidate) {
    let value = 0;
    if (candidate.sacrifice) value += 2;
    if (candidate.centralPawnAdvance && candidate.forcingContinuation) value += 1;
    if (candidate.equalMinorRookTrade) value -= 1.5;
    return value;
  }

  // A4 — Greek Gift pattern: bishop takes h7/h2 while the enemy king sits next to
  // the corner (castled). Returns a boolean plus modifiers for annotations.
  function detectGreekGift(piece, from, to, captured, playerIsWhite, enemyKing) {
    const isBishop = piece && piece.toLowerCase() === 'b';
    if (!isBishop || !captured || captured.toLowerCase() !== 'p') return { detected: false };
    const target = playerIsWhite ? 'h7' : 'h2';
    if (to !== target) return { detected: false };
    // The enemy king must be castled toward the corner next to the target pawn:
    //  White Bxh7+ -> Black king on h8/g8/h7 (kingside, high files 6-7).
    //  Black Bxh2+ -> White king on h1/g1/h2 (kingside, high files 6-7).
    const nearCorner = enemyKing && (
      (playerIsWhite && (enemyKing.row === 0 || enemyKing.row === 1) && enemyKing.col >= 6) ||
      (!playerIsWhite && (enemyKing.row === 7 || enemyKing.row === 6) && enemyKing.col >= 6)
    );
    return { detected: Boolean(nearCorner) };
  }

  // A6 — Overload exploitation: capturing a defender near the king, or landing
  // where many enemy pieces are clustered in the king zone.
  // Phase 1: a cluster of defenders around their OWN king is the normal state
  // of a castled position — it is only an overload when we are actually
  // pressing that zone. Without attack units bearing on the king, the cluster
  // clause is silent (it used to fire for literally every legal move).
  function overloadScoreOf(candidate, after, playerIsWhite, enemyKing) {
    let score = 0;
    if (candidate.defenderRemoval) score += 1;
    const clustered = enemyKing ? countPiecesInZone(after, !playerIsWhite, enemyKing) : 0;
    const pressing = Number(candidate.attackUnitsAfter) || 0;
    if (clustered >= 3 && pressing >= 3 && (Number(candidate.attackUnitDelta) || 0) > 0) score += 1;
    return score;
  }

  // A7 — Tempo-with-threats: count of enemy major pieces (Q/R) attacked from the
  // destination square, and whether the piece develops while pressing the king.
  function multiThreatCount(after, to, playerIsWhite) {
    const pos = squareToCoords(to);
    let count = 0;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const target = after[row][col];
      if (!target || (target === target.toUpperCase()) === playerIsWhite) continue;
      if (['q', 'r'].includes(target.toLowerCase()) && pieceAttacksSquare(after, pos.row, pos.col, row, col)) count++;
    }
    return count;
  }
  // ─── Chaos Attack delegation ─────────────────────────────────────────
  // The Chaos Attack advanced primitives and tactical toolkit all live in
  // engine/chaos-attack.js. The engine delegates the whole style via
  // getChaosEngine() — future Chaos enhancements never touch this file.

  function analyzeCandidate(fen, pv, playerColor, rawScore, scoreType, depth = 0, options = {}) {
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

    // ── Chaos Attack feature-delta primitives (grafted Berserker vocabulary) ──
    const attackUnitsBefore = countAttackUnits(board, playerIsWhite, opponentKingBefore);
    const attackUnitsAfter = countAttackUnits(after, playerIsWhite, opponentKingAfter);
    const attackUnitDelta = attackUnitsAfter - attackUnitsBefore;
    const attackersZoneAfter = opponentKingAfter ? countPiecesInZone(after, playerIsWhite, opponentKingAfter) : 0;
    const defendersZoneAfter = opponentKingAfter ? countPiecesInZone(after, !playerIsWhite, opponentKingAfter) : 0;
    const practicalChancesScore = attackersZoneAfter - defendersZoneAfter;
    const centralPawnAdvance = piece && piece.toLowerCase() === 'p' &&
      destination.row >= 2 && destination.row <= 5 && destination.col >= 2 && destination.col <= 5;
    const equalMinorRookTrade = captured && ['n', 'b', 'r'].includes(piece?.toLowerCase()) &&
      ['n', 'b', 'r'].includes(captured.toLowerCase()) &&
      PIECE_VALUES[piece.toLowerCase()] === PIECE_VALUES[captured.toLowerCase()];
    const greekGift = detectGreekGift(piece, from, to, captured, playerIsWhite, opponentKingBefore);
    const drawContemptScore = Math.abs(rawScore) < 50 ? -1 - (50 - Math.abs(rawScore)) / 50 : 0;
    const overloadScore = overloadScoreOf(
      { defenderRemoval, attackUnitsAfter, attackUnitDelta },
      after, playerIsWhite, opponentKingAfter);
    const tempoThreatCount = multiThreatCount(after, to, playerIsWhite);
    const pressureDeltaForDevelopment = (pressureAfter.pressure - pressureBefore.pressure) +
      (pressureAfter.attackedSquares - pressureBefore.attackedSquares) * 0.5;
    const developmentWithAttack = isDevelopingMove(piece, from) &&
      (pressureDeltaForDevelopment > 0 || terrainAfter.penetration > terrainBefore.penetration || givesCheck);

    // ── Phase 1: concreteness gates ──────────────────────────────────────
    // "Increases king pressure" and "raises complexity" are claims about a
    // THREAT this move creates. Compute the evidence explicitly instead of
    // inferring it from a counter that moved.
    const rawKingPressureDelta = (pressureAfter.pressure - pressureBefore.pressure) +
      (pressureAfter.attackedSquares - pressureBefore.attackedSquares) * 0.5;
    const moverBearsOnKingZone = Boolean(opponentKingAfter) &&
      kingZoneSquares(opponentKingAfter).some(([tr, tc]) =>
        concreteZoneAttack(after, destination.row, destination.col, tr, tc, opponentKingAfter));
    const concreteKingThreat = Boolean(
      givesCheck || defenderRemoval || opensKingFile || moverBearsOnKingZone || attackUnitDelta > 0
    );
    let centralAdvanceAttacksPiece = false;
    if (centralPawnAdvance) {
      for (let row = 0; row < 8 && !centralAdvanceAttacksPiece; row++) {
        for (let col = 0; col < 8; col++) {
          const target = after[row][col];
          if (!target || (target === target.toUpperCase()) === playerIsWhite) continue;
          if (pieceAttacksSquare(after, destination.row, destination.col, row, col)) {
            centralAdvanceAttacksPiece = true;
            break;
          }
        }
      }
    }

// ── Chaos Attack feature deltas are computed by engine/chaos-attack.js
    // (the style lives there now). computeFeatures(ctx) returns the whole
    // Chaos feature set and it is merged onto the candidate below.

    const features = {
      rawScore, scoreType, depth, first, from, to, piece, captured, fen,
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
      attackUnits: attackUnitsAfter,
      attackUnitDelta,
      practicalChancesScore,
      structuralComplexity: structuralComplexityOf({
        sacrifice, centralPawnAdvance, equalMinorRookTrade,
        // Phase 1: a central push only raises complexity inside a forcing
        // line (or when it attacks something) — never on its own.
        forcingContinuation: forcingPly >= 2 || centralAdvanceAttacksPiece
      }),
      isGreekGift: greekGift.detected,
      drawContemptScore,
      overloadScore,
      tempoThreatCount,
      developmentWithAttack,
      winningMate: scoreType === 'mate' && rawScore > 0,
      losingMate: scoreType === 'mate' && rawScore < 0,
      forcingPly,
      playerForcingMoves,
      // Phase 1: the raw delta is kept for diagnostics, but the scored
      // `kingPressureDelta` is zero unless this move created a NEW concrete
      // threat against the king (check, defender removed, opened line, the
      // mover itself bearing on the zone, or a new attacker joining it).
      kingPressureDeltaRaw: rawKingPressureDelta,
      concreteKingThreat,
      kingPressureDelta: concreteKingThreat ? rawKingPressureDelta : 0,
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
      // plan is assigned below, after the ChaosEngine merges its features.
      reasons: [], risks: []
    };

    // ── ChaosEngine merge — the Chaos feature set and plan live in
    // engine/chaos-attack.js (the style hierarchy). Fall back gracefully to
    // the generic plan if the module is not present.
    const chaos0 = getChaosEngine();
    if (chaos0) {
      Object.assign(features, chaos0.computeFeatures({
        board, after, piece, captured, from, to, destination,
        playerIsWhite, playerColor, opponentKingBefore, opponentKingAfter,
        ownKingBefore, ownKingAfter, givesCheck, materialDelta, line,
        boardAfterReply, fen, scoreType, rawScore, pressureBefore, pressureAfter
      }));
      features.plan = chaos0.choosePlan(features);
    }

    // The optional module is evaluated after the base/Chaos feature set so it
    // can use concrete king pressure, forcing-PV, deployment, and sacrifice
    // facts. It is still inert unless the exact style and setting are supplied.
    const earlyHunt = getEarlyKingHuntEngine();
    if (earlyHunt) {
      Object.assign(features, earlyHunt.computeFeatures({
        board, after, piece, captured, from, to, destination,
        playerIsWhite, playerColor, opponentKingBefore, opponentKingAfter,
        ownKingBefore, ownKingAfter, givesCheck, materialDelta, line,
        boardAfterReply, fen, scoreType, rawScore, pressureBefore, pressureAfter,
        candidate: features,
        style: options.style,
        earlyKingHuntEnabled: options.earlyKingHuntEnabled === true
      }));
      if (features.earlyKingHuntActive && typeof earlyHunt.choosePlan === 'function') {
        features.plan = earlyHunt.choosePlan(features) || features.plan;
      }
    } else {
      features.earlyKingHuntActive = false;
      features.earlyKingHuntSafe = true;
      features.earlyKingHuntUnsafe = false;
    }
    if (!features.plan) {
      features.plan = features.chased && pressureAfter.pressure > pressureBefore.pressure ? 'hunt the exposed king'
        : features.punishUncastled ? 'punish the uncastled king'
        : givesCheck || pressureAfter.pressure > pressureBefore.pressure
          ? (opponentKingAfter?.col >= 4 ? 'kingside attack' : 'queenside attack')
          : isDevelopingMove(piece, from) ? 'complete development'
          : piecesBefore - countPieces(boardAfterReply) > 1 ? 'force a favorable simplification'
          : captured ? 'win material with tempo'
          : 'improve piece activity';
    }
    return features;
  }

  function candidateStyleBonus(candidate, style, context = {}) {
    const weights = style.weights || {};
    // scoring.conversion — set by the caller when the position is clearly
    // winning; switches the vocabulary from "create chaos" to "finish fast".
    const scoring = { conversion: context.conversion === true };
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
    add(candidate.tempoThreatCount > 1, 'tempo', weights.tempo * Math.min(candidate.tempoThreatCount - 1, 2), 'creates multiple simultaneous threats');
    add(candidate.development, 'development', weights.development, 'develops with attacking purpose');
    add(candidate.developmentWithAttack, 'developmentWithAttack', weights.developmentWithAttack, 'develops directly into the attack');
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
    add(candidate.complexity > 0 && !scoring.conversion, 'complexity', weights.complexity * Math.min(candidate.complexity, 4), 'creates practical complexity');
    // Winning-conversion mode (ported from the retired Aggressive style's
    // "fastest sound win" discipline): once the position is clearly won,
    // trading away the opponent's last active pieces is FINISHING, not
    // timidity — the usual simplification penalty flips into a bonus and
    // mate-speed urgency is rewarded.
    if (scoring.conversion) {
      add(candidate.simplification > 1, 'conversionTrade', (weights.conversionTrade || 90) * Math.min(candidate.simplification - 1, 3),
        'trades away the last counterplay — time to finish');
      add(Boolean(candidate.winningMate) || candidate.forcingPly >= 2, 'finishUrgency', weights.mateSpeed || 130,
        'drives the fastest finish');
    } else {
      add(candidate.simplification > 1, 'simplification', weights.simplification * Math.min(candidate.simplification - 1, 3), 'simplifies the attack');
    }
    add(candidate.ownKingDangerDelta > 0, 'ownKingDanger', weights.ownKingDanger * Math.min(candidate.ownKingDangerDelta, 5), 'weakens your own king');
    add(candidate.unsupportedAttack, 'unsupportedAttack', weights.unsupportedAttack, 'attacking piece lacks support');
    // King safety is part of the attack, not its opposite: early castling is
    // paid from the style's own quiet-prep weight (only ultra defines it).
    add(candidate.castling && detectGamePhase(candidate.fen) === 'opening', 'castleEarly', weights.quietKingPrep,
      'tucks the king away early — safety first, then the storm');

    // attackMomentum must be computed BEFORE the Chaos delegation: its
    // siege-continuity clause reads candidate.attackMomentum to scale the
    // continuity bonus, and on a fresh candidate it would otherwise always
    // read undefined, pinning continuityScale to its 0.6 floor. The
    // re-assignment after the delegation keeps the engine-owned sum as the
    // final value (Chaos's calibrateAttackScore overwrites it mid-call).
    candidate.attackMomentum = (candidate.kingPressureDelta || 0) +
      (candidate.penetrationDelta || 0) + (candidate.pawnStormDelta || 0);
    // Winning-conversion context for the style engine (e.g. the queen-trade
    // veto must not fight clean technique in already-won positions).
    candidate.conversionMode = scoring.conversion;

    // ── Chaos Attack delegation ─────────────────────────────────────────
    // The full grafted Berserker-vocabulary, advanced Chaos, kill-geometry,
    // mating-square arithmetic, position-level, opening-trap, second-move
    // vision, and tactical-toolkit clauses live in engine/chaos-attack.js
    // (styleBonus). Future Chaos enhancements never touch this engine again.
    const chaosB = getChaosEngine();
    if (chaosB) {
      let chaosWeights = style.weights || {};
      if (style.id === 'super_ultra_aggressive' && typeof chaosB.scaledWeights === 'function') {
        const phase = candidate.fen ? detectGamePhase(candidate.fen) : 'middlegame';
        const moveCount = parseMoveCount(candidate.fen);
        chaosWeights = chaosB.scaledWeights(candidate, phase, moveCount);
      }
      bonus += chaosB.styleBonus(candidate, chaosWeights);
    }

    // The opt-in add-on is a second, explicitly gated scoring layer. It never
    // runs for Normal, Aggressive, or unknown/custom style ids, even if a stale
    // settings object contains `earlyKingHuntEnabled: true`.
    if (style.id === 'super_ultra_aggressive' && candidate.earlyKingHuntActive) {
      const earlyHunt = getEarlyKingHuntEngine();
      if (earlyHunt) bonus += earlyHunt.styleBonus(candidate, earlyHunt.profile?.weights);
    }

    // A8 — Phase-aware aggression scaling (Chaos only). Middlegame amplifies the
    // whole aggression budget; the endgame amplifies a forced-mate seeker. The
    // middlegame magnitude comes from the style's phaseAggressionScale config.
    if (style.id === 'super_ultra_aggressive') {
      const phase = candidate.fen ? detectGamePhase(candidate.fen) : 'middlegame';
      const base = style.phaseAggressionScale || 1;
      // Opening used to be AMPLIFIED (0.8 + 1.5*0.3 = 1.25), producing Ng5?!
      // on move four. The build-up phase is now damped; development and king
      // safety incentives carry the opening instead.
      let phaseMult = phase === 'middlegame' ? base : (phase === 'opening' ? 0.6 : 1.0);
      if (phase === 'endgame' && candidate.winningMate) phaseMult = Math.max(phaseMult, base);
      if (bonus > 0) bonus *= phaseMult;
      // Bring the whole ultra vocabulary back into a magnitude where the
      // eval-loss term and the human shortlist margins can compete with it.
      bonus *= ULTRA_BONUS_SCALE;
    }

    // A9 — Secondary hard ceiling so a single stacked move cannot run away with
    // the score. The existing chaosSacrificeTrigger gate and risk budget remain
    // authoritative; this cap is purely a symmetry safety net.
    const synergyCap = (style.sacrificeTolerance || 0) * 6;
    if (synergyCap > 0 && Number.isFinite(bonus)) bonus = Math.min(bonus, synergyCap);
    const overlap = [
      candidate.givesCheck,
      candidate.kingPressureDelta > 0,
      candidate.opensKingFile,
      candidate.penetrationDelta > 0
    ].filter(Boolean).length;
    if (overlap >= 3 && bonus > 0) bonus /= (1 + (overlap - 2) * 0.12);
    // Restore the engine-owned momentum after Chaos's internal overwrite.
    candidate.attackMomentum = (candidate.kingPressureDelta || 0) +
      (candidate.penetrationDelta || 0) + (candidate.pawnStormDelta || 0);

    // ── Divergence premium (D1) ──────────────────────────────────────
    // The aggressive style is meant to be *different* from the engine, not a
    // different caption on the engine's own top move. A candidate whose first
    // move differs from the objective best receives a bounded premium ONLY
    // when it carries concrete attacking evidence — bare difference is never
    // rewarded. The premium is added AFTER the ultra scaling so it lives in
    // the same magnitude as the (already-scaled) attack vocabulary; it can
    // tip a near-tie toward the attacking alternative but can never out-vote
    // the hard gates, which run before scoring (styleSafetyAllows).
    const divergenceWeight = Number(DIVERGENCE_PREMIUM[style.id]) || 0;
    if (divergenceWeight && context.objectiveBestMove &&
        candidate.first && candidate.first !== context.objectiveBestMove) {
      const attackingEvidence = candidate.givesCheck ||
        candidate.tempoThreatCount > 0 ||
        candidate.kingPressureDelta > 0 ||
        candidate.pawnStormDelta > 0 ||
        candidate.penetrationDelta > 0 ||
        (candidate.sacrifice && candidate.chaosSacrificeTrigger);
      if (attackingEvidence) {
        bonus += divergenceWeight;
        candidate.reasons.push('diverges from the engine top move with a concrete attacking point');
      }
    }
    return bonus;
  }

  // Central style policy. Style may choose among objectively acceptable
  // candidates. It may never override these facts.
  // Verified compensation: the only way a candidate may exceed its risk
  // budget (or drop a win-probability class). Requires a CONCRETE sacrifice
  // mechanism (classified by the style engine's geometry, not by "it feels
  // attacking") plus a forced mate in the PV or a genuinely forcing
  // sequence — and never more than the desperate ceiling overall.
  function verifiedCompensation(analysis, evalLoss) {
    if (!Number.isFinite(evalLoss) || evalLoss > 450) return false;
    const mechanism = analysis?.sacMechanism;
    if (mechanism !== 'deflect' && mechanism !== 'lineOpen' && mechanism !== 'tempo') return false;
    if (analysis?.winningMate) return true;
    return (analysis?.forcingPly || 0) >= 3 && Boolean(analysis?.givesCheck || analysis?.chaosSacrificeTrigger);
  }

  const WIN_CLASS_RANK = { losing: 0, worse: 1, equal: 2, advantage: 3, winning: 4 };
  function winClass(score) {
    if (!Number.isFinite(score)) return 'equal';
    if (score > 200) return 'winning';
    if (score > 50) return 'advantage';
    if (score >= -50) return 'equal';
    if (score >= -200) return 'worse';
    return 'losing';
  }

  function styleSafetyAllows(analysis, evalLoss, profile, objectiveBest, conversion = false) {
    if (analysis?.invalid) return false;
    if (!Number.isFinite(evalLoss)) return false;
    if (objectiveBest?.pv?.scoreType === 'mate' && objectiveBest.score > 0) return evalLoss === 0;
    if (profile.id !== 'normal' && analysis.ownKingTrapped) return false;
    if (analysis.earlyKingHuntActive && analysis.earlyKingHuntUnsafe) return false;
    const bestScore = objectiveBest?.score || 0;
    // The objective profile never buys out of its budget — escapes are a
    // style freedom only.
    const compensated = profile.id !== 'normal' && verifiedCompensation(analysis, evalLoss);
    // Conversion-trade exemption (the retired Aggressive style's core
    // discipline): in a clearly won position, trading the opponent's last
    // active pieces is textbook technique even when it costs eval — as long
    // as the position STAYS clearly winning. Hard-capped at 120cp and the
    // class-collapse guard below still applies.
    const conversionTrade = profile.id !== 'normal' &&
      !(objectiveBest?.pv?.scoreType === 'mate') &&
      bestScore > 200 && (analysis.simplification || 0) >= 2 &&
      evalLoss <= 120 && (bestScore - evalLoss) > 200;
    const budget = riskBudgetFor(profile, bestScore);
    if (evalLoss > budget && !compensated && !conversionTrade) return false;
    // Win-preservation gate (F3 / G1). Once the position is clearly won the
    // persona converts instead of creating chaos: the win-probability class
    // must not move AT ALL (not merely "by less than two classes"), and the
    // winning-tier budget caps the spend even when verifiedCompensation
    // would otherwise excuse it. Compensation may justify spending in
    // equality — never in conversion. The conversion-trade exemption is
    // allowed through because it is defined to keep the position above +200.
    if (profile.id !== 'normal' && bestScore > 200 && objectiveBest?.pv?.scoreType !== 'mate') {
      if (evalLoss > budget && !conversionTrade) return false;
      if (winClass(bestScore - evalLoss) !== winClass(bestScore)) return false;
    }
    // Class-collapse guard: a style pick may never throw away two or more
    // win-probability classes (winning→equal-or-worse, equal→losing) without
    // verified compensation. Single-class dips stay governed by the budget,
    // which already encodes how much chaos each position justifies.
    const classDrop = WIN_CLASS_RANK[winClass(bestScore)] - WIN_CLASS_RANK[winClass(bestScore - evalLoss)];
    if (classDrop >= 2 && !compensated) return false;
    // Opening sanity: in the first eight moves of a quiet position (no
    // tactics on the board), style pays club-level prices only — develop
    // and castle first, hunt later. Recognized opening traps (Qh5-class
    // scholar patterns) and the opted-in Early King Hunt are exempt: the
    // former are concrete by definition, the latter owns its own safety veto.
    if (profile.id !== 'normal' && analysis.fen && parseMoveCount(analysis.fen) <= 8 &&
        Math.abs(bestScore) <= 120 && evalLoss > (profile.openingCostCap ?? 40) && !compensated &&
        !analysis.earlyKingHuntActive &&
        !(analysis.scholarTrap || analysis.legalsTrap || analysis.laskerTrap)) return false;
    // Principle 6 — never trade queens while a weak enemy king is under
    // fire: the queen is the mating piece. Hard gate (a soft score penalty
    // could not out-weigh the check/defender geometry the trade itself
    // collects). Exempt: clean winning-conversion mode (technique decides
    // once the game is clearly won), forced mates in the candidate's PV,
    // and materially-winning "trades".
    if (profile.id !== 'normal' && analysis.queenTradeOffered &&
        !conversion && !analysis.winningMate && (analysis.materialDelta || 0) <= 60 &&
        (analysis.punishUncastled || (analysis.kingPressureDelta || 0) > 0 ||
          (analysis.sustainedPressure || 0) >= 0.5 || analysis.shieldStrike || analysis.kingSuffocation)) {
      return false;
    }
    if (profile.id !== 'normal' && analysis.losingMate) return false;
    return true;
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
    // (Non-ultra profiles keep their compact original budgets.)
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

  // Book moves (Masters DB win rates, the owned attack book) live in their
  // own lane. Their scores are popularity-derived, not engine evaluations,
  // so mixing them into the cp ranking let fake centipawns outvote real
  // analysis. Book-only pools rank inside their lane (curated order);
  // mixed pools append the book lane after the engine ranking, ineligible
  // for the style pick.
  function tagBookLane(bookPvs) {
    return bookPvs
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((pv, rank) => ({
        ...pv,
        _styleAnalysis: {
          mode: 'book',
          bookLane: true,
          objectiveRank: rank + 1,
          styleRank: rank + 1,
          evalLoss: 0,
          eligible: true,
          reasons: [
            pv._masterData
              ? `book move — ${pv._masterData.totalGames} master games (${pv._masterData.whiteWinPct}% White wins)`
              : (pv._bookLine ? `book move — ${pv._bookLine}` : 'book move — opening theory')
          ],
          risks: [],
          masterGames: Number(pv._masterData?.totalGames || 0)
        }
      }));
  }

  // Returns PVs in style order. Each PV receives non-invasive _styleAnalysis
  // metadata used to keep hints, candidates, and explanations synchronized.
  // Book PVs (Masters win rates, owned repertoire) are kept in their own
  // lane: a pure book pool ranks inside the lane, a mixed pool appends the
  // book lane (ineligible for the style pick) after the engine ranking —
  // except for the bounded book-first preference below.
  //
  // Repertoire/book soft preference (spec 2.2.3). A book move may take the
  // PRIMARY slot only within this many centipawns of the engine's best — and
  // never over a winning mate. Book scores stay win-rate-derived; this is a
  // bounded preference, not a re-scoring.
  const BOOK_FIRST_TOLERANCE_CP = 50;

  // Who gets the bounded book preference: always on for both product styles.
  // Normal applies it unconditionally (spec 2.2.3); the persona applies it
  // because the setting is now internal and always-on.
  function bookFirstAllowed(style, context = {}) {
    const profile = resolveStyleProfile(style);
    if (profile.id === 'normal') return true;
    return context.bookFirstOpenings === true;
  }

  // Promotes the best book-lane candidate to the primary slot when it is
  // within tolerance of the engine's top line. Never displaces a winning
  // mate (spec 2.2.3 / 2.2.4).
  function promoteBookWithinTolerance(ranked, playerColor, tolerance = BOOK_FIRST_TOLERANCE_CP) {
    if (!Array.isArray(ranked) || ranked.length < 2) return ranked;
    const top = ranked[0];
    // A single-PV engine lane is passed through untouched, so its entries
    // carry no _styleAnalysis at all — treat that as "not the book lane".
    if (!top || top._styleAnalysis?.bookLane) return ranked;
    const bestScore = playerScore(top, playerColor);
    if (top.scoreType === 'mate' && bestScore > 0) return ranked;
    const bestMove = top.pv?.[0];
    const index = ranked.findIndex((pv, i) =>
      i > 0 && pv._styleAnalysis?.bookLane &&
      pv.scoreType !== 'mate' &&
      pv.pv?.[0] && pv.pv?.[0] !== bestMove &&
      playerScore(pv, playerColor) >= bestScore - tolerance);
    if (index < 0) return ranked;
    const promoted = ranked[index];
    const reordered = [promoted, ...ranked.slice(0, index), ...ranked.slice(index + 1)];
    return reordered.map((pv, rank) => ({
      ...pv,
      _styleAnalysis: {
        ...(pv._styleAnalysis || {}),
        styleRank: rank + 1,
        eligible: rank === 0 ? true : Boolean(pv._styleAnalysis?.eligible),
        reasons: rank === 0
          ? [`book preference — within ${tolerance}cp of the engine's best`, ...(pv._styleAnalysis?.reasons || [])]
          : pv._styleAnalysis?.reasons
      }
    }));
  }

  function selectPVForStyle(pvs, fen, style, playerColor, context = {}) {
    if (!Array.isArray(pvs) || pvs.length === 0) return [];
    const bookPvs = pvs.filter(p => p.scoreType === 'book');
    const enginePvs = pvs.filter(p => p.scoreType !== 'book');
    if (bookPvs.length > 0 && enginePvs.length === 0) return tagBookLane(bookPvs);
    if (bookPvs.length === 0) return selectEngineLane(pvs, fen, style, playerColor, context);
    const engineRanked = selectEngineLane(enginePvs, fen, style, playerColor, context);
    const offset = engineRanked.length;
    const tagged = tagBookLane(bookPvs).map(pv => ({
      ...pv,
      _styleAnalysis: { ...pv._styleAnalysis, eligible: false, styleRank: offset + pv._styleAnalysis.styleRank }
    }));
    const merged = [...engineRanked, ...tagged];
    return bookFirstAllowed(style, context)
      ? promoteBookWithinTolerance(merged, playerColor)
      : merged;
  }

  function selectEngineLane(pvs, fen, style, playerColor, context = {}) {
    const profile = applyAggressionLevel(resolveStyleProfile(style), context.aggressionLevel);
    const earlyKingHuntEnabled = earlyKingHuntRequested(profile.id, context.earlyKingHuntEnabled);
    if (pvs.length === 1) {
      // A single-PV source cannot be re-ranked, but the opt-in still annotates
      // the line and applies the same safety checks so diagnostics stay honest.
      if (!earlyKingHuntEnabled) return pvs;
      const only = pvs[0];
      const score = playerScore(only, playerColor);
      const meta = analyzeCandidate(
        fen, only.pv || [], playerColor, score, only.scoreType, only.depth || 0,
        { style: profile.id, earlyKingHuntEnabled }
      );
      meta.evalLoss = 0;
      meta.objectiveRank = 1;
      meta.styleRank = 1;
      meta.mode = profile.id;
      meta.limitedCandidates = true;
      meta.masterGames = Number(only._masterData?.totalGames || context.openingData?.moves?.find(move => move.uci === only.pv?.[0])?.total || 0);
      candidateStyleBonus(meta, profile);
      return [{ ...only, _styleAnalysis: meta }];
    }
    const objective = pvs.map((pv, index) => ({ pv, index, utility: objectiveUtility(pv, playerColor), score: playerScore(pv, playerColor) }))
      .sort((a, b) => b.utility - a.utility);
    // ── F4 pool integrity ────────────────────────────────────────────────
    // A pool widened from a single-line source carries `localPool` extras
    // produced by the on-device alpha-beta (depth <= 6, heuristic evals).
    // They may inform the style contest and fill the display list, but they
    // may never take the primary slot while an authoritative cloud PV is
    // present: their scores are noise next to a real engine evaluation, and
    // `styleScore` happily adds attack bonuses to them. The single exception
    // is a shallow cloud line (depth < 12) where the local search is at least
    // as deep (>= 5) and AGREES with the cloud evaluation within 30cp — i.e.
    // it is corroborating, not outvoting.
    const cloudEntries = objective.filter(entry => entry.pv.localPool !== true);
    const cloudBest = cloudEntries[0];
    const shallowCloud = Boolean(cloudBest) && (Number(cloudBest.pv.depth) || 0) < 12;
    const localMayCompete = (entry) =>
      entry.pv.localPool === true && shallowCloud &&
      (Number(entry.pv.depth) || 0) >= 5 &&
      Math.abs(entry.score - cloudBest.score) <= 30;
    const isBenched = (entry) =>
      entry.pv.localPool === true && cloudEntries.length > 0 && !localMayCompete(entry);
    // Budgets, the mate lock and the win-preservation gate are all measured
    // against the authoritative cloud line, never against local noise.
    const objectiveBest = cloudBest || objective[0];

    // Normal is the objective baseline (F1 / spec 2.2): the engine's own
    // order, no persona machinery, no diversity, no dial. Mate discipline
    // still governs the METADATA — with a winning mate on top, a non-mating
    // line does not cost "nothing". The old subtraction reported evalLoss 0
    // for a +800cp candidate next to a mate-in-2 (score 2), which made the
    // losing alternative look free.
    if (profile.id === 'normal') {
      const bestIsWinningMateForNormal = objectiveBest.pv.scoreType === 'mate' && objectiveBest.score > 0;
      return objective.map((entry, rank) => {
        let evalLoss;
        if (bestIsWinningMateForNormal) {
          evalLoss = entry.pv.scoreType === 'mate' && entry.score > 0
            ? Math.max(0, Math.abs(entry.score) - Math.abs(objectiveBest.score))
            : Infinity;
        } else if (entry.pv.scoreType === 'mate') {
          evalLoss = entry.score > 0 ? 0 : Infinity;
        } else if (objectiveBest.pv.scoreType === 'mate') {
          evalLoss = Infinity;
        } else {
          evalLoss = Math.max(0, objectiveBest.score - entry.score);
        }
        return {
          ...entry.pv,
          _styleAnalysis: {
            objectiveRank: rank + 1,
            styleRank: rank + 1,
            evalLoss,
            reasons: ['objective best play'],
            risks: [], mode: profile.id
          }
        };
      });
    }

    const bestIsWinningMate = objectiveBest.pv.scoreType === 'mate' && objectiveBest.score > 0;
    // Winning-conversion mode kicks in before mate is forced: with a clear
    // advantage the persona switches to the retired Aggressive style's
    // "fastest sound win" discipline (trade counterplay, drive the finish).
    // Level I converts earlier (from +120), II/III from +200.
    const conversion = !bestIsWinningMate && objectiveBest.score > (profile.aggression?.conversionFrom ?? profile.conversionFrom ?? 200);
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
      const analysis = analyzeCandidate(
        fen,
        entry.pv.pv || [],
        playerColor,
        entry.score,
        entry.pv.scoreType,
        entry.pv.depth || 0,
        { style: profile.id, earlyKingHuntEnabled }
      );
      const firstMove = entry.pv.pv?.[0];
      const openingMove = context.openingData?.moves?.find(move => move.uci === firstMove);
      analysis.masterGames = Number(entry.pv._masterData?.totalGames || openingMove?.total || 0);
      // V2 siege continuity: remember whether this candidate advances the same
      // plan as the previous hint. The Chaos styleBonus converts this into a
      // real bonus so consecutive picks form one coherent attack instead of
      // greedy per-move choices.
      analysis.siegeContinuity = Boolean(context.activePlan && analysis.plan === context.activePlan);
      // Generated attack candidates are searched by the shallow on-device
      // engine, so their objective cost is less trustworthy than a cloud line.
      // Price that uncertainty into evalLoss before the safety gates and the
      // style contest see it — divergence may be sought, never assumed cheap.
      if (entry.pv.attackCandidate === true && Number.isFinite(evalLoss)) {
        evalLoss += ATTACK_CANDIDATE_PENALTY_CP;
        analysis.attackCandidate = true;
        analysis.candidateKind = entry.pv.candidateKind || 'candidate';
        analysis.candidateTag = entry.pv.candidateTag || 'attack line';
      }
      analysis.evalLoss = evalLoss;
      analysis.objectiveRank = rank + 1;
      analysis.mode = profile.id;
      const benched = isBenched(entry);
      if (benched) {
        analysis.poolBenched = true;
      }
      const eligible = !benched && styleSafetyAllows(analysis, evalLoss, profile, objectiveBest, conversion);
      const bonus = eligible
        ? candidateStyleBonus(analysis, profile, { conversion, objectiveBestMove: objectiveBest.pv.pv?.[0] })
        : -Infinity;
      // Per-style eval cost. Normal is the strictest (1.5); Aggressive pays
      // 1.25 so checks and sustained forcing play can still overcome it;
      // Ultra keeps 1.0 — it paid 0.62 while its bonuses were ~10x every
      // other style's, and with bonuses rescaled the eval term must count
      // (Preserve List: do not revert to 0.62).
      const lossWeight = Number.isFinite(profile.lossWeight) ? profile.lossWeight : 1.0;
      const styleScore = eligible ? bonus - evalLoss * lossWeight : -Infinity;
      analysis.attackSubTotal = analysis.attackMomentum ||
        ((analysis.kingPressureDelta || 0) + (analysis.penetrationDelta || 0) + (analysis.pawnStormDelta || 0));
      return { ...entry, analysis, eligible, bonus, styleScore };
    });

    let eligible = candidates.filter(candidate => candidate.eligible);
    if (!eligible.length) {
      // Every candidate was vetoed: fall back to the objective best. That
      // candidate must leave the ineligible list, or it renders twice.
      eligible = [candidates.find(candidate => candidate.index === objectiveBest.index) || candidates[0]];
    }
    // C1 — For Chaos, tie-break budget-eligible candidates by concrete attack
    // facts (king pressure + penetration + pawn storm) so the most aggressive
    // candidate within tolerance surfaces first. Budget gate stays authoritative.
    eligible.sort((a, b) =>
      b.styleScore - a.styleScore ||
      (profile.id === 'super_ultra_aggressive' ? (b.analysis.attackSubTotal - a.analysis.attackSubTotal) : 0) ||
      b.utility - a.utility);
    // Stable, tightly controlled variety for Chaos Attack only. It never applies
    // to mate lines and only considers a near-tied second attacking candidate.
    // Variety is an equal-position luxury (G1): the swap is additionally
    // gated on the objective evaluation, so a winning position never trades
    // its top pick for a near-tie. Level I's diversity rate is already 0.
    if (profile.diversity > 0 && !bestIsWinningMate && eligible.length > 1 &&
        objectiveBest.score <= 100 &&
        eligible[0].styleScore - eligible[1].styleScore <= Math.max(2, Math.round(18 * ULTRA_BONUS_SCALE)) &&
        stableFenFraction(fen, profile.id) < profile.diversity) {
      [eligible[0], eligible[1]] = [eligible[1], eligible[0]];
    }

    const ineligible = candidates.filter(candidate => !eligible.includes(candidate))
      .sort((a, b) => b.utility - a.utility);
    return [...eligible, ...ineligible].map((candidate, styleRank) => ({
      ...candidate.pv,
      _styleAnalysis: {
        ...candidate.analysis,
        styleRank: styleRank + 1,
        styleBonus: Number.isFinite(candidate.bonus) ? Math.round(candidate.bonus) : 0,
        riskBudget: budget,
        eligible: candidate.eligible,
        localPool: candidate.pv.localPool === true,
        poolBenched: candidate.analysis.poolBenched === true,
        attackCandidate: candidate.analysis.attackCandidate === true
      }
    }));
  }

  // ─── Style-Aware Move Annotation ───────────────────────────────────
  // Enhanced with pawn storm, exchange sacrifice, outpost, prophylactic annotations.
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
    // Chaos-only flavor tags. The full tag set (grafted Berserker-vocabulary,
    // kill-geometry, mating-square math, opening traps, second-move vision, and
    // tactical toolkit) lives in engine/chaos-attack.js (annotate), so future
    // Chaos enhancements never touch this engine again.
    if (profile.id === 'super_ultra_aggressive') {
      const chaosA = getChaosEngine();
      if (chaosA) {
        annotations.push(...chaosA.annotate(analysis));
      } else {
        annotations.push('ultra-aggressive attack');
        annotations.push('attacking');
      }
      const earlyA = getEarlyKingHuntEngine();
      if (analysis.earlyKingHuntActive && earlyA) annotations.push(...earlyA.annotate(analysis));
    }
    return [...new Set(annotations)];
  }

  // ─── Generate Hints (Main Entry) ───────────────────────────────────
  function generateHints(analysisData, _legacyHintLevel, playerColor, style, _legacyRepertoire, context = {}) {
    const hintLevel = EXACT_HINT_LEVEL;
    const { fen, pvs, bestMove, source, tablebaseData, openingData } = analysisData;
    const position = assessPosition(fen);
    const isWhite = playerColor === 'w';
    const currentStyle = applyAggressionLevel(resolveStyleProfile(style), context.aggressionLevel);
    const earlyKingHuntEnabled = earlyKingHuntRequested(currentStyle.id, context.earlyKingHuntEnabled);

    // Apply the rebuilt, mate-safe style ranking. Normal also receives objective
    // metadata, while one-PV sources remain unchanged and are explained honestly.
    let rankedPVs = pvs?.[0]?._styleAnalysis
      ? pvs
      : (pvs && pvs.length > 1 ? selectPVForStyle(pvs, fen, style, playerColor, {
        ...context,
        earlyKingHuntEnabled,
        openingData
      }) : (pvs || []));
    if (earlyKingHuntEnabled && rankedPVs.length === 1 && !rankedPVs[0]._styleAnalysis) {
      const only = rankedPVs[0];
      const score = playerScore(only, playerColor);
      const meta = analyzeCandidate(
        fen, only.pv || [], playerColor, score, only.scoreType, only.depth || 0,
        { style: currentStyle.id, earlyKingHuntEnabled }
      );
      meta.evalLoss = 0;
      meta.objectiveRank = 1;
      meta.styleRank = 1;
      meta.mode = currentStyle.id;
      meta.limitedCandidates = true;
      candidateStyleBonus(meta, currentStyle, { conversion: only.scoreType !== 'mate' && score > 200 });
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
      levelName: EXACT_HINT_LEVEL_NAME,
      main: '',
      captions: [],
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
      selectionMode: 'standard',
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
        const isPieceWhite = piece && piece === piece.toUpperCase();
        const sideLabel = isPieceWhite ? 'White' : 'Black';
        hints.bestMoveFromTo = `${sideLabel}: ${pieceName}: ${from} \u2192 ${to}`;
      }
      hints.winningPlan = generateTablebasePlan(tablebaseData, playerColor);
      return hints;
    }

    // Exact-move-only primary hint. The hero shows the move itself; every
    // supporting sentence travels separately in `hints.captions` so the UI
    // can render a dedicated caption rail outside the hero.
    const moveHint = generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle, null, analysisData.moveHistory);
    hints.main = moveHint.text;
    hints.captions.push(...moveHint.captions);

    // Explain why the selected move fits the requested mode as caption
    // items. This keeps lower hint levels educational and gives exact/deep
    // hints concrete compensation — without crowding the hero move.
    if (bestPV?._styleAnalysis) {
      const meta = bestPV._styleAnalysis;
      hints.styleAnalysis = meta;
      if (meta.mode === 'book') {
        hints.captions.push({
          kind: 'book', label: 'Opening book',
          text: `${(meta.reasons || ['book move'])[0]} — theory, not an engine evaluation.`
        });
      } else if (currentStyle.id !== 'normal') {
        const reasons = (meta.reasons || []).slice(0, 3);
        const risks = (meta.risks || []).slice(0, 2);
        if (reasons.length) {
          const ideaLabel = 'Maximum-pressure idea';
          hints.captions.push({ kind: 'idea', label: ideaLabel, text: `${reasons.join(', ')}.` });
        }
        if (hintLevel === EXACT_HINT_LEVEL && Number.isFinite(meta.evalLoss) && meta.evalLoss > 0) {
          hints.captions.push({ kind: 'cost', label: 'Objective cost', text: `${(meta.evalLoss / 100).toFixed(1)} pawn${meta.evalLoss === 100 ? '' : 's'} versus the strongest continuation` });
        }
        if (hintLevel === EXACT_HINT_LEVEL && risks.length) {
          hints.captions.push({ kind: 'risk', label: 'Risk', text: `${risks.join(', ')}.` });
        }
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
      const isPieceWhite = piece && piece === piece.toUpperCase();
      const sideLabel = isPieceWhite ? 'White' : 'Black';
      hints.bestMoveFromTo = `${sideLabel}: ${pieceName}: ${from} \u2192 ${to}`;
    }

    // Threat / best-reply caption — lives on the "Why this move" rail, not the hero.
    if (rankedPVs && rankedPVs.length > 0) {
      const reply = generateThreatHint(rankedPVs[0], position, playerColor, fen || '');
      hints.threat = reply.text;
      hints.threatLabel = reply.label;
      if (reply.text) hints.captions.push({ kind: 'reply', label: reply.label, text: reply.text });
    }

    // Continuation
    if (bestPV && bestPV.pv) {
    }

    // Move classification — from the mover's perspective (the side that
    // played the last move is the opposite of the current side to move).
    if (analysisData.prevEval !== undefined && analysisData.currEval !== undefined) {
      const activeColor = (fen && typeof fen === 'string') ? (fen.split(' ')[1] || 'w') : 'w';
      hints.moveClassification = classifyMove(analysisData.prevEval, analysisData.currEval, {
        moverColor: activeColor === 'w' ? 'b' : 'w',
        scoreTypeBefore: analysisData.prevScoreType || 'cp',
        scoreTypeAfter: analysisData.currScoreType || 'cp'
      });
    }

    // Winning plan (style-aware)
    hints.winningPlan = generateWinningPlan(evalScore, scoreType, position, playerColor, fen || '', style, earlyKingHuntEnabled);

    // Style annotation for exact-move hints
    if (hintLevel === EXACT_HINT_LEVEL && bestPV && bestPV.pv && bestPV.pv.length > 0 && fen) {
      const annotations = annotateMoveForStyle(bestPV.pv[0], fen, style, evalScore, bestPV._styleAnalysis);
      if (annotations.length > 0) hints.styleAnnotation = annotations.join(', ');
    }

    // Depth-aware hint quality indicator
    if (bestPV && bestPV.depth >= 40) {
      hints.depthQuality = 'deep';
    } else if (bestPV && bestPV.depth >= 20) {
      hints.depthQuality = 'standard';
    } else if (bestPV) {
      hints.depthQuality = 'basic';
    }

    // Candidate-pool transparency: tell the user when style ranking ran on a
    // locally widened pool, or had to be paused because only one line exists.
    if (analysisData.poolExpanded) {
      hints.captions.push({
        kind: 'context', label: 'Candidate pool',
        text: 'One cloud line — widened with fast local analysis so style ranking stays active (extra lines are lower confidence).'
      });
    } else if (hints.styleAnalysis?.limitedCandidates && currentStyle.id !== 'normal') {
      hints.captions.push({
        kind: 'context', label: 'Candidate pool',
        text: 'Only a single analysis line is available — style ranking is paused for this move.'
      });
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
  // Returns structured output: `text` is the hero line (the move itself,
  // nothing else) and `captions` is an ordered list of supporting detail
  // items ({ kind, label, text }) that the UI renders in its own caption
  // rail outside the hero. The user already chose the style in settings, so
  // the hero leads with the move — never with a style-name label.
  function generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen, style, repertoire, moveHistory) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) return { text: 'Analysis in progress...', captions: [] };
    if (!fen) return { text: 'Waiting for position...', captions: [] };

    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const captured = getPieceAt(board, to);
    const san = uciToSan(uci, fen);
    const isWhite = playerColor === 'w';
    // Use ACTUAL piece color from the board, not assumed ownership.
    // A piece on e7 with lowercase letter is Black's piece regardless of
    // which side the user is assisting.
    const currentStyle = style || PLAYING_STYLES.normal;

    // uciToSan already includes the promotion suffix.
    const captions = [];
    let hint = san;

    if (scoreType === 'mate') {
      hint += ` \u2014 MATE IN ${Math.abs(evalScore)}`;
    }

    if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isOppPiece = isWhite ? (captured === captured.toLowerCase()) : (captured === captured.toUpperCase());
      // Sacrifice annotation comes from PV-validated material loss.
      if (isOppPiece) {
        if (bestPV._styleAnalysis?.sacrifice) {
          const soundness = bestPV._styleAnalysis.sacrificeSoundness === 'sound' ? 'Sound' : (bestPV._styleAnalysis.sacrificeSoundness === 'speculative' ? 'Speculative' : 'Unsound');
          captions.push({ kind: 'sacrifice', label: `${soundness} sacrifice`, text: `Gives material to take the opponent's ${capturedName}` });
        } else {
          captions.push({ kind: 'capture', label: 'Capture', text: `Takes the opponent's ${capturedName}` });
        }
      } else {
        captions.push({ kind: 'capture', label: 'Capture', text: `Takes the ${capturedName}` });
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
        if (distToKing <= 2) {
          captions.push({ kind: 'kinghunt', label: 'King hunt', text: 'Lands within striking distance of the enemy king' });
        }
      }
    }

    return { text: hint, captions };
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
      const captured = getPieceAt(boardAfterOppMove, to);
      const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
      const fenAfterOppMove = applyMoveToFen(fen, oppMoveUci);
      const responseSan = uciToSan(responseUci, fenAfterOppMove);
      // Determine the actual side of the response piece
      const isRespWhitePiece = piece && piece === piece.toUpperCase();
      const respPieceLabel = isRespWhitePiece ? 'White' : 'Black';
      // Compact primary hint: the move itself. Any capture detail rides in
      // the caption rail instead of crowding the hero line.
      responseHint = responseSan;
      if (captured) {
        const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
        const isOppPiece = isRespWhitePiece ? (captured === captured.toLowerCase()) : (captured === captured.toUpperCase());
        hints.captions.push({
          kind: 'capture',
          label: 'Capture',
          text: isOppPiece ? `Takes the opponent's ${capturedName}` : `Takes the ${capturedName}`
        });
      }
      responseFromToHint = `${respPieceLabel}: ${pieceName}: ${from} \u2192 ${to}`;
    }

    // Build main hint — PLAYER-FIRST design:
    // Always lead with the player's best response, compact and clean.
    // Opponent's expected move is contextual/secondary (Why this move rail).
    const postureText = evalScore > 100 ? "You're clearly better"
      : evalScore > 0 ? 'Slight advantage for you'
      : evalScore < -100 ? 'Be careful — the opponent is pressing'
      : evalScore < 0 ? 'Slight disadvantage'
      : 'Equal position';
    let mainHint = '';
    if (responseUci) {
      // PRIMARY: the player's best response — the hero shows the move itself.
      mainHint = responseHint;
      hints.captions.push({ kind: 'posture', label: 'Balance of the game', text: postureText });
    } else if (oppMoveUci) {
      // No response PV line available — still show player-focused message
      mainHint = `Waiting for ${oppColor}'s move. Expect: ${oppMoveHint}`;
      if (evalScore !== 0) hints.captions.push({ kind: 'posture', label: 'Balance of the game', text: postureText });
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

    // Expected line — opponent's move + the player's reply, as a caption rail item.
    if (oppMoveUci) {
      const reply = generateOpponentThreatHint(oppMoveUci, responseUci, position, playerColor, fen);
      hints.threat = reply.text;
      hints.threatLabel = reply.label;
      if (reply.text) hints.captions.push({ kind: 'reply', label: reply.label, text: reply.text });
    }

    // Continuation
    if (bestPV.pv) {
    }
  }

  // ─── Opponent Threat Hint (Player-First) ──────────────────────────
  function generateOpponentThreatHint(oppMoveUci, responseUci, position, playerColor, fen) {
    if (!fen || !oppMoveUci) return { label: 'Expected line', text: '' };
    const board = parseFENPlacement(fen.split(' ')[0]);
    const isWhite = playerColor === 'w';

    const from = oppMoveUci.substring(0, 2);
    const to = oppMoveUci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
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
      const isRWhite = rPiece && rPiece === rPiece.toUpperCase();
      const rSideLabel = isRWhite ? 'White' : 'Black';
      threat += `. ${rSideLabel}'s best reply: ${rPieceName} ${rFrom} \u2192 ${rTo}`;
    }

    return { label: 'Expected line', text: threat };
  }

  // ─── Threat Hint (Player's turn) ──────────────────────────────────
  function generateThreatHint(bestPV, position, playerColor, fen) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length < 2) return { label: 'Best reply', text: '' };
    if (!fen) return { label: 'Best reply', text: '' };

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
    if (!oppMoveUci) return { label: 'Best reply', text: '' };

    const boardAfterPlayerMove = playerMoveUci ? applyMoveToBoard(board, playerMoveUci) : board;
    const fenAfterPlayerMove = playerMoveUci ? applyMoveToFen(fen, playerMoveUci) : fen;

    const from = oppMoveUci.substring(0, 2);
    const to = oppMoveUci.substring(2, 4);
    const piece = getPieceAt(boardAfterPlayerMove, from);
    const captured = getPieceAt(boardAfterPlayerMove, to);
    const san = uciToSan(oppMoveUci, fenAfterPlayerMove);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';

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

    return { label: 'Best reply', text: threat };
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

  // ─── Public API ────────────────────────────────────────────────────
  window.ChessHintEngine = {
    generateHints,
    classifyMove,
    assessPosition,
    detectOpening,
    ensureEcoLoaded,
    detectGamePhase,
    describeEval,
    formatEvalBar,
    formatPVs,
    formatMove,
    uciToSan,
    detectCriticalMoment,
    selectPVForStyle,
    selectEngineLane,
    analyzeCandidate,
    // Exposed so the Phase 0 harness and the vocabulary regression suite can
    // assert on the exact reasons a candidate is credited with.
    candidateStyleBonus,
    PLAYING_STYLES,
    AGGRESSION_LEVELS,
    resolveAggressionLevel,
    applyAggressionLevel,
    resolveStyleProfile,
    bookFirstAllowed,
    promoteBookWithinTolerance,
    BOOK_FIRST_TOLERANCE_CP,
    styleSafetyAllows,
    EXACT_HINT_LEVEL,
    // Exposed for deterministic regression tests and progressive-PV consumers.
    applyMoveToFen,
    applyMoveToBoard
  };

})();
