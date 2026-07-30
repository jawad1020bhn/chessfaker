/**
 * Chess Hint Assistant — Cloud Engine v9.0.0
 *
 * Cloud Provider Metadata
 *
 * v9.0.0: Metadata retained for the rebuilt Standard/Human-like style pipeline.
 * v8.5.0: Removed unused duplicate cache (localCache/clearLocalCache/getCacheStats)
 *         — background.js owns caching through its central coordinator.
 * v7.5.0 — Earlier API rotation metadata:
 *  - Lichess Masters Explorer as third analysis source
 *  - Health-based weighted round-robin API rotation
 *  - Phase-aware source selection (openings → masters, midgame → engines)
 *  - Cache-only enrichment — no extra API calls for PV merge
 *
 * v7.1.0 preserved:
 *  - Turn-based analysis metadata
 *  - Cloud API endpoint definitions
 *  - Source labels and quality rankings
 *
 * NOTE: The actual API calls are made in background.js (service worker context).
 * This file provides the hint-engine with cloud API metadata and utilities.
 */

(function () {
  'use strict';

  // ─── Cloud API Metadata ──────────────────────────────────────────────
  const API_ENDPOINTS = {
    chessApi: {
      url: 'https://chess-api.com/v1',
      name: 'Chess-API.com',
      quality: 'Stockfish 18 NNUE (live, depth ~12-18)',
      latency: '~1-5s',
      multiPV: false,
      method: 'POST',
      alwaysEvaluates: true
    },
    lichessCloudEval: {
      url: 'https://lichess.org/api/cloud-eval',
      name: 'Lichess Cloud Eval',
      quality: 'Cached depth 40-75+ (deepest when available)',
      latency: '~1-3s (if cached)',
      multiPV: true,
      method: 'GET',
      alwaysEvaluates: false
    },
    lichessMastersExplorer: {
      url: 'https://explorer.lichess.ovh/master',
      name: 'Lichess Masters Explorer',
      quality: 'Human grandmaster game statistics (natural moves)',
      latency: '~0.5-2s',
      multiPV: true,
      method: 'GET',
      alwaysEvaluates: false,
      isHumanSource: true
    },
    lichessOpeningExplorer: {
      url: 'https://explorer.lichess.ovh/lichess',
      name: 'Lichess Opening Explorer',
      quality: 'Player game statistics',
      latency: '~1-2s',
      multiPV: false,
      method: 'GET'
    },
    lichessTablebase: {
      url: 'https://tablebase.lichess.ovh/standard',
      name: 'Lichess Tablebase',
      quality: 'Perfect play (<=7 pieces)',
      latency: '~0.5-1s',
      multiPV: false,
      method: 'GET'
    }
  };

  // ─── Source Labels for UI ────────────────────────────────────────────
  const SOURCE_LABELS = {
    'chess-api': { label: 'Chess-API.com', badge: 'CLOUD', quality: 'Strong' },
    'lichess-cloud': { label: 'Lichess Cloud', badge: 'CLOUD', quality: 'Deepest' },
    'masters-explorer': { label: 'Masters DB', badge: 'HUMAN', quality: 'Natural' },
    'tablebase': { label: 'Tablebase', badge: 'TB', quality: 'Perfect' }
  };

  // ─── Source Quality Ranking ──────────────────────────────────────────
  function getSourceRank(source) {
    const ranks = {
      'tablebase': 5,
      'lichess-cloud': 4,
      'chess-api': 3,
      'masters-explorer': 2  // v7.5.0: Human source, lower engine rank but higher "naturalness"
    };
    return ranks[source] || 0;
  }

  function getSourceInfo(source) {
    return SOURCE_LABELS[source] || { label: source, badge: 'CLOUD', quality: 'Unknown' };
  }

  // ─── Public API ──────────────────────────────────────────────────────
  window.ChessCloudEngine = {
    API_ENDPOINTS,
    SOURCE_LABELS,
    getSourceRank,
    getSourceInfo
  };

})();
