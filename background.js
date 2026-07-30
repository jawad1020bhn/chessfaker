importScripts('engine/core-utils.js', 'engine/api-coordinator.js');

/**
 * Chess Hint Assistant — Background Service Worker v9.0.0
 * Centralized API reliability, cache, quota, and cooldown protection
 *
 * v9.0.0 — Three-mode style engine, Human-like selection setting,
 *            stateful FEN reconciliation, safer rendering, and regression coverage.
 *
 * v8.5.0 — Bug-fix & Enhancement Release:
 *  - FIX: Removed dead message handlers ('position_update_from_panel', 'position_changed',
 *         'position_update', 'analysis_info') and the dead handlePositionUpdate() path
 *  - FIX: Masters Explorer score now correctly normalised to White's perspective
 *  - FIX: Masters Explorer multiPv now respects user setting instead of hardcoded 3
 *  - FIX: Fallback loop no longer re-calls sources that failed non-fatally (e.g. 404)
 *  - FIX: hintUsageTracker now resets on player_color_changed (was only reset on new game)
 *  - FIX: inFlightRequests rejection-safe (no orphan entries on unexpected throw)
 *  - FIX: memoryCache LRU eviction when over cap (was only TTL-based)
 *  - FIX: Consolidated keep-alive into a single chrome.alarms-based mechanism
 *         (removed the redundant setInterval + platform-info leak)
 *  - ENH (G): Replaced setInterval keep-alive with chrome.alarms (MV3 best practice)
 *  - ENH (C): Forwards depthTarget setting to sidepanel for L4/L5 gating
 *  - ENH (I): Tracks player-move / engine-recommendation correlation; sidepanel reads it
 *  - ENH (J): ECO openings now loaded from engine/eco.json (with inline fallback)
 *
 * v7.5.0 — Earlier API rotation design (superseded by the central coordinator):
 *  - 3-API rotation (Chess-API.com, Lichess Cloud Eval, Lichess Masters Explorer)
 *  - Health-based weighted round-robin — distributes load evenly across APIs
 *  - Lichess Masters Explorer as third source — human grandmaster move choices
 *  - Phase-aware source selection — openings prefer master games, midgame prefers engines
 *  - Cache-only enrichment — never makes extra API calls for PV enrichment
 *  - Adaptive backoff escalation — 60s→120s→300s for repeated rate limits
 *
 * v7.3.0 preserved features:
 *  - Turn-based analysis — only analyzes on the assisted player's turn
 *  - Adaptive circuit breaker with per-error-type recovery
 *  - Request coalescing (singleflight pattern)
 *  - Persistent cache across service worker restarts
 *  - Coach Mode & Fair Play warnings
 *  - Berserker/Kamikaze/Ultra Aggressive playing styles
 *  - Lichess 429 = 60s+ cooldown, 404 = not a failure
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
  repertoire: 'none',
  hintLevel: 3,
  autoAnalyze: true,
  showThreats: true,
  showAssessment: true,
  showContinuation: true,
  showEvalHistory: true,
  showOpeningExplorer: true,
  showTablebase: true,
  showEndgameCoach: true,
  showCriticalMoments: true,
  showCandidateMoves: true,
  coachModeEnabled: true,
  coachModeMaxHints: 3,
  // v8.5.0 enhancements
  depthTarget: 0,                  // 0 = no minimum; otherwise min depth for L4/L5
  correlationThreshold: 100        // 100 = off; otherwise % cap that downgrades L5→L3
};

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

function semanticSourceOrder(fen) {
  return ApiReliability.planPositionWorkflow(fen, { showOpeningExplorer: true }).analysisSources;
}


// ─── Coach Mode & Hint Tracking ──────────────────────────────────────
let hintUsageTracker = { gameId: null, l5Count: 0, l4Count: 0, lastWarnLevel: 0 };
let lastL5HintTime = 0;
const L5_COOLDOWN_MS = 5000;

// v8.5.0 — Real engine-correlation guard (Enhancement I)
// Stores the engine's first-choice UCI move keyed by FEN-of-side-to-move.
// When the sidepanel reports the player's actual move (or the actual
// resulting FEN), we compare and update a rolling window of last 8 moves.
const ENGINE_MOVE_BY_FEN_LIMIT = 200;
const engineMoveByFen = new Map();
const correlationWindow = []; // array of booleans (true = matched engine)
let correlationMatches = 0;
let correlationTotal = 0;

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

// Accepts either:
//   { prevFen, playerUci }  — exact UCI the player played
//   { prevFen, actualFen }  — resulting FEN (we'll infer match by FEN-diff)
// Returns { matched, expected, recentPct } or null if no stored recommendation.
function recordPlayerMove(prevFen, payload) {
  if (!prevFen) return null;
  const expected = engineMoveByFen.get(prevFen);
  if (!expected) return null;
  let matched = false;
  if (payload && payload.playerUci) {
    matched = payload.playerUci === expected;
  } else if (payload && payload.actualFen) {
    // v8.5.0: Infer whether the player played the engine's recommended move
    // by applying it to prevFen and comparing piece-placement + side-to-move
    // against actualFen. If they match, the player played the engine move.
    matched = didPlayerPlayEngineMove(prevFen, expected, payload.actualFen);
  }
  correlationWindow.push(matched);
  if (correlationWindow.length > 8) correlationWindow.shift();
  correlationTotal++;
  if (matched) correlationMatches++;
  return { matched, expected, recentPct: correlationWindow.filter(Boolean).length / correlationWindow.length };
}

// v8.5.0: Apply the engine's UCI to prevFen and compare placement + side-to-move
// with actualFen. If equal, the player played the recommended move.
// The shared helper applies the move to piece placement and compares it with
// the newly observed position, while deliberately ignoring volatile counters.
function didPlayerPlayEngineMove(prevFen, engineUci, actualFen) {
  // Compare the resulting placement and require the side to move to flip.
  // ChessCore also handles castling, promotion and en-passant captures.
  return ChessCore.didUciProduceFen(prevFen, engineUci, actualFen);
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

function resetCorrelationTracker() {
  engineMoveByFen.clear();
  correlationWindow.length = 0;
  correlationMatches = 0;
  correlationTotal = 0;
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
// ─── Service Worker Keep-Alive (v8.5.0: chrome.alarms based) ─────────
// ═══════════════════════════════════════════════════════════════════════
// v8.5.0: Replaced two redundant setInterval-based keep-alives with a
// single chrome.alarms-based one. Alarms fire in the SW's event page,
// resetting its 30s idle timer. No more platform-info leak, no more
// orphaned timers across fetch failures.
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
  const activeColor = fen ? (fen.split(' ')[1] || 'w') : 'w';
  const isBlackToMove = activeColor === 'b';

  if (data.move) {
    const isMate = data.mate !== null && data.mate !== undefined && data.mate !== '';
    let scoreType, score;

    if (isMate) {
      scoreType = 'mate';
      const mateScore = parseInt(String(data.mate)) || 0;
      score = isBlackToMove ? -mateScore : mateScore;
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
          const mateScore = parseInt(String(v.mate)) || 0;
          score = isBlackToMove ? -mateScore : mateScore;
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
  const pvs = (data.pvs || []).map((pv, idx) => {
    const pvMoves = (pv.moves || '').split(/\s+/).filter(Boolean);
    return {
      multipv: idx + 1,
      scoreType: pv.mate !== undefined ? 'mate' : 'cp',
      score: pv.mate !== undefined ? pv.mate : (pv.cp || 0),
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
// ─── Cloud API #3: Lichess Masters Explorer (v7.5.0 NEW) ────────────
// ═══════════════════════════════════════════════════════════════════════
// Provides moves based on what human GRANDMASTERS actually played.
// More "natural and human" than engine evaluation — reflects real
// human decision-making at the highest level of play.
async function lichessMastersEval(fen, multiPv = 5, context = {}) {
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

  // v8.5.0: Score MUST be normalised to White's perspective to match
  // the contract documented in hint-engine.js (pv.score > 0 = White winning).
  // Previously this computed side-to-move-relative scores, which double-
  // flipped for black-to-move positions and showed inverted evaluations.

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
    isHumanSource: true, // v7.5.0: flag for UI to show "Human" label
    opening: data.opening || null,
    masterTopGames: topGames,
    totalMasterGames: total,
    moveHistory: [],
    scorePerspective: 'white' // v8.5.0: now correctly white-relative
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
async function getCachedAnalysisSource(source, fen, multiPv) {
  const depth = source === 'chess-api' ? 12 : 0;
  const cacheKey = analysisCacheKey(source, fen, multiPv, depth);
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
    chrome.storage.local.get('settings', result => resolve({ ...DEFAULT_SETTINGS, ...(result.settings || {}) }))
  );
  const priority = options.refresh ? 'manual-current-position' : 'current-player-turn';
  const context = { positionToken, refresh: Boolean(options.refresh), priority };

  // Deterministic tablebases are the sole remote workflow for eligible
  // endgames. A successful tablebase lookup always stops engine routing.
  if (settings.showTablebase !== false && countFenPieces(fen) <= 7) {
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

  const sourceOrder = semanticSourceOrder(fen);
  let bestResult = null;
  let usedSource = null;

  // Cache lookup spans all semantically relevant sources before any remote
  // request, so a fresh secondary cache beats an unnecessary primary call.
  if (!options.refresh) {
    for (const source of sourceOrder) {
      // In openings, a cached player-explorer result is useful human move data
      // and is checked after Masters but before any engine cache or remote call.
      if (source === 'lichess-cloud' && isPlausibleOpening(fen)) {
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

  if (!bestResult) {
    const eligibleSources = sourceOrder.filter(source =>
      apiCoordinator.canSchedule(providerForAnalysisSource(source), priority)
    );
    // One primary plus at most one genuine fallback. Permanent 4xx responses,
    // cooldowns and disabled providers never trigger repeated calls.
    for (const source of eligibleSources.slice(0, 2)) {
      const result = await callAnalysisSource(source, fen, multiPv, context);
      if (!apiCoordinator.isPositionCurrent(positionToken)) {
        return { error: true, stalePosition: true, fen, errorDetail: { type: 'stale_position', message: 'Position changed', suggestion: 'none' } };
      }
      if (result) {
        bestResult = result;
        usedSource = source;
        break;
      }
    }
  }

  if (!bestResult) {
    return {
      error: true,
      fen,
      playerColor,
      errorDetail: classifyError(),
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
  if (settings.showOpeningExplorer === true && isPlausibleOpening(fen)) {
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
function classifyError() {
  const diagnostics = apiCoordinator.getDiagnostics();
  const statuses = Object.values(diagnostics.providers || {});
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
    message: 'No eligible cloud result is available within the current request budget.',
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
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    const result = results?.[0]?.result;
    if (!result || !ChessCore.parseFen(result.fen)) return null;
    result.tabId = tab.id;

    const previousFen = lastObservedFenByTab.get(tab.id) || null;
    if (previousFen && previousFen.split(' ')[0] === result.fen.split(' ')[0]) {
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msgType = message.type;

  if (msgType === 'read_board') {
    readBoardFromActiveTab().then(result => {
      sendResponse(result);
    }).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msgType === 'get_turn_state') {
    sendResponse({
      isPlayerTurn: turnState.isPlayerTurn,
      waitingForOpponent: turnState.waitingForOpponent,
      lastAnalyzedFen: turnState.lastAnalyzedFen,
      analysisInProgress: turnState.analysisInProgress
    });
    return false;
  }

  // v8.5.0: Removed dead 'position_update_from_panel' and 'position_changed'
  //         handlers — side panel only communicates via 'request_analysis'.

  if (msgType === 'request_analysis') {
    if (!ChessCore.parseFen(message.fen)) {
      sendResponse({ ok: false, error: 'Invalid board position' });
      return false;
    }
    chrome.storage.local.get(['settings', 'assistedPlayerColor'], (result) => {
      const settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
      const assistedPlayerColor = message.playerColor || result.assistedPlayerColor || 'w';
      const tabId = message.tabId ?? sender.tab?.id ?? 'active';
      notePanelActivity(tabId, true);
      const positionToken = registerPosition(message.fen, tabId);

      if (positionToken && hintUsageTracker.gameId !== positionToken.gameId) {
        hintUsageTracker = { gameId: positionToken.gameId, l5Count: 0, l4Count: 0, lastWarnLevel: 0 };
        resetAnalysisState();
        resetCorrelationTracker();
      }

      let effectiveHintLevel = message.hintLevel || settings.hintLevel || 3;
      let coachModeDowngrade = false;
      if (settings.coachModeEnabled && effectiveHintLevel === 5) {
        const now = Date.now();
        if (now - lastL5HintTime < L5_COOLDOWN_MS) {
          effectiveHintLevel = 3;
          coachModeDowngrade = true;
        } else if (hintUsageTracker.l5Count >= (settings.coachModeMaxHints || 3)) {
          effectiveHintLevel = 3;
          coachModeDowngrade = true;
        } else {
          hintUsageTracker.l5Count++;
          lastL5HintTime = now;
        }
      } else if (effectiveHintLevel === 4) {
        hintUsageTracker.l4Count++;
      }

      // Refresh is deliberately non-destructive: caches, cooldowns, quotas and
      // passive health remain intact. The coordinator decides whether the
      // current cached result is old enough to revalidate.

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
        tabId
      }).then(cloudResult => {
        turnState.analysisInProgress = false;
        if (!apiCoordinator.isPositionCurrent(positionToken) || cloudResult?.stalePosition) return;

        if (cloudResult && !cloudResult.error) {
          markPositionAnalyzed(message.fen, cloudResult.source);
          turnState.consecutiveFailures = 0;

          cloudResult.hintLevel = effectiveHintLevel;
          cloudResult.coachModeDowngrade = coachModeDowngrade;
          cloudResult.hintUsage = {
            l5Count: hintUsageTracker.l5Count,
            l4Count: hintUsageTracker.l4Count,
            maxL5: settings.coachModeMaxHints || 3
          };

          // v8.5.0: Apply depth-target gating (Enhancement C) — if the engine's
          // depth is below the user's configured minimum AND hint level is L4/L5,
          // downgrade to L3 so we don't reveal specific moves on shallow analysis.
          const depthTarget = settings.depthTarget || 0;
          if (depthTarget > 0 && effectiveHintLevel >= 4) {
            const actualDepth = cloudResult.depth || 0;
            // Tablebase (depth 999) always passes.
            if (actualDepth < depthTarget && actualDepth < 100) {
              cloudResult.depthDowngrade = { from: effectiveHintLevel, to: 3, reason: `depth ${actualDepth} < target ${depthTarget}` };
              effectiveHintLevel = 3;
              cloudResult.hintLevel = 3;
            }
          }

          // v8.5.0: Apply correlation cap (Enhancement I) — if recent
          // engine-match rate over the last 8 moves exceeds the user's
          // threshold, downgrade L5 → L3.
          const corrThreshold = settings.correlationThreshold || 100;
          if (effectiveHintLevel === 5 && corrThreshold < 100) {
            const stats = getCorrelationStats();
            if (stats.recentSize >= 3 && stats.recentPct >= corrThreshold) {
              cloudResult.correlationDowngrade = { from: 5, to: 3, recentPct: stats.recentPct, threshold: corrThreshold };
              effectiveHintLevel = 3;
              cloudResult.hintLevel = 3;
            }
          }

          // v8.5.0: Record the engine's first-choice move so that when the
          // player makes their move, we can update the correlation tracker.
          if (cloudResult.pvs && cloudResult.pvs.length > 0 && cloudResult.pvs[0].pv && cloudResult.pvs[0].pv.length > 0) {
            recordEngineRecommendation(message.fen, cloudResult.pvs[0].pv[0]);
            // Also expose (non-revealing) correlation stats so the sidepanel UI
            // can show "Engine Match: X / Y (Z%)" without revealing the move.
            cloudResult.correlationStats = getCorrelationStats();
          }

          chrome.runtime.sendMessage({ type: 'analysis_update', data: cloudResult }).catch(() => {});
        } else {
          turnState.consecutiveFailures++;
          const detail = cloudResult?.errorDetail || classifyError();
          let errorMsg = detail.message || 'Cloud analysis unavailable';
          if (detail.suggestion === 'retry') errorMsg += ' Try Refresh.';
          else if (detail.suggestion === 'wait') errorMsg += ' Will retry on your next turn.';
          else errorMsg += ' Check your connection and try Refresh.';
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

  if (msgType === 'request_cloud_analysis') {
    if (!ChessCore.parseFen(message.fen)) { sendResponse(null); return false; }
    const tabId = message.tabId ?? sender.tab?.id ?? 'active';
    const positionToken = registerPosition(message.fen, tabId);
    notePanelActivity(tabId, true);
    performCloudAnalysis(message.fen, message.playerColor, {
      multiPv: message.multiPv || 3,
      moveHistory: message.moveHistory || [],
      refresh: Boolean(message.refresh),
      positionToken,
      tabId
    }).then(result => sendResponse(result)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'request_opening_data') {
    if (!ChessCore.parseFen(message.fen) || !isPlausibleOpening(message.fen)) {
      sendResponse(null);
      return false;
    }
    const tabId = message.tabId ?? sender.tab?.id ?? 'active';
    const positionToken = registerPosition(message.fen, tabId);
    chrome.storage.local.get('settings').then(result => {
      const settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
      if (!settings.showOpeningExplorer) return null;
      return lichessOpeningExplorer(message.fen, { positionToken, priority: 'opening-enrichment' });
    }).then(data => sendResponse(data)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'request_tablebase_data') {
    if (!ChessCore.parseFen(message.fen) || countFenPieces(message.fen) > 7) {
      sendResponse(null);
      return false;
    }
    const tabId = message.tabId ?? sender.tab?.id ?? 'active';
    const positionToken = registerPosition(message.fen, tabId);
    lichessTablebase(message.fen, { positionToken, priority: 'current-position-tablebase' })
      .then(data => sendResponse(data)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'get_circuit_states') {
    sendResponse(apiCoordinator.getDiagnostics().providers);
    return false;
  }

  if (msgType === 'health_check') {
    checkConnectionHealth().then(results => sendResponse(results)).catch(() => sendResponse({}));
    return true;
  }

  if (msgType === 'get_api_diagnostics') {
    apiCoordinator.ready.then(() => sendResponse(apiCoordinator.getDiagnostics())).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'panel_state') {
    const tabId = message.tabId ?? sender.tab?.id ?? 'active';
    notePanelActivity(tabId, message.open !== false);
    if (message.open === false) apiCoordinator.cancelTab(tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (msgType === 'clear_caches') {
    // Clearing result data never clears quota, cooldown or provider-health state.
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

  if (msgType === 'player_color_changed') {
    // v8.5.0: Reset all per-game/per-color trackers, not just turnState.
    resetAnalysisState();
    hintUsageTracker = { gameId: null, l5Count: 0, l4Count: 0, lastWarnLevel: 0 };
    resetCorrelationTracker();
    sendResponse({ ok: true });
    return false;
  }

  // v8.5.0 (Enhancement I): Side panel reports the player's actual move so
  // we can compare it to the engine's recommendation and update the rolling
  // correlation window. Accepts either { playerUci } (exact UCI) or
  // { actualFen } (resulting FEN — we'll FEN-diff to infer a match).
  // Returns the match result (or null if no stored engine recommendation).
  if (msgType === 'record_player_move') {
    const result = recordPlayerMove(message.prevFen, {
      playerUci: message.playerUci,
      actualFen: message.actualFen
    });
    sendResponse(result);
    return false;
  }

  if (msgType === 'get_correlation_stats') {
    sendResponse(getCorrelationStats());
    return false;
  }

  // v8.5.0 (Enhancement I): Side panel signals a new game so the tracker resets.
  if (msgType === 'reset_correlation') {
    resetCorrelationTracker();
    hintUsageTracker = { gameId: null, l5Count: 0, l4Count: 0, lastWarnLevel: 0 };
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// v8.5.0: Removed dead handlePositionUpdate() function — was only reachable
//         from the now-removed 'position_update_from_panel' / 'position_changed'
//         handlers. The side panel drives analysis via 'request_analysis' only.

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

      // v8.5.0: ensure new fields exist on migrated settings
      if (s.depthTarget === undefined) { s.depthTarget = 0; updated = true; }
      if (s.correlationThreshold === undefined) { s.correlationThreshold = 100; updated = true; }

      if (updated) {
        chrome.storage.local.set({ settings: s });
      }
    }
  });
});

// v8.5.0: Start the keep-alive alarm immediately on SW startup too,
// so it survives SW restarts without waiting for onInstalled.
startKeepAliveAlarm();
