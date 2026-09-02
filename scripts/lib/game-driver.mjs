// Minimal game driver + rating-banded opponent models for the strength harness.
//
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// Self-play only: both sides are local code, no live game is observed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Rating bands for the opponent model. Depth is what the on-device search can
// actually deliver in harness time; `slipRate` is how often the opponent plays
// a non-best legal move (the practical difference between bands at this scale).
export const BANDS = {
  1200: { depth: 2, timeMs: 90, slipRate: 0.3, slipWindow: 6 },
  1500: { depth: 3, timeMs: 140, slipRate: 0.12, slipWindow: 4 },
  1800: { depth: 4, timeMs: 220, slipRate: 0.04, slipWindow: 3 }
};

export function bandFor(rating) {
  return BANDS[rating] || BANDS[1500];
}

export function materialCount(core, fen) {
  const parsed = core.parseFen(fen);
  if (!parsed) return 0;
  let count = 0;
  for (const row of parsed.board) for (const piece of row) if (piece && piece.toLowerCase() !== 'k') count++;
  return count;
}

// Terminal detection: mate / stalemate / 50-move / threefold / bare kings.
export function terminalState(mods, fen, seen) {
  const { contract, core } = mods;
  const legal = contract.generateLegalMoves(fen);
  const parsed = core.parseFen(fen);
  const whiteToMove = parsed.parts[1] === 'w';
  if (!legal.length) {
    const inCheck = contract.kingInCheck(parsed.board, whiteToMove);
    if (inCheck) return { over: true, result: whiteToMove ? '0-1' : '1-0', reason: 'checkmate' };
    return { over: true, result: '1/2-1/2', reason: 'stalemate' };
  }
  if ((Number(parsed.parts[4]) || 0) >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move' };
  const key = fen.split(' ').slice(0, 4).join(' ');
  if (seen && (seen.get(key) || 0) >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold' };
  if (materialCount(core, fen) === 0) return { over: true, result: '1/2-1/2', reason: 'bare kings' };
  return { over: false, legal };
}

// Opponent model: shallow objective search, with a band-dependent chance of
// playing a slightly worse legal move (the "1200 vs 1800" difference here).
export function opponentMove(mods, fen, playerColor, band, rand) {
  const { local, contract } = mods;
  const analysis = local.analyze(fen, {
    multiPv: Math.max(1, band.slipWindow),
    maxDepth: band.depth,
    timeMs: band.timeMs
  });
  const legal = contract.generateLegalMoves(fen);
  if (!analysis || !analysis.pvs || !analysis.pvs.length) {
    return legal[Math.floor(rand() * legal.length)] || null;
  }
  const moves = analysis.pvs.map((pv) => pv.pv[0]).filter(Boolean);
  if (rand() < band.slipRate) {
    const pool = moves.length > 1 ? moves.slice(1) : legal;
    return pool[Math.floor(rand() * pool.length)] || moves[0];
  }
  return moves[0];
}
