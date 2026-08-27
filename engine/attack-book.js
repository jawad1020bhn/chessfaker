/*
 * Attack Book — the style persona's owned opening repertoire.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 *
 * A small, hand-verified mini-book of attacking lines (moves 1-6) for the
 * Ultra Super Aggressive style. Purpose: when every cloud provider is
 * silent, the persona still suggests a coherent, pre-solved attacking
 * setup instead of a depth-4 material shuffle. Book answers are theory
 * positions with deliberately modest scores — they never pretend to be
 * engine evaluations (scoreType: "book", rendered in the book lane).
 *
 * Every SAN/UCI pair below was machine-verified for legality when the
 * module was authored. Lines are prefix-matched against the live game's
 * SAN move history; any opponent deviation outside the book simply means
 * "no coverage" and the caller falls through to the local engine.
 *
 * Classic global + CommonJS export, mirroring human-form.js.
 */
(function (root) {
  'use strict';

  // side: which color this line is played BY. moves alternate white/black
  // from the standard start position (even index = white's move).
  const LINES = [{"name":"Italian: c3-d4 gambit build-up","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"e5","uci":"e7e5"},{"san":"Nf3","uci":"g1f3"},{"san":"Nc6","uci":"b8c6"},{"san":"Bc4","uci":"f1c4"},{"san":"Bc5","uci":"f8c5"},{"san":"c3","uci":"c2c3"},{"san":"Nf6","uci":"g8f6"},{"san":"d4","uci":"d2d4"},{"san":"exd4","uci":"e5d4"},{"san":"cxd4","uci":"c3d4"}]},{"name":"Two Knights: Fried Liver Attack","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"e5","uci":"e7e5"},{"san":"Nf3","uci":"g1f3"},{"san":"Nc6","uci":"b8c6"},{"san":"Bc4","uci":"f1c4"},{"san":"Nf6","uci":"g8f6"},{"san":"Ng5","uci":"f3g5"},{"san":"d5","uci":"d7d5"},{"san":"exd5","uci":"e4d5"},{"san":"Nxd5","uci":"f6d5"},{"san":"Nxf7","uci":"g5f7"}]},{"name":"Sicilian: Smith-Morra Gambit","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"c5","uci":"c7c5"},{"san":"d4","uci":"d2d4"},{"san":"cxd4","uci":"c5d4"},{"san":"c3","uci":"c2c3"},{"san":"dxc3","uci":"d4c3"},{"san":"Nxc3","uci":"b1c3"},{"san":"Nc6","uci":"b8c6"},{"san":"Nf3","uci":"g1f3"}]},{"name":"French Advance: Milner-Barry gambit setup","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"e6","uci":"e7e6"},{"san":"d4","uci":"d2d4"},{"san":"d5","uci":"d7d5"},{"san":"e5","uci":"e4e5"},{"san":"c5","uci":"c7c5"},{"san":"c3","uci":"c2c3"},{"san":"Nc6","uci":"b8c6"},{"san":"Nf3","uci":"g1f3"},{"san":"Qb6","uci":"d8b6"},{"san":"Bd3","uci":"f1d3"}]},{"name":"Caro Exchange: piece attack setup","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"c6","uci":"c7c6"},{"san":"d4","uci":"d2d4"},{"san":"d5","uci":"d7d5"},{"san":"exd5","uci":"e4d5"},{"san":"cxd5","uci":"c6d5"},{"san":"Bd3","uci":"f1d3"},{"san":"Nc6","uci":"b8c6"},{"san":"c3","uci":"c2c3"},{"san":"Nf6","uci":"g8f6"},{"san":"Bf4","uci":"c1f4"}]},{"name":"Pirc Austrian: Qe2 + kingside storm","side":"w","moves":[{"san":"e4","uci":"e2e4"},{"san":"d6","uci":"d7d6"},{"san":"d4","uci":"d2d4"},{"san":"Nf6","uci":"g8f6"},{"san":"Nc3","uci":"b1c3"},{"san":"g6","uci":"g7g6"},{"san":"Bc4","uci":"f1c4"},{"san":"Bg7","uci":"f8g7"},{"san":"Qe2","uci":"d1e2"},{"san":"O-O","uci":"e8g8"},{"san":"h4","uci":"h2h4"}]},{"name":"Sicilian Dragon (accelerated setup)","side":"b","moves":[{"san":"e4","uci":"e2e4"},{"san":"c5","uci":"c7c5"},{"san":"Nf3","uci":"g1f3"},{"san":"d6","uci":"d7d6"},{"san":"d4","uci":"d2d4"},{"san":"cxd4","uci":"c5d4"},{"san":"Nxd4","uci":"f3d4"},{"san":"Nf6","uci":"g8f6"},{"san":"Nc3","uci":"b1c3"},{"san":"g6","uci":"g7g6"},{"san":"Be3","uci":"c1e3"},{"san":"Bg7","uci":"f8g7"}]},{"name":"King's Indian: classic e5 fight","side":"b","moves":[{"san":"d4","uci":"d2d4"},{"san":"Nf6","uci":"g8f6"},{"san":"c4","uci":"c2c4"},{"san":"g6","uci":"g7g6"},{"san":"Nc3","uci":"b1c3"},{"san":"Bg7","uci":"f8g7"},{"san":"e4","uci":"e2e4"},{"san":"d6","uci":"d7d6"},{"san":"Nf3","uci":"g1f3"},{"san":"O-O","uci":"e8g8"},{"san":"Be2","uci":"f1e2"},{"san":"e5","uci":"e7e5"}]},{"name":"English reversed-Sicilian dragon","side":"b","moves":[{"san":"c4","uci":"c2c4"},{"san":"e5","uci":"e7e5"},{"san":"Nc3","uci":"b1c3"},{"san":"Nf6","uci":"g8f6"},{"san":"Nf3","uci":"g1f3"},{"san":"Nc6","uci":"b8c6"},{"san":"g3","uci":"g2g3"},{"san":"g6","uci":"g7g6"},{"san":"Bg2","uci":"f1g2"},{"san":"Bg7","uci":"f8g7"},{"san":"d3","uci":"d2d3"},{"san":"d6","uci":"d7d6"}]}];

  const MAX_BOOK_PLIES = 12; // ~move 6: pre-solved theory only

  function playerTurnIndex(playerColor) {
    // Ply index of the NEXT move when it is playerColor's turn.
    return playerColor === 'b' ? 1 : 0; // parity only; length comes from history
  }

  /**
   * Longest-prefix book lookup.
   * @param {object} args
   *   moveHistory  SAN move list of the game so far (from the board reader)
   *   playerColor  'w' | 'b' — must match the side to move implied by parity
   * @returns {null | { name, pvs: [{ uci, san, score, lineIndex }], ply }}
   *   pvs are ordered: primary line first, then distinct alternates.
   */
  function lookup(args) {
    const history = Array.isArray(args && args.moveHistory) ? args.moveHistory : [];
    const playerColor = args && args.playerColor === 'b' ? 'b' : 'w';
    if (history.length >= MAX_BOOK_PLIES) return null;

    // It must genuinely be the player's move next.
    const whiteToMove = history.length % 2 === 0;
    if (whiteToMove !== (playerColor === 'w')) return null;

    let matches = [];
    for (let i = 0; i < LINES.length; i++) {
      const line = LINES[i];
      if (line.side !== playerColor) continue;
      if (line.moves.length <= history.length) continue;
      let ok = true;
      for (let p = 0; p < history.length; p++) {
        if (line.moves[p].san !== history[p]) { ok = false; break; }
      }
      if (ok) matches.push({ line, index: i, depth: history.length });
    }
    if (matches.length === 0) return null;

    // Deepest match first (most specific theory), then line priority.
    matches.sort((a, b) => b.depth - a.depth || a.index - b.index);

    const seen = new Set();
    const pvs = [];
    for (const m of matches) {
      const next = m.line.moves[history.length];
      if (seen.has(next.uci)) continue;
      seen.add(next.uci);
      pvs.push({
        uci: next.uci,
        san: next.san,
        // Deliberately small, descending scores: book order is a curated
        // preference, not an evaluation. Rendered in the book lane.
        score: 40 - pvs.length * 15,
        lineName: m.line.name
      });
      if (pvs.length >= 3) break;
    }
    if (pvs.length === 0) return null;
    return { name: matches[0].line.name, pvs, ply: history.length };
  }

  const exported = { lookup, LINES, MAX_BOOK_PLIES };
  root.AttackBook = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
