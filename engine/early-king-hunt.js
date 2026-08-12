/**
 * Early Full Advanced King Hunt
 *
 * Optional, style-scoped add-on for the `super_ultra_aggressive` profile.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 * This module only ranks hypothetical analysis lines. It does not make moves,
 * inject input, or interact with a live game. It is intentionally isolated
 * from the normal and Aggressive profiles: callers must provide both the
 * exact style id and the opt-in flag before the module returns an active
 * feature set or a non-zero bonus.
 *
 * The module is deliberately dependency-light. The hint engine supplies its
 * board primitives when it creates the module, which keeps this file usable in
 * the browser extension and in the dependency-free VM test harness.
 */
(function (root) {
  'use strict';

  function createEngine(utils) {
    const U = utils || {};
    const isSquareAttacked = U.isSquareAttacked;
    const findKing = U.findKing;
    const pieceAttacksSquare = U.pieceAttacksSquare;
    const detectGamePhase = U.detectGamePhase;

    const profile = {
      id: 'early_king_hunt',
      name: 'Early Full Advanced King Hunt',
      enabledStyle: 'super_ultra_aggressive',
      // The first ten full moves get the full treatment. The score fades out
      // through move sixteen so the add-on cannot quietly become a permanent
      // style modifier in the middlegame or endgame.
      openingMoveLimit: 10,
      fadeMoveLimit: 16,
      weights: {
        directAttack: 180,
        openLine: 135,
        immediateThreat: 145,
        forceResponse: 105,
        deployment: 72,
        targetVulnerability: 90,
        attackMomentum: 100,
        soundSacrifice: 175,
        speculativeSacrifice: 65,
        passivity: -105,
        ownKingRisk: -100,
        unsupportedAttack: -55,
        slowQueen: -45,
        concreteCompensation: 80
      }
    };

    const NO_FEATURES = Object.freeze({
      earlyKingHuntActive: false,
      earlyKingHuntPhase: 'inactive',
      earlyKingHuntIntensity: 0,
      earlyKingHuntMoveNumber: 0,
      earlyKingHuntReason: 'opt-in is off or the position is outside the early phase',
      earlyKingHuntTargetVulnerability: 0,
      earlyKingHuntLineOpening: 0,
      earlyKingHuntImmediateThreat: 0,
      earlyKingHuntForceResponse: 0,
      earlyKingHuntDeployment: 0,
      earlyKingHuntAttackMomentum: 0,
      earlyKingHuntSacrificeValue: 0,
      earlyKingHuntPassivity: 0,
      earlyKingHuntOwnKingRisk: 0,
      earlyKingHuntConcreteCompensation: 0,
      earlyKingHuntDirectAttack: false,
      earlyKingHuntUnsafe: false,
      earlyKingHuntSafe: true,
      earlyKingHuntBonus: 0
    });

    function isWhite(piece) {
      return Boolean(piece) && piece === piece.toUpperCase();
    }

    function distance(a, b) {
      return a && b ? Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) : 99;
    }

    function moveNumber(fen) {
      const value = Number(String(fen || '').trim().split(/\s+/)[5]);
      return Number.isFinite(value) && value > 0 ? value : 1;
    }

    function phaseInfo(fen, style, enabled) {
      const fullmove = moveNumber(fen);
      if (style !== profile.enabledStyle || enabled !== true) {
        return { active: false, phase: 'inactive', intensity: 0, fullmove, reason: 'style or opt-in flag is inactive' };
      }
      // A low-material endgame should never receive an early-opening bonus,
      // even when a reconstructed FEN has an old move counter.
      if (typeof detectGamePhase === 'function' && detectGamePhase(fen) === 'endgame') {
        return { active: false, phase: 'inactive', intensity: 0, fullmove, reason: 'endgame safety boundary' };
      }
      if (fullmove <= profile.openingMoveLimit) {
        return { active: true, phase: 'opening', intensity: 1, fullmove, reason: 'early opening phase' };
      }
      if (fullmove < profile.fadeMoveLimit) {
        const span = profile.fadeMoveLimit - profile.openingMoveLimit;
        const intensity = Math.max(0, 1 - ((fullmove - profile.openingMoveLimit) / span));
        return { active: intensity > 0, phase: 'transition', intensity, fullmove, reason: 'early-phase transition fade' };
      }
      return { active: false, phase: 'inactive', intensity: 0, fullmove, reason: 'early phase has ended' };
    }

    function kingZoneLinePressure(board, attackerIsWhite, king) {
      if (!king || typeof pieceAttacksSquare !== 'function') return { lines: 0, sliders: 0, zone: 0 };
      let lines = 0;
      let sliders = 0;
      let zone = 0;
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        const piece = board?.[row]?.[col];
        if (!piece || isWhite(piece) !== attackerIsWhite) continue;
        const type = piece.toLowerCase();
        if (!['b', 'r', 'q'].includes(type)) continue;
        if (pieceAttacksSquare(board, row, col, king.row, king.col)) {
          lines++;
          sliders++;
          continue;
        }
        let attacksZone = false;
        for (let dr = -1; dr <= 1 && !attacksZone; dr++) for (let dc = -1; dc <= 1 && !attacksZone; dc++) {
          const targetRow = king.row + dr;
          const targetCol = king.col + dc;
          if (targetRow < 0 || targetRow > 7 || targetCol < 0 || targetCol > 7) continue;
          if (pieceAttacksSquare(board, row, col, targetRow, targetCol)) attacksZone = true;
        }
        if (attacksZone) {
          zone++;
          if (type !== 'q') sliders++;
        }
      }
      if (typeof isSquareAttacked === 'function' && isSquareAttacked(board, king, attackerIsWhite ? 'w' : 'b')) lines++;
      return { lines, sliders, zone };
    }

    function shieldGaps(board, king, enemyIsWhite) {
      if (!king) return 0;
      const forward = enemyIsWhite ? -1 : 1;
      const row = king.row + forward;
      if (row < 0 || row > 7) return 0;
      let gaps = 0;
      for (let dc = -1; dc <= 1; dc++) {
        const col = king.col + dc;
        if (col < 0 || col > 7) continue;
        if (board?.[row]?.[col] !== (enemyIsWhite ? 'P' : 'p')) gaps++;
      }
      return gaps;
    }

    function kingEscapePressure(board, attackerIsWhite, king) {
      if (!king || typeof isSquareAttacked !== 'function') return 0;
      let covered = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const row = king.row + dr;
        const col = king.col + dc;
        if (row < 0 || row > 7 || col < 0 || col > 7) continue;
        if (board?.[row]?.[col] || isSquareAttacked(board, { row, col }, attackerIsWhite ? 'w' : 'b')) covered++;
      }
      return covered;
    }

    function targetVulnerability(board, attackerIsWhite, king) {
      if (!king) return 0;
      const lines = kingZoneLinePressure(board, attackerIsWhite, king);
      const gaps = shieldGaps(board, king, !attackerIsWhite);
      const escapePressure = kingEscapePressure(board, attackerIsWhite, king);
      const homeRow = attackerIsWhite ? 0 : 7;
      const uncastled = king.row === homeRow && king.col === 4 ? 0 : 1;
      return Math.min(10, lines.lines * 1.4 + lines.zone * 0.8 + gaps * 1.4 + escapePressure * 0.35 + uncastled);
    }

    function numeric(value) {
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    }

    function computeFeatures(ctx = {}) {
      const {
        fen,
        board,
        after,
        piece,
        captured,
        destination,
        playerIsWhite,
        playerColor,
        opponentKingBefore,
        opponentKingAfter,
        ownKingAfter,
        givesCheck,
        candidate = ctx
      } = ctx;
      const info = phaseInfo(fen, ctx.style, ctx.earlyKingHuntEnabled);
      if (!info.active) return { ...NO_FEATURES, earlyKingHuntMoveNumber: info.fullmove, earlyKingHuntReason: info.reason };

      const beforeLines = kingZoneLinePressure(board, playerIsWhite, opponentKingBefore);
      const afterLines = kingZoneLinePressure(after, playerIsWhite, opponentKingAfter);
      const lineOpening = Math.max(0,
        (afterLines.lines - beforeLines.lines) +
        (afterLines.zone - beforeLines.zone) * 0.5 +
        (candidate.opensKingFile ? 1 : 0)
      );
      const beforeVulnerability = targetVulnerability(board, playerIsWhite, opponentKingBefore);
      const afterVulnerability = targetVulnerability(after, playerIsWhite, opponentKingAfter);
      const targetDelta = Math.max(0, afterVulnerability - beforeVulnerability);

      const immediateThreat = Math.min(8,
        (givesCheck ? 4 : 0) +
        (candidate.winningMate ? 4 : 0) +
        Math.max(0, numeric(candidate.tempoThreatCount)) * 1.2 +
        Math.max(0, numeric(candidate.kingPressureDelta)) * 0.65 +
        (candidate.defenderRemoval ? 1 : 0)
      );
      const forceResponse = Math.min(6,
        (givesCheck ? 3 : 0) +
        Math.min(2, Math.max(0, numeric(candidate.forcingPly))) +
        (candidate.tempoThreatCount > 0 ? 1 : 0) +
        (candidate.followUpVision ? 1 : 0)
      );
      const deployment = Math.min(5,
        (candidate.developmentWithAttack ? 2.5 : 0) +
        (candidate.development && candidate.kingPressureDelta > 0 ? 1.5 : 0) +
        (candidate.attackUnitDelta > 0 ? Math.min(1, candidate.attackUnitDelta) : 0) +
        (candidate.penetrationDelta > 0 ? 0.75 : 0)
      );
      const attackMomentum = Math.min(10,
        Math.max(0, numeric(candidate.kingPressureDelta)) * 0.8 +
        Math.max(0, numeric(candidate.attackUnitDelta)) * 0.7 +
        Math.max(0, numeric(candidate.penetrationDelta)) * 0.6 +
        Math.max(0, numeric(candidate.pawnStormDelta)) * 0.7 +
        Math.max(0, numeric(candidate.playerForcingMoves)) * 0.55 +
        Math.max(0, numeric(candidate.followUpVision)) * 0.8
      );
      const directAttack = Boolean(
        givesCheck || lineOpening > 0 || targetDelta > 0 ||
        numeric(candidate.kingPressureDelta) > 0 || candidate.opensKingFile
      );
      const concreteCompensation = Math.min(10,
        immediateThreat + forceResponse * 0.7 + attackMomentum * 0.45 + lineOpening * 0.8
      );
      const sacrifice = Boolean(candidate.sacrifice || numeric(candidate.materialDelta) <= -180);
      const sacrificeValue = sacrifice
        ? Math.min(10, concreteCompensation + (candidate.winningMate ? 4 : 0) + (candidate.defenderRemoval ? 1 : 0))
        : 0;
      const passive = !directAttack && !candidate.developmentWithAttack &&
        !candidate.givesCheck && !candidate.defenderRemoval &&
        !candidate.tempo && !candidate.sacrifice
        ? Math.min(5, 1 + (candidate.development ? 1 : 0) + (candidate.simplification > 1 ? 2 : 0))
        : 0;
      const ownKingRisk = Math.max(0,
        numeric(candidate.ownKingDangerDelta) +
        (candidate.ownKingTrapped ? 6 : 0) +
        (candidate.losingMate ? 10 : 0)
      );
      const unsafe = Boolean(
        candidate.losingMate || candidate.ownKingTrapped ||
        (ownKingRisk > 5 && concreteCompensation < 4) ||
        (sacrifice && sacrificeValue < 2.5)
      );
      const directAttackScore = Math.min(10,
        immediateThreat * 0.9 + lineOpening * 1.1 + targetDelta * 0.7 + forceResponse * 0.7
      );

      return {
        earlyKingHuntActive: true,
        earlyKingHuntPhase: info.phase,
        earlyKingHuntIntensity: info.intensity,
        earlyKingHuntMoveNumber: info.fullmove,
        earlyKingHuntReason: info.reason,
        earlyKingHuntTargetVulnerability: Number(targetDelta.toFixed(3)),
        earlyKingHuntLineOpening: Number(lineOpening.toFixed(3)),
        earlyKingHuntImmediateThreat: Number(immediateThreat.toFixed(3)),
        earlyKingHuntForceResponse: Number(forceResponse.toFixed(3)),
        earlyKingHuntDeployment: Number(deployment.toFixed(3)),
        earlyKingHuntAttackMomentum: Number(attackMomentum.toFixed(3)),
        earlyKingHuntSacrificeValue: Number(sacrificeValue.toFixed(3)),
        earlyKingHuntPassivity: Number(passive.toFixed(3)),
        earlyKingHuntOwnKingRisk: Number(ownKingRisk.toFixed(3)),
        earlyKingHuntConcreteCompensation: Number(concreteCompensation.toFixed(3)),
        earlyKingHuntDirectAttack: directAttack,
        earlyKingHuntDirectAttackScore: Number(directAttackScore.toFixed(3)),
        earlyKingHuntUnsafe: unsafe,
        earlyKingHuntSafe: !unsafe,
        earlyKingHuntBonus: 0,
        // These aliases make the feature easy to inspect in diagnostics and
        // keep the terminology readable to callers outside this module.
        earlyTargetVulnerability: Number(targetDelta.toFixed(3)),
        earlyLineOpening: Number(lineOpening.toFixed(3)),
        earlyAttackMomentum: Number(attackMomentum.toFixed(3)),
        earlySacrificeCompensation: Number(sacrificeValue.toFixed(3)),
        earlyPhaseIntensity: info.intensity,
        earlyKingDistance: distance(opponentKingAfter, destination),
        earlyOwnKingDistance: distance(ownKingAfter, destination),
        earlyKingHuntPlayerColor: playerColor
      };
    }

    function styleBonus(candidate, weights = profile.weights) {
      if (!candidate?.earlyKingHuntActive || candidate.earlyKingHuntIntensity <= 0) return 0;
      const intensity = candidate.earlyKingHuntIntensity;
      let amount = 0;
      const add = (condition, key, value, reason) => {
        if (!condition || !Number.isFinite(value) || value === 0) return;
        amount += value;
        if (value > 0 && reason && Array.isArray(candidate.reasons)) candidate.reasons.push(reason);
        if (value < 0 && reason && Array.isArray(candidate.risks)) candidate.risks.push(reason);
      };
      const scaled = (key, factor = 1) => numeric(weights[key]) * factor * intensity;

      add(candidate.earlyKingHuntDirectAttackScore > 0, 'directAttack',
        scaled('directAttack', Math.min(2, candidate.earlyKingHuntDirectAttackScore / 3)),
        'launches the Early King Hunt directly at the king');
      add(candidate.earlyKingHuntLineOpening > 0, 'openLine',
        scaled('openLine', Math.min(3, candidate.earlyKingHuntLineOpening)),
        'opens a line toward the enemy king');
      add(candidate.earlyKingHuntImmediateThreat > 0, 'immediateThreat',
        scaled('immediateThreat', Math.min(3, candidate.earlyKingHuntImmediateThreat / 2)),
        'creates an immediate early tactical threat');
      add(candidate.earlyKingHuntForceResponse > 0, 'forceResponse',
        scaled('forceResponse', Math.min(3, candidate.earlyKingHuntForceResponse / 2)),
        'forces the opponent to defend instead of developing');
      add(candidate.earlyKingHuntDeployment > 0, 'deployment',
        scaled('deployment', Math.min(3, candidate.earlyKingHuntDeployment / 2)),
        'accelerates attacking piece deployment');
      add(candidate.earlyKingHuntTargetVulnerability > 0, 'targetVulnerability',
        scaled('targetVulnerability', Math.min(3, candidate.earlyKingHuntTargetVulnerability / 2)),
        'targets an early weakness around the king');
      add(candidate.earlyKingHuntAttackMomentum > 0, 'attackMomentum',
        scaled('attackMomentum', Math.min(3, candidate.earlyKingHuntAttackMomentum / 3)),
        'keeps the attack gaining momentum');

      if (candidate.sacrifice) {
        const compensation = candidate.earlyKingHuntSacrificeValue;
        add(compensation >= 4, 'soundSacrifice', scaled('soundSacrifice', Math.min(2.5, compensation / 4)),
          'sacrifices material for concrete early attacking compensation');
        add(compensation > 0 && compensation < 4, 'speculativeSacrifice', scaled('speculativeSacrifice', 1),
          'accepts a speculative sacrifice only because it keeps the king under fire');
        add(compensation <= 0, 'speculativeSacrifice', -Math.abs(scaled('speculativeSacrifice', 1)),
          'sacrifice has no concrete early king-hunt compensation');
      }

      add(candidate.earlyKingHuntPassivity > 0, 'passivity',
        scaled('passivity', candidate.earlyKingHuntPassivity),
        'avoids a passive early move with no attacking purpose');
      add(candidate.earlyKingHuntOwnKingRisk > 0, 'ownKingRisk',
        -Math.abs(scaled('ownKingRisk', Math.min(3, candidate.earlyKingHuntOwnKingRisk / 2))),
        'keeps enough respect for your own king');
      add(candidate.unsupportedAttack && candidate.earlyKingHuntConcreteCompensation < 5, 'unsupportedAttack',
        -Math.abs(scaled('unsupportedAttack', 1)),
        'the early attacking piece is not adequately supported');
      add(candidate.earlyQueenMove && !candidate.earlyKingHuntDirectAttack && !candidate.tempo, 'slowQueen',
        -Math.abs(scaled('slowQueen', 1)),
        'early queen sortie lacks a forcing target');
      add(candidate.earlyKingHuntConcreteCompensation >= 4, 'concreteCompensation',
        scaled('concreteCompensation', Math.min(2, candidate.earlyKingHuntConcreteCompensation / 4)),
        'has concrete compensation for the attacking risk');

      candidate.earlyKingHuntBonus = Math.round(amount);
      return amount;
    }

    function annotate(features) {
      if (!features?.earlyKingHuntActive) return [];
      const tags = ['early king hunt'];
      if (features.earlyKingHuntLineOpening > 0) tags.push('opens king lines');
      if (features.earlyKingHuntImmediateThreat > 0) tags.push('immediate threat');
      if (features.earlyKingHuntDeployment > 0) tags.push('rapid deployment');
      if (features.earlyKingHuntForceResponse > 0) tags.push('forces defense');
      if (features.earlyKingHuntSacrificeValue >= 4) tags.push('sound attacking sacrifice');
      return tags;
    }

    function choosePlan(features) {
      if (!features?.earlyKingHuntActive) return null;
      if (features.earlyKingHuntImmediateThreat >= 4 && features.earlyKingHuntForceResponse >= 3) return 'launch the Early King Hunt with forcing checks';
      if (features.earlyKingHuntLineOpening > 0) return 'open lines and bring every attacker toward the king';
      if (features.earlyKingHuntDeployment > 0) return 'develop with tempo and accelerate the king-side attack';
      if (features.earlyKingHuntSacrificeValue >= 4) return 'sacrifice only where the king cannot escape the attack';
      if (features.earlyKingHuntTargetVulnerability > 0) return 'strike the exposed king before it can consolidate';
      return 'keep the initiative and prepare the next direct king attack';
    }

    return {
      profile,
      computeFeatures,
      styleBonus,
      annotate,
      choosePlan,
      phaseInfo,
      isActive: (style, enabled, fen) => phaseInfo(fen, style, enabled).active,
      isEnabledForStyle: (style, enabled) => style === profile.enabledStyle && enabled === true
    };
  }

  const api = { createEngine };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (root) root.EarlyKingHunt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
