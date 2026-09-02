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

export function attackLane(mods, result, fen, playerColor, quality) {
  const { attackCandidates, local } = mods;
  if (!attackCandidates || !local) return null;
  const cloudMoves = (result.pvs || []).map((p) => p && p.pv && p.pv[0]).filter(Boolean);
  const candidates = attackCandidates.rootCandidates({ fen, playerColor, cloudMoves });
  if (!candidates.length) return null;
  const searched = local.analyzeCandidates(fen, candidates, {
    maxDepth: Math.max(4, (quality && quality.localDepth) || 4),
    timeMs: Math.max(120, (quality && quality.localTimeMs) || 180)
  });
  const extras = searched.filter((c) => c && c.pv && c.pv[0] && !cloudMoves.includes(c.pv[0])).slice(0, 6);
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

  let pool = base;
  if (style !== 'normal' && options.attackLane !== false) {
    pool = attackLane(mods, base, fen, playerColor, quality) || base;
  }

  const ranked = engine.selectPVForStyle(
    pool.pvs.map((pv) => ({ ...pv })),
    fen,
    style,
    playerColor,
    {
      aggressionLevel: options.aggressionLevel,
      activePlan: options.activePlan,
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
    reasons: analysis.reasons || [],
    styleAnalysis: analysis
  };
}
