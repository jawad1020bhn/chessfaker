importScripts('engine/core-utils.js');

/**
 * Chess Hint Assistant — Background Service Worker v8.5.0
 * 3-API Rotation Engine with Anti-Ban Protection
 *
 * v8.5.0 — Bug-fix & Enhancement Release:
 *  - FIX: Removed dead message handlers ('position_update_from_panel', 'position_changed',
 *         'position_update', 'analysis_info') and the dead handlePositionUpdate() path
 *  - FIX: smartThrottling & minimalFootprint settings now actually gate rate-limiter jitter
 *         and request spacing (previously placebo toggles)
 *  - FIX: Masters Explorer score now correctly normalised to White's perspective
 *  - FIX: Masters Explorer multiPv now respects user setting instead of hardcoded 3
 *  - FIX: Fallback loop no longer re-calls sources that failed non-fatally (e.g. 404)
 *  - FIX: cacheFirstMode cache keys now match runtime keys exactly
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
 * v7.5.0 — API Rotation & Anti-Ban (preserved):
 *  - 3-API rotation (Chess-API.com, Lichess Cloud Eval, Lichess Masters Explorer)
 *  - Health-based weighted round-robin — distributes load evenly across APIs
 *  - Lichess Masters Explorer as third source — human grandmaster move choices
 *  - Phase-aware source selection — openings prefer master games, midgame prefers engines
 *  - Cache-only enrichment — never makes extra API calls for PV enrichment
 *  - Anti-ban jitter on all rate limiters — random ±200-300ms spacing
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
  minimalFootprint: false,
  smartThrottling: true,
  cacheFirstMode: false,
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
  if (fen === turnState.lastAnalyzedFen) {
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
// ─── Adaptive Circuit Breaker v3 — Escalating Backoff ────────────────
// ═══════════════════════════════════════════════════════════════════════
class AdaptiveCircuitBreaker {
  constructor(name, config = {}) {
    this.name = name;
    this.failures = 0;
    this.lastFailureTime = 0;
    this.state = 'closed';
    this.failureThreshold = config.failureThreshold || 3;
    this.defaultRecoveryTime = config.defaultRecoveryTime || 20000;
    this.currentRecoveryTime = this.defaultRecoveryTime;
    this.maxRecoveryTime = config.maxRecoveryTime || 300000; // v7.5.0: max 5 min
    this.halfOpenTries = 0;
    this.halfOpenMaxTries = 2;
    this.successCount = 0;
    this.lastSuccessTime = 0;
    this.consecutiveFailures = 0;
    this.rateLimitHits = 0; // v7.5.0: track rate limit count for escalation
  }

  recordFailure(errorType = 'unknown') {
    this.failures++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    switch (errorType) {
      case 'rate_limit':
        this.rateLimitHits++;
        // v7.5.0: Escalating backoff for repeated rate limits
        if (this.rateLimitHits >= 3) {
          this.currentRecoveryTime = Math.min(300000, 60000 * this.rateLimitHits);
        } else if (this.name.includes('lichess')) {
          this.currentRecoveryTime = Math.min(this.maxRecoveryTime, 60000 * this.rateLimitHits);
        } else {
          this.currentRecoveryTime = Math.min(this.maxRecoveryTime, 30000 * this.rateLimitHits);
        }
        break;
      case 'server_error':
        this.currentRecoveryTime = 20000;
        break;
      case 'timeout':
        this.currentRecoveryTime = 15000;
        break;
      case 'network':
        this.currentRecoveryTime = 10000;
        break;
      case 'not_found':
        return;
      case 'circuit_open':
        return;
      default:
        this.currentRecoveryTime = this.defaultRecoveryTime;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      console.warn(`[Background] Circuit breaker OPEN for ${this.name} — ${this.consecutiveFailures} consecutive failures (recovery: ${this.currentRecoveryTime}ms)`);
    }
  }

  recordSuccess() {
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.halfOpenTries = 0;
    this.successCount++;
    this.lastSuccessTime = Date.now();
    this.currentRecoveryTime = this.defaultRecoveryTime;
    this.rateLimitHits = Math.max(0, this.rateLimitHits - 1); // Gradually reduce escalation
  }

  canTry() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.currentRecoveryTime) {
        this.state = 'half-open';
        this.halfOpenTries = 0;
        console.log(`[Background] Circuit breaker HALF-OPEN for ${this.name} — testing recovery`);
        return true;
      }
      return false;
    }
    if (this.state === 'half-open') {
      return this.halfOpenTries < this.halfOpenMaxTries;
    }
    return false;
  }

  incrementHalfOpen() {
    this.halfOpenTries++;
  }

  reset() {
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.halfOpenTries = 0;
    this.currentRecoveryTime = this.defaultRecoveryTime;
    this.rateLimitHits = 0;
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      currentRecoveryTime: this.currentRecoveryTime,
      rateLimitHits: this.rateLimitHits,
      healthScore: this.getHealthScore()
    };
  }

  getHealthScore() {
    if (this.consecutiveFailures === 0 && this.rateLimitHits === 0) return 100;
    if (this.state === 'open') return 0;
    if (this.state === 'half-open') return 30;
    return Math.max(10, 100 - (this.consecutiveFailures * 20) - (this.rateLimitHits * 10));
  }
}

// ─── Create Circuit Breakers ─────────────────────────────────────────
const breakers = {
  chessApi: new AdaptiveCircuitBreaker('chess-api', {
    failureThreshold: 4,
    defaultRecoveryTime: 15000,
    maxRecoveryTime: 180000
  }),
  lichessCloudEval: new AdaptiveCircuitBreaker('lichess-cloud-eval', {
    failureThreshold: 4,
    defaultRecoveryTime: 20000,
    maxRecoveryTime: 300000
  }),
  lichessMastersExplorer: new AdaptiveCircuitBreaker('lichess-masters-explorer', {
    failureThreshold: 4,
    defaultRecoveryTime: 20000,
    maxRecoveryTime: 300000
  }),
  lichessOpeningExplorer: new AdaptiveCircuitBreaker('lichess-opening-explorer', {
    failureThreshold: 4,
    defaultRecoveryTime: 15000
  }),
  lichessTablebase: new AdaptiveCircuitBreaker('lichess-tablebase', {
    failureThreshold: 3,
    defaultRecoveryTime: 15000
  })
};

// ═══════════════════════════════════════════════════════════════════════
// ─── Sliding Window Rate Limiter v2 — With Anti-Ban Jitter ───────────
// ═══════════════════════════════════════════════════════════════════════
// v8.5.0: Now respects live settings — smartThrottling gates jitter,
//         minimalFootprint roughly doubles the spacing & halves the cap.
class SlidingWindowRateLimiter {
  constructor(config = {}) {
    this.windows = new Map();
    this.maxRequests = config.maxRequests || 20;
    this.windowMs = config.windowMs || 60000;
    this.minSpacing = config.minSpacing || 1000;
    this.jitterMs = config.jitterMs || 200;
    this.lastRequestTime = 0;
    // v8.5.0: live settings overrides (read on each acquire)
    this._settingsProvider = null;
  }

  setSettingsProvider(fn) { this._settingsProvider = fn; }

  _liveSettings() {
    if (typeof this._settingsProvider === 'function') {
      try { return this._settingsProvider() || {}; } catch (_) { return {}; }
    }
    return {};
  }

  async acquire() {
    const s = this._liveSettings();
    const smartOn = s.smartThrottling !== false; // default ON
    const minimal = s.minimalFootprint === true;

    // v8.5.0: minimalFootprint doubles spacing & halves throughput.
    const spacingMultiplier = minimal ? 2.0 : 1.0;
    const capMultiplier = minimal ? 0.5 : 1.0;
    // Jitter is gated by smartThrottling (off → no jitter, deterministic spacing).
    const jitter = smartOn ? this.jitterMs : 0;

    const now = Date.now();
    const effectiveSpacing = (this.minSpacing * spacingMultiplier) + (jitter > 0 ? Math.random() * jitter : 0);

    if (now - this.lastRequestTime < effectiveSpacing) {
      await new Promise(r => setTimeout(r, effectiveSpacing - (now - this.lastRequestTime)));
    }

    let window = this.windows.get('default');
    if (!window || now - window.start >= this.windowMs) {
      window = { count: 0, start: now };
      this.windows.set('default', window);
    }

    const effectiveCap = Math.max(1, Math.floor(this.maxRequests * capMultiplier));
    if (window.count >= effectiveCap) {
      const waitTime = this.windowMs - (now - window.start) + 100 + (smartOn ? Math.random() * 500 : 0);
      console.warn(`[Background] Rate limiter: at limit (${window.count}/${effectiveCap} per ${this.windowMs / 1000}s), waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(r => setTimeout(r, waitTime));
      window = { count: 0, start: Date.now() };
      this.windows.set('default', window);
    }

    window.count++;
    this.lastRequestTime = Date.now();
  }
}

// v7.5.0: More conservative rate limits with jitter to avoid bans
const rateLimiters = {
  chessApi: new SlidingWindowRateLimiter({ maxRequests: 20, windowMs: 60000, minSpacing: 1200, jitterMs: 300 }),
  lichessCloudEval: new SlidingWindowRateLimiter({ maxRequests: 12, windowMs: 60000, minSpacing: 2500, jitterMs: 400 }),
  lichessMastersExplorer: new SlidingWindowRateLimiter({ maxRequests: 12, windowMs: 60000, minSpacing: 2500, jitterMs: 400 }),
  lichessOpeningExplorer: new SlidingWindowRateLimiter({ maxRequests: 15, windowMs: 60000, minSpacing: 2000, jitterMs: 300 }),
  lichessTablebase: new SlidingWindowRateLimiter({ maxRequests: 25, windowMs: 60000, minSpacing: 1000, jitterMs: 200 })
};

// v8.5.0: Live settings snapshot — read on every rate-limiter acquire so
// settings changes take effect without re-instantiating the limiters.
let _liveSettingsSnapshot = { ...DEFAULT_SETTINGS };
function refreshLiveSettings() {
  chrome.storage.local.get('settings', (r) => {
    if (r && r.settings) {
      _liveSettingsSnapshot = { ...DEFAULT_SETTINGS, ...r.settings };
    }
  });
}
for (const rl of Object.values(rateLimiters)) {
  rl.setSettingsProvider(() => _liveSettingsSnapshot);
}
refreshLiveSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    _liveSettingsSnapshot = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ─── API Rotation Engine v7.5.0 ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Distributes API calls across 3 sources using health-weighted round-robin.
// Prevents the repetitive patterns that trigger anti-abuse systems.
class ApiRotationEngine {
  constructor() {
    this.sources = ['chess-api', 'lichess-cloud', 'masters-explorer'];
    this.usageCounts = { 'chess-api': 0, 'lichess-cloud': 0, 'masters-explorer': 0 };
    this.lastUsed = { 'chess-api': 0, 'lichess-cloud': 0, 'masters-explorer': 0 };
    this.rotationIndex = 0;
  }

  /**
   * Get the ordered list of sources to try, based on health scores and rotation.
   * v7.5.0: Phase-aware — openings prefer masters, midgame/endgame prefer engines.
   */
  getSourceOrder(fen) {
    const moveNumber = parseInt(fen.split(' ')[5]) || 1;
    const totalPieces = this._countPieces(fen);
    const isInOpening = moveNumber <= 10 && totalPieces >= 24;

    // Get health scores for each source
    const scores = {};
    for (const source of this.sources) {
      const breaker = this._getBreaker(source);
      scores[source] = breaker ? breaker.getHealthScore() : 50;
      // Penalize sources that were used recently (spread the load)
      const timeSinceLastUse = Date.now() - (this.lastUsed[source] || 0);
      if (timeSinceLastUse < 5000) {
        scores[source] -= 20;
      }
      // Small bonus for sources used less (fair distribution)
      const minUsage = Math.min(...Object.values(this.usageCounts));
      if (this.usageCounts[source] === minUsage) {
        scores[source] += 10;
      }
    }

    // Phase-aware adjustments
    if (isInOpening) {
      scores['masters-explorer'] += 25; // Prefer human master moves in openings
    } else {
      scores['chess-api'] += 10; // Prefer engine in midgame/endgame
      scores['lichess-cloud'] += 5;
    }

    // Sort by score descending, but skip sources whose breakers are open
    const sorted = [...this.sources].sort((a, b) => scores[b] - scores[a]);

    // Filter out sources with open circuit breakers
    const available = sorted.filter(source => {
      const breaker = this._getBreaker(source);
      return breaker && breaker.canTry();
    });

    // If all circuit breakers are open, return all sources anyway (we'll try them)
    return available.length > 0 ? available : sorted;
  }

  recordUsage(source) {
    this.usageCounts[source] = (this.usageCounts[source] || 0) + 1;
    this.lastUsed[source] = Date.now();
  }

  _getBreaker(source) {
    const mapping = {
      'chess-api': breakers.chessApi,
      'lichess-cloud': breakers.lichessCloudEval,
      'masters-explorer': breakers.lichessMastersExplorer
    };
    return mapping[source] || null;
  }

  _countPieces(fen) {
    if (!fen) return 0;
    const placement = fen.split(' ')[0];
    let count = 0;
    for (const ch of placement) {
      if (/[prnbqkPRNBQK]/.test(ch)) count++;
    }
    return count;
  }
}

const rotationEngine = new ApiRotationEngine();

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

// ─── Request Coalescing (Singleflight) ────────────────────────────────
const inFlightRequests = new Map();

// ─── In-Memory Cache ─────────────────────────────────────────────────
// v8.5.0: LRU-ish eviction — when over cap, evict oldest by timestamp
//         (not just TTL-expired) so a flood of fresh entries can't grow unbounded.
const memoryCache = new Map();
const MEMORY_CACHE_CAP = 1000;
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_TTL_TB = 60 * 60 * 1000;

function getMemoryCache(key, ttl) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > (ttl || CACHE_TTL)) {
    memoryCache.delete(key);
    return null;
  }
  // v8.5.0: refresh insertion order for LRU behaviour
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.data;
}

function setMemoryCache(key, data) {
  memoryCache.set(key, { data, timestamp: Date.now() });
  if (memoryCache.size > MEMORY_CACHE_CAP) {
    // v8.5.0: evict oldest 25% by insertion order (Map preserves it)
    const toRemove = Math.ceil(memoryCache.size * 0.25);
    let removed = 0;
    for (const k of memoryCache.keys()) {
      if (removed >= toRemove) break;
      memoryCache.delete(k);
      removed++;
    }
  }
}

function clearMemoryCache(prefix) {
  if (!prefix) { memoryCache.clear(); return; }
  for (const [k] of memoryCache) {
    if (k.startsWith(prefix)) memoryCache.delete(k);
  }
}

// ─── Storage Cache Helper ────────────────────────────────────────────
async function getStorageCache(key, ttl) {
  try {
    const cached = await chrome.storage.local.get(key);
    if (cached[key] && Date.now() - cached[key].timestamp < ttl) {
      return cached[key].data;
    }
  } catch (e) {}
  return null;
}

async function setStorageCache(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { data, timestamp: Date.now() } });
  } catch (e) {}
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

// v8.5.0: per-fetch in-flight counter — used to know when to NOT let the
// SW go idle. We no longer need explicit start/stop; the alarm runs
// continuously while the SW is alive, and the SW is kept alive by the
// presence of in-flight fetches + the alarm.
let inFlightFetchCount = 0;
function startApiKeepAlive() { inFlightFetchCount++; }
function stopApiKeepAlive() { inFlightFetchCount = Math.max(0, inFlightFetchCount - 1); }

// ═══════════════════════════════════════════════════════════════════════
// ─── Fetch with Adaptive Retry ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function fetchWithRetry(url, options = {}, breaker = null, maxRetries = 1, baseDelay = 1500) {
  let lastError = null;
  let lastErrorType = 'unknown';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (breaker && !breaker.canTry()) {
      console.log(`[Background] Circuit breaker ${breaker.name} is OPEN, skipping`);
      return { _failed: true, _errorType: 'circuit_open' };
    }
    if (breaker && breaker.state === 'half-open') {
      breaker.incrementHalfOpen();
    }

    startApiKeepAlive();

    try {
      const controller = new AbortController();
      const timeoutMs = options.timeout || 15000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions = { ...options, signal: controller.signal };
      if (!fetchOptions.headers) fetchOptions.headers = {};
      if (!fetchOptions.headers['Accept']) fetchOptions.headers['Accept'] = 'application/json';

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      // ── 429 Rate Limit ──
      if (response.status === 429) {
        lastErrorType = 'rate_limit';
        const retryAfter = response.headers.get('Retry-After');
        let waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 0;

        if (url.includes('lichess.org') || url.includes('lichess.ovh')) {
          waitMs = Math.max(waitMs, 60000);
        } else {
          const jitter = Math.random() * baseDelay;
          waitMs = Math.max(waitMs, baseDelay * Math.pow(2, attempt) + jitter);
        }

        console.warn(`[Background] Rate limited (429) by ${url}, waiting ${Math.round(waitMs / 1000)}s...`);

        // v7.5.0: On rate limit, don't retry — just fail fast and try next source
        if (breaker) breaker.recordFailure('rate_limit');
        return { _failed: true, _errorType: 'rate_limit' };
      }

      // ── 404 Not Found ──
      if (response.status === 404) {
        if (url.includes('lichess.org/api/cloud-eval')) {
          return { status: 404, _lichessNotCached: true };
        }
        if (url.includes('explorer.lichess.ovh/master')) {
          return { status: 404, _mastersNotCached: true }; // v7.5.0: Masters 404 is normal
        }
        if (breaker) breaker.recordFailure('not_found');
        return { _failed: true, _errorType: 'not_found' };
      }

      // ── 5xx Server Errors ──
      if (response.status >= 500) {
        lastErrorType = 'server_error';
        if (attempt < maxRetries) {
          const jitter = Math.random() * 500;
          const delay = baseDelay * Math.pow(2, attempt) + jitter;
          console.warn(`[Background] Server error ${response.status} from ${url}, retrying in ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (breaker) breaker.recordFailure('server_error');
        return { _failed: true, _errorType: 'server_error' };
      }

      // ── Other HTTP errors ──
      if (!response.ok) {
        if (breaker) breaker.recordFailure('unknown');
        return { _failed: true, _errorType: 'http_' + response.status };
      }

      // ── Success ──
      if (breaker) breaker.recordSuccess();
      return response;

    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') {
        lastErrorType = 'timeout';
        console.warn(`[Background] Request timeout for ${url}, attempt ${attempt + 1}/${maxRetries + 1}`);
      } else {
        lastErrorType = 'network';
        console.warn(`[Background] Fetch error for ${url}: ${e.message}, attempt ${attempt + 1}/${maxRetries + 1}`);
      }

      if (attempt < maxRetries) {
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
      }
    } finally {
      if (attempt >= maxRetries) {
        stopApiKeepAlive();
      }
    }
  }

  if (breaker) breaker.recordFailure(lastErrorType);
  console.error(`[Background] All retries failed for ${url}: ${lastError?.message}`);
  return { _failed: true, _errorType: lastErrorType };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Cloud API #1: Chess-API.com ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function chessApiEval(fen, multiPv = 3, depth = 12) {
  const cacheKey = `chessapi_${fen}_${multiPv}_${depth}`;
  const cached = getMemoryCache(cacheKey, CACHE_TTL);
  if (cached) return { ...cached, cached: true };

  await rateLimiters.chessApi.acquire();

  try {
    const response = await fetchWithRetry('https://chess-api.com/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        fen: fen,
        depth: depth,
        maxThinkingTime: 100
      }),
      timeout: 18000
    }, breakers.chessApi, 1, 1500);

    if (response && response._failed) {
      console.warn(`[Background] Chess-API failed: ${response._errorType}`);
      return null;
    }
    if (!response) return null;
    if (response._lichessNotCached || response._mastersNotCached) return null;

    const data = await response.json();

    if (data.type === 'error' || data.error) {
      console.warn('[Background] Chess-API returned error:', data.error || data.text);
      return null;
    }

    if (!data.move) return null;

    const result = normalizeChessApi(data, fen);
    setMemoryCache(cacheKey, result);
    return { ...result, source: 'chess-api', cached: false };
  } catch (e) {
    console.error('[Background] Chess-API error:', e.message);
    return null;
  }
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
async function lichessCloudEval(fen, multiPv = 5) {
  const cacheKey = `cloud_eval_${fen}_${multiPv}`;
  const cached = getMemoryCache(cacheKey, CACHE_TTL);
  if (cached) return { ...cached, cached: true };

  const storageCached = await getStorageCache(cacheKey, CACHE_TTL);
  if (storageCached) {
    setMemoryCache(cacheKey, storageCached);
    return { ...storageCached, cached: true };
  }

  await rateLimiters.lichessCloudEval.acquire();

  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  const response = await fetchWithRetry(url, { timeout: 14000 }, breakers.lichessCloudEval, 1, 2000);

  if (response && response._failed) {
    console.warn(`[Background] Lichess cloud eval failed: ${response._errorType}`);
    return null;
  }
  if (!response) return null;

  if (response._lichessNotCached) {
    console.log('[Background] Lichess cloud eval: position not cached, skipping');
    return null;
  }

  try {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const text = await response.text();
      console.warn('[Background] Lichess returned non-JSON:', text.substring(0, 100));
      breakers.lichessCloudEval.recordFailure('rate_limit');
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.log('[Background] Lichess cloud eval error:', data.error);
      return null;
    }

    if (!data.pvs || data.pvs.length === 0) return null;

    const result = normalizeLichessCloudEval(data, fen);
    setMemoryCache(cacheKey, result);
    setStorageCache(cacheKey, result);
    return { ...result, source: 'lichess-cloud', cached: false };
  } catch (e) {
    console.error('[Background] Lichess cloud eval parse error:', e.message);
    return null;
  }
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
async function lichessMastersEval(fen, multiPv = 5) {
  const cacheKey = `masters_eval_${fen}_${multiPv}`;
  const cached = getMemoryCache(cacheKey, CACHE_TTL * 2);
  if (cached) return { ...cached, cached: true };

  const storageCached = await getStorageCache(cacheKey, CACHE_TTL * 2);
  if (storageCached) {
    setMemoryCache(cacheKey, storageCached);
    return { ...storageCached, cached: true };
  }

  await rateLimiters.lichessMastersExplorer.acquire();

  const url = `https://explorer.lichess.ovh/master?fen=${encodeURIComponent(fen)}&moves=${multiPv}&topGames=3`;
  const response = await fetchWithRetry(url, { timeout: 12000 }, breakers.lichessMastersExplorer, 1, 2000);

  if (response && response._failed) {
    console.warn(`[Background] Masters explorer failed: ${response._errorType}`);
    return null;
  }
  if (!response) return null;
  if (response._mastersNotCached || response._lichessNotCached) {
    console.log('[Background] Masters explorer: position not in database (normal for non-opening positions)');
    return null;
  }

  try {
    const data = await response.json();
    const result = normalizeMastersEval(data, fen);

    if (!result || result.pvs.length === 0) return null;

    setMemoryCache(cacheKey, result);
    setStorageCache(cacheKey, result);
    return { ...result, source: 'masters-explorer', cached: false };
  } catch (e) {
    console.error('[Background] Masters explorer parse error:', e.message);
    return null;
  }
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
async function lichessOpeningExplorer(fen) {
  const cacheKey = `opening_${fen}`;
  const cached = getMemoryCache(cacheKey, CACHE_TTL * 2);
  if (cached) return { ...cached, cached: true };

  await rateLimiters.lichessOpeningExplorer.acquire();

  const url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fen)}&moves=8&topGames=3&ratings=1600,1800,2000,2200,2500`;
  const response = await fetchWithRetry(url, { timeout: 10000 }, breakers.lichessOpeningExplorer, 1, 1200);

  if (response && response._failed) return null;
  if (!response) return null;
  if (response._lichessNotCached || response._mastersNotCached) return null;

  try {
    const data = await response.json();
    const result = normalizeOpeningExplorer(data);
    setMemoryCache(cacheKey, result);
    return { ...result, cached: false };
  } catch (e) {
    console.error('[Background] Opening explorer parse error:', e.message);
    return null;
  }
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
async function lichessTablebase(fen) {
  if (!fen) return null;
  const placement = fen.split(' ')[0];
  let pieceCount = 0;
  for (const ch of placement) { if (/[prnbqkPRNBQK]/.test(ch)) pieceCount++; }
  if (pieceCount > 7) return null;

  const cacheKey = `tablebase_${fen}`;
  const cached = getMemoryCache(cacheKey, CACHE_TTL_TB);
  if (cached) return { ...cached, cached: true };

  await rateLimiters.lichessTablebase.acquire();

  const url = `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`;
  const response = await fetchWithRetry(url, { timeout: 10000 }, breakers.lichessTablebase, 1, 1000);

  if (response && response._failed) return null;
  if (!response) return null;
  if (response._lichessNotCached || response._mastersNotCached) return null;

  try {
    const data = await response.json();
    const result = normalizeTablebase(data);
    setMemoryCache(cacheKey, result);
    return { ...result, cached: false };
  } catch (e) {
    console.error('[Background] Tablebase parse error:', e.message);
    return null;
  }
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
// ─── Main Cloud Analysis — 3-API Rotation Engine v7.5.0 ──────────────
// ═══════════════════════════════════════════════════════════════════════
async function performCloudAnalysis(fen, playerColor, options = {}) {
  const multiPv = options.multiPv || 3;

  // Request coalescing
  const dedupeKey = `${fen}_${multiPv}`;
  if (inFlightRequests.has(dedupeKey)) {
    console.log('[Background] Coalescing request for:', fen.substring(0, 20));
    return inFlightRequests.get(dedupeKey);
  }

  // v8.5.0: Wrap in a top-level catch so an unexpected throw inside
  // _performCloudAnalysisInternal can never orphan the dedupe entry.
  const analysisPromise = (async () => {
    try {
      return await _performCloudAnalysisInternal(fen, playerColor, options);
    } catch (e) {
      console.error('[Background] Cloud analysis unexpected error:', e?.message || e);
      return {
        error: true,
        fen,
        playerColor,
        errorDetail: { type: 'transient', message: 'Analysis failed unexpectedly', suggestion: 'retry' },
        moveHistory: options.moveHistory || []
      };
    }
  })();

  inFlightRequests.set(dedupeKey, analysisPromise);
  try {
    return await analysisPromise;
  } finally {
    inFlightRequests.delete(dedupeKey);
  }
}

async function _performCloudAnalysisInternal(fen, playerColor, options = {}) {
  const multiPv = options.multiPv || 3;
  const settings = await new Promise(resolve =>
    chrome.storage.local.get('settings', r => resolve(r.settings || DEFAULT_SETTINGS))
  );

  console.log(`[Background] v7.5.0 Starting rotation analysis for: ${fen.substring(0, 30)}... (multiPv=${multiPv})`);

  // 1. Check tablebase first (instant perfect play for endgames)
  const tbResult = await lichessTablebase(fen);
  if (tbResult && tbResult.category && tbResult.category !== 'unknown') {
    const result = buildTablebaseResult(tbResult, fen);
    result.tablebaseData = tbResult;
    if (options.moveHistory) result.moveHistory = options.moveHistory;
    result.playerColor = playerColor;
    console.log('[Background] Tablebase result found');
    // v7.5.0: Non-blocking opening data fetch — don't block the return
    lichessOpeningExplorer(fen).then(openingData => {
      if (openingData) {
        result.openingData = openingData;
        chrome.runtime.sendMessage({
          type: 'opening_data_update',
          data: { fen, openingData }
        }).catch(() => {});
      }
    }).catch(() => {});
    return result;
  }

  // ── v7.5.0: 3-API Rotation with Health-Based Priority ──
  const sourceOrder = rotationEngine.getSourceOrder(fen);
  console.log(`[Background] Rotation order: ${sourceOrder.join(' → ')}`);

  let bestResult = null;
  let usedSource = null;
  const allResults = {}; // Store all results for cache-only enrichment

  // If cache-first mode is enabled, try cache before any API calls
  if (settings.cacheFirstMode) {
    const cacheChecks = [
      { source: 'chess-api', key: `chessapi_${fen}_${multiPv}_12` },
      { source: 'lichess-cloud', key: `cloud_eval_${fen}_${multiPv}` },
      { source: 'masters-explorer', key: `masters_eval_${fen}_${multiPv}` }
    ];

    for (const { source, key } of cacheChecks) {
      let cached = getMemoryCache(key, CACHE_TTL);
      if (!cached && source === 'lichess-cloud') {
        cached = await getStorageCache(key, CACHE_TTL);
      }
      if (!cached && source === 'masters-explorer') {
        cached = await getStorageCache(key, CACHE_TTL * 2);
      }
      if (cached) {
        allResults[source] = { ...cached, cached: true };
        if (!bestResult) {
          bestResult = allResults[source];
          usedSource = source;
        }
      }
    }

    if (bestResult) {
      console.log(`[Background] Cache-first: using cached ${usedSource} result`);
    }
  }

  // If no cached result, try sources in rotation order
  if (!bestResult) {
    // v8.5.0: Track which sources returned null (failed non-fatally, e.g.
    // Masters 404). Prevents the fallback loop from re-calling them.
    const failedSources = new Set();
    for (const source of sourceOrder) {
      // Skip if circuit breaker is open
      const breaker = rotationEngine._getBreaker(source);
      if (breaker && !breaker.canTry()) {
        console.log(`[Background] Skipping ${source} — circuit breaker open`);
        failedSources.add(source);
        continue;
      }

      const startTime = Date.now();
      let result = null;

      switch (source) {
        case 'chess-api':
          result = await chessApiEval(fen, multiPv, 12);
          break;
        case 'lichess-cloud':
          result = await lichessCloudEval(fen, multiPv);
          break;
        case 'masters-explorer':
          result = await lichessMastersEval(fen, multiPv);
          break;
      }

      const elapsed = Date.now() - startTime;

      if (result) {
        console.log(`[Background] ${source} succeeded in ${elapsed}ms`);
        allResults[source] = result;
        bestResult = result;
        usedSource = source;
        rotationEngine.recordUsage(source);
        break; // Got a result, stop trying other sources
      } else {
        console.log(`[Background] ${source} failed (${elapsed}ms)`);
        failedSources.add(source);
      }
    }

    // v7.5.0: If primary rotation failed, try remaining sources as fallback.
    // v8.5.0: Track failed sources explicitly so we don't re-call sources
    //         that already failed non-fatally (e.g. Masters 404 on non-opening
    //         position) — those breakers didn't open but the call was wasted.
    if (!bestResult) {
      const fallbackSources = sourceOrder.filter(s => !allResults[s] && !failedSources.has(s));
      for (const source of fallbackSources) {
        const breaker = rotationEngine._getBreaker(source);
        if (breaker && !breaker.canTry()) continue;

        console.log(`[Background] Fallback: trying ${source}...`);
        let result = null;

        switch (source) {
          case 'chess-api':
            result = await chessApiEval(fen, 1, 10); // Lower depth for fallback
            break;
          case 'lichess-cloud':
            result = await lichessCloudEval(fen, 1);
            break;
          case 'masters-explorer':
            result = await lichessMastersEval(fen, 3);
            break;
        }

        if (result) {
          allResults[source] = result;
          bestResult = result;
          usedSource = source;
          rotationEngine.recordUsage(source);
          break;
        } else {
          // v8.5.0: mark as failed so a subsequent fallback pass won't retry it.
          failedSources.add(source);
        }
      }
    }
  }

  // ── v7.5.0: Cache-Only Enrichment ──
  // Only enrich from ALREADY CACHED data — never make new API calls for enrichment.
  // This eliminates the double-call problem that caused rate limiting in v7.3.0.
  if (bestResult) {
    const existingMoves = new Map();
    bestResult.pvs.forEach(pv => {
      if (pv.pv[0]) existingMoves.set(pv.pv[0], pv);
    });

    for (const [source, srcResult] of Object.entries(allResults)) {
      if (source === usedSource || !srcResult || !srcResult.pvs) continue;
      for (const pv of srcResult.pvs) {
        if (!pv.pv[0]) continue;
        if (existingMoves.has(pv.pv[0])) {
          const existing = existingMoves.get(pv.pv[0]);
          // Only replace if the other source has significantly deeper analysis
          if ((pv.depth || 0) > (existing.depth || 0) + 10 && pv.depth > 20) {
            const origIdx = existing.multipv;
            Object.assign(existing, { ...pv, multipv: origIdx });
          }
        } else if (bestResult.pvs.length < multiPv) {
          pv.multipv = bestResult.pvs.length + 1;
          bestResult.pvs.push(pv);
          existingMoves.set(pv.pv[0], pv);
        }
      }
    }

    // Enrich depth from cached Lichess Cloud data
    if (allResults['lichess-cloud'] && usedSource !== 'lichess-cloud') {
      const lichessResult = allResults['lichess-cloud'];
      if (lichessResult.depth > bestResult.depth) {
        bestResult.depth = lichessResult.depth;
        bestResult.knodes = lichessResult.knodes || bestResult.knodes;
      }
    }
  }

  if (bestResult) {
    bestResult.source = usedSource;
    bestResult.playerColor = playerColor;
    if (options.moveHistory) bestResult.moveHistory = options.moveHistory;

    // Non-blocking opening data fetch
    lichessOpeningExplorer(fen).then(openingData => {
      if (openingData) {
        bestResult.openingData = openingData;
        chrome.runtime.sendMessage({
          type: 'opening_data_update',
          data: { fen, openingData }
        }).catch(() => {});
      }
    }).catch(() => {});

    if (tbResult) bestResult.tablebaseData = tbResult;

    console.log(`[Background] Analysis complete: source=${usedSource}, depth=${bestResult.depth}, pvs=${bestResult.pvs.length}`);
    return bestResult;
  }

  // All sources failed
  console.error('[Background] All cloud analysis sources failed for FEN:', fen.substring(0, 30));

  const breakerStates = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    breakerStates[name] = breaker.getStatus();
  }

  const errorDetail = classifyError(breakerStates);

  return {
    error: true,
    fen,
    playerColor,
    breakerStates,
    errorDetail,
    moveHistory: options.moveHistory || []
  };
}

// ─── Error Classification for User-Friendly Messages ─────────────────
function classifyError(breakerStates) {
  const states = Object.entries(breakerStates);
  const openBreakers = states.filter(([_, s]) => s.state === 'open');
  const allHealthy = states.every(([_, s]) => s.state === 'closed');

  if (allHealthy) {
    return {
      type: 'transient',
      message: 'Analysis temporarily unavailable. This usually resolves within seconds.',
      suggestion: 'retry'
    };
  }

  const rateLimited = openBreakers.filter(([name, s]) =>
    s.currentRecoveryTime >= 50000 && (name.includes('lichess') || name.includes('masters'))
  );

  if (rateLimited.length > 0) {
    return {
      type: 'rate_limited',
      message: 'Rate limited by cloud API. Waiting before retrying.',
      suggestion: 'wait'
    };
  }

  if (openBreakers.length === states.length) {
    return {
      type: 'all_down',
      message: 'All cloud APIs are currently unavailable.',
      suggestion: 'wait_long'
    };
  }

  return {
    type: 'partial',
    message: 'Some cloud APIs are unavailable. Retrying with available sources.',
    suggestion: 'retry'
  };
}

// ─── Connection Health Check ─────────────────────────────────────────
async function checkConnectionHealth() {
  const results = {};
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
  }

  // Check Chess-API
  try {
    const start = Date.now();
    const response = await fetchWithTimeout('https://chess-api.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ fen: startFen, depth: 10, maxThinkingTime: 50 })
    }, 12000);
    const latency = Date.now() - start;
    if (!response.ok) {
      results['chess-api'] = { ok: false, latency, status: response.status, error: `HTTP ${response.status}` };
    } else {
      const data = await response.json();
      const isOk = !!data.move && data.type !== 'error' && !data.error;
      results['chess-api'] = { ok: isOk, latency, status: response.status };
    }
  } catch (e) {
    results['chess-api'] = { ok: false, latency: -1, error: e.message };
  }

  // Check Lichess Cloud Eval
  try {
    const start = Date.now();
    const response = await fetchWithTimeout(
      `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(startFen)}&multiPv=1`,
      { headers: { 'Accept': 'application/json' } },
      10000
    );
    const latency = Date.now() - start;
    results['lichess'] = { ok: response.ok || response.status === 404, latency, status: response.status };
  } catch (e) {
    results['lichess'] = { ok: false, latency: -1, error: e.message };
  }

  // v7.5.0: Check Masters Explorer
  try {
    const start = Date.now();
    const response = await fetchWithTimeout(
      `https://explorer.lichess.ovh/master?fen=${encodeURIComponent(startFen)}&moves=3`,
      { headers: { 'Accept': 'application/json' } },
      10000
    );
    const latency = Date.now() - start;
    results['masters'] = { ok: response.ok || response.status === 404, latency, status: response.status };
  } catch (e) {
    results['masters'] = { ok: false, latency: -1, error: e.message };
  }

  return results;
}

// ─── Read Board from Active Tab ──────────────────────────────────────
// DOM readers can observe placement reliably, but castling, en-passant and
// counters require move history. Keep reconciled metadata separately per tab.
const lastObservedFenByTab = new Map();

async function readBoardFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
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

chrome.tabs.onRemoved.addListener(tabId => lastObservedFenByTab.delete(tabId));

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
      const settings = result.settings || DEFAULT_SETTINGS;
      const assistedPlayerColor = message.playerColor || result.assistedPlayerColor || 'w';

      if (message.fen) {
        const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const startPlacement = startFen.split(' ')[0];
        const fenPlacement = message.fen.split(' ')[0];
        if (fenPlacement === startPlacement) {
          hintUsageTracker = { gameId: Date.now(), l5Count: 0, l4Count: 0, lastWarnLevel: 0 };
          resetAnalysisState();
          // v8.5.0: also reset correlation tracker on new game
          resetCorrelationTracker();
        }
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

      if (message.refresh) {
        for (const breaker of Object.values(breakers)) breaker.reset();
        resetAnalysisState();
        if (message.fen) {
          clearMemoryCache('cloud_eval_' + message.fen);
          clearMemoryCache('chessapi_' + message.fen);
          clearMemoryCache('opening_' + message.fen);
          clearMemoryCache('tablebase_' + message.fen);
          clearMemoryCache('masters_eval_' + message.fen); // v7.5.0
          const prefixes = [
            'cloud_eval_' + message.fen + '_',
            'chessapi_' + message.fen + '_',
            'opening_' + message.fen,
            'tablebase_' + message.fen,
            'masters_eval_' + message.fen + '_'
          ];
          // storage.remove does not support wildcard keys; enumerate so every
          // multi-PV/depth variant for this position is actually invalidated.
          chrome.storage.local.get(null).then(items => {
            const keys = Object.keys(items).filter(key => prefixes.some(prefix => key.startsWith(prefix)));
            if (keys.length) return chrome.storage.local.remove(keys);
          }).catch(() => {});
        }
      }

      const turnCheck = shouldAnalyzePosition(message.fen, assistedPlayerColor);

      if (!turnCheck.shouldAnalyze && !message.refresh) {
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
        moveHistory: message.gameInfo?.moveHistory || []
      }).then(cloudResult => {
        turnState.analysisInProgress = false;

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
          const detail = cloudResult?.errorDetail || classifyError(cloudResult?.breakerStates || {});
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
    performCloudAnalysis(message.fen, message.playerColor, {
      multiPv: message.multiPv || 3,
      moveHistory: message.moveHistory || []
    }).then(result => sendResponse(result)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'request_opening_data') {
    lichessOpeningExplorer(message.fen).then(data => sendResponse(data)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'request_tablebase_data') {
    lichessTablebase(message.fen).then(data => sendResponse(data)).catch(() => sendResponse(null));
    return true;
  }

  if (msgType === 'get_circuit_states') {
    const states = {};
    for (const [name, breaker] of Object.entries(breakers)) states[name] = breaker.getStatus();
    sendResponse(states);
    return false;
  }

  if (msgType === 'health_check') {
    checkConnectionHealth().then(results => sendResponse(results)).catch(() => sendResponse({}));
    return true;
  }

  if (msgType === 'clear_caches') {
    memoryCache.clear();
    for (const breaker of Object.values(breakers)) breaker.reset();
    resetAnalysisState();
    chrome.storage.local.get(null, (items) => {
      const keysToRemove = Object.keys(items).filter(k =>
        k.startsWith('cloud_eval_') || k.startsWith('chessapi_') ||
        k.startsWith('opening_') || k.startsWith('tablebase_') ||
        k.startsWith('eval_') || k.startsWith('masters_eval_') // v7.5.0
      );
      chrome.storage.local.remove(keysToRemove).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
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

      if (s.stealthMode !== undefined && s.minimalFootprint === undefined) {
        s.minimalFootprint = s.stealthMode;
        delete s.stealthMode;
        updated = true;
      }
      if (s.stealthRequestDelay !== undefined && s.smartThrottling === undefined) {
        s.smartThrottling = s.stealthRequestDelay;
        delete s.stealthRequestDelay;
        updated = true;
      }
      if (s.stealthCacheOnly !== undefined && s.cacheFirstMode === undefined) {
        s.cacheFirstMode = s.stealthCacheOnly;
        delete s.stealthCacheOnly;
        updated = true;
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
