importScripts('engine/core-utils.js', 'engine/api-coordinator.js');

/**
 * Chess Hint Assistant — Background Service Worker
 * Centralized API reliability, cache, quota, and cooldown protection
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 * This project is a study/research tool for building a chess engine that can
 * play in a variety of styles (normal, aggressive, ultra-aggressive). It is
 * intended for learning, offline analysis, and engine-variation research. It
 * is anti-cheat compliant and fair-play safe: it never assists a player in a
 * rated or live online game, and it must not be used to gain an unfair
 * advantage against human opponents.
 */

// ─── Constants ───────────────────────────────────────────────────────
const KEEPALIVE_ALARM = 'chess-hint-keepalive';
// Chrome 114 enforces a one-minute minimum for repeating extension alarms.
// The worker remains suspension-safe; this alarm is only a periodic maintenance wake-up.
const KEEPALIVE_ALARM_INTERVAL_MIN = 1;

// ─── Default Settings ────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  cloudDepth: 5,
  style: 'normal',
  humanLikeMode: false,
  whiteRepertoire: 'none',
  blackRepertoire: 'none',
  autoAnalyze: true,
  showThreats: true,
  showCriticalMoments: true,
  showCorrelationStat: true,       // Engine-comparison card in the side panel position-info card
  // Which row of the comparison card to highlight. 'engine' follows the
  // historical default (engine match rate); 'human' emphasises the
  // human-like pick match rate; 'independent' surfaces the rate at which
  // the player plays a move neither side recommended.
  comparisonMode: 'engine',
  depthTarget: 0,                  // 0 = no minimum; otherwise min depth for exact hints
  // These gate background fetching that feeds opening names and tablebase-backed plans.
  showOpeningExplorer: true,
  showTablebase: true,
  // Individual analysis providers can be excluded without bypassing safeguards.
  useChessApi: true,
  useLichessCloud: true,
  useMastersExplorer: true
};

const COMPARISON_MODES = Object.freeze(['engine', 'human', 'independent']);

function normalizeSettings(value = {}) {
  const candidate = value && typeof value === 'object' ? value : {};
  const booleanKeys = [
    'humanLikeMode', 'autoAnalyze', 'showThreats',
    'showCriticalMoments', 'showCorrelationStat',
    'showOpeningExplorer', 'showTablebase',
    'useChessApi', 'useLichessCloud', 'useMastersExplorer'
  ];
  const normalized = { ...DEFAULT_SETTINGS };
  normalized.cloudDepth = ChessCore.clampNumber(candidate.cloudDepth, 1, 10, DEFAULT_SETTINGS.cloudDepth);
  normalized.depthTarget = ChessCore.clampNumber(candidate.depthTarget, 0, 40, DEFAULT_SETTINGS.depthTarget);
  normalized.style = ['normal', 'aggressive', 'super_ultra_aggressive'].includes(candidate.style)
    ? candidate.style
    : DEFAULT_SETTINGS.style;
  normalized.whiteRepertoire = typeof candidate.whiteRepertoire === 'string' ? candidate.whiteRepertoire : DEFAULT_SETTINGS.whiteRepertoire;
  normalized.blackRepertoire = typeof candidate.blackRepertoire === 'string' ? candidate.blackRepertoire : DEFAULT_SETTINGS.blackRepertoire;
  normalized.comparisonMode = COMPARISON_MODES.includes(candidate.comparisonMode)
    ? candidate.comparisonMode
    : DEFAULT_SETTINGS.comparisonMode;
  for (const key of booleanKeys) normalized[key] = typeof candidate[key] === 'boolean' ? candidate[key] : DEFAULT_SETTINGS[key];
  return normalized;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Turn-Based Analysis State Machine ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const turnState = {
  lastAnalyzedFen: null,
  lastAnalysisSource: null,
  isPlayerTurn: true,
  waitingForOpponent: false,
  analysisInProgress: false,
  autoAnalysisPending: false,
  lastPositionUpdateTime: 0,
  consecutiveFailures: 0,
  analysisDebounceTimer: null
};

let lastAnalysisGameId = null;

function shouldAnalyzePosition(fen, playerColor) {
  if (!fen || !playerColor) {
    return { shouldAnalyze: false, reason: 'missing_data', isPlayerTurn: false };
  }
  const activeColor = fen.split(' ')[1] || 'w';
  const isPlayerTurn = activeColor === playerColor;
  if (ApiReliability.canonicalAnalysisFen(fen) === ApiReliability.canonicalAnalysisFen(turnState.lastAnalyzedFen)) {
    return { shouldAnalyze: false, reason: 'same_position', isPlayerTurn };
  }
  if (!isPlayerTurn) {
    turnState.isPlayerTurn = false;
    turnState.waitingForOpponent = true;
    return { shouldAnalyze: false, reason: 'opponents_turn', isPlayerTurn: false };
  }
  turnState.isPlayerTurn = true;
  turnState.waitingForOpponent = false;
  return { shouldAnalyze: true, reason: 'players_turn_new_position', isPlayerTurn: true };
}

function markPositionAnalyzed(fen, source) {
  turnState.lastAnalyzedFen = fen;
  turnState.lastAnalysisSource = source;
}

function resetAnalysisState() {
  turnState.lastAnalyzedFen = null;
  turnState.lastAnalysisSource = null;
  turnState.isPlayerTurn = true;
  turnState.waitingForOpponent = false;
  turnState.analysisInProgress = false;
  turnState.autoAnalysisPending = false;
  turnState.consecutiveFailures = 0;
  if (turnState.analysisDebounceTimer) {
    clearTimeout(turnState.analysisDebounceTimer);
    turnState.analysisDebounceTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Central API Request Coordinator ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// These limits are intentionally conservative. Lichess documents that clients
// should make only one request at a time and stop after a 429; the coordinator
// additionally applies endpoint-specific spacing and a global request budget.
const PROVIDER_POLICIES = Object.freeze({
  chessApi: {
    maxConcurrent: 1,
    minSpacingMs: 3000,
    burstCapacity: 1,
    conservativeRequestsPerMinute: 10,
    defaultCooldownMs: 2 * 60 * 1000,
    maxCooldownMs: 30 * 60 * 1000,
    retry5xx: 1,
    retryNetwork: 1
  },
  lichessCloud: {
    maxConcurrent: 1,
    minSpacingMs: 5000,
    burstCapacity: 1,
    conservativeRequestsPerMinute: 6,
    defaultCooldownMs: 3 * 60 * 1000,
    maxCooldownMs: 60 * 60 * 1000,
    retry5xx: 0,
    retryNetwork: 1
  },
  mastersExplorer: {
    maxConcurrent: 1,
    minSpacingMs: 5000,
    burstCapacity: 1,
    conservativeRequestsPerMinute: 6,
    defaultCooldownMs: 5 * 60 * 1000,
    maxCooldownMs: 60 * 60 * 1000,
    retry5xx: 0,
    retryNetwork: 1
  },
  openingExplorer: {
    maxConcurrent: 1,
    minSpacingMs: 5000,
    burstCapacity: 1,
    conservativeRequestsPerMinute: 6,
    defaultCooldownMs: 5 * 60 * 1000,
    maxCooldownMs: 60 * 60 * 1000,
    retry5xx: 0,
    retryNetwork: 1
  },
  tablebase: {
    maxConcurrent: 1,
    minSpacingMs: 2500,
    burstCapacity: 1,
    conservativeRequestsPerMinute: 12,
    defaultCooldownMs: 2 * 60 * 1000,
    maxCooldownMs: 30 * 60 * 1000,
    retry5xx: 0,
    retryNetwork: 1
  }
});

const API_CACHE_POLICIES = Object.freeze({
  chessApi: {
    freshTtlMs: 60 * 60 * 1000,
    staleTtlMs: 2 * 60 * 60 * 1000,
    negativeTtlMs: 5 * 60 * 1000,
    networkFailureTtlMs: 20 * 1000,
    minRefreshAgeMs: 2 * 60 * 1000,
    persistent: true
  },
  lichessCloud: {
    freshTtlMs: 6 * 60 * 60 * 1000,
    staleTtlMs: 24 * 60 * 60 * 1000,
    negativeTtlMs: 20 * 60 * 1000,
    notFoundTtlMs: 20 * 60 * 1000,
    networkFailureTtlMs: 20 * 1000,
    minRefreshAgeMs: 10 * 60 * 1000,
    persistent: true
  },
  mastersExplorer: {
    freshTtlMs: 7 * 24 * 60 * 60 * 1000,
    staleTtlMs: 30 * 24 * 60 * 60 * 1000,
    negativeTtlMs: 24 * 60 * 60 * 1000,
    notFoundTtlMs: 24 * 60 * 60 * 1000,
    emptyTtlMs: 24 * 60 * 60 * 1000,
    minRefreshAgeMs: 24 * 60 * 60 * 1000,
    persistent: true
  },
  openingExplorer: {
    freshTtlMs: 72 * 60 * 60 * 1000,
    staleTtlMs: 14 * 24 * 60 * 60 * 1000,
    negativeTtlMs: 12 * 60 * 60 * 1000,
    emptyTtlMs: 12 * 60 * 60 * 1000,
    minRefreshAgeMs: 12 * 60 * 60 * 1000,
    persistent: true
  },
  tablebase: {
    freshTtlMs: 30 * 24 * 60 * 60 * 1000,
    staleTtlMs: 365 * 24 * 60 * 60 * 1000,
    negativeTtlMs: 24 * 60 * 60 * 1000,
    minRefreshAgeMs: 7 * 24 * 60 * 60 * 1000,
    persistent: true
  }
});

const coordinatorStorage = {
  async get(key) {
    const values = await chrome.storage.local.get(key);
    return values?.[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(keys) {
    await chrome.storage.local.remove(keys);
  }
};

const apiCoordinator = new ApiReliability.ApiRequestCoordinator({
  policies: PROVIDER_POLICIES,
  storage: coordinatorStorage,
  fetchFn: (url, options) => fetch(url, options),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  globalPolicy: {
    maxRemoteCallsPerMinute: 12,
    maxRemoteCallsPerGame: 80,
    maxEnrichmentCallsPerMinute: 2,
    maxRequestsPerPosition: 3,
    maxEnrichmentCallsPerPosition: 1,
    maxQueueLengthPerProvider: 20,
    maxTotalQueueLength: 50,
    maxRetriesPerWorkflow: 1
  }
});

const positionGenerations = new Map();
function registerPosition(fen, tabId = 'active') {
  const canonicalFen = ApiReliability.canonicalAnalysisFen(fen);
  if (!canonicalFen) return null;
  const key = String(tabId ?? 'active');
  const previous = positionGenerations.get(key);
  const startPlacement = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const isNewGame = canonicalFen.split(' ')[0] === startPlacement && previous && previous.canonicalFen !== canonicalFen;
  const token = previous && previous.canonicalFen === canonicalFen
    ? previous
    : {
        tabId: key,
        gameId: isNewGame || !previous ? Date.now() : previous.gameId,
        sequence: (previous?.sequence || 0) + 1,
        canonicalFen
      };
  positionGenerations.set(key, token);
  apiCoordinator.updatePosition(token);
  return token;
}

function countFenPieces(fen) {
  return ApiReliability.countFenPieces(fen);
}

function isPlausibleOpening(fen) {
  return ApiReliability.isPlausibleOpeningFen(fen);
}

function analysisCacheKey(source, fen, multiPv, depth = 0) {
  const canonicalFen = ApiReliability.canonicalAnalysisFen(fen);
  if (source === 'chess-api') return `analysis:${canonicalFen}:provider=chess-api:multipv=${multiPv}:depth=${depth}`;
  if (source === 'lichess-cloud') return `analysis:${canonicalFen}:provider=lichess-cloud:multipv=${multiPv}`;
  return `masters:${canonicalFen}:multipv=${multiPv}`;
}

function openingCacheKey(fen) {
  return `opening:${ApiReliability.canonicalAnalysisFen(fen)}:ratings=1600,1800,2000,2200,2500`;
}

function tablebaseCacheKey(fen) {
  return `tablebase:${ApiReliability.canonicalAnalysisFen(fen)}`;
}

function semanticSourceOrder(fen, settings = DEFAULT_SETTINGS) {
  return ApiReliability.planPositionWorkflow(fen, settings).analysisSources;
}


// ─── Engine-correlation / human-likeness guard ───────────────────────
// Stores the engine's first-choice UCI move keyed by FEN-of-side-to-move.
// When the side panel is in human-like mode it also stores the human-natural
// recommendation for the same FEN. A player move that blindly copies the
// engine's exact top pick (while a different human recommendation was offered)
// is flagged as "bot-like"; any natural or recommended move counts as
// "sensible/human". This drives the fair-play-safe "Sensible moves" stat.
const ENGINE_MOVE_BY_FEN_LIMIT = 200;
const engineMoveByFen = new Map();
const humanMoveByFen = new Map();
const correlationWindow = []; // array of booleans (true = human-like move)
let correlationMatches = 0;
let correlationTotal = 0;

// ─── Engine-vs-human comparison tracker ──────────────────────────────
// A side-by-side comparison: for every recorded move we capture what the
// engine's top pick was, what the human-like pick was, and what the player
// actually moved. Four independent verdicts per move (engine-match, human-
// match, played-own-natural, engine-and-human-agreed) feed four numbers in
// the UI so the player can see "I followed the engine 6/8, but the human
// pick only on 2/3" — i.e. *when* the engine and human disagreed, what did I
// do? The legacy "Sensible moves" binary above is preserved; this is a new
// shape that runs alongside it. The window is bounded to keep memory in
// check; counters are unbounded for the per-game totals.
const COMPARISON_WINDOW_LIMIT = 32;
const comparisonWindow = []; // { playedUci, engineTop, humanUci, t }
const comparisonStats = {
  totalMoves: 0,         // moves where the engine had a top pick
  engineMatches: 0,      // Σ playedUci === engineTop
  humanSamples: 0,       // moves where the human-like pick was offered
  humanMatches: 0,       // Σ playedUci === humanUci (only when humanUci exists)
  engineHumanPairs: 0,   // moves with both engineTop and humanUci
  engineHumanAgreed: 0,  // Σ engineTop === humanUci (only when both exist)
  ownNaturalMoves: 0     // Σ playedUci differed from both engine and human
};

function recordEngineRecommendation(fen, uci) {
  if (!fen || !uci) return;
  engineMoveByFen.set(fen, uci);
  if (engineMoveByFen.size > ENGINE_MOVE_BY_FEN_LIMIT) {
    // evict oldest 25%
    const toRemove = Math.ceil(engineMoveByFen.size * 0.25);
    let removed = 0;
    for (const k of engineMoveByFen.keys()) {
      if (removed >= toRemove) break;
      engineMoveByFen.delete(k);
      removed++;
    }
  }
}

// The side panel reports the human-natural move it actually recommended
// (from its style/human-like selection). Distinct from the raw engine top pick.
function recordHumanRecommendation(fen, uci) {
  if (!fen || !uci) return;
  humanMoveByFen.set(fen, uci);
  if (humanMoveByFen.size > ENGINE_MOVE_BY_FEN_LIMIT) {
    const toRemove = Math.ceil(humanMoveByFen.size * 0.25);
    let removed = 0;
    for (const k of humanMoveByFen.keys()) {
      if (removed >= toRemove) break;
      humanMoveByFen.delete(k);
      removed++;
    }
  }
}

// Accepts either:
//   { prevFen, playerUci }  — exact UCI the player played
//   { prevFen, actualFen }  — resulting FEN (we'll infer match by FEN-diff)
// Returns { matched, sensible, expected, recentPct } or null if no stored
// recommendation.
//
// The "Sensible moves" stat is a human-likeness guard:
//  * Human-like mode (a distinct human recommendation exists): a move is
//    sensible when the player did NOT blindly copy the engine's exact top pick.
//    Playing the recommended human move, or any own natural move, is human-like
//    and fair-play safe.
//  * Standard mode (no separate human recommendation): following the
//    recommendation (the engine's move) counts as sensible, preserving the
//    classic "did you play the suggested move" behaviour.
function recordPlayerMove(prevFen, payload) {
  if (!prevFen) return null;
  const engineTop = engineMoveByFen.get(prevFen);
  const humanMove = humanMoveByFen.get(prevFen);
  const expected = humanMove || engineTop;
  if (!expected) return null;

  let playedUci = null;
  if (payload && payload.playerUci) {
    playedUci = payload.playerUci;
  } else if (payload && payload.actualFen) {
    // Infer which of our stored moves the player actually played by applying
    // each to prevFen and comparing piece-placement + side-to-move.
    if (engineTop && didPlayerPlayEngineMove(prevFen, engineTop, payload.actualFen)) playedUci = engineTop;
    else if (humanMove && didPlayerPlayEngineMove(prevFen, humanMove, payload.actualFen)) playedUci = humanMove;
  }

  let sensible;
  if (humanMove && humanMove !== engineTop) {
    // Human-like mode: a blind copy of the engine's exact top pick (ignoring
    // the different human recommendation) is bot-like. Everything else —
    // including the player's own natural move — is human and safe.
    sensible = playedUci !== engineTop;
  } else {
    // Standard mode: playing the suggested move is sensible play.
    sensible = Boolean(playedUci) && playedUci === expected;
  }
  correlationWindow.push(sensible);
  if (correlationWindow.length > 8) correlationWindow.shift();
  correlationTotal++;
  if (sensible) correlationMatches++;

  // ── Engine-vs-human comparison bookkeeping ────────────────────────
  // Only run the comparison if we have a known engine top pick and a
  // concrete player move; without those, every verdict is undefined.
  if (engineTop && playedUci) {
    const matchedEngine = playedUci === engineTop;
    const matchedHuman = Boolean(humanMove) && playedUci === humanMove;
    const engineHumanAgree = Boolean(humanMove) && engineTop === humanMove;
    const ownNatural = playedUci !== engineTop && playedUci !== humanMove;
    comparisonWindow.push({ playedUci, engineTop, humanUci: humanMove || null, t: Date.now() });
    if (comparisonWindow.length > COMPARISON_WINDOW_LIMIT) {
      comparisonWindow.splice(0, comparisonWindow.length - COMPARISON_WINDOW_LIMIT);
    }
    comparisonStats.totalMoves += 1;
    if (matchedEngine) comparisonStats.engineMatches += 1;
    if (humanMove) {
      comparisonStats.humanSamples += 1;
      if (matchedHuman) comparisonStats.humanMatches += 1;
      comparisonStats.engineHumanPairs += 1;
      if (engineHumanAgree) comparisonStats.engineHumanAgreed += 1;
    }
    if (ownNatural) comparisonStats.ownNaturalMoves += 1;
  }

  return {
    matched: sensible,
    sensible,
    expected,
    playedUci,
    recentPct: correlationWindow.filter(Boolean).length / correlationWindow.length
  };
}

// Apply the engine's UCI to prevFen and compare placement + side-to-move
// with actualFen. If equal, the player played the recommended move.
// The shared helper applies the move to piece placement and compares it with
// the newly observed position, while deliberately ignoring volatile counters.
function didPlayerPlayEngineMove(prevFen, engineUci, actualFen) {
  // Compare the resulting placement and require the side to move to flip.
  // ChessCore also handles castling, promotion and en-passant captures.
  return ChessCore.didUciProduceFen(prevFen, engineUci, actualFen);
}

// Infer the UCI that was played between two FENs. Walks all plausible
// from/to squares from `inferTransition` and finds the unique UCI that
// reproduces `currentFen`'s placement. Returns null when no UCI fits
// (positions differ in more than one move, illegal positions, etc.).
// Promotions are detected by checking which under-promotion piece the
// target square ended up with.
function inferUciFromFenDiff(prevFen, currentFen) {
  if (!prevFen || !currentFen) return null;
  const prev = ChessCore.parseFen(prevFen);
  const next = ChessCore.parseFen(currentFen);
  if (!prev || !next) return null;
  if (prev.parts[1] === next.parts[1]) return null; // side to move must flip

  // Build a list of candidate from-to squares from the placement diff.
  // inferTransition already does this; reuse it.
  const transition = ChessCore.inferTransition(prevFen, currentFen);
  if (!transition) return null;
  const fromSq = String.fromCharCode(97 + transition.from.c) + (8 - transition.from.r);
  const toSq = String.fromCharCode(97 + transition.to.c) + (8 - transition.to.r);
  // Promotion: if the from piece is a pawn and the to piece is not a
  // pawn of the same color, infer the promotion piece. Otherwise no
  // promotion suffix.
  let promo = '';
  const moverIsWhite = prev.parts[1] === 'w';
  const fromPiece = transition.from.before;
  const toPiece = transition.to.after;
  if (fromPiece && fromPiece.toLowerCase() === 'p' && toPiece && toPiece.toLowerCase() !== 'p' && toPiece !== fromPiece) {
    promo = toPiece.toLowerCase();
  }
  return fromSq + toSq + promo;
}

function getCorrelationStats() {
  const recentPct = correlationWindow.length > 0
    ? correlationWindow.filter(Boolean).length / correlationWindow.length
    : 0;
  return {
    matches: correlationMatches,
    total: correlationTotal,
    recentPct: Math.round(recentPct * 100),
    recentSize: correlationWindow.length
  };
}

// Side-by-side engine vs human comparison. The same numerator/denominator
// pair drives each percentage so the headline figures are directly comparable:
// "8/8 (100%) engine match, 5/7 (71%) human match" means the player followed
// the engine on every move but only picked the human-style suggestion 71% of
// the time it was offered. The agreement figure answers the upstream question
// of *how often* the human-mode re-ranker actually moved the engine off its
// top pick — if the agreement is high, the comparison column is mostly
// measuring the same thing twice.
function getComparisonStats() {
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);
  return {
    totalMoves: comparisonStats.totalMoves,
    humanSamples: comparisonStats.humanSamples,
    engine: {
      matches: comparisonStats.engineMatches,
      total: comparisonStats.totalMoves,
      pct: pct(comparisonStats.engineMatches, comparisonStats.totalMoves)
    },
    human: {
      matches: comparisonStats.humanMatches,
      total: comparisonStats.humanSamples,
      pct: pct(comparisonStats.humanMatches, comparisonStats.humanSamples)
    },
    independent: {
      moves: comparisonStats.ownNaturalMoves,
      total: comparisonStats.totalMoves,
      pct: pct(comparisonStats.ownNaturalMoves, comparisonStats.totalMoves)
    },
    agreement: {
      agreed: comparisonStats.engineHumanAgreed,
      total: comparisonStats.engineHumanPairs,
      pct: pct(comparisonStats.engineHumanAgreed, comparisonStats.engineHumanPairs)
    },
    recentWindow: comparisonWindow.slice()
  };
}

function resetCorrelationTracker() {
  engineMoveByFen.clear();
  humanMoveByFen.clear();
  correlationWindow.length = 0;
  correlationMatches = 0;
  correlationTotal = 0;
  comparisonWindow.length = 0;
  comparisonStats.totalMoves = 0;
  comparisonStats.engineMatches = 0;
  comparisonStats.humanSamples = 0;
  comparisonStats.humanMatches = 0;
  comparisonStats.engineHumanPairs = 0;
  comparisonStats.engineHumanAgreed = 0;
  comparisonStats.ownNaturalMoves = 0;
}

// ─── Analysis workflow coalescing and panel lifecycle ─────────────────
const analysisWorkflows = new Map();
const panelActivityByTab = new Map();
const PANEL_RECENT_ACTIVITY_MS = 2 * 60 * 1000;

function notePanelActivity(tabId = 'active', open = true) {
  const key = String(tabId ?? 'active');
  if (open) panelActivityByTab.set(key, Date.now());
  else panelActivityByTab.delete(key);
}

function hasRecentPanelActivity(tabId = 'active') {
  const at = panelActivityByTab.get(String(tabId ?? 'active')) || 0;
  return Date.now() - at <= PANEL_RECENT_ACTIVITY_MS;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Service Worker Keep-Alive (chrome.alarms based) ─────────────────
// ═══════════════════════════════════════════════════════════════════════
// A single chrome.alarms-based keep-alive replaces redundant setInterval
// timers. Alarms fire in the SW's event page, resetting its idle timer.
function startKeepAliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_ALARM_INTERVAL_MIN });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Minimal work — touching chrome.storage.local resets the SW idle timer.
    chrome.storage.local.get('_keepalive', () => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ─── Cloud API #1: Chess-API.com ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function chessApiEval(fen, multiPv = 3, depth = 12, context = {}) {
  const cacheKey = analysisCacheKey('chess-api', fen, multiPv, depth);
  const outcome = await apiCoordinator.request({
    provider: 'chessApi',
    endpointClass: 'analysis',
    cacheKey,
    requestKey: `variants=${Math.min(5, multiPv)}:depth=${depth}`,
    priority: context.priority || 'current-player-turn',
    positionToken: context.positionToken,
    refresh: Boolean(context.refresh),
    allowStale: true,
    cachePolicy: API_CACHE_POLICIES.chessApi,
    request: {
      url: 'https://chess-api.com/v1',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen,
        variants: Math.max(1, Math.min(5, multiPv)),
        depth,
        maxThinkingTime: 100
      }),
      timeoutMs: 18000
    },
    parse: async response => {
      const data = await response.json();
      if (data.type === 'error' || data.error || !data.move) return null;
      return normalizeChessApi(data, fen);
    }
  });
  if (!outcome.ok) return null;
  return {
    ...outcome.data,
    fen,
    source: 'chess-api',
    cached: Boolean(outcome.cached),
    stale: Boolean(outcome.stale)
  };
}

function normalizeChessApi(data, fen) {
  const pvs = [];
  // chess-api.com reports eval/centipawns/mate from White's perspective
  // (positive = White is better; "Negative value means that black is winning").
  // So scores are used verbatim — no side-to-move flip — to match the pipeline's
  // white-relative contract (pv.score > 0 = White winning).
  const activeColor = fen ? (fen.split(' ')[1] || 'w') : 'w';

  if (data.move) {
    const isMate = data.mate !== null && data.mate !== undefined && data.mate !== '';
    let scoreType, score;

    if (isMate) {
      scoreType = 'mate';
      score = parseInt(String(data.mate)) || 0;
    } else {
      scoreType = 'cp';
      if (data.centipawns) {
        score = parseInt(String(data.centipawns)) || 0;
      } else {
        score = Math.round((data.eval || 0) * 100);
      }
    }

    pvs.push({
      multipv: 1,
      scoreType,
      score,
      depth: data.depth || 0,
      seldepth: 0,
      pv: [data.move, ...(data.continuationArr || [])].filter(Boolean),
      nodes: 0, nps: 0, time: 0
    });
  }

  if (data.variations && Array.isArray(data.variations)) {
    data.variations.forEach((v, idx) => {
      if (v.move) {
        const isMate = v.mate !== null && v.mate !== undefined && v.mate !== '';
        let scoreType, score;
        if (isMate) {
          scoreType = 'mate';
          score = parseInt(String(v.mate)) || 0;
        } else {
          scoreType = 'cp';
          score = Math.round((v.eval || 0) * 100);
        }
        pvs.push({
          multipv: idx + 2,
          scoreType, score,
          depth: v.depth || data.depth || 0,
          seldepth: 0,
          pv: [v.move, ...(v.continuationArr || [])].filter(Boolean),
          nodes: 0, nps: 0, time: 0
        });
      }
    });
  }

  return {
    fen, pvs,
    bestMove: data.move || (pvs.length > 0 ? pvs[0].pv[0] : null),
    depth: data.depth || 0,
    san: data.san || null,
    from: data.from || null,
    to: data.to || null,
    winChance: data.winChance || null,
    moveHistory: [],
    scorePerspective: 'white'
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Cloud API #2: Lichess Cloud Eval ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function lichessCloudEval(fen, multiPv = 5, context = {}) {
  // Lichess cloud-eval caps multiPv at 5; sending more is rejected with a 400.
  multiPv = clampMultiPvForSource('lichess-cloud', multiPv);
  const cacheKey = analysisCacheKey('lichess-cloud', fen, multiPv);
  const outcome = await apiCoordinator.request({
    provider: 'lichessCloud',
    endpointClass: 'analysis',
    cacheKey,
    requestKey: `multipv=${multiPv}`,
    priority: context.priority || 'current-player-turn',
    positionToken: context.positionToken,
    refresh: Boolean(context.refresh),
    allowStale: true,
    cachePolicy: API_CACHE_POLICIES.lichessCloud,
    request: {
      url: `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`,
      timeoutMs: 14000
    },
    parse: async response => {
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType && !contentType.includes('json')) throw new Error('Expected JSON response');
      const data = await response.json();
      if (data.error || !Array.isArray(data.pvs) || data.pvs.length === 0) return null;
      return normalizeLichessCloudEval(data, fen);
    }
  });
  if (!outcome.ok) return null;
  return {
    ...outcome.data,
    fen,
    source: 'lichess-cloud',
    cached: Boolean(outcome.cached),
    stale: Boolean(outcome.stale)
  };
}

function normalizeLichessCloudEval(data, fen) {
  // Lichess cloud-eval reports cp/mate relative to the side to move (UCI
  // convention: positive = side to move is better). The rest of the pipeline
  // treats every pv.score as White-relative (pv.score > 0 = White winning), so
  // black-to-move positions must be flipped here or evaluations, the eval bar,
  // move ranking and move classification are all inverted for Black.
  const activeColor = fen ? (fen.split(' ')[1] || 'w') : 'w';
  const isBlackToMove = activeColor === 'b';
  const pvs = (data.pvs || []).map((pv, idx) => {
    const pvMoves = (pv.moves || '').split(/\s+/).filter(Boolean);
    const rawScore = pv.mate !== undefined ? pv.mate : (pv.cp || 0);
    return {
      multipv: idx + 1,
      scoreType: pv.mate !== undefined ? 'mate' : 'cp',
      score: isBlackToMove ? -rawScore : rawScore,
      depth: data.depth || 0,
      seldepth: data.knodes ? Math.round(data.knodes / 10) : 0,
      pv: pvMoves,
      nodes: (data.knodes || 0) * 1000,
      nps: 0, time: 0
    };
  });

  return {
    fen, pvs,
    bestMove: pvs.length > 0 && pvs[0].pv.length > 0 ? pvs[0].pv[0] : null,
    depth: data.depth || 0,
    knodes: data.knodes || 0,
    moveHistory: [],
    scorePerspective: 'white'
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Cloud API #3: Lichess Masters Explorer ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Provides moves based on what human GRANDMASTERS actually played.
// More "natural and human" than engine evaluation — reflects real
// human decision-making at the highest level of play.
async function lichessMastersEval(fen, multiPv = 5, context = {}) {
  // The masters explorer returns at most 5 moves; requesting more is rejected.
  multiPv = clampMultiPvForSource('masters-explorer', multiPv);
  const cacheKey = analysisCacheKey('masters-explorer', fen, multiPv);
  const outcome = await apiCoordinator.request({
    provider: 'mastersExplorer',
    endpointClass: 'analysis',
    cacheKey,
    requestKey: `moves=${multiPv}`,
    priority: context.priority || 'current-player-turn',
    positionToken: context.positionToken,
    refresh: Boolean(context.refresh),
    allowStale: true,
    cachePolicy: API_CACHE_POLICIES.mastersExplorer,
    request: {
      url: `https://explorer.lichess.ovh/master?fen=${encodeURIComponent(fen)}&moves=${multiPv}&topGames=3`,
      timeoutMs: 12000
    },
    parse: async response => {
      const data = await response.json();
      return normalizeMastersEval(data, fen);
    }
  });
  if (!outcome.ok) return null;
  return {
    ...outcome.data,
    fen,
    source: 'masters-explorer',
    cached: Boolean(outcome.cached),
    stale: Boolean(outcome.stale)
  };
}

function normalizeMastersEval(data, fen) {
  if (!data || !data.moves || data.moves.length === 0) return null;

  const total = (data.white || 0) + (data.draws || 0) + (data.black || 0);
  if (total === 0) return null;

  // Score is normalised to White's perspective to match the contract
  // documented in hint-engine.js (pv.score > 0 = White winning).

  // Convert master game statistics into PV-like format
  const pvs = data.moves.slice(0, 5).map((m, idx) => {
    const moveTotal = (m.white || 0) + (m.draws || 0) + (m.black || 0);
    const whiteWinPct = moveTotal > 0 ? (m.white || 0) / moveTotal : 0.5;
    const drawPct = moveTotal > 0 ? (m.draws || 0) / moveTotal : 0;

    // White-perspective approximate centipawn score:
    // (whiteWinPct * 2 + drawPct - 1) ranges from -1 (all black wins)
    // to +1 (all white wins); * 300 scales to roughly ±3 pawns.
    const score = Math.round((whiteWinPct * 2 + drawPct - 1) * 300);

    return {
      multipv: idx + 1,
      scoreType: 'cp',
      score: score,
      depth: 0, // No engine depth — this is human data
      seldepth: 0,
      pv: [m.uci],
      nodes: 0, nps: 0, time: 0,
      _masterData: {
        san: m.san,
        uci: m.uci,
        totalGames: moveTotal,
        whiteWinPct: ((m.white || 0) / moveTotal * 100).toFixed(1),
        drawPct: ((m.draws || 0) / moveTotal * 100).toFixed(1),
        blackWinPct: ((m.black || 0) / moveTotal * 100).toFixed(1),
        averageRating: m.averageRating || 2400
      }
    };
  });

  const topGames = (data.topGames || []).map(g => ({
    id: g.id, winner: g.winner,
    white: g.white || {}, black: g.black || {},
    year: g.year, month: g.month, uci: g.uci
  }));

  return {
    fen, pvs,
    bestMove: pvs.length > 0 ? pvs[0].pv[0] : null,
    depth: 0,
    isHumanSource: true, // flag for UI to show "Human" label
    opening: data.opening || null,
    masterTopGames: topGames,
    totalMasterGames: total,
    moveHistory: [],
    scorePerspective: 'white' // now correctly white-relative
  };
}

// ─── Lichess Opening Explorer (player games) ────────────────────────
async function lichessOpeningExplorer(fen, context = {}) {
  if (!isPlausibleOpening(fen)) return null;
  const cacheKey = openingCacheKey(fen);
  const outcome = await apiCoordinator.request({
    provider: 'openingExplorer',
    endpointClass: 'enrichment',
    cacheKey,
    requestKey: 'moves=8:topGames=3:ratings=1600,1800,2000,2200,2500',
    priority: context.priority || 'opening-enrichment',
    positionToken: context.positionToken,
    refresh: Boolean(context.refresh),
    allowStale: true,
    cachePolicy: API_CACHE_POLICIES.openingExplorer,
    request: {
      url: `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fen)}&moves=8&topGames=3&ratings=1600,1800,2000,2200,2500`,
      timeoutMs: 10000
    },
    parse: async response => normalizeOpeningExplorer(await response.json()),
    isEmpty: result => !result || result.totalGames <= 0 || !result.moves?.length
  });
  if (!outcome.ok) return null;
  return {
    ...outcome.data,
    cached: Boolean(outcome.cached),
    stale: Boolean(outcome.stale)
  };
}

function normalizeOpeningExplorer(data) {
  const total = (data.white || 0) + (data.draws || 0) + (data.black || 0);
  const moves = (data.moves || []).map(m => {
    const moveTotal = (m.white || 0) + (m.draws || 0) + (m.black || 0);
    return {
      uci: m.uci, san: m.san,
      white: m.white || 0, draws: m.draws || 0, black: m.black || 0,
      total: moveTotal,
      winRate: moveTotal > 0 ? ((m.white || 0) / moveTotal * 100).toFixed(1) : '0',
      drawRate: moveTotal > 0 ? ((m.draws || 0) / moveTotal * 100).toFixed(1) : '0',
      lossRate: moveTotal > 0 ? ((m.black || 0) / moveTotal * 100).toFixed(1) : '0',
      averageRating: m.averageRating || 0
    };
  });
  const topGames = (data.topGames || []).map(g => ({
    id: g.id, winner: g.winner,
    white: g.white || {}, black: g.black || {},
    year: g.year, month: g.month, uci: g.uci
  }));
  return {
    opening: data.opening || null, moves, topGames, totalGames: total,
    whiteWins: data.white || 0, draws: data.draws || 0, blackWins: data.black || 0
  };
}

// ─── Lichess Tablebase ───────────────────────────────────────────────
async function lichessTablebase(fen, context = {}) {
  if (!fen || countFenPieces(fen) > 7) return null;
  const cacheKey = tablebaseCacheKey(fen);
  const outcome = await apiCoordinator.request({
    provider: 'tablebase',
    endpointClass: 'tablebase',
    cacheKey,
    requestKey: 'standard',
    priority: context.priority || 'current-position-tablebase',
    positionToken: context.positionToken,
    refresh: Boolean(context.refresh),
    allowStale: true,
    cachePolicy: API_CACHE_POLICIES.tablebase,
    request: {
      url: `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`,
      timeoutMs: 10000
    },
    parse: async response => normalizeTablebase(await response.json())
  });
  if (!outcome.ok) return null;
  return {
    ...outcome.data,
    cached: Boolean(outcome.cached),
    stale: Boolean(outcome.stale)
  };
}

function normalizeTablebase(data) {
  const moves = (data.moves || []).map(m => ({
    uci: m.uci, san: m.san, dtz: m.dtz, dtm: m.dtm,
    category: m.category, checkmate: m.checkmate || false,
    stalemate: m.stalemate || false, zeroing: m.zeroing || false
  }));
  return {
    dtz: data.dtz, dtm: data.dtm, category: data.category,
    checkmate: data.checkmate || false, stalemate: data.stalemate || false,
    moves, isTablebase: true
  };
}

// ─── Build Tablebase Result ──────────────────────────────────────────
function buildTablebaseResult(tbData, fen) {
  let bestMove = null;
  let bestCategory = 'loss';
  for (const m of tbData.moves) {
    const cat = m.category;
    if (cat === 'checkmate' || cat === 'variant-win' || cat === 'syzygy-win') {
      bestMove = m; break;
    }
    if (cat === 'win' && bestCategory !== 'win') { bestMove = m; bestCategory = 'win'; }
    if (cat === 'cursed-win' && bestCategory !== 'win') { bestMove = m; bestCategory = 'cursed-win'; }
    if (cat === 'draw' && bestCategory !== 'win' && bestCategory !== 'cursed-win') { bestMove = m; bestCategory = 'draw'; }
    if (cat === 'maybe-win' && bestCategory === 'loss') { bestMove = m; bestCategory = 'maybe-win'; }
  }
  if (!bestMove && tbData.moves.length > 0) bestMove = tbData.moves[0];

  const scoreType = (bestMove?.category === 'win' || bestMove?.category === 'syzygy-win') ? 'mate'
    : (bestMove?.category === 'loss' ? 'mate' : 'cp');
  const activeColor = fen ? (fen.split(' ')[1] || 'w') : 'w';
  let score = 0;
  if (bestMove?.dtm) {
    const isWin = bestMove.category === 'win' || bestMove.category === 'syzygy-win';
    const absDtm = Math.abs(bestMove.dtm);
    const sideToMoveScore = isWin ? absDtm : -absDtm;
    score = activeColor === 'b' ? -sideToMoveScore : sideToMoveScore;
  } else if (bestMove?.category === 'draw') {
    score = 0;
  }

  return {
    fen,
    pvs: bestMove ? [{
      multipv: 1, scoreType, score, depth: 999, seldepth: 999,
      pv: [bestMove.uci], nodes: 0, nps: 0, time: 0
    }] : [],
    bestMove: bestMove?.uci || null,
    depth: 999, source: 'tablebase', tablebase: tbData,
    moveHistory: [], scorePerspective: 'white'
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Main Cloud Analysis — Semantic Routing and Bounded Fallback ─────
// ═══════════════════════════════════════════════════════════════════════
// Lichess cloud-eval and the masters explorer return at most 5 lines; chess-api
// is clamped to 5 internally as well. Clamping here keeps the cache key and the
// request in sync so a 7/10-line selection never yields a 400 or a cache miss.
function clampMultiPvForSource(source, multiPv) {
  return Math.max(1, Math.min(5, Number(multiPv) || 3));
}

async function getCachedAnalysisSource(source, fen, multiPv) {
  const depth = source === 'chess-api' ? 12 : 0;
  const cacheKey = analysisCacheKey(source, fen, clampMultiPvForSource(source, multiPv), depth);
  const provider = source === 'chess-api' ? 'chessApi'
    : source === 'lichess-cloud' ? 'lichessCloud'
    : 'mastersExplorer';
  const cached = await apiCoordinator.getCached(cacheKey, provider);
  if (!cached?.ok) return null;
  return {
    ...cached.data,
    fen,
    source,
    cached: true,
    stale: Boolean(cached.stale)
  };
}

async function callAnalysisSource(source, fen, multiPv, context) {
  if (source === 'chess-api') return chessApiEval(fen, multiPv, 12, context);
  if (source === 'lichess-cloud') return lichessCloudEval(fen, multiPv, context);
  if (source === 'masters-explorer') return lichessMastersEval(fen, multiPv, context);
  return null;
}

function providerForAnalysisSource(source) {
  if (source === 'chess-api') return 'chessApi';
  if (source === 'lichess-cloud') return 'lichessCloud';
  return 'mastersExplorer';
}

// Choose a source at request time, not from a fixed list. This keeps the
// preferred semantic source first while immediately failing over around a
// provider that is unavailable or would impose a material queue delay.
function rankAnalysisSources(sourceOrder, context) {
  const diagnostics = apiCoordinator.getDiagnostics();
  const healthPenalty = { healthy: 0, unknown: 0, slow: 4, 'half-open': 12, degraded: 24, cooldown: 100, 'rate-limited': 100, disabled: 100 };
  return sourceOrder.map((source, semanticIndex) => {
    const provider = providerForAnalysisSource(source);
    const schedule = apiCoordinator.getScheduleStatus(provider, {
      priority: context.priority,
      endpointClass: 'analysis',
      positionToken: context.positionToken
    });
    const health = diagnostics.providers?.[provider]?.state || 'unknown';
    // 250 ms units let an immediately available fallback win over a source
    // that is merely spacing-limited, without preferring a degraded source.
    const queuePenalty = Math.min(40, Math.ceil((schedule.waitMs || 0) / 250));
    return { source, provider, schedule, health, semanticIndex, score: semanticIndex * 10 + (healthPenalty[health] ?? 16) + queuePenalty };
  }).filter(candidate => candidate.schedule.allowed)
    .sort((left, right) => left.score - right.score || left.semanticIndex - right.semanticIndex);
}

async function findCachedAnalysisFallback(sourceOrder, fen, multiPv) {
  for (const source of sourceOrder) {
    const cached = await getCachedAnalysisSource(source, fen, multiPv);
    if (cached) return { result: cached, source };
  }
  return null;
}

function analysisFromOpeningData(openingData, fen, multiPv) {
  if (!openingData?.moves?.length) return null;
  const pvs = openingData.moves.slice(0, multiPv).map((move, index) => {
    const total = Number(move.total || 0);
    const white = Number(move.white || 0);
    const draws = Number(move.draws || 0);
    const score = total > 0 ? Math.round(((white * 2 + draws) / total - 1) * 300) : 0;
    return {
      multipv: index + 1,
      scoreType: 'cp',
      score,
      depth: 0,
      seldepth: 0,
      pv: [move.uci],
      nodes: 0,
      nps: 0,
      time: 0,
      _masterData: {
        san: move.san,
        uci: move.uci,
        totalGames: total,
        averageRating: move.averageRating || 0
      }
    };
  }).filter(pv => pv.pv[0]);
  if (!pvs.length) return null;
  return {
    fen,
    pvs,
    bestMove: pvs[0].pv[0],
    depth: 0,
    opening: openingData.opening || null,
    openingData,
    isHumanSource: true,
    cached: true,
    stale: Boolean(openingData.stale),
    scorePerspective: 'white'
  };
}

function openingDataFromMastersResult(result) {
  if (!result?.pvs?.length) return null;
  const moves = result.pvs.map(pv => ({
    uci: pv.pv?.[0] || '',
    san: pv._masterData?.san || pv.pv?.[0] || '',
    total: Number(pv._masterData?.totalGames || 0),
    winRate: pv._masterData?.whiteWinPct || '0',
    drawRate: pv._masterData?.drawPct || '0',
    lossRate: pv._masterData?.blackWinPct || '0',
    averageRating: pv._masterData?.averageRating || 0
  })).filter(move => move.uci);
  return moves.length ? {
    opening: result.opening || null,
    moves,
    topGames: result.masterTopGames || [],
    totalGames: result.totalMasterGames || moves.reduce((max, move) => Math.max(max, move.total), 0)
  } : null;
}

async function performCloudAnalysis(fen, playerColor, options = {}) {
  const multiPv = options.multiPv || 3;
  const canonicalFen = ApiReliability.canonicalAnalysisFen(fen);
  const dedupeKey = `workflow:${canonicalFen}:multipv=${multiPv}`;
  if (analysisWorkflows.has(dedupeKey)) return analysisWorkflows.get(dedupeKey);

  const workflow = _performCloudAnalysisInternal(fen, playerColor, options).catch(error => ({
    error: true,
    fen,
    playerColor,
    errorDetail: { type: 'transient', message: error?.message || 'Analysis failed unexpectedly', suggestion: 'retry' },
    moveHistory: options.moveHistory || []
  }));
  analysisWorkflows.set(dedupeKey, workflow);
  try {
    return await workflow;
  } finally {
    if (analysisWorkflows.get(dedupeKey) === workflow) analysisWorkflows.delete(dedupeKey);
  }
}

async function _performCloudAnalysisInternal(fen, playerColor, options = {}) {
  const multiPv = options.multiPv || 3;
  const positionToken = options.positionToken || registerPosition(fen, options.tabId || 'active');
  await apiCoordinator.ready;
  if (!hasRecentPanelActivity(options.tabId || positionToken?.tabId || 'active')) {
    return {
      error: true,
      fen,
      playerColor,
      errorDetail: { type: 'inactive_panel', message: 'Analysis paused because the panel is not active.', suggestion: 'none' }
    };
  }
  const settings = await new Promise(resolve =>
    chrome.storage.local.get('settings', result => resolve(normalizeSettings(result.settings)))
  );
  const priority = options.refresh ? 'manual-current-position' : 'current-player-turn';
  const context = { positionToken, refresh: Boolean(options.refresh), priority };
  // A board-placement snapshot cannot reliably encode castling, en-passant, or
  // move counters. Keep regular engine analysis available, but never use it
  // for state-sensitive databases until the site supplied an authoritative FEN.
  const hasReliablePositionMetadata = options.positionReliable === true;

  // Deterministic tablebases are the sole remote workflow for eligible
  // endgames. A successful tablebase lookup always stops engine routing.
  if (hasReliablePositionMetadata && settings.showTablebase !== false && countFenPieces(fen) <= 7) {
    const tbResult = await lichessTablebase(fen, {
      ...context,
      priority: options.refresh ? 'manual-current-position' : 'current-position-tablebase'
    });
    if (!apiCoordinator.isPositionCurrent(positionToken)) {
      return { error: true, stalePosition: true, fen, errorDetail: { type: 'stale_position', message: 'Position changed', suggestion: 'none' } };
    }
    if (tbResult && tbResult.category && tbResult.category !== 'unknown') {
      const result = buildTablebaseResult(tbResult, fen);
      result.tablebaseData = tbResult;
      result.moveHistory = options.moveHistory || [];
      result.playerColor = playerColor;
      result.cached = Boolean(tbResult.cached);
      result.stale = Boolean(tbResult.stale);
      return result;
    }
  }

  const sourceOrder = semanticSourceOrder(fen, hasReliablePositionMetadata
    ? settings
    : { ...settings, useMastersExplorer: false });
  if (sourceOrder.length === 0) {
    return {
      error: true,
      fen,
      playerColor,
      errorDetail: {
        type: 'no_sources_enabled',
        message: 'All analysis sources are disabled in Settings. Enable at least one source to analyze this position.',
        suggestion: 'none'
      },
      moveHistory: options.moveHistory || []
    };
  }
  let bestResult = null;
  let usedSource = null;

  // Cache lookup spans all semantically relevant sources before any remote
  // request, so a fresh secondary cache beats an unnecessary primary call.
  if (!options.refresh) {
    for (const source of sourceOrder) {
      // In openings, a cached player-explorer result is useful human move data
      // and is checked after Masters but before any engine cache or remote call.
      if (hasReliablePositionMetadata && source === 'lichess-cloud' && isPlausibleOpening(fen)) {
        const cachedOpening = await apiCoordinator.getCached(openingCacheKey(fen), 'openingExplorer');
        if (cachedOpening?.ok) {
          bestResult = analysisFromOpeningData(cachedOpening.data, fen, multiPv);
          if (bestResult) {
            bestResult.openingData = cachedOpening.data;
            bestResult.stale = Boolean(cachedOpening.stale);
            usedSource = 'opening-explorer';
            break;
          }
        }
      }
      const cached = await getCachedAnalysisSource(source, fen, multiPv);
      if (cached) {
        bestResult = cached;
        usedSource = source;
        break;
      }
    }
  }

  let routing = null;
  if (!bestResult) {
    const candidates = rankAnalysisSources(sourceOrder, context);
    routing = {
      attempted: [],
      skipped: sourceOrder.filter(source => !candidates.some(candidate => candidate.source === source)).map(source => ({
        source,
        provider: providerForAnalysisSource(source),
        schedule: apiCoordinator.getScheduleStatus(providerForAnalysisSource(source), {
          priority, endpointClass: 'analysis', positionToken
        })
      }))
    };

    // Try every semantically valid provider at most once. Providers enforce
    // their own spacing, quota, cooldown, and retry rules; this is compliant
    // failover rather than retrying or bypassing a provider limit.
    for (const candidate of candidates) {
      routing.attempted.push(candidate.source);
      const result = await callAnalysisSource(candidate.source, fen, multiPv, context);
      if (!apiCoordinator.isPositionCurrent(positionToken)) {
        return { error: true, stalePosition: true, fen, errorDetail: { type: 'stale_position', message: 'Position changed', suggestion: 'none' } };
      }
      if (result) {
        bestResult = result;
        usedSource = candidate.source;
        break;
      }
    }
  }

  if (!bestResult) {
    // Refresh is advisory: if every compliant provider path failed, preserve
    // continuity with any usable fresh or stale result before surfacing error.
    const fallback = await findCachedAnalysisFallback(sourceOrder, fen, multiPv);
    if (fallback) {
      bestResult = fallback.result;
      usedSource = fallback.source;
      bestResult.refreshFailed = Boolean(options.refresh);
    }
  }

  if (!bestResult) {
    return {
      error: true,
      fen,
      playerColor,
      errorDetail: classifyError(routing),
      routing,
      moveHistory: options.moveHistory || []
    };
  }

  bestResult.source = usedSource;
  bestResult.fen = fen;
  bestResult.playerColor = playerColor;
  bestResult.moveHistory = options.moveHistory || [];

  // Use cached opening data immediately. A remote enrichment is allowed only
  // for a current, plausible opening while the panel feature is enabled and
  // the low-priority budget still has capacity.
  if (hasReliablePositionMetadata && settings.showOpeningExplorer === true && isPlausibleOpening(fen)) {
    if (usedSource === 'masters-explorer') bestResult.openingData = openingDataFromMastersResult(bestResult);
    const cachedOpening = bestResult.openingData ? null : await apiCoordinator.getCached(openingCacheKey(fen), 'openingExplorer');
    if (cachedOpening?.ok) bestResult.openingData = cachedOpening.data;

    const shouldEnrich = !bestResult.openingData && usedSource !== 'masters-explorer' &&
      apiCoordinator.isPositionCurrent(positionToken) &&
      apiCoordinator.canSchedule('openingExplorer', 'opening-enrichment');
    if (shouldEnrich) {
      lichessOpeningExplorer(fen, { positionToken, priority: 'opening-enrichment' }).then(openingData => {
        if (!openingData || !apiCoordinator.isPositionCurrent(positionToken)) return;
        chrome.runtime.sendMessage({
          type: 'opening_data_update',
          data: { fen, openingData }
        }).catch(() => {});
      }).catch(() => {});
    }
  }

  return bestResult;
}

// ─── Error Classification for User-Friendly Messages ─────────────────
function classifyError(routing = null) {
  const diagnostics = apiCoordinator.getDiagnostics();
  const statuses = Object.values(diagnostics.providers || {});
  const skipped = routing?.skipped || [];
  const skippedTypes = skipped.map(entry => entry.schedule?.errorType).filter(Boolean);
  const waitMs = Math.max(0, ...skipped.map(entry => entry.schedule?.waitMs || 0));

  if (skippedTypes.includes('game_budget') || skippedTypes.includes('position_budget')) {
    return {
      type: 'budget_exhausted',
      message: skippedTypes.includes('game_budget')
        ? 'Analysis request budget for this game has been reached. Existing cached analysis remains available.'
        : 'This position has already used its analysis request budget. Make a move or use the cached analysis.',
      suggestion: 'none'
    };
  }
  if (waitMs > 0) {
    return {
      type: 'queued',
      message: `Analysis is queued to respect provider pacing; retry in about ${Math.max(1, Math.ceil(waitMs / 1000))} seconds.`,
      suggestion: 'wait'
    };
  }
  if (statuses.some(status => status.state === 'rate-limited' || status.state === 'cooldown')) {
    return {
      type: 'rate_limited',
      message: 'Cloud providers are cooling down. Cached results remain available.',
      suggestion: 'wait'
    };
  }
  if (statuses.length && statuses.every(status => status.state === 'disabled' || status.state === 'degraded')) {
    return {
      type: 'all_down',
      message: 'Cloud analysis providers are currently unavailable.',
      suggestion: 'wait_long'
    };
  }
  return {
    type: 'transient',
    message: 'No cloud provider returned analysis for this position. Cached results will be used when available.',
    suggestion: 'retry'
  };
}

// ─── Connection Health Check ─────────────────────────────────────────
async function checkConnectionHealth() {
  await apiCoordinator.ready;
  const diagnostics = apiCoordinator.getDiagnostics();
  const convert = provider => {
    const data = diagnostics.providers[provider];
    if (!data) return { ok: false, passive: true, label: 'No recent data', latency: -1 };
    return {
      ok: data.state === 'healthy' || data.state === 'slow' || data.state === 'unknown',
      passive: true,
      label: data.label,
      state: data.state,
      latency: data.recentLatency || -1,
      status: data.lastStatus || 0,
      cooldownRemainingMs: data.cooldownRemainingMs || 0
    };
  };
  return {
    'chess-api': convert('chessApi'),
    lichess: convert('lichessCloud'),
    masters: convert('mastersExplorer'),
    opening: convert('openingExplorer'),
    tablebase: convert('tablebase'),
    diagnostics
  };
}

// ─── Read Board from Active Tab ──────────────────────────────────────
// DOM readers can observe placement reliably, but castling, en-passant and
// counters require move history. Keep reconciled metadata separately per tab.
const lastObservedFenByTab = new Map();

async function readBoardFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
    if (coordinatorActiveTabId !== null && coordinatorActiveTabId !== tab.id) {
      apiCoordinator.cancelTab(coordinatorActiveTabId);
    }
    coordinatorActiveTabId = tab.id;
    const url = new URL(tab.url);
    const host = url.hostname.toLowerCase();
    const isChessSite = host === 'chess.com' || host.endsWith('.chess.com') ||
      host === 'lichess.org' || host.endsWith('.lichess.org');
    if (!isChessSite) return null;
    // Run in the page's main world first. This is required to read the
    // sites' own game objects, whose full FEN includes castling, en-passant,
    // and move counters. The content reader still falls back to DOM placement
    // when no site API is exposed.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
        world: 'MAIN'
      });
    } catch (_) {
      // Older Chromium builds or hardened pages can reject MAIN-world
      // injection; retain the isolated-world DOM-reader fallback.
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    }
    const result = results?.[0]?.result;
    if (!result || !ChessCore.parseFen(result.fen)) return null;
    result.tabId = tab.id;

    const previousFen = lastObservedFenByTab.get(tab.id) || null;
    if (result.positionReliable === true) {
      // A site API FEN is authoritative, including its counters, castling and
      // en-passant fields. Never overwrite it with locally inferred metadata.
      lastObservedFenByTab.set(tab.id, result.fen);
    } else if (previousFen && previousFen.split(' ')[0] === result.fen.split(' ')[0]) {
      result.fen = previousFen;
    } else {
      result.fen = ChessCore.reconcileFen(previousFen, result.fen) || result.fen;
      lastObservedFenByTab.set(tab.id, result.fen);
    }
    return result;
  } catch (e) {
    console.error('[Background] Board read error:', e.message);
    return null;
  }
}

let coordinatorActiveTabId = null;
chrome.tabs.onRemoved.addListener(tabId => {
  lastObservedFenByTab.delete(tabId);
  positionGenerations.delete(String(tabId));
  apiCoordinator.cancelTab(tabId);
  if (coordinatorActiveTabId === tabId) coordinatorActiveTabId = null;
});
chrome.tabs.onActivated.addListener(activeInfo => {
  if (coordinatorActiveTabId !== null && coordinatorActiveTabId !== activeInfo.tabId) {
    apiCoordinator.cancelTab(coordinatorActiveTabId);
  }
  coordinatorActiveTabId = activeInfo.tabId;
});

// ─── Side Panel Management ──────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ═══════════════════════════════════════════════════════════════════════
// ─── Message Routing ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Every chrome.runtime.onMessage handler is a function that receives the
// (message, sender, sendResponse) triple and returns a truthy value when
// the response is delivered asynchronously (keeps the channel open) or a
// falsy value when the response is already sent synchronously. Pulling the
// per-message work out of one giant listener into a routes map makes each
// precondition easier to read and easier to test in isolation.
//
// The route shape is:
//   { pre?: (msg, sender) => boolean,
//     run: (msg, sender, sendResponse) => boolean }
//
// `pre` is an optional validation hook. If it returns false, the response
// is sent as `null` synchronously and the route is skipped. Returning true
// means "valid, proceed".

function getEffectiveTabId(message, sender) {
  return message.tabId ?? sender.tab?.id ?? 'active';
}

const MESSAGE_ROUTES = {
  read_board: {
    run(_message, _sender, sendResponse) {
      readBoardFromActiveTab()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
  },

  // The side panel drives analysis via 'request_analysis' only.
  request_analysis: {
    pre: (message) => ChessCore.parseFen(message.fen) !== null,
    run(message, sender, sendResponse) {
      // A turn-unknown reply is sent synchronously so the side panel can
      // render the "Turn unavailable" state without waiting for storage I/O.
      if (message.turnReliable !== true) {
        chrome.runtime.sendMessage({
          type: 'turn_status_update',
          data: { isPlayerTurn: false, waitingForOpponent: false, reason: 'turn_unknown', fen: message.fen }
        }).catch(() => {});
        sendResponse({ ok: true, turnStatus: 'turn_unknown' });
        return false;
      }
      chrome.storage.local.get(['settings', 'assistedPlayerColor'], (result) => {
        const settings = normalizeSettings(result.settings);
        const assistedPlayerColor = message.playerColor || result.assistedPlayerColor || 'w';
        const tabId = getEffectiveTabId(message, sender);
        notePanelActivity(tabId, true);
        const positionToken = registerPosition(message.fen, tabId);

        if (positionToken && lastAnalysisGameId !== positionToken.gameId) {
          lastAnalysisGameId = positionToken.gameId;
          resetAnalysisState();
          resetCorrelationTracker();
        }

        const effectiveHintLevel = 5;
        let exactHintBlocked = null;

        // Refresh is deliberately non-destructive: caches, cooldowns, quotas
        // and passive health remain intact. The coordinator decides whether
        // the current cached result is old enough to revalidate.
        const turnCheck = shouldAnalyzePosition(message.fen, assistedPlayerColor);
        const refreshCurrentPosition = Boolean(message.refresh && turnCheck.reason === 'same_position' && turnCheck.isPlayerTurn);
        if (!turnCheck.shouldAnalyze && !refreshCurrentPosition) {
          chrome.runtime.sendMessage({
            type: 'turn_status_update',
            data: {
              isPlayerTurn: turnCheck.isPlayerTurn,
              waitingForOpponent: !turnCheck.isPlayerTurn,
              reason: turnCheck.reason,
              fen: message.fen,
              playerColor: assistedPlayerColor
            }
          }).catch(() => {});
          if (turnCheck.reason === 'opponents_turn') {
            sendResponse({ ok: true, turnStatus: 'opponents_turn' });
          } else if (turnCheck.reason === 'same_position') {
            sendResponse({ ok: true, turnStatus: 'same_position' });
          } else {
            sendResponse({ ok: true });
          }
          return;
        }

        turnState.analysisInProgress = true;
        performCloudAnalysis(message.fen, assistedPlayerColor, {
          multiPv: message.multiPv || settings.cloudDepth || 3,
          moveHistory: message.gameInfo?.moveHistory || [],
          refresh: Boolean(message.refresh),
          positionToken,
          tabId,
          positionReliable: message.positionReliable === true
        }).then(cloudResult => {
          turnState.analysisInProgress = false;
          if (!apiCoordinator.isPositionCurrent(positionToken) || cloudResult?.stalePosition) return;

          if (cloudResult && !cloudResult.error) {
            markPositionAnalyzed(message.fen, cloudResult.source);
            turnState.consecutiveFailures = 0;
            cloudResult.hintLevel = effectiveHintLevel;

            // Exact-only mode has no lower-detail fallback. Guards withhold
            // the move rather than leaking it through a downgraded hint.
            const depthTarget = settings.depthTarget || 0;
            if (!exactHintBlocked && depthTarget > 0) {
              const actualDepth = cloudResult.depth || 0;
              // Sources with perfect or forced information (tablebase, mate
              // scores) bypass the depth target — they are not subject to
              // the same "shallow engine evaluation" risk.
              const isAuthoritative = cloudResult.source === 'tablebase' ||
                (cloudResult.pvs && cloudResult.pvs.some(pv => pv.scoreType === 'mate'));
              if (!isAuthoritative && actualDepth < depthTarget) {
                exactHintBlocked = { reason: 'depth_target', message: `Exact-move hints require depth ${depthTarget}; current depth is ${actualDepth}.` };
              }
            }
            cloudResult.exactHintBlocked = exactHintBlocked;

            if (cloudResult.pvs && cloudResult.pvs.length > 0 && cloudResult.pvs[0].pv && cloudResult.pvs[0].pv.length > 0) {
              recordEngineRecommendation(message.fen, cloudResult.pvs[0].pv[0]);
              cloudResult.correlationStats = getCorrelationStats();
              cloudResult.comparisonStats = getComparisonStats();
            }
            chrome.runtime.sendMessage({ type: 'analysis_update', data: cloudResult }).catch(() => {});
          } else {
            turnState.consecutiveFailures++;
            const detail = cloudResult?.errorDetail || classifyError();
            let errorMsg = detail.message || 'Cloud analysis unavailable';
            if (detail.suggestion === 'retry') errorMsg += ' Try Refresh.';
            else if (detail.suggestion === 'wait') errorMsg += ' Will retry on your next turn.';
            else if (detail.suggestion !== 'none') errorMsg += ' Check your connection and try Refresh.';
            chrome.runtime.sendMessage({
              type: 'analysis_error',
              data: { error: errorMsg, fen: message.fen, detail }
            }).catch(() => {});
          }
        });
        sendResponse({ ok: true });
      });
      return true;
    }
  },

  request_cloud_analysis: {
    pre: (message) => ChessCore.parseFen(message.fen) !== null,
    run(message, sender, sendResponse) {
      const tabId = getEffectiveTabId(message, sender);
      const positionToken = registerPosition(message.fen, tabId);
      notePanelActivity(tabId, true);
      performCloudAnalysis(message.fen, message.playerColor, {
        multiPv: message.multiPv || 3,
        moveHistory: message.moveHistory || [],
        refresh: Boolean(message.refresh),
        positionToken,
        tabId,
        positionReliable: message.positionReliable === true
      }).then(result => sendResponse(result)).catch(() => sendResponse(null));
      return true;
    }
  },

  health_check: {
    run(_message, _sender, sendResponse) {
      checkConnectionHealth().then(results => sendResponse(results)).catch(() => sendResponse({}));
      return true;
    }
  },

  get_api_diagnostics: {
    run(_message, _sender, sendResponse) {
      apiCoordinator.ready.then(() => sendResponse(apiCoordinator.getDiagnostics())).catch(() => sendResponse(null));
      return true;
    }
  },

  panel_state: {
    run(message, sender, sendResponse) {
      const tabId = getEffectiveTabId(message, sender);
      notePanelActivity(tabId, message.open !== false);
      if (message.open === false) apiCoordinator.cancelTab(tabId);
      sendResponse({ ok: true });
      return false;
    }
  },

  clear_caches: {
    run(_message, _sender, sendResponse) {
      // Clearing result data never clears quota, cooldown or provider-health
      // state — those are kept on purpose so the next request still has the
      // rate-limit and circuit-breaker signals to lean on.
      apiCoordinator.clearCaches().then(async () => {
        const items = await chrome.storage.local.get(null);
        const legacyKeys = Object.keys(items).filter(key =>
          key.startsWith('cloud_eval_') || key.startsWith('chessapi_') ||
          key.startsWith('opening_') || key.startsWith('tablebase_') ||
          key.startsWith('eval_') || key.startsWith('masters_eval_')
        );
        if (legacyKeys.length) await chrome.storage.local.remove(legacyKeys);
        resetAnalysisState();
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
  },

  player_color_changed: {
    run(_message, _sender, sendResponse) {
      // Reset all per-game/per-color trackers, not just turnState.
      resetAnalysisState();
      lastAnalysisGameId = null;
      resetCorrelationTracker();
      sendResponse({ ok: true });
      return false;
    }
  },

  // The side panel reports the player's actual move so we can compare it to
  // the engine's recommendation and update the rolling correlation window.
  // Accepts either { playerUci } (exact UCI) or { actualFen } (resulting FEN
  // — we FEN-diff to infer a match). Returns the match result (or null if
  // no stored engine recommendation).
  record_player_move: {
    run(message, _sender, sendResponse) {
      const result = recordPlayerMove(message.prevFen, {
        playerUci: message.playerUci,
        actualFen: message.actualFen
      });
      sendResponse(result);
      return false;
    }
  },

  // The side panel reports the human-natural move it actually recommended
  // (from its style/human-like selection), so the correlation guard can
  // distinguish human-like play from blind engine-top copies.
  record_human_recommendation: {
    run(message, _sender, sendResponse) {
      recordHumanRecommendation(message.fen, message.uci);
      sendResponse({ ok: true });
      return false;
    }
  },

  get_correlation_stats: {
    run(_message, _sender, sendResponse) {
      sendResponse(getCorrelationStats());
      return false;
    }
  },

  get_comparison_stats: {
    run(_message, _sender, sendResponse) {
      sendResponse(getComparisonStats());
      return false;
    }
  },

  // Infer the UCI that was played between two FENs. Used by the side
  // panel's moves-history log to display the SAN of the opponent's last
  // move (the side panel knows `fenAfterMyMove` from the snapshot and
  // `currentFen` from the next analysis, but not which UCI bridged them).
  // Returns null when no move can be inferred (different positions,
  // invalid FENs, or multiple plausible moves).
  infer_move: {
    pre: (message) => {
      if (!message || !message.prevFen || !message.currentFen) return false;
      if (ChessCore.parseFen(message.prevFen) === null) return false;
      if (ChessCore.parseFen(message.currentFen) === null) return false;
      return true;
    },
    run(message, _sender, sendResponse) {
      sendResponse(inferUciFromFenDiff(message.prevFen, message.currentFen));
      return false;
    }
  },

  // Side panel signals a new game so the tracker resets.
  reset_correlation: {
    run(_message, _sender, sendResponse) {
      resetCorrelationTracker();
      lastAnalysisGameId = null;
      sendResponse({ ok: true });
      return false;
    }
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = MESSAGE_ROUTES[message?.type];
  if (!route) return false;
  if (route.pre && !route.pre(message, sender)) {
    // A pre-condition failure silently nullifies the response. The previous
    // giant listener did the same thing via early `sendResponse(null)` calls;
    // keeping the contract for routes that already used null avoids changing
    // the side panel's interpretation of "this isn't available right now".
    sendResponse(null);
    return false;
  }
  return route.run(message, sender, sendResponse);
});

// ─── Start keepalive on install ──────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  startKeepAliveAlarm();

  // Migrate old settings keys
  chrome.storage.local.get('settings', (result) => {
    if (result.settings) {
      let updated = false;
      const s = result.settings;

      // Request reliability is now mandatory and centrally enforced. Remove
      // legacy toggles that implied quota or cache protection was optional.
      for (const obsolete of ['stealthMode', 'stealthRequestDelay', 'stealthCacheOnly',
        'minimalFootprint', 'smartThrottling', 'cacheFirstMode']) {
        if (s[obsolete] !== undefined) { delete s[obsolete]; updated = true; }
      }
      // Consolidate legacy playing styles into the rebuilt three-mode system.
      if (['super_aggressive', 'ultra_aggressive_stealth', 'kamikaze', 'berserker'].includes(s.style)) {
        s.style = 'super_ultra_aggressive';
        updated = true;
      } else if (!['normal', 'aggressive', 'super_ultra_aggressive'].includes(s.style)) {
        s.style = 'normal';
        updated = true;
      }

      if (s.humanLikeMode === undefined) { s.humanLikeMode = false; updated = true; }
      if (s.hintLevel !== undefined) { delete s.hintLevel; updated = true; }
      if (s.repertoire !== undefined) {
        // Preserve a legacy repertoire as the equivalent White selection.
        if (s.whiteRepertoire === undefined) s.whiteRepertoire = s.repertoire;
        delete s.repertoire;
        updated = true;
      }
      if (s.whiteRepertoire === undefined) { s.whiteRepertoire = 'none'; updated = true; }
      if (s.blackRepertoire === undefined) { s.blackRepertoire = 'none'; updated = true; }
      for (const obsolete of ['coachModeEnabled', 'coachModeMaxHints']) {
        if (s[obsolete] !== undefined) { delete s[obsolete]; updated = true; }
      }

      // Ensure new fields exist on migrated settings
      if (s.depthTarget === undefined) { s.depthTarget = 0; updated = true; }
      if (s.correlationThreshold !== undefined) { delete s.correlationThreshold; updated = true; }
      if (s.useChessApi === undefined) { s.useChessApi = true; updated = true; }
      if (s.useLichessCloud === undefined) { s.useLichessCloud = true; updated = true; }
      if (s.useMastersExplorer === undefined) { s.useMastersExplorer = true; updated = true; }
      if (s.showCorrelationStat === undefined) { s.showCorrelationStat = true; updated = true; }
      if (s.comparisonMode === undefined) { s.comparisonMode = 'engine'; updated = true; }

      if (updated) {
        chrome.storage.local.set({ settings: s });
      }
    }
  });
});

// Start the keep-alive alarm immediately on SW startup too,
// so it survives SW restarts without waiting for onInstalled.
startKeepAliveAlarm();
