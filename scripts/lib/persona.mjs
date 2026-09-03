// Persona move-selection pipeline, reproduced faithfully for offline harnesses.
//
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// This drives the SAME decision layer the extension ships (LocalEngine ->
// attack lane -> ChessHintEngine.selectPVForStyle) against self-play or
// replayed PGNs. It never touches a live game.
//
// The attack-lane assembly mirrors background.js `buildAttackLane`; if that
// function changes, mirror it here (the harness is only useful while it
// reproduces production).

export function attackLane(mods, result, fen, playerColor, quality, divergence) {
  const { attackCandidates, local } = mods;
  if (!attackCandidates || !local) return null;
  if (divergence && divergence.attackLane === false) return null;
  const cloudMoves = (result.pvs || []).map((p) => p && p.pv && p.pv[0]).filter(Boolean);
  const candidates = attackCandidates.rootCandidates({ fen, playerColor, cloudMoves });
  if (!candidates.length) return null;
  const verifyDepth = Math.max(5, ((quality && quality.localDepth) || 4) + 1);
  const verifyTime = Math.max(200, ((quality && quality.localTimeMs) || 180) * 2);
  const searched = local.analyzeCandidates(fen, candidates, { maxDepth: verifyDepth, timeMs: verifyTime });
  if (!searched.length) return null;
  const reference = local.analyze(fen, { multiPv: 1, maxDepth: verifyDepth, timeMs: verifyTime });
  const toMover = (score) => (playerColor === 'w' ? Number(score) || 0 : -(Number(score) || 0));
  const referenceScore = reference && reference.pvs && reference.pvs[0] ? toMover(reference.pvs[0].score) : null;
  const windowCp = Number.isFinite(divergence && divergence.maxDivergenceCp)
    ? Math.max(30, divergence.maxDivergenceCp * 2)
    : 60;
  const extras = searched
    .filter((c) => c && c.pv && c.pv[0] && !cloudMoves.includes(c.pv[0]))
    .filter((c) => referenceScore === null || c.scoreType === 'mate' || toMover(c.score) >= referenceScore - windowCp)
    .slice(0, 2);
  if (!extras.length) return null;
  return {
    ...result,
    poolExpanded: true,
    attackLane: true,
    pvs: [
      ...result.pvs,
      ...extras.map((c, index) => ({
        multipv: result.pvs.length + index + 1,
        scoreType: c.scoreType,
        score: c.score,
        depth: c.depth,
        seldepth: c.depth,
        pv: c.pv,
        nodes: 0,
        nps: 0,
        time: 0,
        attackCandidate: true,
        candidateKind: c.kind,
        candidateTag: c.tag
      }))
    ]
  };
}

const toMover = (pv, playerColor) => {
  const score = Number(pv.score) || 0;
  return playerColor === 'w' ? score : -score;
};

// One persona decision. Returns the played move plus the three numbers the
// Phase 0 baseline is defined in terms of: objective best, eval donation
// (objective best minus played, mover-relative cp) and whether it diverged.
export function personaDecision(mods, fen, playerColor, options = {}) {
  const { local, engine, policy } = mods;
  const style = options.style || 'super_ultra_aggressive';
  const settings = { style, analysisQuality: options.analysisQuality || 'auto' };
  const quality = policy.resolveQuality(settings);
  const multiPv = policy.resolveMultiPv(settings, {});
  const base = local.analyze(fen, {
    multiPv: Math.max(3, multiPv),
    maxDepth: options.depth || quality.localDepth,
    timeMs: options.timeMs || quality.localTimeMs
  });
  if (!base || !base.pvs || !base.pvs.length) return null;

  const objectiveBestUci = base.pvs[0].pv[0];
  const objectiveBestScore = toMover(base.pvs[0], playerColor);

  const divergence = policy.divergencePolicyFor(options.opponentRating);
  let pool = base;
  if (style !== 'normal' && options.attackLane !== false) {
    pool = attackLane(mods, base, fen, playerColor, quality, divergence) || base;
  }

  const ranked = engine.selectPVForStyle(
    pool.pvs.map((pv) => ({ ...pv })),
    fen,
    style,
    playerColor,
    {
      aggressionLevel: options.aggressionLevel,
      activePlan: options.activePlan,
      opponentRating: options.opponentRating,
      earlyKingHuntEnabled: options.earlyKingHuntEnabled === true
    }
  );
  const top = ranked && ranked[0];
  if (!top || !top.pv || !top.pv[0]) return null;
  const played = top.pv[0];
  const playedScore = toMover(top, playerColor);
  const analysis = top._styleAnalysis || {};
  return {
    uci: played,
    plan: analysis.plan || null,
    objectiveBest: objectiveBestUci,
    objectiveScore: objectiveBestScore,
    playedScore,
    // Donation uses the pool's own scores, so an attack-lane extra is charged
    // against the objective line it displaced.
    donationCp: Math.max(0, Math.round(objectiveBestScore - playedScore)),
    diverged: played !== objectiveBestUci,
    attackCandidate: analysis.attackCandidate === true,
    divergenceBand: analysis.divergenceBand || divergence.band,
    reasons: analysis.reasons || [],
    styleAnalysis: analysis
  };
}
