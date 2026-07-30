/**
 * Chess Hint Assistant — Max-Strength Hint Engine v8.5.0
 *
 * 5-level hint system: L1 (Positional Coach) through L5 (Exact Move)
 * Cloud-only analysis — no local Stockfish.
 *
 * v8.5.0 — Bug-fix & Enhancement Release:
 *  - FIX: uciToSan now appends '+' (check) / '#' (checkmate) suffixes
 *         per SAN standard (previously produced "Qh5" instead of "Qh5+")
 *  - FIX: Cached assessKingSafety() result inside scoreMoveForStyle()
 *         — was called 4× per scored move (hot-path cost for Berserker)
 *  - FIX: sacrificeHistory exposed via resetSacrificeHistory() so the
 *         side panel can clear it on new-game detection
 *  - ENH (D): New formatScorePlayerPerspective() helper for "+1.5 (you)"
 *             style eval displays, regardless of assisted player's colour
 *  - ENH (J): ECO database loaded asynchronously from engine/eco.json
 *             (425 entries vs the previous ~46 inline); inline fallback
 *             retained for resilience
 *  - Removed dead code: PIECE_UNICODE constant, getPieceOwnerLabel(),
 *         validateMoveSide()
 *
 * v7.3.0 — Berserker Style (preserved):
 *  - NEW STYLE: "Berserker" — Above Kamikaze! Inspired by Patricia engine
 *    (most aggressive engine ever, EAS score 750K), AlphaZero's positional
 *    sacrifice style, and CSTal's speculative evaluation. Plays NOTHING like
 *    Stockfish — pure berserker rage on the board!
 *  - Berserker-exclusive scoring mechanics (9 NEW — beyond Kamikaze's 5):
 *    - Attack Unit System: Stockfish-inspired S-curve (N/B=2, R=3, Q=5 units)
 *    - Practical Chances: Score moves creating maximum opponent difficulty
 *    - Complexity Amplifier: Boost moves increasing position complexity
 *    - Greek Gift Detection: Bxh7+/Bxh2+ sacrifice pattern detection
 *    - Draw Contempt: Penalize drawish positions, avoid draws at all costs
 *    - Sacrifice Cascade: Bonus for consecutive sacrifices (Tal-style chains)
 *    - Tempo Bonus: Reward development WITH threats, forcing sequences
 *    - Overload Exploitation: Exploit overloaded defending pieces
 *    - Phase-Aware Scaling: Different aggression profiles per game phase
 *  - Berserker-specific parameters:
 *    - sacrificeTolerance 400cp (4.0 pawns!) — can sacrifice queen+pawn
 *    - evalWeight 0.20 — almost ignore engine eval
 *    - defenseWeight 0.02 — literally zero defense
 *    - kingZonePressure 5.5x — overwhelming king danger amplification
 *    - Bonus cap 6x sacrificeTolerance = 2400cp for truly berserker moves
 *    - Synergy detection: exponential multiplier for stacked bonuses
 *    - Two-phase re-ranking: pure aggression score within eval tolerance
 *  - Berserker-specific winning plans ("ANNIHILATE!", "BERSERKER RAGE!")
 *  - New annotations: "berserker", "greek gift", "cascade sac", "overload"
 *  - Anti-simplification bias: penalizes equal trades, rewards complications
 *
 * v7.1.0 — Kamikaze Style + Turn-Based Analysis:
 *  - NEW STYLE: "Kamikaze" — ALL-IN ATTACK! Sacrifice everything for checkmate.
 *    No defense, no mercy — pure destruction. Pieces are expendable, the king must die!
 *  - Kamikaze-exclusive scoring mechanics:
 *    - Queen sacrifice detection: massive bonus for sacrificing the queen for attack
 *    - Mate seeker: bonus for moves leading toward checkmate patterns
 *    - Initiative bonus: bonus for moves that create forcing threats
 *    - Back rank threat: bonus for moves creating back rank mate patterns
 *    - Piece sacrifice near king: bonus for sacrificing ANY piece near opponent's king
 *    - Knight fork detection near king: bonus for double-attacks/forks
 *    - Smothered mate pattern detection: bonus for cornered-king knight checks
 *  - sacrificeTolerance 250cp (2.5 pawns!) — will sacrifice even the queen
 *  - kingZonePressure 3.5x — overwhelming king danger amplification
 *  - No stealth/anti-detection — this style OWNS its aggression
 *  - Higher bonus cap (4x sacrificeTolerance) for truly wild sacrifices
 *  - Kamikaze-specific winning plans ("OBLITERATE!", "ALL-IN ATTACK!")
 *  - New annotations: "queen sac", "mate attack", "kamikaze"
 *
 * v6.2.0 — Ultra Aggressive Stealth Style (backported from v7.0.0):
 *  - NEW STYLE: "Ultra Aggressive Stealth" — Tal/Kasparov-inspired attacks
 *    with anti-detection diversification to avoid engine fingerprinting
 *  - Anti-detection: weighted random selection from top 2-3 moves
 *  - Anti-detection: evaluation noise injection (+/-5-10cp) on display
 *  - Anti-detection: position-criticality aware move selection
 *    (more randomness in equal positions, less in critical ones)
 *  - Anti-detection: "humanized" move selection that avoids always
 *    playing the #1 engine move
 *  - Enhanced aggressive scoring: pawn storm detection, exchange sacrifice
 *    patterns, prophylactic moves, king zone pressure amplification
 *  - King safety amplification: opponent's king danger penalty x1.8
 *  - Piece activity bonuses: outpost knights, open-diagonal bishops,
 *    7th-rank rooks get extra weight in ultra-aggressive mode
 *  - Opening line-pushing: prefer moves that open files toward
 *    opponent's castled king
 *
 * v6.1.0 — Coach Mode & Fair Play:
 *  - Added L1 (Positional Coach), L2 (Area Hint), L3 (Direction Hint) levels
 *  - L1-L3 reduce engine correlation by not revealing specific moves
 *  - Added fairPlayWarning field for L4 and L5 hints
 *  - Coach Mode: limits L5 hints per game to prevent correlation
 *  - Default hint level changed from 5 to 3
 *  - Enhanced candidate move evaluation with up to 5 PV lines (was 3)
 *  - Depth-aware hint quality indicators in annotations
 *  - Multi-source annotations: show which sources agree on best move
 *  - v7.0.0: Removed ChessDB.cn references
 *  - Better "from-to" square descriptions with source confidence
 *
 * v5.4.0 — Player-First Hint Design:
 *  - Hints ALWAYS prioritize the assisted player's best move as the primary hint
 *  - When playing as Black, hints show Black's best moves first (not White's expectations)
 *  - Opponent's expected move shown as secondary context ("If opponent plays...")
 *  - Candidate moves redesigned: when opponent's turn, show player's best responses
 *  - bestMoveFromTo always shows the assisted player's piece move
 *  - Fixed all cases where opponent's move was shown as primary when it shouldn't be
 *
 * v5.3.0 enhancements:
 *  - Fixed Black-side score normalization: Stockfish.online and Chess-API mate scores
 *    are now correctly converted from side-to-move perspective to White's perspective
 *  - Fixed Lichess active color detection when board is flipped (playing as Black)
 *  - Fixed move classification for Black players (prevEval/currEval perspective mismatch)
 *  - Enhanced Chess.com active color fallback (checks move list when clocks aren't active)
 *  - All scores are now guaranteed to be from White's perspective (positive = White winning)
 *
 * v5.2.0 enhancements:
 *  - Cloud-only mode: no local engine dependency
 *  - Three cloud API sources: Lichess Cloud Eval, Chess-API.com, Stockfish.online
 *  - Playing styles: Normal, Aggressive Attacking, Super Aggressive Attacking
 *  - Style-aware move ranking (styles actually change which move is recommended)
 *  - Aggressive styles boost attacking moves, sacrifice detection, king hunt moves
 *  - Super Aggressive prioritizes direct attacks, sacrifices, and forcing sequences
 *  - Side-specific hints: Black player gets Black-piece hints, White gets White-piece hints
 *  - Cloud API response normalization (Lichess Cloud Eval, Chess-API, Stockfish.online, Tablebase)
 *  - Opening Explorer data integration (win rates, master games)
 *  - Tablebase perfect play integration
 *  - From-to square notation ("e2 to e4") with side-aware labels
 *  - Opening repertoire recommendations
 *  - Winning plan generation
 *  - Enhanced refresh: clears cache + circuit breakers for forced re-analysis
 */

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────
  const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  // v8.5.0: Removed unused PIECE_UNICODE constant.

  // ─── Hint Levels (5 levels) ────────────────────────────────────────
  const HINT_LEVELS = {
    1: { name: 'Positional Coach', desc: 'Position assessment and plan only — no move hints' },
    2: { name: 'Area Hint', desc: 'Which area of the board and which piece type to focus on' },
    3: { name: 'Direction Hint', desc: 'Which piece to move and general direction — no exact squares' },
    4: { name: 'Deep Line', desc: 'Explains multi-move idea with piece names and direction' },
    5: { name: 'Exact Move', desc: 'Shows exact move with from-to squares, style, and plan' }
  };

  // ─── Playing Styles (v7.3 — 6 styles, incl. Berserker from v7.3) ──
  const PLAYING_STYLES = {
    normal: {
      name: 'Normal',
      desc: 'Best overall move — balanced between attack and defense',
      evalWeight: 1.0,
      attackBonus: 0,
      defenseWeight: 1.0,
      sacrificeTolerance: 0,     // How much eval to sacrifice for an attack (in cp)
      kingHuntBonus: 0,         // Bonus for moves approaching opponent's king
      forcingBonus: 0,          // Bonus for checks and captures
      pawnStormBonus: 0,        // Bonus for pawn pushes toward opponent king
      exchangeSacrificeBonus: 0,// Bonus for R-for-minor sacrifices
      prophylacticBonus: 0,     // Bonus for moves that restrict opponent
      kingZonePressure: 0,      // Amplification of opponent king danger
      outpostBonus: 0,          // Bonus for knight/bishop on outposts
      // Anti-detection settings
      antiDetect: false,        // Whether anti-detection is active
      moveDiversity: 0,         // Probability of picking 2nd/3rd best move (0.0-1.0)
      evalNoise: 0,             // Max evaluation noise to inject (cp)
      sourceRotation: false,    // Whether to rotate API sources
      // v7.1 Kamikaze-specific (zero for non-kamikaze styles)
      queenSacrificeBonus: 0,
      mateSeekerBonus: 0,
      initiativeBonus: 0,
      backRankThreatBonus: 0,
      pieceSacNearKingBonus: 0,
      // v7.3 Berserker-exclusive (zero for non-berserker styles)
      attackUnitBonus: 0,
      practicalChancesBonus: 0,
      complexityBonus: 0,
      greekGiftBonus: 0,
      drawContempt: 0,
      sacrificeCascadeBonus: 0,
      tempoBonus: 0,
      overloadExploitBonus: 0,
      phaseAggressionScale: 0
    },
    aggressive: {
      name: 'Aggressive Attacking',
      desc: 'Prefers attacking moves, sacrifices, and king hunts — plays for initiative',
      evalWeight: 0.88,
      attackBonus: 35,
      defenseWeight: 0.7,
      sacrificeTolerance: 40,    // Will sacrifice up to 0.4 pawns for attack
      kingHuntBonus: 25,        // Bonus for moves approaching opponent's king
      forcingBonus: 15,         // Bonus for checks and captures
      pawnStormBonus: 0,
      exchangeSacrificeBonus: 0,
      prophylacticBonus: 0,
      kingZonePressure: 0,
      outpostBonus: 0,
      antiDetect: false,
      moveDiversity: 0,
      evalNoise: 0,
      sourceRotation: false,
      queenSacrificeBonus: 0,
      mateSeekerBonus: 0,
      initiativeBonus: 0,
      backRankThreatBonus: 0,
      pieceSacNearKingBonus: 0,
      attackUnitBonus: 0,
      practicalChancesBonus: 0,
      complexityBonus: 0,
      greekGiftBonus: 0,
      drawContempt: 0,
      sacrificeCascadeBonus: 0,
      tempoBonus: 0,
      overloadExploitBonus: 0,
      phaseAggressionScale: 0
    },
    super_aggressive: {
      name: 'Super Aggressive',
      desc: 'Maximum aggression — sacrifices, direct attacks, forcing sequences. High risk, high reward!',
      evalWeight: 0.75,
      attackBonus: 60,
      defenseWeight: 0.5,
      sacrificeTolerance: 80,    // Will sacrifice up to 0.8 pawns for attack
      kingHuntBonus: 45,        // Big bonus for moves approaching opponent's king
      forcingBonus: 30,         // Big bonus for checks and captures
      pawnStormBonus: 0,
      exchangeSacrificeBonus: 0,
      prophylacticBonus: 0,
      kingZonePressure: 0,
      outpostBonus: 0,
      antiDetect: false,
      moveDiversity: 0,
      evalNoise: 0,
      sourceRotation: false,
      queenSacrificeBonus: 0,
      mateSeekerBonus: 0,
      initiativeBonus: 0,
      backRankThreatBonus: 0,
      pieceSacNearKingBonus: 0,
      attackUnitBonus: 0,
      practicalChancesBonus: 0,
      complexityBonus: 0,
      greekGiftBonus: 0,
      drawContempt: 0,
      sacrificeCascadeBonus: 0,
      tempoBonus: 0,
      overloadExploitBonus: 0,
      phaseAggressionScale: 0
    },
    ultra_aggressive_stealth: {
      name: 'Ultra Aggressive Stealth',
      desc: 'Fierce Tal/Kasparov-style attacks with anti-detection diversification. Different moves from standard Stockfish, still devastating!',
      evalWeight: 0.60,         // Significantly reduce eval weight — allow bigger sacrifices
      attackBonus: 90,          // Massive attack bonus
      defenseWeight: 0.35,      // Almost ignore defense
      sacrificeTolerance: 130,  // Will sacrifice up to 1.3 pawns for attack
      kingHuntBonus: 65,        // Huge bonus for moves approaching opponent's king
      forcingBonus: 45,         // Very big bonus for checks and captures
      pawnStormBonus: 35,       // Strong bonus for pawn pushes toward opponent king
      exchangeSacrificeBonus: 25,// Strong bonus for R-for-minor sacrifices (Rxc3!)
      prophylacticBonus: 15,    // Bonus for moves that restrict opponent's plans
      kingZonePressure: 1.8,    // Multiply opponent's king danger by 1.8x
      outpostBonus: 20,         // Strong bonus for knight/bishop on outposts
      // Anti-detection: makes move choices look more human and less "Stockfish"
      antiDetect: true,
      moveDiversity: 0.25,      // 25% chance of picking 2nd/3rd best move in non-critical positions
      evalNoise: 8,             // Add +/-8cp noise to displayed evaluation
      sourceRotation: true,     // Rotate between API sources for diversity
      // Kamikaze-specific (not used by ultra aggressive)
      queenSacrificeBonus: 0,
      mateSeekerBonus: 0,
      initiativeBonus: 0,
      backRankThreatBonus: 0,
      pieceSacNearKingBonus: 0,
      // Berserker-specific (not used by ultra aggressive)
      attackUnitBonus: 0,
      practicalChancesBonus: 0,
      complexityBonus: 0,
      greekGiftBonus: 0,
      drawContempt: 0,
      sacrificeCascadeBonus: 0,
      tempoBonus: 0,
      overloadExploitBonus: 0,
      phaseAggressionScale: 0
    },
    kamikaze: {
      name: 'Kamikaze',
      desc: 'ALL-IN ATTACK! Sacrifice everything for checkmate. No defense, no mercy — pure destruction. Pieces are expendable, the king must die!',
      evalWeight: 0.38,          // Extremely low — sacrifice is always on the table
      attackBonus: 150,          // Insane attack bonus — always attack
      defenseWeight: 0.08,       // Defense is a four-letter word — almost zero
      sacrificeTolerance: 250,   // Will sacrifice up to 2.5 pawns for an attack!
      kingHuntBonus: 110,        // If the king is nearby, GO THERE
      forcingBonus: 80,          // Checks and captures are king
      pawnStormBonus: 65,        // Pawn storms are devastating — use them
      exchangeSacrificeBonus: 55,// Exchange sacs near king? YES.
      prophylacticBonus: 3,      // Almost zero — attack, don't prevent
      kingZonePressure: 3.5,     // MASSIVE — 3.5x king zone pressure amplification
      outpostBonus: 35,          // Strong outpost bonus for attacking pieces
      // No stealth — this is pure, open aggression
      antiDetect: false,         // No hiding — this style OWNS its aggression
      moveDiversity: 0,          // Always pick the most aggressive move
      evalNoise: 0,              // No noise — pure calculated destruction
      sourceRotation: false,     // No rotation — focus on attack
      // Kamikaze-exclusive parameters — these go BEYOND ultra aggressive
      queenSacrificeBonus: 70,   // Sacrificing the queen for attack? MASSIVE BONUS
      mateSeekerBonus: 60,       // Bonus for moves leading toward mate patterns
      initiativeBonus: 40,       // Bonus for moves that seize initiative (checks, threats)
      backRankThreatBonus: 35,   // Bonus for moves creating back rank mate threats
      pieceSacNearKingBonus: 50, // Bonus for sacrificing ANY piece near opponent's king
      // Berserker-specific (not used by kamikaze)
      attackUnitBonus: 0,
      practicalChancesBonus: 0,
      complexityBonus: 0,
      greekGiftBonus: 0,
      drawContempt: 0,
      sacrificeCascadeBonus: 0,
      tempoBonus: 0,
      overloadExploitBonus: 0,
      phaseAggressionScale: 0
    },
    berserker: {
      name: 'Berserker',
      desc: 'Maximum destruction! Inspired by Patricia & AlphaZero — sacrifices pieces for chaos, seeks mate through overwhelming attack. Plays NOTHING like Stockfish — pure berserker rage on the board!',
      evalWeight: 0.20,          // Almost ignore engine eval — aggression is king
      attackBonus: 220,          // UNPRECEDENTED — always attack, no exceptions
      defenseWeight: 0.02,       // Literally zero — defense is surrender
      sacrificeTolerance: 400,   // Will sacrifice up to 4.0 pawns — queen+pawn is on the table
      kingHuntBonus: 160,        // If you can see the king, CHARGE
      forcingBonus: 120,         // Checks and captures are the only moves worth playing
      pawnStormBonus: 95,        // Pawn storms are weapons of mass destruction
      exchangeSacrificeBonus: 85,// Exchange sacs near king — ALWAYS YES
      prophylacticBonus: 0,      // ZERO — prophylaxis is for cowards
      kingZonePressure: 5.5,     // ASTRONOMICAL — 5.5x king zone pressure
      outpostBonus: 50,          // Outposts are attack launch pads
      // No stealth, no hiding — pure berserker rage
      antiDetect: false,
      moveDiversity: 0,          // Always pick the most berserker move
      evalNoise: 0,              // No noise — pure calculated rage
      sourceRotation: false,     // No rotation — focused destruction
      // Kamikaze-level parameters (INCREASED from Kamikaze)
      queenSacrificeBonus: 120,  // Queen sacrifice near king? ABSOLUTE MAXIMUM
      mateSeekerBonus: 100,      // Mate is the only acceptable outcome
      initiativeBonus: 75,       // Seize initiative at ALL costs
      backRankThreatBonus: 65,   // Back rank mate threats are premium targets
      pieceSacNearKingBonus: 90, // ANY piece sacrifice near king is rewarded
      // ═══════════════════════════════════════════════════════════════
      // v7.3: BERSERKER-EXCLUSIVE PARAMETERS — goes beyond Kamikaze
      // These make Berserker play FUNDAMENTALLY differently from both
      // Stockfish AND Kamikaze. Inspired by Patricia engine (EAS 750K),
      // AlphaZero's positional sacrifices, and CSTal's speculative eval.
      // ═══════════════════════════════════════════════════════════════
      attackUnitBonus: 80,       // Stockfish-inspired S-curve attack unit system
      practicalChancesBonus: 55, // Score moves that create max opponent difficulty
      complexityBonus: 45,       // Boost moves increasing position complexity
      greekGiftBonus: 100,       // Detect Bxh7+/Bxh2+ sacrifice patterns
      drawContempt: 50,          // Penalize draws — BERSERKER NEVER DRAWS
      sacrificeCascadeBonus: 70, // Bonus for consecutive sacrifices (Tal-style)
      tempoBonus: 40,            // Reward development WITH threats
      overloadExploitBonus: 60,  // Exploit overloaded defending pieces
      phaseAggressionScale: 1.5  // Phase-aware aggression scaling multiplier
    }
  };

  // ─── Opening Repertoires ───────────────────────────────────────────
  const OPENING_REPERTOIRES = {
    none: { name: 'No Preference', desc: 'Engine picks the best move regardless of opening theory' },
    e4_player: { name: '1.e4 Player', desc: 'Favors e4 openings: Italian, Ruy Lopez, Sicilian defenses as Black', preferredFirstMove: 'e2e4' },
    d4_player: { name: '1.d4 Player', desc: 'Favors d4 openings: QGD, Nimzo, King\'s Indian as Black', preferredFirstMove: 'd2d4' },
    c4_player: { name: '1.c4 / English', desc: 'Favors English/Reti flank approaches', preferredFirstMove: 'c2c4' },
  };

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

    // Castling
    if (pieceType === 'k') {
      if (from === 'e1' && to === 'g1') return 'O-O';
      if (from === 'e1' && to === 'c1') return 'O-O-O';
      if (from === 'e8' && to === 'g8') return 'O-O';
      if (from === 'e8' && to === 'c8') return 'O-O-O';
    }

    let san = '';
    if (pieceType !== 'p') san += piece.toUpperCase();

    // Disambiguation
    if (pieceType !== 'p' && pieceType !== 'k') {
      const sameType = findPiecesOfType(board, piece, piece === piece.toUpperCase());
      const ambiguous = sameType.filter(sq => {
        if (sq === from) return false;
        return canPieceReachSquare(board, sq, to, pieceType, piece === piece.toUpperCase());
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
            const uci = fromSq + toSq;
            const newBoard = applyMoveToBoard(board, uci);
            const kingChar = isWhite ? 'K' : 'k';
            let kingPos = null;
            for (let kr = 0; kr < 8 && !kingPos; kr++) {
              for (let kc = 0; kc < 8 && !kingPos; kc++) {
                if (newBoard[kr][kc] === kingChar) kingPos = { row: kr, col: kc };
              }
            }
            if (!kingPos) continue;
            if (!isSquareAttacked(newBoard, kingPos, isWhite ? 'b' : 'w')) return true;
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
    let total = 0, queens = 0, rooks = 0, minors = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.toLowerCase() === 'k' || p.toLowerCase() === 'p') continue;
      total++;
      if (p.toLowerCase() === 'q') queens++;
      else if (p.toLowerCase() === 'r') rooks++;
      else if (p.toLowerCase() === 'n' || p.toLowerCase() === 'b') minors++;
    }
    if (queens === 0 && rooks <= 2 && minors <= 2) return 'endgame';
    if (total > 8 || queens >= 2) return 'opening';
    return 'middlegame';
  }

  // ─── Winning Plan Generation ───────────────────────────────────────
  function generateWinningPlan(evalScore, scoreType, position, playerColor, fen, style) {
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;

    if (scoreType === 'mate') {
      if (evalScore > 0) return `Force checkmate in ${evalScore} move${evalScore > 1 ? 's' : ''}!`;
      return `Defend against mate in ${Math.abs(evalScore)}!`;
    }

    const phase = detectGamePhase(fen);
    const plans = [];

    // Style-specific plan adjustments
    if (currentStyle.attackBonus > 200) {
      // Berserker (v7.3 — intelligent insanity, Patricia/AlphaZero inspired)
      if (evalScore > 100) plans.push('ANNIHILATE! Multiple pieces attacking — cascade sacrifices until the king falls!');
      else if (evalScore > 0) plans.push('BERSERKER RAGE! Throw pieces at the king — create chaos, exploit every weakness!');
      else if (evalScore > -150) plans.push('No retreat! Counter-attack like a berserker — the only defense is OVERWHELMING AGGRESSION!');
      else plans.push('RAGE MODE! Even losing — ATTACK! Create maximum chaos, force errors, NEVER surrender!');
    } else if (currentStyle.attackBonus > 120) {
      // Kamikaze (v7.1 — all-out attack, sacrifice everything)
      if (evalScore > 50) plans.push('OBLITERATE! Throw everything at the king — sacrifice the queen if it leads to mate!');
      else if (evalScore > -50) plans.push('ALL-IN ATTACK! Open lines, sacrifice pieces, storm the king — no retreat!');
      else if (evalScore > -200) plans.push('Counter-attack like a maniac! The only defense is TOTAL AGGRESSION — sac and attack!');
      else plans.push('Go down swinging! Throw pieces at the king — create chaos, look for mating traps!');
    } else if (currentStyle.attackBonus > 80) {
      // Ultra Aggressive Stealth (v6.2 — from v7.0)
      if (evalScore > 50) plans.push('Storm the king! Sacrifice if needed — calculate the killing blow!');
      else if (evalScore > -100) plans.push('Create maximum pressure! Open lines, push pawns, force concessions!');
      else plans.push('Counter-attack with everything! The best defense is overwhelming aggression!');
    } else if (currentStyle.attackBonus > 40) {
      // Super Aggressive
      if (evalScore > 50) plans.push('Attack! Sacrifice if needed — go for the kill!');
      else if (evalScore > -100) plans.push('Create threats! Attack the king directly — force the issue!');
      else plans.push('Counter-attack! The best defense is a fierce counter-attack!');
    } else if (currentStyle.attackBonus > 0) {
      // Aggressive
      if (evalScore > 50) plans.push('Press the attack — look for tactical combinations and king hunts');
      else if (evalScore > -100) plans.push('Find active play — attack where possible, seize the initiative');
      else plans.push('Counter-attack! Look for tactical tricks and active defense');
    } else {
      // Normal
      if (evalScore > 300) {
        if (position.material.balance !== 0) {
          const sign = (playerColor === 'w' && position.material.balance > 0) || (playerColor !== 'w' && position.material.balance < 0);
          if (sign) plans.push('Trade pieces to convert your material advantage');
        }
        plans.push(phase === 'endgame' ? 'Activate your king and push passed pawns' : 'Simplify the position — trade pieces, not pawns');
      } else if (evalScore > 100) {
        const myPassedPawns = playerColor === 'w' ? position.pawnStructure.whitePassedPawns : position.pawnStructure.blackPassedPawns;
        if (myPassedPawns > 0) plans.push('Advance your passed pawn(s) with piece support');
        const oppKingIssues = position.kingSafety.issues.filter(i => i.color !== playerColor && i.severity === 'high');
        if (oppKingIssues.length > 0) plans.push('Attack the weakened enemy king');
        if (plans.length === 0) plans.push('Increase pressure — find small improvements');
      } else if (evalScore > -100) {
        plans.push('Equal position — look for active piece play and small edges');
      } else if (evalScore > -300) {
        plans.push('Stay solid — defend carefully and look for counterplay');
      } else {
        plans.push('Defend stubbornly — look for tactical tricks and simplification');
      }
    }

    return plans[0] || 'Find the best move in this position';
  }

  // ─── Style-Aware Move Scoring ──────────────────────────────────────
  // Applies style bonuses to a candidate move's effective score.
  // This allows aggressive styles to prefer attacking moves even if
  // they're slightly worse in raw eval.

  // v7.3: Sacrifice cascade tracking state.
  // v8.5.0: Exposed a resetSacrificeHistory() so the side panel can clear
  //         it on new-game detection (previously it accumulated forever).
  const sacrificeHistory = { lastMoveWasSac: false, consecutiveSacs: 0 };
  function resetSacrificeHistory() {
    sacrificeHistory.lastMoveWasSac = false;
    sacrificeHistory.consecutiveSacs = 0;
  }

  // v7.3: Attack Unit System — Stockfish-inspired king attack quantification
  // Counts attack units targeting opponent's king zone:
  // Minor (N/B) = 2, Rook = 3, Queen = 5
  function countAttackUnits(board, isWhite, oppKingPos) {
    let units = 0;
    if (!oppKingPos) return 0;
    // King zone: 3x3 area around king + 3 squares forward toward our side
    const forward = isWhite ? 1 : -1; // forward from opponent's perspective
    const kingZone = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        kingZone.push({ row: oppKingPos.row + dr, col: oppKingPos.col + dc });
      }
    }
    // Add 3 forward squares (toward center, from opponent's POV)
    for (let dc = -1; dc <= 1; dc++) {
      kingZone.push({ row: oppKingPos.row + forward, col: oppKingPos.col + dc });
    }

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;
        const isPlayerPiece = isWhite ? (piece === piece.toUpperCase()) : (piece === piece.toLowerCase());
        if (!isPlayerPiece) continue;
        const type = piece.toLowerCase();
        if (type === 'k' || type === 'p') continue;

        // Check if this piece attacks any square in the king zone
        let attacksZone = false;
        if (type === 'n') {
          const knightJumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
          for (const [dr, dc] of knightJumps) {
            const tr = r + dr, tc = c + dc;
            if (kingZone.some(s => s.row === tr && s.col === tc)) { attacksZone = true; break; }
          }
        } else if (type === 'b') {
          for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
              if (kingZone.some(s => s.row === nr && s.col === nc)) { attacksZone = true; break; }
              if (board[nr][nc]) break;
              nr += dr; nc += dc;
            }
            if (attacksZone) break;
          }
        } else if (type === 'r') {
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
              if (kingZone.some(s => s.row === nr && s.col === nc)) { attacksZone = true; break; }
              if (board[nr][nc]) break;
              nr += dr; nc += dc;
            }
            if (attacksZone) break;
          }
        } else if (type === 'q') {
          for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
              if (kingZone.some(s => s.row === nr && s.col === nc)) { attacksZone = true; break; }
              if (board[nr][nc]) break;
              nr += dr; nc += dc;
            }
            if (attacksZone) break;
          }
        }

        if (attacksZone) {
          if (type === 'n' || type === 'b') units += 2;
          else if (type === 'r') units += 3;
          else if (type === 'q') units += 5;
        }
      }
    }
    return units;
  }

  // v7.3: Convert attack units to bonus using S-curve
  // S-curve: slow start (0-2 units = nearly worthless),
  // rapid middle (3-5 = attack building), steep (6-9 = dangerous),
  // cap (10+ = overwhelming)
  function attackUnitsToBonus(units, attackUnitBonus) {
    if (units <= 2) return 0;  // Not enough attackers
    if (units <= 5) return attackUnitBonus * 0.25 * (units - 2) / 3;
    if (units <= 9) return attackUnitBonus * 0.25 + attackUnitBonus * 0.45 * (units - 5) / 4;
    return attackUnitBonus * 0.7 + attackUnitBonus * 0.3 * Math.min((units - 9) / 4, 1);
  }

  // v7.3: Count player pieces in a zone around a position
  function countPiecesInZone(board, isWhite, centerPos, radius) {
    let count = 0;
    if (!centerPos) return 0;
    for (let r = Math.max(0, centerPos.row - radius); r <= Math.min(7, centerPos.row + radius); r++) {
      for (let c = Math.max(0, centerPos.col - radius); c <= Math.min(7, centerPos.col + radius); c++) {
        const p = board[r][c];
        if (!p) continue;
        const isPlayerPiece = isWhite ? (p === p.toUpperCase()) : (p === p.toLowerCase());
        if (isPlayerPiece && p.toLowerCase() !== 'k' && p.toLowerCase() !== 'p') count++;
      }
    }
    return count;
  }

  // v7.3: Draw contempt — penalize drawish positions
  // Berserker NEVER wants to draw. Penalize moves that lead to equal positions
  // and reward moves that push the position away from draw territory.
  function applyDrawContempt(rawScore, drawContempt) {
    if (Math.abs(rawScore) < 50) {
      // Near-equal position — apply contempt penalty to encourage risk-taking
      return -drawContempt;
    }
    if (Math.abs(rawScore) >= 50 && Math.abs(rawScore) < 200) {
      // Imbalanced position — small bonus for maintaining tension
      return drawContempt * 0.3;
    }
    return 0;
  }

  function scoreMoveForStyle(uci, fen, rawScore, scoreType, style, playerColor) {
    if (!fen || !uci) return rawScore;
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (currentStyle.attackBonus === 0 && !currentStyle.antiDetect && !currentStyle.queenSacrificeBonus && !currentStyle.attackUnitBonus) return rawScore;

    const parts = fen.split(' ');
    const board = parseFENPlacement(parts[0]);
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    if (!piece) return rawScore;

    const isWhite = playerColor === 'w';
    const pieceType = piece.toLowerCase();

    // CRITICAL: Only score moves that belong to the assisted player.
    // If the piece on the from-square belongs to the opponent, skip style scoring
    // to avoid boosting the opponent's moves or misattributing them.
    const isPieceOwnerPlayer = isWhite ? (piece === piece.toUpperCase()) : (piece === piece.toLowerCase());
    if (!isPieceOwnerPlayer) return rawScore;

    let bonus = 0;

    // v8.5.0: Cache assessKingSafety(board) — was called 4× per move
    //         (twice for oppKingPos, twice for ownKingPos) plus more in
    //         the practical-chances bonus section. For Berserker's 23
    //         scoring rules this was a significant hot-path cost.
    const kingSafety = assessKingSafety(board);
    const oppKingPos = isWhite ? kingSafety.bKingPos : kingSafety.wKingPos;
    const ownKingPos = isWhite ? kingSafety.wKingPos : kingSafety.bKingPos;

    // 1. Capture bonus — attacking pieces are preferred
    if (captured) {
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      const pieceVal = PIECE_VALUES[pieceType] || 0;
      // Sacrifice capture (giving up more valuable piece): big aggressive bonus
      if (pieceVal > capturedVal) {
        bonus += currentStyle.sacrificeTolerance * 1.5;
      }
      // Equal or winning capture: moderate bonus
      bonus += currentStyle.forcingBonus;
    }

    // 2. King hunt bonus — moving pieces toward the opponent's king
    // v8.5.0: oppKingPos/ownKingPos now cached above.
    if (oppKingPos) {
      const toCoords = squareToCoords(to);
      const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
      // The closer to the opponent's king, the bigger the bonus
      if (distToKing <= 3) {
        bonus += currentStyle.kingHuntBonus * (4 - distToKing) / 3;
      }
      // Moving queen toward king is especially aggressive
      if (pieceType === 'q' && distToKing <= 2) {
        bonus += currentStyle.kingHuntBonus * 0.5;
      }

      // v6.2: Pawn storm detection — pawns advancing toward opponent's castled king
      if (currentStyle.pawnStormBonus > 0 && pieceType === 'p') {
        const pawnFile = from.charCodeAt(0) - 97;
        const kingFile = oppKingPos.col;
        const isNearKingFile = Math.abs(pawnFile - kingFile) <= 1;
        const isKingCastled = (kingFile >= 5 && kingFile <= 7) || (kingFile >= 0 && kingFile <= 2);
        const fromRow = squareToCoords(from).row;
        const toRow = squareToCoords(to).row;
        const forward = isWhite ? -1 : 1;
        const isAdvancing = (toRow - fromRow) * forward > 0;
        if (isNearKingFile && isKingCastled && isAdvancing) {
          bonus += currentStyle.pawnStormBonus;
          const distToKingFile = Math.abs(pawnFile - kingFile);
          if (distToKingFile === 0) bonus += currentStyle.pawnStormBonus * 0.5;
        }
      }

      // v6.2: King zone pressure — moves that attack squares around opponent's king
      if (currentStyle.kingZonePressure > 0) {
        const toCoords2 = squareToCoords(to);
        const kingZoneSize = 2;
        const distToKingZone = Math.max(
          Math.abs(toCoords2.row - oppKingPos.row),
          Math.abs(toCoords2.col - oppKingPos.col)
        );
        if (distToKingZone <= kingZoneSize) {
          bonus += currentStyle.kingZonePressure * 8 * (3 - distToKingZone) / 3;
        }
      }
    }

    // 3. Central control bonus for aggressive play
    if (pieceType === 'n' || pieceType === 'b') {
      const toCoords = squareToCoords(to);
      if (toCoords.row >= 2 && toCoords.row <= 5 && toCoords.col >= 2 && toCoords.col <= 5) {
        bonus += currentStyle.attackBonus * 0.3;
      }

      // v6.2: Outpost bonus — knight on protected square in opponent's territory
      if (currentStyle.outpostBonus > 0) {
        const toCoords2 = squareToCoords(to);
        const isOpponentTerritory = isWhite
          ? (toCoords2.row <= 3)
          : (toCoords2.row >= 4);
        const ownPawn = isWhite ? 'P' : 'p';
        const pawnDir = isWhite ? 1 : -1;
        let isProtectedByPawn = false;
        for (const dc of [-1, 1]) {
          const pr = toCoords2.row + pawnDir;
          const pc = toCoords2.col + dc;
          if (pr >= 0 && pr < 8 && pc >= 0 && pc < 8 && board[pr][pc] === ownPawn) {
            isProtectedByPawn = true;
            break;
          }
        }
        if (isOpponentTerritory && isProtectedByPawn) {
          bonus += currentStyle.outpostBonus;
        }
      }
    }

    // 4. Forward push bonus — pawns and pieces advancing toward opponent
    if (pieceType === 'p') {
      const fromRow = squareToCoords(from).row;
      const toRow = squareToCoords(to).row;
      const forward = isWhite ? -1 : 1;
      if ((toRow - fromRow) * forward > 0) {
        bonus += currentStyle.attackBonus * 0.2;
      }
    }

    // v6.2: 5. Exchange sacrifice detection (Rxf3, Rxc3 patterns)
    if (currentStyle.exchangeSacrificeBonus > 0 && captured) {
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      const pieceVal = PIECE_VALUES[pieceType] || 0;
      if (pieceType === 'r' && (captured.toLowerCase() === 'n' || captured.toLowerCase() === 'b')) {
        if (oppKingPos) {
          const toCoords = squareToCoords(to);
          const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
          if (distToKing <= 4) {
            bonus += currentStyle.exchangeSacrificeBonus;
            const kingShieldSquares = [];
            const fwd = isWhite ? -1 : 1;
            for (const dc of [-1, 0, 1]) {
              const sr = oppKingPos.row + fwd;
              const sc = oppKingPos.col + dc;
              if (sr >= 0 && sr < 8 && sc >= 0 && sc < 8) {
                kingShieldSquares.push({ row: sr, col: sc });
              }
            }
            const hitsShield = kingShieldSquares.some(s => s.row === toCoords.row && s.col === toCoords.col);
            if (hitsShield) {
              bonus += currentStyle.exchangeSacrificeBonus * 0.8;
            }
          }
        }
      }
    }

    // v6.2: 6. Prophylactic bonus — moves that restrict opponent's piece activity
    if (currentStyle.prophylacticBonus > 0) {
      const toCoords = squareToCoords(to);
      let restrictsOpponent = false;
      if (['n', 'b', 'q', 'r'].includes(pieceType)) {
        const isAdvanced = isWhite ? (toCoords.row <= 4) : (toCoords.row >= 3);
        const isCentral = toCoords.row >= 2 && toCoords.row <= 5 && toCoords.col >= 2 && toCoords.col <= 5;
        if (isAdvanced || isCentral) {
          for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
              const opp = board[r][c];
              if (!opp) continue;
              const isOppPiece = isWhite ? (opp === opp.toLowerCase()) : (opp === opp.toUpperCase());
              if (!isOppPiece) continue;
              const dist = Math.abs(r - toCoords.row) + Math.abs(c - toCoords.col);
              if (dist <= 2 && opp.toLowerCase() !== 'p') {
                restrictsOpponent = true;
                break;
              }
            }
            if (restrictsOpponent) break;
          }
        }
      }
      if (restrictsOpponent) {
        bonus += currentStyle.prophylacticBonus;
      }
    }

    // v6.2: 7. 7th-rank rook bonus — rooks on the 7th rank are extremely aggressive
    if (currentStyle.attackBonus >= 60 && pieceType === 'r') {
      const toRow = squareToCoords(to).row;
      const isSeventhRank = isWhite ? (toRow === 1) : (toRow === 6);
      if (isSeventhRank) {
        bonus += currentStyle.attackBonus * 0.25;
      }
    }

    // v6.2: 8. Open file toward king — rook moves to file that leads to opponent's king
    if (currentStyle.pawnStormBonus > 0 && pieceType === 'r' && oppKingPos) {
      const toCoords = squareToCoords(to);
      if (toCoords.col === oppKingPos.col) {
        const ownPawn = isWhite ? 'P' : 'p';
        let isSemiOpen = true;
        for (let r = 0; r < 8; r++) {
          if (board[r][toCoords.col] === ownPawn) { isSemiOpen = false; break; }
        }
        if (isSemiOpen) {
          bonus += currentStyle.pawnStormBonus * 0.6;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // v7.1: KAMIKAZE-EXCLUSIVE SCORING — goes beyond ultra aggressive
    // These bonuses are what make Kamikaze play COMPLETELY differently
    // from typical Stockfish. They reward extreme aggression, sacrifice,
    // and all-out attack over safe, positional play.
    // ═══════════════════════════════════════════════════════════════════

    // v7.1: 9. Queen sacrifice detection — sacrificing the queen for attack
    if (currentStyle.queenSacrificeBonus > 0 && captured && pieceType === 'q') {
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      // Queen capturing something less valuable = queen sacrifice
      if (capturedVal < 9) {
        bonus += currentStyle.queenSacrificeBonus;
        // If the queen sac is NEAR the opponent's king, extra huge bonus
        if (oppKingPos) {
          const toCoords = squareToCoords(to);
          const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
          if (distToKing <= 3) {
            bonus += currentStyle.queenSacrificeBonus * 0.8;
          }
        }
      }
    }

    // v7.1: 10. Mate seeker bonus — moves that lead toward checkmate patterns
    // If the PV line contains a mate score, this move is on the path to checkmate
    if (currentStyle.mateSeekerBonus > 0 && oppKingPos) {
      const toCoords = squareToCoords(to);
      // Direct check pattern: piece moves adjacent to opponent's king
      // and the destination square attacks the king's square
      const attacksKingDirectly = (pieceType === 'q' || pieceType === 'r')
        ? (toCoords.row === oppKingPos.row || toCoords.col === oppKingPos.col ||
           Math.abs(toCoords.row - oppKingPos.row) === Math.abs(toCoords.col - oppKingPos.col))
        : (pieceType === 'n' &&
          ((Math.abs(toCoords.row - oppKingPos.row) === 2 && Math.abs(toCoords.col - oppKingPos.col) === 1) ||
           (Math.abs(toCoords.row - oppKingPos.row) === 1 && Math.abs(toCoords.col - oppKingPos.col) === 2)));

      if (attacksKingDirectly) {
        // Count how many of our pieces already attack the king zone
        let attackersInZone = 0;
        const kingZoneRadius = 2;
        for (let r = Math.max(0, oppKingPos.row - kingZoneRadius); r <= Math.min(7, oppKingPos.row + kingZoneRadius); r++) {
          for (let c = Math.max(0, oppKingPos.col - kingZoneRadius); c <= Math.min(7, oppKingPos.col + kingZoneRadius); c++) {
            const p = board[r][c];
            if (!p) continue;
            const isPlayerPiece = isWhite ? (p === p.toUpperCase()) : (p === p.toLowerCase());
            if (isPlayerPiece && p.toLowerCase() !== 'k' && p.toLowerCase() !== 'p') {
              attackersInZone++;
            }
          }
        }
        // More attackers = bigger mate-seeker bonus (3+ attackers = mating attack)
        if (attackersInZone >= 2) {
          bonus += currentStyle.mateSeekerBonus * Math.min(attackersInZone / 3, 1.5);
        }
      }

      // Smothered mate pattern detection: knight gives check near cornered king
      if (pieceType === 'n' && oppKingPos) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.max(Math.abs(toCoords.row - oppKingPos.row), Math.abs(toCoords.col - oppKingPos.col));
        if (distToKing <= 2) {
          // Check if king is near the edge (cornered = potential smothered mate)
          const kingNearEdge = oppKingPos.row <= 1 || oppKingPos.row >= 6 || oppKingPos.col <= 1 || oppKingPos.col >= 6;
          if (kingNearEdge) {
            bonus += currentStyle.mateSeekerBonus * 0.5;
          }
        }
      }
    }

    // v7.1: 11. Initiative bonus — moves that create forcing threats
    if (currentStyle.initiativeBonus > 0) {
      let createsThreats = 0;
      // Captures that open lines are initiative-gaining
      if (captured) createsThreats++;
      // Moving queen to aggressive diagonals/files near opponent's territory
      if (pieceType === 'q') {
        const toCoords = squareToCoords(to);
        const isAdvanced = isWhite ? (toCoords.row <= 4) : (toCoords.row >= 3);
        if (isAdvanced && oppKingPos) {
          const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
          if (distToKing <= 4) createsThreats++;
        }
      }
      // Moving pieces to open lines/diagonals attacking toward the king
      if ((pieceType === 'r' || pieceType === 'b') && oppKingPos) {
        const toCoords = squareToCoords(to);
        const hasLineToKing = pieceType === 'r'
          ? (toCoords.row === oppKingPos.row || toCoords.col === oppKingPos.col)
          : (Math.abs(toCoords.row - oppKingPos.row) === Math.abs(toCoords.col - oppKingPos.col));
        if (hasLineToKing) createsThreats++;
      }
      // Piece moving into attack range of opponent's king = initiative
      if (['q', 'r', 'b', 'n'].includes(pieceType) && oppKingPos) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
        if (distToKing <= 3) createsThreats += 0.5;
      }

      if (createsThreats >= 1.5) {
        bonus += currentStyle.initiativeBonus * Math.min(createsThreats, 3) / 2;
      }
    }

    // v7.1: 12. Back rank threat bonus — moves creating back rank mate patterns
    if (currentStyle.backRankThreatBonus > 0 && oppKingPos) {
      const oppBackRank = isWhite ? 0 : 7;  // opponent's back rank
      // Is opponent's king on or near back rank?
      const kingOnBackRank = Math.abs(oppKingPos.row - oppBackRank) <= 1;
      if (kingOnBackRank) {
        // Moving a rook or queen to opponent's back rank
        if ((pieceType === 'r' || pieceType === 'q')) {
          const toCoords = squareToCoords(to);
          if (toCoords.row === oppBackRank) {
            bonus += currentStyle.backRankThreatBonus;
          }
          // Moving to same file as king on back rank (potential back rank)
          if (toCoords.col === oppKingPos.col && (toCoords.row === oppBackRank || Math.abs(toCoords.row - oppKingPos.row) <= 2)) {
            bonus += currentStyle.backRankThreatBonus * 0.6;
          }
        }
        // Moving piece that opens a file toward opponent's back rank
        if (pieceType === 'p' && captured) {
          const fromCoords = squareToCoords(from);
          const toCoords = squareToCoords(to);
          // Capturing pawn opens a file
          if (Math.abs(fromCoords.col - toCoords.col) === 1) {
            // Check if the opened file is near opponent's king
            if (Math.abs(fromCoords.col - oppKingPos.col) <= 1) {
              bonus += currentStyle.backRankThreatBonus * 0.4;
            }
          }
        }
      }
    }

    // v7.1: 13. Piece sacrifice near king — ANY piece sacrifice near opponent's king
    if (currentStyle.pieceSacNearKingBonus > 0 && captured && oppKingPos) {
      const pieceVal = PIECE_VALUES[pieceType] || 0;
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      // If this is a sacrifice (giving up more valuable piece)
      if (pieceVal > capturedVal) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
        // The closer to the king, the bigger the bonus
        if (distToKing <= 4) {
          const proximityMultiplier = (5 - distToKing) / 4;  // 1.0 at dist=1, 0.25 at dist=4
          bonus += currentStyle.pieceSacNearKingBonus * proximityMultiplier;
          // Extra bonus for rook/queen sacrifices near the king
          if (pieceType === 'r') bonus += currentStyle.pieceSacNearKingBonus * 0.4;
          if (pieceType === 'q') bonus += currentStyle.pieceSacNearKingBonus * 0.6;
        }
      }
    }

    // v7.1: 14. Kamikaze double-attack / fork bonus near king
    if (currentStyle.attackBonus > 120 && oppKingPos) {
      const toCoords = squareToCoords(to);
      // Knight forks: knight moving to square that attacks both king and another piece
      if (pieceType === 'n') {
        const knightAttacks = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
        let attacksKing = false;
        let attacksOther = false;
        for (const [dr, dc] of knightAttacks) {
          const tr = toCoords.row + dr, tc = toCoords.col + dc;
          if (tr < 0 || tr >= 8 || tc < 0 || tc >= 8) continue;
          const target = board[tr][tc];
          if (tr === oppKingPos.row && tc === oppKingPos.col) attacksKing = true;
          else if (target) {
            const isOppPiece = isWhite ? (target === target.toLowerCase()) : (target === target.toUpperCase());
            if (isOppPiece && target.toLowerCase() !== 'p') attacksOther = true;
          }
        }
        if (attacksKing && attacksOther) {
          bonus += currentStyle.attackBonus * 0.15;  // Fork bonus
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // v7.3: BERSERKER-EXCLUSIVE SCORING — goes beyond Kamikaze
    // These bonuses make Berserker play FUNDAMENTALLY differently from
    // both Stockfish and Kamikaze. Inspired by Patricia engine (EAS 750K),
    // AlphaZero's positional sacrifices, and CSTal's speculative eval.
    // ═══════════════════════════════════════════════════════════════════

    // v7.3: 15. Attack Unit System — Stockfish-inspired S-curve scoring
    // Counts attack units targeting opponent's king zone:
    // Minor (N/B) = 2, Rook = 3, Queen = 5. S-curve conversion:
    // 0-2 units = minimal, 3-5 = moderate, 6-9 = large, 10+ = massive
    if (currentStyle.attackUnitBonus > 0 && oppKingPos) {
      const attackUnits = countAttackUnits(board, isWhite, oppKingPos);
      // Also check if THIS move adds more attack units (piece moving to attack king zone)
      const toCoords = squareToCoords(to);
      const kingZoneRadius = 2;
      const distToKingZone = Math.max(
        Math.abs(toCoords.row - oppKingPos.row),
        Math.abs(toCoords.col - oppKingPos.col)
      );
      let addedUnits = 0;
      if (distToKingZone <= kingZoneRadius) {
        if (pieceType === 'n' || pieceType === 'b') addedUnits = 2;
        else if (pieceType === 'r') addedUnits = 3;
        else if (pieceType === 'q') addedUnits = 5;
      }
      const totalUnits = attackUnits + addedUnits;
      bonus += attackUnitsToBonus(totalUnits, currentStyle.attackUnitBonus);
    }

    // v7.3: 16. Practical Chances — score moves creating max opponent difficulty
    if (currentStyle.practicalChancesBonus > 0 && oppKingPos) {
      let practicalScore = 0;
      // Count our attackers in king zone vs their defenders
      const ourAttackers = countPiecesInZone(board, isWhite, oppKingPos, 2);
      const theirDefenders = countPiecesInZone(board, !isWhite, oppKingPos, 2);
      if (ourAttackers > theirDefenders + 1) practicalScore += 30;
      else if (ourAttackers > theirDefenders) practicalScore += 15;
      // Opponent king safety issues = practical chances
      // v8.5.0: Reuse cached kingSafety from earlier in scoreMoveForStyle.
      const oppSafetyIssues = kingSafety.issues.filter(i =>
        isWhite ? i.color === 'b' : i.color === 'w'
      );
      practicalScore += oppSafetyIssues.length * 8;
      // Piece moving right next to opponent king = creates forcing situations
      const toCoords = squareToCoords(to);
      const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
      if (distToKing <= 1 && ['q', 'r', 'n'].includes(pieceType)) practicalScore += 20;
      if (practicalScore > 0) {
        bonus += currentStyle.practicalChancesBonus * Math.min(practicalScore / 40, 1.5);
      }
    }

    // v7.3: 17. Complexity Amplifier — boost moves increasing position complexity
    if (currentStyle.complexityBonus > 0) {
      let complexityScore = 0;
      // Sacrifice that does NOT simplify (sac pawn for attack > trade pieces)
      if (captured && piece) {
        const pieceVal = PIECE_VALUES[pieceType] || 0;
        const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
        if (pieceVal > capturedVal + 1) {
          complexityScore += 25; // Sacrifice = complexity increases
        } else if (pieceVal === capturedVal && pieceVal >= 3) {
          complexityScore -= 10; // Equal trade of minors/rooks = simplification (BAD)
        }
      }
      // Moving pieces to central squares = more tactical possibilities
      if (['n', 'b', 'r', 'q'].includes(pieceType)) {
        const toCoords = squareToCoords(to);
        const isCentral = toCoords.row >= 2 && toCoords.row <= 5 && toCoords.col >= 2 && toCoords.col <= 5;
        if (isCentral) complexityScore += 10;
      }
      // Pawn advancing opens lines = complexity
      if (pieceType === 'p') {
        const fromRow = squareToCoords(from).row;
        const toRow = squareToCoords(to).row;
        const forward = isWhite ? -1 : 1;
        if ((toRow - fromRow) * forward > 0) complexityScore += 5;
      }
      if (complexityScore > 0) {
        bonus += currentStyle.complexityBonus * Math.min(complexityScore / 30, 1.5);
      } else if (complexityScore < 0) {
        bonus += complexityScore * (currentStyle.complexityBonus / 30); // Penalty
      }
    }

    // v7.3: 18. Greek Gift Detection — Bxh7+/Bxh2+ sacrifice pattern
    if (currentStyle.greekGiftBonus > 0 && pieceType === 'b' && oppKingPos) {
      const targetSquare = isWhite ? 'h7' : 'h2';
      if (to === targetSquare) {
        let greekGiftScore = 40; // Base: bishop going to h7/h2
        // King must be near the target (castled short)
        const expectedKingRow = isWhite ? 0 : 7;
        const expectedKingCol = 6; // g-file
        if (oppKingPos.row === expectedKingRow && Math.abs(oppKingPos.col - expectedKingCol) <= 1) {
          greekGiftScore += 30; // King on g8/g1 — perfect target
        }
        // Check if our knight can reach g5/g4
        const knightTarget = isWhite ? 'g5' : 'g4';
        const knightCoords = squareToCoords(knightTarget);
        const ourKnight = isWhite ? 'N' : 'n';
        let knightCanReach = false;
        const knightJumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
        for (const [dr, dc] of knightJumps) {
          const nr = knightCoords.row + dr, nc = knightCoords.col + dc;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === ourKnight) {
            knightCanReach = true; break;
          }
        }
        if (knightCanReach) greekGiftScore += 25;
        // Check enemy knight NOT on f6/f3 (defending)
        const defSquare = isWhite ? 'f6' : 'f3';
        const defCoords = squareToCoords(defSquare);
        const enemyKnight = isWhite ? 'n' : 'N';
        if (!(defCoords.row >= 0 && defCoords.row < 8 && board[defCoords.row]?.[defCoords.col] === enemyKnight)) {
          greekGiftScore += 15; // No defender
        }
        // Our queen exists (can deliver Qh5+)
        const ourQueen = isWhite ? 'Q' : 'q';
        const queenExists = board.flat().some(p => p === ourQueen);
        if (queenExists) greekGiftScore += 10;
        bonus += currentStyle.greekGiftBonus * Math.min(greekGiftScore / 80, 1.5);
      }
    }

    // v7.3: 19. Draw Contempt — penalize drawish positions, avoid draws
    if (currentStyle.drawContempt > 0 && scoreType === 'cp') {
      const contemptBonus = applyDrawContempt(rawScore, currentStyle.drawContempt);
      bonus += contemptBonus;
    }

    // v7.3: 20. Sacrifice Cascade — bonus for consecutive sacrifices (Tal-style)
    if (currentStyle.sacrificeCascadeBonus > 0 && captured) {
      const pieceVal = PIECE_VALUES[pieceType] || 0;
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      if (pieceVal > capturedVal) {
        // This is a sacrifice — check if previous move was also a sacrifice
        const cascadeMultiplier = sacrificeHistory.consecutiveSacs > 0
          ? Math.min(sacrificeHistory.consecutiveSacs + 1, 4) / 2
          : 0;
        if (cascadeMultiplier > 0) {
          bonus += currentStyle.sacrificeCascadeBonus * cascadeMultiplier;
        }
      }
    }

    // v7.3: 21. Tempo Bonus — reward development WITH threats
    if (currentStyle.tempoBonus > 0) {
      let tempoScore = 0;
      const backRank = isWhite ? 7 : 0;
      const fromRow = squareToCoords(from).row;
      const toCoords = squareToCoords(to);
      // Development + attack: minor piece leaving back rank to active square near king
      if (fromRow === backRank && (pieceType === 'n' || pieceType === 'b')) {
        if (oppKingPos) {
          const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
          if (distToKing <= 4) tempoScore += 20;
        }
      }
      // Capture gains tempo
      if (captured) tempoScore += 8;
      // Piece attacking multiple enemy pieces from destination
      if (['n', 'b', 'q'].includes(pieceType)) {
        let attackedPieces = 0;
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const enemy = board[r][c];
            if (!enemy) continue;
            const isEnemy = isWhite ? (enemy === enemy.toLowerCase()) : (enemy === enemy.toUpperCase());
            if (!isEnemy || enemy.toLowerCase() === 'k' || enemy.toLowerCase() === 'p') continue;
            const dist = Math.abs(r - toCoords.row) + Math.abs(c - toCoords.col);
            if (dist <= 2) attackedPieces++;
          }
        }
        if (attackedPieces >= 2) tempoScore += 15;
      }
      if (tempoScore > 0) {
        bonus += currentStyle.tempoBonus * Math.min(tempoScore / 25, 1.5);
      }
    }

    // v7.3: 22. Overload Exploitation — exploit overloaded defending pieces
    if (currentStyle.overloadExploitBonus > 0 && oppKingPos) {
      let overloadScore = 0;
      // Check if captured piece was defending king zone
      if (captured) {
        const capCoords = squareToCoords(to);
        const distCapToKing = Math.abs(capCoords.row - oppKingPos.row) + Math.abs(capCoords.col - oppKingPos.col);
        // If we're capturing a piece near the king, it was likely a defender
        if (distCapToKing <= 3 && (captured.toLowerCase() === 'n' || captured.toLowerCase() === 'b')) {
          overloadScore += 20;
        }
      }
      // Moving piece to square that attacks TWO+ enemy pieces near king
      const toCoords = squareToCoords(to);
      let enemyPiecesNearKing = 0;
      for (let r = Math.max(0, oppKingPos.row - 2); r <= Math.min(7, oppKingPos.row + 2); r++) {
        for (let c = Math.max(0, oppKingPos.col - 2); c <= Math.min(7, oppKingPos.col + 2); c++) {
          const enemy = board[r][c];
          if (!enemy) continue;
          const isEnemy = isWhite ? (enemy === enemy.toLowerCase()) : (enemy === enemy.toUpperCase());
          if (isEnemy && enemy.toLowerCase() !== 'k' && enemy.toLowerCase() !== 'p') enemyPiecesNearKing++;
        }
      }
      if (enemyPiecesNearKing >= 3) overloadScore += 25; // Many pieces near king = likely overloaded
      if (overloadScore > 0) {
        bonus += currentStyle.overloadExploitBonus * Math.min(overloadScore / 30, 1.5);
      }
    }

    // v7.3: 23. Phase-Aware Aggression Scaling — adjust by game phase
    let phaseMultiplier = 1.0;
    if (currentStyle.phaseAggressionScale > 0 && fen) {
      const phase = detectGamePhase(fen);
      switch (phase) {
        case 'opening':
          phaseMultiplier = 0.8; // Slightly less — develop first, then attack
          // But tempo is amplified in opening
          if (currentStyle.tempoBonus > 0) bonus += currentStyle.tempoBonus * 0.3;
          break;
        case 'middlegame':
          phaseMultiplier = currentStyle.phaseAggressionScale; // MAXIMUM — go berserk
          break;
        case 'endgame':
          phaseMultiplier = 1.0; // Still aggressive but calculated
          // Mate seeker amplified in endgame
          if (currentStyle.mateSeekerBonus > 0) bonus += currentStyle.mateSeekerBonus * 0.2;
          break;
      }
    }

    // ─── Synergy Detection (v7.3 Berserker) ─────────────────────────
    // When multiple aggression bonuses stack, apply exponential multiplier
    let synergyMultiplier = 1.0;
    if (currentStyle.phaseAggressionScale > 0) {
      // Count how many distinct bonus categories contributed
      let activeBonuses = 0;
      if (captured && (PIECE_VALUES[pieceType] || 0) > (PIECE_VALUES[captured?.toLowerCase()] || 0)) activeBonuses++; // sacrifice
      if (oppKingPos && Math.abs(squareToCoords(to).row - oppKingPos.row) + Math.abs(squareToCoords(to).col - oppKingPos.col) <= 3) activeBonuses++; // king hunt
      if (currentStyle.attackUnitBonus > 0 && oppKingPos) activeBonuses++; // attack units
      if (currentStyle.practicalChancesBonus > 0) activeBonuses++; // practical chances
      if (currentStyle.complexityBonus > 0 && captured) activeBonuses++; // complexity
      if (currentStyle.greekGiftBonus > 0 && pieceType === 'b') activeBonuses++; // greek gift
      if (currentStyle.sacrificeCascadeBonus > 0 && sacrificeHistory.consecutiveSacs > 0) activeBonuses++; // cascade
      if (currentStyle.tempoBonus > 0) activeBonuses++; // tempo
      if (currentStyle.overloadExploitBonus > 0) activeBonuses++; // overload
      if (currentStyle.drawContempt > 0 && Math.abs(rawScore) < 50) activeBonuses++; // contempt

      // Exponential synergy: stacking bonuses create more-than-linear effect
      if (activeBonuses >= 7) synergyMultiplier = 3.0;
      else if (activeBonuses >= 5) synergyMultiplier = 2.0;
      else if (activeBonuses >= 3) synergyMultiplier = 1.5;
    }

    // Apply phase multiplier and synergy
    bonus = bonus * phaseMultiplier * synergyMultiplier;

    // Update sacrifice history for cascade detection
    if (currentStyle.sacrificeCascadeBonus > 0) {
      const isSac = captured && (PIECE_VALUES[pieceType] || 0) > (PIECE_VALUES[captured.toLowerCase()] || 0);
      // Also: moving valuable piece right next to king without capture = offering sac
      const isOfferingSac = !captured && ['q', 'r', 'b', 'n'].includes(pieceType) && oppKingPos &&
        Math.abs(squareToCoords(to).row - oppKingPos.row) + Math.abs(squareToCoords(to).col - oppKingPos.col) <= 2;
      if (isSac || isOfferingSac) {
        sacrificeHistory.consecutiveSacs++;
        sacrificeHistory.lastMoveWasSac = true;
      } else {
        sacrificeHistory.consecutiveSacs = 0;
        sacrificeHistory.lastMoveWasSac = false;
      }
    }

    // Apply the bonus — scale by evalWeight so aggressive moves get a relative boost
    // The bonus is capped at sacrificeTolerance to avoid recommending terrible moves
    // v6.2: Ultra-aggressive has higher cap
    // v7.1: Kamikaze has MUCH higher cap — allows truly wild sacrifices
    // v7.3: Berserker has the HIGHEST cap — 6x sacrificeTolerance
    const capMultiplier = currentStyle.phaseAggressionScale > 0 ? 6
      : (currentStyle.antiDetect ? 3 : (currentStyle.attackBonus > 120 ? 4 : 2));
    const cappedBonus = Math.min(bonus, currentStyle.sacrificeTolerance * capMultiplier);
    return rawScore + cappedBonus;
  }

  // ─── Anti-Detection: Position Criticality Assessment (v6.2 — from v7.0) ──
  // Returns a value 0-1 indicating how critical the position is.
  // 0 = completely equal/quiet (more diversity allowed)
  // 1 = extremely critical (stick to best moves)
  function assessPositionCriticality(fen, pvs) {
    if (!fen || !pvs || pvs.length < 2) return 0.8;

    const bestScore = pvs[0].score || 0;
    const secondScore = pvs[1].score || 0;
    const scoreGap = Math.abs(bestScore - secondScore);

    let criticality = 0.3;

    if (scoreGap > 50) criticality += 0.3;
    else if (scoreGap > 25) criticality += 0.15;

    if (Math.abs(bestScore) > 200) criticality += 0.25;
    else if (Math.abs(bestScore) > 100) criticality += 0.1;

    if (pvs[0].scoreType === 'mate') criticality = 1.0;

    const parts = fen.split(' ');
    const board = parseFENPlacement(parts[0]);
    let pieceCount = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (board[r][c]) pieceCount++;
    }
    if (pieceCount > 24) criticality += 0.05;

    return Math.min(1.0, criticality);
  }

  // ─── Anti-Detection: Weighted Random Move Selection (v6.2 — from v7.0) ──
  function applyAntiDetection(pvs, fen, style, playerColor) {
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (!currentStyle.antiDetect || !pvs || pvs.length < 2) return pvs;

    const criticality = assessPositionCriticality(fen, pvs);
    const diversityChance = currentStyle.moveDiversity * (1 - criticality);

    // Seeded pseudo-random based on FEN (deterministic per position for consistency)
    let fenHash = 0;
    const fenStr = fen || '';
    for (let i = 0; i < fenStr.length; i++) {
      fenHash = ((fenHash << 5) - fenHash + fenStr.charCodeAt(i)) | 0;
    }
    const sessionRand = Math.random();
    const combinedRand = Math.abs(Math.sin(fenHash + sessionRand * 65536));

    if (combinedRand > diversityChance) return pvs;

    const isWhite = playerColor === 'w';
    const bestScore = isWhite ? (pvs[0].score || 0) : -(pvs[0].score || 0);

    const tolerance = currentStyle.sacrificeTolerance;
    const alternatives = [];
    for (let i = 1; i < pvs.length && i < 5; i++) {
      const altScore = isWhite ? (pvs[i].score || 0) : -(pvs[i].score || 0);
      const evalLoss = bestScore - altScore;
      if (evalLoss <= tolerance) {
        const weight = Math.max(0.1, 1 - evalLoss / tolerance);
        alternatives.push({ pv: pvs[i], weight, idx: i });
      }
    }

    if (alternatives.length === 0) return pvs;

    const totalWeight = alternatives.reduce((sum, a) => sum + a.weight, 0);
    let roll = Math.random() * totalWeight;
    let selectedAlt = alternatives[0];
    for (const alt of alternatives) {
      roll -= alt.weight;
      if (roll <= 0) { selectedAlt = alt; break; }
    }

    const result = [...pvs];
    const temp = result[0];
    result[0] = selectedAlt.pv;
    result[selectedAlt.idx] = temp;

    return result;
  }

  // ─── Anti-Detection: Evaluation Noise (v6.2 — from v7.0) ──────────
  function injectEvalNoise(score, scoreType, style) {
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (!currentStyle.antiDetect || currentStyle.evalNoise <= 0) return { score, scoreType };
    if (scoreType === 'mate') return { score, scoreType };

    const u1 = Math.random();
    const u2 = Math.random();
    const gaussianNoise = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);
    const noise = Math.round(gaussianNoise * currentStyle.evalNoise * 0.5);

    return { score: score + noise, scoreType };
  }

  // ─── Style-Aware Move Selection ────────────────────────────────────
  // Re-ranks PVs based on style preferences, returns reordered PVs
  // v6.2: Also applies anti-detection diversification if enabled
  // v7.3: Berserker uses two-phase re-ranking: filter within tolerance, then rank by pure aggression
  function selectPVForStyle(pvs, fen, style, playerColor) {
    if (!pvs || pvs.length <= 1) return pvs;
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    if (currentStyle.attackBonus === 0 && !currentStyle.antiDetect && !currentStyle.attackUnitBonus) return pvs; // Normal: use engine ranking

    const isWhite = playerColor === 'w';

    // Score each PV line for style preference
    const scored = pvs.map((pv, idx) => {
      const rawScore = isWhite ? pv.score : -pv.score;
      const firstMove = pv.pv && pv.pv.length > 0 ? pv.pv[0] : null;
      const styleScore = firstMove
        ? scoreMoveForStyle(firstMove, fen, rawScore, pv.scoreType, style, playerColor)
        : rawScore;

      return { pv, styleScore, rawScore, idx };
    });

    // v7.3: Berserker two-phase re-ranking
    // Phase 1: Filter moves within sacrificeTolerance of best raw score
    // Phase 2: Among filtered moves, rank by pure aggression score (styleScore)
    // This makes Berserker DELIBERATELY choose moves that are slightly worse
    // objectively but MUCH more aggressive — the essence of being "different from Stockfish"
    if (currentStyle.phaseAggressionScale > 0) {
      const bestRawScore = Math.max(...scored.map(s => s.rawScore));
      const tolerance = currentStyle.sacrificeTolerance;

      // Filter to moves within tolerance
      const viable = scored.filter(s => bestRawScore - s.rawScore <= tolerance);

      if (viable.length > 1) {
        // Among viable moves, sort by style score (aggression) — pick the most aggressive
        viable.sort((a, b) => b.styleScore - a.styleScore);

        // Rebuild the full list: viable (sorted by aggression) first, then the rest (sorted by raw score)
        const viablePvs = viable.map(s => s.pv);
        const eliminated = scored.filter(s => !viable.includes(s));
        eliminated.sort((a, b) => b.rawScore - a.rawScore);
        const eliminatedPvs = eliminated.map(s => s.pv);

        let result = [...viablePvs, ...eliminatedPvs];

        // Apply anti-detection (not used by Berserker, but just in case)
        if (currentStyle.antiDetect) {
          result = applyAntiDetection(result, fen, style, playerColor);
        }

        return result;
      }
    }

    // Standard re-ranking (non-Berserker styles)
    // Sort by style-adjusted score (descending)
    scored.sort((a, b) => b.styleScore - a.styleScore);

    // But don't let a much worse move be chosen — limit how far down we'll reach
    // Only pick a style-preferred move if it's within sacrificeTolerance of the best
    const bestRawScore = scored[0].rawScore;
    const tolerance = currentStyle.sacrificeTolerance;

    // Find the best style move within tolerance
    let bestIdx = 0;
    for (let i = 0; i < scored.length; i++) {
      if (bestRawScore - scored[i].rawScore <= tolerance) {
        bestIdx = i;
        break;
      }
    }

    // If the style-preferred move is within tolerance, promote it
    if (bestIdx > 0 && scored[bestIdx].styleScore > scored[0].styleScore) {
      // Swap the style-preferred move to position 0
      const stylePreferred = scored[bestIdx];
      scored.splice(bestIdx, 1);
      scored.unshift(stylePreferred);
    }

    let result = scored.map(s => s.pv);

    // v6.2: Apply anti-detection diversification
    if (currentStyle.antiDetect) {
      result = applyAntiDetection(result, fen, style, playerColor);
    }

    return result;
  }

  // ─── Style-Aware Move Annotation ───────────────────────────────────
  // v6.2: Enhanced with pawn storm, exchange sacrifice, outpost, prophylactic annotations
  function annotateMoveForStyle(uci, fen, style, evalScore) {
    if (!fen || !uci) return [];
    const parts = fen.split(' ');
    const board = parseFENPlacement(parts[0]);
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    const pieceType = piece ? piece.toLowerCase() : '?';
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    const annotations = [];

    if (captured) {
      annotations.push('captures');
      // Sacrifice detection for aggressive styles
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      const pieceVal = PIECE_VALUES[pieceType] || 0;
      if (pieceVal > capturedVal && currentStyle.sacrificeTolerance > 0) {
        annotations.push('sacrifice');
      }
      // v6.2: Exchange sacrifice (rook takes minor)
      if (currentStyle.exchangeSacrificeBonus > 0 && pieceType === 'r' &&
          (captured.toLowerCase() === 'n' || captured.toLowerCase() === 'b')) {
        annotations.push('exchange sac');
      }
    }

    // King hunt detection
    const oppKingColor = piece === piece.toUpperCase() ? 'k' : 'K';
    let oppKingPos = null;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (board[r][c] === oppKingColor) oppKingPos = { row: r, col: c };
    }
    if (oppKingPos && currentStyle.kingHuntBonus > 0) {
      const toCoords = squareToCoords(to);
      const distToKing = Math.abs(toCoords.row - oppKingPos.row) + Math.abs(toCoords.col - oppKingPos.col);
      if (distToKing <= 2) annotations.push('king hunt');
    }

    // v6.2: Pawn storm detection
    if (currentStyle.pawnStormBonus > 0 && pieceType === 'p' && oppKingPos) {
      const pawnFile = from.charCodeAt(0) - 97;
      const kingFile = oppKingPos.col;
      const isNearKingFile = Math.abs(pawnFile - kingFile) <= 1;
      const isKingCastled = (kingFile >= 5 && kingFile <= 7) || (kingFile >= 0 && kingFile <= 2);
      if (isNearKingFile && isKingCastled) {
        annotations.push('pawn storm');
      }
    }

    if (pieceType === 'q' && (to[1] === '1' || to[1] === '8') && evalScore > 200) annotations.push('aggressive');
    if (pieceType === 'n' && (to[0] >= 'c' && to[0] <= 'f') && (to[1] >= '3' && to[1] <= '6')) {
      annotations.push('centralizing');
      // v6.2: Outpost detection
      if (currentStyle.outpostBonus > 0) {
        const toCoords = squareToCoords(to);
        const isWhite = piece === piece.toUpperCase();
        const isOpponentTerritory = isWhite ? (toCoords.row <= 3) : (toCoords.row >= 4);
        const ownPawn = isWhite ? 'P' : 'p';
        const pawnDir = isWhite ? 1 : -1;
        let isProtectedByPawn = false;
        for (const dc of [-1, 1]) {
          const pr = toCoords.row + pawnDir;
          const pc = toCoords.col + dc;
          if (pr >= 0 && pr < 8 && pc >= 0 && pc < 8 && board[pr][pc] === ownPawn) {
            isProtectedByPawn = true;
            break;
          }
        }
        if (isOpponentTerritory && isProtectedByPawn) {
          annotations.push('outpost');
        }
      }
    }
    if (pieceType === 'r' && !captured) {
      const toCoords = squareToCoords(to);
      let isSemiOpen = true;
      const ownPawn = piece === piece.toUpperCase() ? 'P' : 'p';
      for (let r = 0; r < 8; r++) { if (board[r][toCoords.col] === ownPawn) { isSemiOpen = false; break; } }
      if (isSemiOpen) annotations.push('to open file');
      // v6.2: 7th rank rook
      const isWhite = piece === piece.toUpperCase();
      const isSeventhRank = isWhite ? (toCoords.row === 1) : (toCoords.row === 6);
      if (isSeventhRank && currentStyle.attackBonus >= 60) {
        annotations.push('7th rank');
      }
    }

    // v6.2: Anti-detection mode indicator
    if (currentStyle.antiDetect) {
      annotations.push('stealth');
    }

    // v7.1: Kamikaze-exclusive annotations
    if (currentStyle.attackBonus > 120 && currentStyle.attackBonus <= 200) {
      // Queen sacrifice annotation
      if (captured && pieceType === 'q') {
        const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
        if (capturedVal < 9) {
          annotations.push('queen sac');
        }
      }
      // Mate attack annotation — piece attacking king directly
      if (oppKingPos && ['q', 'r', 'n'].includes(pieceType)) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.max(Math.abs(toCoords.row - oppKingPos.row), Math.abs(toCoords.col - oppKingPos.col));
        if (distToKing <= 1) {
          annotations.push('mate attack');
        }
      }
      // Kamikaze mode indicator
      annotations.push('kamikaze');
    }

    // v7.3: Berserker-exclusive annotations
    if (currentStyle.attackBonus > 200) {
      // Queen sacrifice annotation
      if (captured && pieceType === 'q') {
        const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
        if (capturedVal < 9) {
          annotations.push('queen sac');
        }
      }
      // Mate attack annotation
      if (oppKingPos && ['q', 'r', 'n'].includes(pieceType)) {
        const toCoords = squareToCoords(to);
        const distToKing = Math.max(Math.abs(toCoords.row - oppKingPos.row), Math.abs(toCoords.col - oppKingPos.col));
        if (distToKing <= 1) {
          annotations.push('mate attack');
        }
      }
      // Greek Gift annotation
      if (currentStyle.greekGiftBonus > 0 && pieceType === 'b') {
        const targetSquare = piece === piece.toUpperCase() ? 'h7' : 'h2';
        if (to === targetSquare) {
          annotations.push('greek gift');
        }
      }
      // Cascade sacrifice annotation
      if (currentStyle.sacrificeCascadeBonus > 0 && sacrificeHistory.consecutiveSacs > 0 && captured) {
        const pieceVal = PIECE_VALUES[pieceType] || 0;
        const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
        if (pieceVal > capturedVal) {
          annotations.push('cascade sac');
        }
      }
      // Overload exploitation annotation
      if (currentStyle.overloadExploitBonus > 0 && captured && oppKingPos) {
        const capCoords = squareToCoords(to);
        const distCapToKing = Math.abs(capCoords.row - oppKingPos.row) + Math.abs(capCoords.col - oppKingPos.col);
        if (distCapToKing <= 3 && (captured.toLowerCase() === 'n' || captured.toLowerCase() === 'b')) {
          annotations.push('overload');
        }
      }
      // Berserker mode indicator
      annotations.push('berserker');
    }

    return annotations;
  }

  // ─── Generate Hints (Main Entry) ───────────────────────────────────
  function generateHints(analysisData, hintLevel, playerColor, style, openingRepertoire) {
    const { fen, pvs, bestMove, source, tablebaseData, openingData } = analysisData;
    const position = assessPosition(fen);
    const isWhite = playerColor === 'w';
    const currentStyle = PLAYING_STYLES[style] || PLAYING_STYLES.normal;
    const currentRepertoire = OPENING_REPERTOIRES[openingRepertoire] || OPENING_REPERTOIRES.none;

    // Apply style-aware PV re-ranking
    let rankedPVs = pvs;
    if (pvs && pvs.length > 1 && (currentStyle.attackBonus > 0 || currentStyle.antiDetect || currentStyle.attackUnitBonus > 0)) {
      rankedPVs = selectPVForStyle(pvs, fen, style, playerColor);
    }

    const bestPV = rankedPVs && rankedPVs.length > 0 ? rankedPVs[0] : null;
    // All scores are normalized to White's perspective
    const evalScore = bestPV ? (isWhite ? bestPV.score : -bestPV.score) : 0;
    // v6.2: Apply eval noise for anti-detection styles
    const noisyEval = injectEvalNoise(evalScore, bestPV ? bestPV.scoreType : 'cp', style);
    const displayEvalScore = noisyEval.score;
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
      return hints;
    }

    // Generate main hint
    if (hintLevel === 1) {
      hints.main = generatePositionalCoachHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle);
      hints.bestMoveFromTo = null;
      hints.fairPlayWarning = null;
    } else if (hintLevel === 2) {
      hints.main = generateAreaHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle);
      hints.bestMoveFromTo = null;
      hints.fairPlayWarning = null;
    } else if (hintLevel === 3) {
      hints.main = generateDirectionHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle);
      hints.bestMoveFromTo = null;
      hints.fairPlayWarning = null;
    } else if (hintLevel === 4) {
      hints.main = generateDeepLineHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle);
      hints.fairPlayWarning = 'Deep line hints reveal specific moves. Use sparingly to avoid engine correlation patterns.';
    } else {
      hints.main = generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen || '', currentStyle, currentRepertoire, analysisData.moveHistory);
      hints.fairPlayWarning = 'Using exact move hints frequently may cause your moves to match engine recommendations, which fair play systems can detect.';
    }

    // From-to square notation — always show actual piece color
    if (hintLevel >= 5 && bestPV && bestPV.pv && bestPV.pv.length > 0) {
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

    // Style annotation for L5
    if (hintLevel >= 5 && bestPV && bestPV.pv && bestPV.pv.length > 0 && fen) {
      const annotations = annotateMoveForStyle(bestPV.pv[0], fen, style, evalScore);
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

  // ─── L1: Positional Coach Hint ───────────────────────────────────
  function generatePositionalCoachHint(bestPV, position, evalScore, scoreType, playerColor, fen, style) {
    if (!fen) return 'Waiting for position...';

    const isWhite = playerColor === 'w';
    const playerLabel = isWhite ? 'White' : 'Black';
    const phase = detectGamePhase(fen);
    const balance = position.material.balance;
    const playerBalance = isWhite ? balance : -balance;

    // Build position assessment
    let assessment = '';

    // Material assessment
    if (playerBalance > 5) assessment += 'You have a decisive material advantage. ';
    else if (playerBalance > 2) assessment += 'You have a significant material advantage. ';
    else if (playerBalance > 0) assessment += 'You have a slight material edge. ';
    else if (playerBalance === 0) assessment += 'Material is equal. ';
    else if (playerBalance > -2) assessment += 'Your opponent has a slight material edge. ';
    else if (playerBalance > -5) assessment += 'You are down material. ';
    else assessment += 'You face a significant material deficit. ';

    // King safety
    const myKingIssues = position.kingSafety.issues.filter(i => i.color === playerColor && i.severity === 'high');
    if (myKingIssues.length > 0) assessment += 'Your king safety needs attention. ';

    // Pawn structure
    const myPassedPawns = isWhite ? position.pawnStructure.whitePassedPawns : position.pawnStructure.blackPassedPawns;
    if (myPassedPawns > 0) assessment += `You have ${myPassedPawns} passed pawn(s). `;

    // Piece activity
    const developed = position.pieceActivity.developed;
    if (phase === 'opening' && developed < 2) assessment += 'Focus on developing your minor pieces. ';

    // Tactical opportunities
    if (position.threats.length > 0) assessment += 'There are tactical opportunities on the board. ';

    // Game phase and plan
    let plan = '';
    if (scoreType === 'mate' && evalScore > 0) {
      plan = 'You have a winning attack — look for forcing sequences.';
    } else if (scoreType === 'mate' && evalScore < 0) {
      plan = 'Defend carefully — your opponent has a dangerous attack.';
    } else if (evalScore > 300) {
      plan = phase === 'endgame'
        ? 'Activate your king and push your passed pawns.'
        : 'Simplify the position — trade pieces to convert your advantage.';
    } else if (evalScore > 100) {
      plan = 'Increase pressure — look for small improvements and piece activity.';
    } else if (evalScore > -100) {
      plan = 'Equal position — focus on piece activity and controlling the center.';
    } else if (evalScore > -300) {
      plan = 'Stay solid — defend carefully and look for counterplay.';
    } else {
      plan = 'Defend stubbornly — look for tactical tricks and simplification.';
    }

    return `${assessment}Plan: ${plan}`;
  }

  // ─── L2: Area Hint ──────────────────────────────────────────────
  function generateAreaHint(bestPV, position, evalScore, scoreType, playerColor, fen, style) {
    if (!fen) return 'Waiting for position...';
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) {
      return generatePositionalCoachHint(bestPV, position, evalScore, scoreType, playerColor, fen, style);
    }

    const isWhite = playerColor === 'w';
    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';

    // Determine the area of the board based on the destination square
    const toCol = to.charCodeAt(0) - 97; // 0-7
    const toRow = 8 - parseInt(to[1]); // 0-7

    let area = '';
    if (toCol <= 2) area = 'queenside';
    else if (toCol >= 5) area = 'kingside';
    else area = 'center';

    // Determine if it's attacking or defensive based on eval
    let intent = '';
    if (evalScore > 50) intent = 'press your advantage on the';
    else if (evalScore > -50) intent = 'focus your attention on the';
    else intent = 'shore up your defenses on the';

    // Check for king proximity for attacking hints
    const oppKingColor = isWhite ? 'k' : 'K';
    let oppKingPos = null;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (board[r][c] === oppKingColor) oppKingPos = { row: r, col: c };
    }

    if (oppKingPos) {
      const distToKing = Math.abs(toRow - oppKingPos.row) + Math.abs(toCol - oppKingPos.col);
      if (distToKing <= 3 && evalScore > 0) {
        intent = 'attack the enemy king on the';
      }
    }

    // Piece type hint
    const pieceTypeHint = piece ? `Consider moving a ${pieceName}` : 'Consider your pieces';

    return `${pieceTypeHint} — ${intent} ${area}.`;
  }

  // ─── L3: Direction Hint ──────────────────────────────────────────
  function generateDirectionHint(bestPV, position, evalScore, scoreType, playerColor, fen, style) {
    if (!fen) return 'Waiting for position...';
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) {
      return generatePositionalCoachHint(bestPV, position, evalScore, scoreType, playerColor, fen, style);
    }

    const isWhite = playerColor === 'w';
    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
    const captured = getPieceAt(board, to);

    // Determine direction
    const fromCol = from.charCodeAt(0) - 97;
    const fromRow = 8 - parseInt(from[1]);
    const toCol = to.charCodeAt(0) - 97;
    const toRow = 8 - parseInt(to[1]);

    let direction = '';
    const dCol = toCol - fromCol;
    const dRow = toRow - fromRow;

    if (Math.abs(dCol) <= 1 && dRow < 0 && isWhite) direction = 'forward';
    else if (Math.abs(dCol) <= 1 && dRow > 0 && !isWhite) direction = 'forward';
    else if (Math.abs(dCol) <= 1 && dRow > 0 && isWhite) direction = 'backward';
    else if (Math.abs(dCol) <= 1 && dRow < 0 && !isWhite) direction = 'backward';
    else if (dCol < 0 && Math.abs(dRow) <= 1) direction = 'toward the queenside';
    else if (dCol > 0 && Math.abs(dRow) <= 1) direction = 'toward the kingside';
    else if (dCol < 0 && dRow < 0 && isWhite) direction = 'forward toward the queenside';
    else if (dCol > 0 && dRow < 0 && isWhite) direction = 'forward toward the kingside';
    else if (dCol < 0 && dRow > 0 && !isWhite) direction = 'forward toward the queenside';
    else if (dCol > 0 && dRow > 0 && !isWhite) direction = 'forward toward the kingside';
    else if (dCol < 0 && dRow > 0 && isWhite) direction = 'backward toward the queenside';
    else if (dCol > 0 && dRow > 0 && isWhite) direction = 'backward toward the kingside';
    else if (dCol < 0 && dRow < 0 && !isWhite) direction = 'backward toward the queenside';
    else if (dCol > 0 && dRow < 0 && !isWhite) direction = 'backward toward the kingside';
    else direction = 'to a new position';

    // Center check
    if (toCol >= 2 && toCol <= 5 && toRow >= 2 && toRow <= 5) {
      direction = 'toward the center';
    }

    let hint = `Move your ${pieceName} ${direction}`;

    // Add context
    if (captured) {
      hint += ' — there is a capture available';
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      const pieceVal = PIECE_VALUES[piece.toLowerCase()] || 0;
      if (pieceVal > capturedVal) hint += ' (sacrifice!)';
    }

    if (scoreType === 'mate' && evalScore > 0) {
      hint += ' — look for a forcing sequence';
    } else if (scoreType === 'mate' && evalScore < 0) {
      hint += ' — defend against the threat';
    }

    return hint + '.';
  }

  // ─── L4: Deep Line Hint (Player-First) ──────────────────────────
  function generateDeepLineHint(bestPV, position, evalScore, scoreType, playerColor, fen, style) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) return 'Analyzing position...';
    if (!fen) return 'Waiting for position...';

    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const piece = getPieceAt(board, from);
    const captured = getPieceAt(board, to);
    const pieceName = piece ? PIECE_NAMES[piece.toLowerCase()] : 'piece';
    const isWhite = playerColor === 'w';
    const playerLabel = isWhite ? 'White' : 'Black';
    // v5.4.0: Use ACTUAL piece color from the board, not assumed ownership
    const isPieceWhite = piece && piece === piece.toUpperCase();
    const pieceSideLabel = isPieceWhite ? 'White' : 'Black';
    const possessive = pieceSideLabel.toLowerCase() + "'s";
    const currentStyle = style || PLAYING_STYLES.normal;

    let hint = '';

    if (scoreType === 'mate' && evalScore > 0) {
      hint = `Force mate! Move ${possessive} ${pieceName} from ${from} to ${to}`;
    } else if (scoreType === 'mate' && evalScore < 0) {
      hint = `Defend! Move ${possessive} ${pieceName} from ${from} to ${to} to avoid mate`;
    } else if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isOppPiece = isWhite ? (captured === captured.toLowerCase()) : (captured === captured.toUpperCase());
      hint = `Capture with ${possessive} ${pieceName} from ${from} to ${to}`;
      if (isOppPiece) hint += `, taking opponent's ${capturedName}`;
      // Sacrifice annotation for aggressive styles
      const pieceVal = PIECE_VALUES[piece.toLowerCase()] || 0;
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      if (pieceVal > capturedVal && currentStyle.sacrificeTolerance > 0) {
        hint += ' (sacrifice!)';
      }
      if (bestPV.pv.length >= 3) {
        const nextUci = bestPV.pv[2];
        if (nextUci) hint += ` \u2014 the idea continues toward ${nextUci.substring(2, 4)}`;
      }
    } else if (evalScore > 100) {
      hint = `${possessive} ${pieceName} from ${from} to ${to} strengthens ${playerLabel.toLowerCase()}'s winning position`;
      if (bestPV.pv.length >= 3) {
        const nextUci = bestPV.pv[2];
        if (nextUci) {
          const boardAfter2 = applyMoveToBoard(applyMoveToBoard(board, bestPV.pv[0]), bestPV.pv[1]);
          const nextFrom = nextUci.substring(0, 2);
          const nextTo = nextUci.substring(2, 4);
          const nextPiece = getPieceAt(boardAfter2, nextFrom);
          if (nextPiece) hint += `. Follow-up: ${PIECE_NAMES[nextPiece.toLowerCase()]} ${nextFrom} to ${nextTo}`;
        }
      }
    } else if (evalScore > -100) {
      hint = `Play ${possessive} ${pieceName} from ${from} to ${to}`;
      if (bestPV.pv.length >= 3) {
        const nextUci = bestPV.pv[2];
        if (nextUci) hint += ` with the idea of reaching ${nextUci.substring(2, 4)}`;
      }
    } else {
      hint = `Defend with ${possessive} ${pieceName} from ${from} to ${to}`;
    }

    const myKingIssues = position.kingSafety.issues.filter(i => i.color === playerColor && i.severity === 'high');
    if (myKingIssues.length > 0 && evalScore < 0) hint += `. ${playerLabel}'s king needs attention`;

    return hint;
  }

  // ─── L5: Exact Move Hint (Player-First) ──────────────────────────
  function generateExactMoveHint(bestPV, position, evalScore, scoreType, playerColor, fen, style, repertoire, moveHistory) {
    if (!bestPV || !bestPV.pv || bestPV.pv.length === 0) return 'Analysis in progress...';
    if (!fen) return 'Waiting for position...';

    const board = parseFENPlacement(fen.split(' ')[0]);
    const uci = bestPV.pv[0];
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promo = uci.length > 4 ? uci[4] : null;
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

    let moveStr = san;
    if (promo) moveStr += '=' + promo.toUpperCase();
    let hint = `Best: ${moveStr}  (${pieceSideLabel}: ${pieceName}: ${from} \u2192 ${to})`;

    if (scoreType === 'mate') {
      hint += ` \u2014 MATE IN ${Math.abs(evalScore)}`;
    } else {
      const evalPawns = (evalScore / 100).toFixed(1);
      hint += evalScore > 0 ? `  eval: +${evalPawns}` : `  eval: ${evalPawns}`;
    }

    if (captured) {
      const capturedName = PIECE_NAMES[captured.toLowerCase()] || 'piece';
      const isOppPiece = isWhite ? (captured === captured.toLowerCase()) : (captured === captured.toUpperCase());
      // Sacrifice annotation
      const pieceVal = PIECE_VALUES[piece.toLowerCase()] || 0;
      const capturedVal = PIECE_VALUES[captured.toLowerCase()] || 0;
      if (isOppPiece) {
        if (pieceVal > capturedVal && currentStyle.sacrificeTolerance > 0) {
          hint += ` | Sacrifice! Takes opponent's ${capturedName}`;
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

    // Opening repertoire check
    if (moveHistory && moveHistory.length === 0 && repertoire.preferredFirstMove) {
      if (uci !== repertoire.preferredFirstMove) {
        const prefSan = uciToSan(repertoire.preferredFirstMove, fen);
        hint += ` | Your repertoire prefers ${prefSan} (${repertoire.preferredFirstMove.substring(0,2)} \u2192 ${repertoire.preferredFirstMove.substring(2,4)})`;
      }
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
    if (hintLevel >= 5) {
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
      if (idx === 0) { quality = 'Best'; qualityClass = 'cm-best'; }
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
        candidateMoveUci
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
    PLAYING_STYLES,
    OPENING_REPERTOIRES,
    HINT_LEVELS,
    // v8.5.0
    resetSacrificeHistory,
    formatScorePlayerPerspective  // Enhancement D
  };

})();
