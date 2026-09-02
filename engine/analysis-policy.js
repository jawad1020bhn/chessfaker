/*
 * Analysis quality, MultiPV, ensemble rules, and user-facing quality labels.
 * Settings describe goals. This module maps them onto provider-specific work.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 */
(function (root) {
  'use strict';

  const QUALITY_IDS = Object.freeze(['auto', 'fast', 'balanced', 'deep']);
  const MAX_PROVIDER_LINES = 5;

  const QUALITY_PROFILES = Object.freeze({
    fast: {
      id: 'fast',
      label: 'Fast',
      chessApiDepth: 8,
      chessApiTimeMs: 50,
      localDepth: 3,
      localTimeMs: 80,
      preferLocalBeforeCloud: false,
      preferLocalOnHumanSource: true
    },
    balanced: {
      id: 'balanced',
      label: 'Balanced',
      chessApiDepth: 12,
      chessApiTimeMs: 100,
      localDepth: 5,
      localTimeMs: 220,
      preferLocalBeforeCloud: false,
      preferLocalOnHumanSource: true
    },
    deep: {
      id: 'deep',
      label: 'Deep',
      chessApiDepth: 18,
      chessApiTimeMs: 160,
      localDepth: 6,
      localTimeMs: 450,
      preferLocalBeforeCloud: false,
      preferLocalOnHumanSource: true
    },
    auto: {
      id: 'auto',
      label: 'Auto',
      chessApiDepth: 12,
      chessApiTimeMs: 100,
      localDepth: 4,
      localTimeMs: 180,
      preferLocalBeforeCloud: false,
      preferLocalOnHumanSource: true
    }
  });

  function normalizeQuality(value) {
    return QUALITY_IDS.includes(value) ? value : 'auto';
  }

  function normalizeCandidateLines(value) {
    if (value === 3 || value === 5 || value === '3' || value === '5') return Number(value);
    return 'auto';
  }

  function migrateLegacySettings(raw = {}) {
    const next = { ...raw };
    if (next.analysisQuality == null && next.depthTarget != null) {
      const depth = Number(next.depthTarget);
      if (depth >= 30) next.analysisQuality = 'deep';
      else if (depth >= 20) next.analysisQuality = 'balanced';
      else if (depth >= 15) next.analysisQuality = 'fast';
      else next.analysisQuality = 'auto';
    }
    if (next.candidateLines == null && next.cloudDepth != null) {
      const lines = Number(next.cloudDepth);
      if (lines >= 5) next.candidateLines = 5;
      else if (lines >= 3) next.candidateLines = 3;
      else next.candidateLines = 'auto';
    }
    delete next.depthTarget;
    delete next.cloudDepth;
    delete next.whiteRepertoire;
    delete next.blackRepertoire;
    delete next.repertoire;
    next.analysisQuality = normalizeQuality(next.analysisQuality);
    next.candidateLines = normalizeCandidateLines(next.candidateLines);
    return next;
  }

  function resolveQuality(settings = {}, extras = {}) {
    const requested = normalizeQuality(settings.analysisQuality);
    if (requested !== 'auto') return QUALITY_PROFILES[requested];
    // The objective profile keeps the conservative default; the Aggressive
    // persona always escalates depth.
    if (settings.style === 'normal') return QUALITY_PROFILES.auto;
    return { ...QUALITY_PROFILES.auto, chessApiDepth: 14, localDepth: 5, localTimeMs: 240 };
  }

  function resolveMultiPv(settings = {}, extras = {}) {
    const requested = normalizeCandidateLines(settings.candidateLines);
    if (requested === 3 || requested === 5) return requested;
    if (extras.earlyKingHunt || settings.style !== 'normal') return 5;
    return 2;
  }

  // Opponent-aware aggression (F2, inverted). Chaos only pays when the
  // DEFENDER's mistakes convert the attack — so the hint must never donate
  // the compensation first. Weaker opposition therefore gets the sound
  // "fastest win" discipline (they will hand the game over anyway), the club
  // band gets the signature persona, and stronger opposition goes back to
  // sound. Max Chaos (Level III) is an explicit user choice only: Auto must
  // never return it on any rating input. Unknown ratings return null and the
  // panel falls back to Level II.
  function suggestAggressionLevel(rating) {
    const n = Number(rating);
    if (!Number.isFinite(n) || n < 100 || n > 4000) return null;
    if (n < 1000) return 1;
    if (n <= 1400) return 2;
    return 1;
  }

  // ── Phase 4: strength-gated divergence ────────────────────────────────
  // "Genuinely different from the engine" and "beats a strong opponent" are in
  // direct conflict: a different move is, by definition, usually a worse move,
  // and above club level the opponent punishes it. So the persona is a real
  // attacker where that pays and converges to the objective move where it does
  // not. This is the single policy every divergence knob reads.
  //
  //   divergenceScale  scales the divergence premium (0 = never reward being
  //                    different for its own sake)
  //   maxDivergenceCp  hard ceiling on the eval a non-objective pick may cost
  //   attackLane       whether generated (non-engine) candidates are produced
  //   objectiveOnly    the persona plays the engine's move; style is
  //                    presentation only
  //
  // An UNKNOWN rating is treated as the sound band, never as full chaos: a
  // missing scrape must make the hint safer, not wilder.
  const DIVERGENCE_BANDS = Object.freeze({
    novice: { band: 'novice', level: 1, divergenceScale: 1, maxDivergenceCp: 120, attackLane: true, objectiveOnly: false },
    club: { band: 'club', level: 2, divergenceScale: 0.7, maxDivergenceCp: 60, attackLane: true, objectiveOnly: false },
    sound: { band: 'sound', level: 1, divergenceScale: 0.35, maxDivergenceCp: 30, attackLane: false, objectiveOnly: false },
    strong: { band: 'strong', level: 1, divergenceScale: 0.15, maxDivergenceCp: 15, attackLane: false, objectiveOnly: false },
    expert: { band: 'expert', level: 1, divergenceScale: 0, maxDivergenceCp: 0, attackLane: false, objectiveOnly: true }
  });

  function divergencePolicyFor(rating) {
    const n = Number(rating);
    if (!Number.isFinite(n) || n < 100 || n > 4000) return DIVERGENCE_BANDS.sound;
    if (n < 1000) return DIVERGENCE_BANDS.novice;
    if (n <= 1300) return DIVERGENCE_BANDS.club;
    if (n <= 1400) return DIVERGENCE_BANDS.sound;
    if (n <= 1700) return DIVERGENCE_BANDS.strong;
    return DIVERGENCE_BANDS.expert;
  }

  function clampProviderLines(multiPv) {
    return Math.max(1, Math.min(MAX_PROVIDER_LINES, Number(multiPv) || 2));
  }

  function qualityClassFor(result = {}, extras = {}) {
    if (!result || result.error) return 'unavailable';
    if (extras.positionReliable === false) return 'unreliable';
    if (result.source === 'tablebase') return 'perfect';
    if (result.stale) return 'stale-fallback';
    if (result.source === 'masters-explorer' || result.source === 'opening-explorer') return 'opening-statistics';
    if (result.source === 'local-engine') {
      return (result.depth || 0) >= 5 ? 'local-engine' : 'shallow-engine';
    }
    if (result.source === 'lichess-cloud' || result.source === 'chess-api') {
      if (result.cached && !result.stale && (result.depth || 0) >= 20) return 'cloud-cached';
      if ((result.depth || 0) >= 18) return 'deep-engine';
      if ((result.depth || 0) > 0 && (result.depth || 0) < 12) return 'shallow-engine';
      return result.cached ? 'cloud-cached' : 'deep-engine';
    }
    return 'unknown';
  }

  const QUALITY_LABELS = Object.freeze({
    perfect: { id: 'perfect', label: 'Perfect', badge: 'TB', detail: 'Tablebase, exact play' },
    'deep-engine': { id: 'deep-engine', label: 'Deep engine', badge: 'ENGINE', detail: 'Live engine evaluation' },
    'cloud-cached': { id: 'cloud-cached', label: 'Cloud cached', badge: 'CLOUD', detail: 'Fresh cached engine evaluation' },
    'local-engine': { id: 'local-engine', label: 'Local engine', badge: 'LOCAL', detail: 'On-device search fallback' },
    'shallow-engine': { id: 'shallow-engine', label: 'Shallow engine', badge: 'SHALLOW', detail: 'Limited depth, use with care' },
    'opening-statistics': { id: 'opening-statistics', label: 'Opening statistics', badge: 'BOOK', detail: 'Human game frequency, not an engine eval' },
    'stale-fallback': { id: 'stale-fallback', label: 'Stale fallback', badge: 'STALE', detail: 'Older cached result while providers are unavailable' },
    unreliable: { id: 'unreliable', label: 'Unverified position', badge: 'WAIT', detail: 'Board snapshot is incomplete' },
    unavailable: { id: 'unavailable', label: 'Unavailable', badge: '—', detail: 'No usable analysis yet' },
    unknown: { id: 'unknown', label: 'Unknown', badge: '—', detail: 'Source not classified' }
  });

  function describeQuality(qualityClass) {
    return QUALITY_LABELS[qualityClass] || QUALITY_LABELS.unknown;
  }

  function isHumanSource(source) {
    return source === 'masters-explorer' || source === 'opening-explorer';
  }

  function isEngineSource(source) {
    return source === 'chess-api' || source === 'lichess-cloud' || source === 'local-engine';
  }

  function shouldReplaceHumanWithEngine(result, fen, settings = {}) {
    if (!result || !isHumanSource(result.source)) return false;
    const reliability = root.ApiReliability;
    if (reliability && typeof reliability.isPlausibleOpeningFen === 'function') {
      return !reliability.isPlausibleOpeningFen(fen);
    }
    const fullmove = Number(String(fen || '').split(' ')[5]) || 1;
    return fullmove > 10 || settings.style === 'super_ultra_aggressive';
  }

  function attachQuality(result, extras = {}) {
    if (!result || result.error) return result;
    const qualityClass = extras.qualityClass || qualityClassFor(result, extras);
    const meta = describeQuality(qualityClass);
    result.qualityClass = qualityClass;
    result.qualityLabel = meta.label;
    result.qualityDetail = meta.detail;
    result.qualityBadge = meta.badge;
    return result;
  }

  function chessApiRequestParams(profile, multiPv) {
    return {
      depth: profile.chessApiDepth,
      maxThinkingTime: profile.chessApiTimeMs,
      variants: clampProviderLines(multiPv)
    };
  }

  const exported = {
    suggestAggressionLevel,
    divergencePolicyFor,
    DIVERGENCE_BANDS,
    QUALITY_IDS,
    QUALITY_PROFILES,
    QUALITY_LABELS,
    MAX_PROVIDER_LINES,
    normalizeQuality,
    normalizeCandidateLines,
    migrateLegacySettings,
    resolveQuality,
    resolveMultiPv,
    clampProviderLines,
    qualityClassFor,
    describeQuality,
    isHumanSource,
    isEngineSource,
    shouldReplaceHumanWithEngine,
    attachQuality,
    chessApiRequestParams
  };
  root.AnalysisPolicy = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
