/**
 * Chess Hint Assistant — Side Panel Controller v9.1.0
 * Turn-Based Analysis Engine. No local Stockfish.
 *
 * v9.1.0 — DGT Slate & Tournament Obsidian Minimalist UI/UX redesign,
 *          synchronized horizontal evaluation gauge, enhanced analytical
 *          chart canvas rendering, and improved source indicator badges.
 *
 * v9.0.0 — Three playing styles with Standard/Human-like modes, synchronized
 *            candidate views, natural plan continuity, and human coaching hints.
 *
 * v8.5.0 — Bug-fix & Enhancement Release:
 *  - FIX: Berserker style now produces border color + tag + mode class in UI
 *         (was invisible — UI only handled kamikaze)
 *  - FIX: currentSource initialised to 'unknown' (was 'cloud' — never matched
 *         real sources like 'masters-explorer' / 'tablebase')
 *  - FIX: Toast only shown on user-initiated refresh, not every auto-analysis
 *         (was spamming toasts every 2-5s on player's turn)
 *  - FIX: Health-check button disabled during check (was clickable repeatedly)
 *  - FIX: clearCaches button text restored to 'Clear Caches' after reset
 *         (was reverting to 'Clear All Caches' — different from initial label)
 *  - FIX: Removed dead message handlers 'position_update' & 'analysis_info'
 *  - FIX: source-badge now properly mapped for masters-explorer ('HUMAN')
 *  - FIX: Settings panel now has a focus trap (Tab can't escape to underlying UI)
 *  - FIX: sacrificeHistory reset on new game (via ChessHintEngine.resetSacrificeHistory)
 *  - ENH (C): depth target and fair-play controls can withhold exact hints
 *             shown as a clear withheld-hint message
 *  - ENH (D): Candidate moves & eval labels now use formatScorePlayerPerspective
 *             for "+1.5 (you)" style displays
 *  - ENH (H): "Open on Lichess" button — opens lichess.org/analysis/<fen> in new tab
 *  - ENH (I): Real engine-correlation guard — tracks player's actual moves
 *             vs engine recommendations over a rolling 8-move window;
 *             side panel sends record_player_move + displays match stats
 *  - ENH (J): ECO database now externalised to engine/eco.json (loaded by hint-engine)
 *
 * v8.0.0 — "Midnight Chess" Ultra-Pro Redesign (preserved):
 *  - Complete visual redesign — dark-only "Midnight Chess" design language
 *  - Tab-based navigation (Coach / Analysis / Explore)
 *  - SVG icons throughout, neon glow accents, refined glassmorphism
 *  - Bottom action bar with always-visible hint level selector + refresh
 *  - Q/W/E keyboard shortcuts for tab switching
 *
 * v7.5.0 — Earlier 3-API routing + v7.3.0 Berserker Style + v7.1.0 Turn-Based Analysis:
 *  - Turn-based analysis — only analyzes on the assisted player's turn
 *  - "Waiting for opponent..." status when it's the opponent's turn
 *  - "Your turn" indicator when analysis is ready
 *
 * v6.0.0/v6.2.0/v6.1.0 preserved features:
 *  - Fair Play warnings for exact-move hints
 *  - Player Selection (White/Black assist)
 *  - Style-aware hints (Normal → Berserker)
 *  - Cloud API health status display
 *  - Candidate Move Evaluation, Critical Moments, Endgame Coach
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────
  let currentFen = null;
  let playerColor = null;          // Auto-detected from board orientation
  let assistedPlayerColor = null;  // User-selected: which player to assist (null = not yet set)
  let activeTabId = 'active';       // Included in position-generation tokens
  let positionReliable = false;     // True only when the site supplied a complete FEN
  let turnReliable = false;         // True only when the site supplied an active color
  const EXACT_HINT_LEVEL = 5;
  let lastAnalysis = null;
  let prevEval = null;
  let evalHistory = [];
  let currentSource = 'unknown';  // v8.5.0: was 'cloud' (never matched real source strings)
  let lastCriticalAlert = null;
  let isRefreshing = false;
  let refreshSafetyTimer = null;
  let humanPlanState = null;

  const normalizeStyle = (style) => {
    if (style === 'normal' || style === 'aggressive' || style === 'super_ultra_aggressive') return style;
    return ['super_aggressive', 'ultra_aggressive_stealth', 'kamikaze', 'berserker'].includes(style)
      ? 'super_ultra_aggressive'
      : 'normal';
  };

  let settings = {
    cloudDepth: 5,
    style: 'normal',
    humanLikeMode: false,
    whiteRepertoire: 'none',
    blackRepertoire: 'none',
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
    // v8.5.0 enhancements
    depthTarget: 0,                 // 0 = no minimum; otherwise min depth for exact hints
    useChessApi: true,
    useLichessCloud: true,
    useMastersExplorer: true
  };

  // ─── DOM References ─────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const h = (value) => ChessCore.escapeHtml(value);
  const clamp = (value, min, max, fallback = min) => ChessCore.clampNumber(value, min, max, fallback);

  const dom = {
    engineStatus: $('#engine-status'),
    statusDot: $('.status-dot'),
    statusText: $('.status-text'),
    positionContext: $('#position-context'),
    positionSource: $('#position-source'),
    positionTurn: $('#position-turn'),
    evalBarBlack: $('#eval-bar-black'),
    evalBarWhite: $('#eval-bar-white'),
    evalWhiteLabel: $('#eval-white-label'),
    evalBlackLabel: $('#eval-black-label'),
    evalDescription: $('#eval-description'),
    openingName: $('#opening-name'),
    gamePhase: $('#game-phase'),
    analysisDepth: $('#analysis-depth'),
    analysisSource: $('#analysis-source'),
    sourceBadge: $('#source-badge'),
    materialBalance: $('#material-balance'),
    hintText: $('#hint-text'),
    hintFromTo: $('#hint-fromto'),
    hintTags: $('#hint-tags'),
    hintCard: $('#hint-card'),
    winningPlan: $('#winning-plan'),
    planText: $('#plan-text'),
    threatSection: $('#threat-section'),
    threatText: $('#threat-text'),
    assessmentSection: $('#assessment-section'),
    assessmentCards: $('#assessment-cards'),
    pvLines: $('#pv-lines'),
    continuationSection: $('#continuation-section'),
    continuationMoves: $('#continuation-moves'),
    moveClassSection: $('#move-class-section'),
    moveClassDisplay: $('#move-class-display'),
    evalHistorySection: $('#eval-history-section'),
    evalChart: $('#eval-chart'),
    settingsPanel: $('#settings-panel'),
    btnSettings: $('#btn-settings'),
    btnCloseSettings: $('#btn-close-settings'),
    btnRefresh: $('#btn-refresh'),
    btnHealthCheck: $('#btn-health-check'),
    btnClearCaches: $('#btn-clear-caches'),
    // Cloud-specific
    openingExplorerSection: $('#opening-explorer-section'),
    openingStats: $('#opening-stats'),
    winBarWhite: $('#win-bar-white'),
    winBarDraws: $('#win-bar-draws'),
    winBarBlack: $('#win-bar-black'),
    winPctWhite: $('#win-pct-white'),
    winPctDraws: $('#win-pct-draws'),
    winPctBlack: $('#win-pct-black'),
    openingMoves: $('#opening-moves'),
    topGames: $('#top-games'),
    tablebaseSection: $('#tablebase-section'),
    tbCategory: $('#tb-category'),
    tbDtm: $('#tb-dtm'),
    tbMoves: $('#tb-moves'),
    // Features
    playerSelector: $('#player-selector'),
    candidateSection: $('#candidate-section'),
    candidateMoves: $('#candidate-moves'),
    criticalMomentSection: $('#critical-moment-section'),
    criticalMomentText: $('#critical-moment-text'),
    criticalMomentDetail: $('#critical-moment-detail'),
    endgameCoachSection: $('#endgame-coach-section'),
    egPhaseLabel: $('#eg-phase-label'),
    egTechnique: $('#eg-technique'),
    egPlan: $('#eg-plan'),
    egStepList: $('#eg-step-list'),
    // v8.5.0 additions
    btnLichessAnalysis: $('#btn-lichess-analysis'),
    correlationStat: $('#correlation-stat')
  };

  // ─── Turn-Based State ──────────────────────────────────────────────
  let isPlayerTurn = true;             // Is it currently the assisted player's turn?
  let waitingForOpponent = false;      // Are we waiting for opponent to move?
  let turnJustChanged = false;         // Did the turn just change to the player?

  // v8.5.0 (Enhancement I): Track player's actual moves vs engine recommendations.
  // We remember the FEN at the moment the engine returned its recommendation;
  // when the side panel later observes a new FEN where it's no longer the player's
  // turn (i.e. the player just moved), we infer the move and report it to background.
  let lastEngineRecommendationFen = null;
  let lastEngineRecommendationUci = null;

  // ─── Board Reading with Jitter ───────────────────────────────────
  let boardReadTimer = null;
  const READ_INTERVAL_MIN = 2000;
  const READ_INTERVAL_MAX = 5000;

  function startBoardReading() {
    if (boardReadTimer) return;
    readBoardFromBackground();
    scheduleNextRead();
  }

  function stopBoardReading() {
    if (boardReadTimer) {
      clearTimeout(boardReadTimer);
      boardReadTimer = null;
    }
  }

  function scheduleNextRead() {
    const delay = READ_INTERVAL_MIN + Math.random() * (READ_INTERVAL_MAX - READ_INTERVAL_MIN);
    boardReadTimer = setTimeout(async () => {
      await readBoardFromBackground();
      scheduleNextRead();
    }, delay);
  }

  async function readBoardFromBackground() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'read_board' });
      if (result && result.fen) {
        activeTabId = result.tabId ?? activeTabId;
        chrome.runtime.sendMessage({ type: 'panel_state', open: true, tabId: activeTabId }).catch(() => {});
        handlePositionUpdate({
          fen: result.fen,
          playerColor: result.playerColor,
          positionReliable: result.positionReliable === true,
          turnReliable: result.turnReliable === true,
          fenSource: result.fenSource || 'dom-placement',
          gameInfo: { site: result.site, url: result.url, timestamp: result.timestamp, moveHistory: [], tabId: activeTabId }
        });
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── v7.9.0: Toast Notification System ────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  const TOAST_DURATION = 3500;
  const TOAST_MAX = 3;
  let toastCount = 0;

  function showToast(message, type = 'info', duration = TOAST_DURATION) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Limit toasts
    while (container.children.length >= TOAST_MAX) {
      const oldest = container.firstElementChild;
      if (oldest) oldest.remove();
    }

    const icons = { success: '\u2713', error: '\u2717', warning: '\u26A0', info: '\u2139' };
    const safeType = Object.hasOwn(icons, type) ? type : 'info';
    const toast = document.createElement('div');
    toast.className = `toast toast-${safeType}`;
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[safeType];
    const messageElement = document.createElement('span');
    messageElement.className = 'toast-message';
    messageElement.textContent = String(message ?? '');
    toast.append(icon, messageElement);
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── v8.0.0: Tab Navigation System ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        // Update button states
        tabBtns.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        // Show target pane, hide others
        tabPanes.forEach(pane => {
          pane.style.display = 'none';
          pane.classList.remove('active');
        });
        const targetPane = document.getElementById(`tab-${targetTab}`);
        if (targetPane) {
          targetPane.style.display = 'flex';
          targetPane.classList.add('active');
        }
      });
    });
  }

  function switchToTab(tabName) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.click();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── v7.9.0: Collapsible Sections ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  function initCollapsibleSections() {
    document.querySelectorAll('.section-collapsible .section-header').forEach(header => {
      header.addEventListener('click', () => {
        const section = header.closest('.section-collapsible');
        if (!section) return;
        section.classList.toggle('collapsed');
        const expanded = !section.classList.contains('collapsed');
        header.setAttribute('aria-expanded', expanded.toString());
      });
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          header.click();
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ─── v7.9.0: Keyboard Shortcuts ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  let shortcutHelpVisible = false;

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Don't intercept if user is in an input/select field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();

      switch (key) {
        case 'r':
          e.preventDefault();
          if (dom.btnRefresh) dom.btnRefresh.click();
          break;
        case 's':
          e.preventDefault();
          if (dom.settingsPanel && dom.settingsPanel.style.display !== 'none') {
            dom.settingsPanel.style.display = 'none';
          } else if (dom.btnSettings) {
            dom.btnSettings.click();
          }
          break;
        case 'q':
          e.preventDefault();
          switchToTab('coach');
          break;
        case 'w':
          e.preventDefault();
          switchToTab('analysis');
          break;
        case 'e':
          e.preventDefault();
          switchToTab('explore');
          break;
        case 'escape':
          if (shortcutHelpVisible) {
            const help = document.getElementById('shortcut-help');
            if (help) help.style.display = 'none';
            shortcutHelpVisible = false;
          } else if (dom.settingsPanel && dom.settingsPanel.style.display !== 'none') {
            dom.settingsPanel.style.display = 'none';
          }
          break;
        case '?':
          e.preventDefault();
          const help = document.getElementById('shortcut-help');
          if (help) {
            shortcutHelpVisible = !shortcutHelpVisible;
            help.style.display = shortcutHelpVisible ? 'block' : 'none';
          }
          break;
        default:
          break;
      }
    });
  }

  function finishRefresh() {
    if (refreshSafetyTimer) clearTimeout(refreshSafetyTimer);
    refreshSafetyTimer = null;
    if (dom.btnRefresh) dom.btnRefresh.classList.remove('spinning');
    isRefreshing = false;
  }

  // ─── Initialize ────────────────────────────────────────────────────
  function init() {
    loadSettings();
    initTabs();
    bindEvents();
    initCollapsibleSections();
    initKeyboardShortcuts();
    initSettingsFocusTrap();   // v8.5.0
    chrome.runtime.sendMessage({ type: 'panel_state', open: true }).catch(() => {});
    window.addEventListener('pagehide', () => {
      chrome.runtime.sendMessage({ type: 'panel_state', open: false, tabId: activeTabId }).catch(() => {});
    }, { once: true });
    startBoardReading();
    updateEngineStatus('connecting', 'Connecting to cloud...');
    updateCorrelationStat();   // v8.5.0: initialise "0 / 0 (0%)" display
    runHealthCheck();          // passive status only; does not call providers
  }

  // v8.5.0 (fix #39): Focus trap for the settings panel so Tab can't escape
  // to the underlying UI while it's open. Also moves focus into the panel on
  // open and restores it to the settings button on close.
  function initSettingsFocusTrap() {
    if (!dom.settingsPanel) return;
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    const getFocusable = () => Array.from(dom.settingsPanel.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetParent !== null && !el.disabled);

    dom.settingsPanel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // When the panel is shown, move focus into it; when hidden, restore.
    const observer = new MutationObserver(() => {
      const isVisible = dom.settingsPanel.style.display !== 'none';
      if (isVisible) {
        const focusable = getFocusable();
        if (focusable.length > 0 && !dom.settingsPanel.contains(document.activeElement)) {
          focusable[0].focus();
        }
      }
    });
    observer.observe(dom.settingsPanel, { attributes: true, attributeFilter: ['style'] });
  }

  function loadSettings() {
    chrome.storage.local.get('settings', (result) => {
      if (result.settings) {
        settings = { ...settings, ...result.settings, style: normalizeStyle(result.settings.style) };
        applySettingsToUI();
        if (settings.style !== result.settings.style) chrome.storage.local.set({ settings });
        if (lastAnalysis) renderAnalysis(lastAnalysis);
      }
    });
    chrome.storage.local.get('assistedPlayerColor', (result) => {
      if (result.assistedPlayerColor) {
        assistedPlayerColor = result.assistedPlayerColor;
        updatePlayerSelectorUI();
      }
    });
  }

  function saveSettings() {
    return Promise.all([
      chrome.storage.local.set({ settings }),
      chrome.storage.local.set({ assistedPlayerColor })
    ]);
  }

  function applySettingsToUI() {
    const mapping = {
      'setting-cloud-depth': settings.cloudDepth,
      'setting-depth-target': settings.depthTarget,         // v8.5.0
      'setting-style': settings.style,
      'setting-human-like-mode': settings.humanLikeMode,
      'setting-white-repertoire': settings.whiteRepertoire,
      'setting-black-repertoire': settings.blackRepertoire,
      'setting-auto-analyze': settings.autoAnalyze,
      'setting-show-threats': settings.showThreats,
      'setting-show-assessment': settings.showAssessment,
      'setting-show-continuation': settings.showContinuation,
      'setting-show-eval-history': settings.showEvalHistory,
      'setting-show-opening-explorer': settings.showOpeningExplorer,
      'setting-show-tablebase': settings.showTablebase,
      'setting-show-endgame-coach': settings.showEndgameCoach,
      'setting-show-critical-moments': settings.showCriticalMoments,
      'setting-show-candidate-moves': settings.showCandidateMoves,
      'setting-use-chess-api': settings.useChessApi,
      'setting-use-lichess-cloud': settings.useLichessCloud,
      'setting-use-masters-explorer': settings.useMastersExplorer,
    };
    Object.entries(mapping).forEach(([id, val]) => {
      const el = $(`#${id}`);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = val;
      else el.value = val;
    });
  }

  // ─── Player Selector ──────────────────────────────────────────────
  function updatePlayerSelectorUI() {
    if (!dom.playerSelector) return;
    $$('.player-btn').forEach(btn => {
      const selected = btn.dataset.color === assistedPlayerColor;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
  }

  // ─── Event Binding ─────────────────────────────────────────────────
  function bindEvents() {
    // Player selector buttons
    $$('.player-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const newColor = btn.dataset.color;
        if (newColor === assistedPlayerColor) return;
        assistedPlayerColor = newColor;
        if (currentFen && turnReliable) {
          isPlayerTurn = (currentFen.split(' ')[1] || 'w') === assistedPlayerColor;
          waitingForOpponent = !isPlayerTurn;
        }
        updatePlayerSelectorUI();
        updatePositionContext();
        // v7.9.0: Update ARIA
        $$('.player-btn').forEach(b => b.setAttribute('aria-checked', b.dataset.color === assistedPlayerColor ? 'true' : 'false'));
        saveSettings();
        lastEngineRecommendationFen = null;
        lastEngineRecommendationUci = null;
        chrome.runtime.sendMessage({ type: 'player_color_changed' }).catch(() => {});
        if (lastAnalysis) {
          renderAnalysis(lastAnalysis);
        }
        if (currentFen) {
          requestAnalysis();
        }
      });
    });

    // Non-destructive refresh — coordinator keeps caches, quotas and cooldowns
    if (dom.btnRefresh) {
      dom.btnRefresh.addEventListener('click', () => {
        if (isRefreshing) return;
        isRefreshing = true;
        dom.btnRefresh.classList.add('spinning');
        updateEngineStatus('analyzing', 'Refreshing analysis...');
        requestAnalysis(true);
        refreshSafetyTimer = setTimeout(finishRefresh, 20000);
      });
    }

    // Health check button
    if (dom.btnHealthCheck) {
      dom.btnHealthCheck.addEventListener('click', () => {
        runHealthCheck();
      });
    }

    // Clear caches button
    if (dom.btnClearCaches) {
      const ORIGINAL_TEXT = dom.btnClearCaches.textContent || 'Clear Caches';
      dom.btnClearCaches.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'clear_caches' }).catch(() => {});
        showToast('All caches cleared', 'success', 2500);
        if (dom.btnClearCaches) {
          dom.btnClearCaches.textContent = 'Caches Cleared!';
          // v8.5.0: restore the *exact* original label (was previously
          // reverting to 'Clear All Caches', which differs from the HTML).
          setTimeout(() => { dom.btnClearCaches.textContent = ORIGINAL_TEXT; }, 2000);
        }
      });
    }

    // v8.5.0 Enhancement H: Open current position on Lichess analysis board.
    if (dom.btnLichessAnalysis) {
      dom.btnLichessAnalysis.addEventListener('click', () => {
        if (!currentFen) {
          showToast('No position yet — open a chess board first', 'warning', 2500);
          return;
        }
        const url = `https://lichess.org/analysis/${encodeURIComponent(currentFen)}`;
        chrome.tabs.create({ url }).catch(() => {
          // Fallback if tabs API unavailable
          window.open(url, '_blank');
        });
      });
    }

    // v8.0.0: Theme toggle removed — dark only

    // Settings and CSP-safe shortcut-help close button
    const closeShortcutHelp = document.getElementById('btn-close-shortcut-help');
    if (closeShortcutHelp) closeShortcutHelp.addEventListener('click', () => {
      const help = document.getElementById('shortcut-help');
      if (help) help.style.display = 'none';
      shortcutHelpVisible = false;
    });
    if (dom.btnSettings) dom.btnSettings.addEventListener('click', () => { if (dom.settingsPanel) dom.settingsPanel.style.display = 'block'; runHealthCheck(); });
    if (dom.btnCloseSettings) dom.btnCloseSettings.addEventListener('click', () => { if (dom.settingsPanel) dom.settingsPanel.style.display = 'none'; });

    const settingEls = {
      'setting-cloud-depth': (v) => { settings.cloudDepth = parseInt(v); },
      'setting-depth-target': (v) => { settings.depthTarget = parseInt(v); },          // v8.5.0
      'setting-style': (v) => { settings.style = v; },
      'setting-human-like-mode': (v) => { settings.humanLikeMode = v; },
      'setting-white-repertoire': (v) => { settings.whiteRepertoire = v; },
      'setting-black-repertoire': (v) => { settings.blackRepertoire = v; },
      'setting-auto-analyze': (v) => { settings.autoAnalyze = v; },
      'setting-show-threats': (v) => { settings.showThreats = v; },
      'setting-show-assessment': (v) => { settings.showAssessment = v; },
      'setting-show-continuation': (v) => { settings.showContinuation = v; },
      'setting-show-eval-history': (v) => { settings.showEvalHistory = v; },
      'setting-show-opening-explorer': (v) => { settings.showOpeningExplorer = v; },
      'setting-show-tablebase': (v) => { settings.showTablebase = v; },
      'setting-show-endgame-coach': (v) => { settings.showEndgameCoach = v; },
      'setting-show-critical-moments': (v) => { settings.showCriticalMoments = v; },
      'setting-show-candidate-moves': (v) => { settings.showCandidateMoves = v; },
      'setting-use-chess-api': (v) => { settings.useChessApi = v; },
      'setting-use-lichess-cloud': (v) => { settings.useLichessCloud = v; },
      'setting-use-masters-explorer': (v) => { settings.useMastersExplorer = v; },
    };

    Object.entries(settingEls).forEach(([id, handler]) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.addEventListener('change', () => {
        const val = el.type === 'checkbox' ? el.checked : el.value;
        handler(val);
        const savePromise = saveSettings();
        applySettingsToUI();
        if ((id === 'setting-style' || id === 'setting-human-like-mode') && lastAnalysis) {
          humanPlanState = null;
          renderAnalysis(lastAnalysis);
        }
        if (['setting-use-chess-api', 'setting-use-lichess-cloud', 'setting-use-masters-explorer'].includes(id) && currentFen) {
          // Ensure the worker sees the new source policy before it routes.
          savePromise.finally(() => requestAnalysis(true));
        }
      });
    });

    chrome.runtime.onMessage.addListener(handleMessage);
  }

  // ─── Passive Provider Status and Local Usage Diagnostics ─────────────
  let healthCheckInFlight = false;

  function formatCooldown(ms) {
    const totalSeconds = Math.max(0, Math.ceil((ms || 0) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }

  function renderPassiveProvider(element, result) {
    if (!element) return;
    if (!result) {
      element.textContent = 'No recent data';
      element.className = 'api-status unknown';
      return;
    }
    const suffix = result.cooldownRemainingMs > 0 ? ` ${formatCooldown(result.cooldownRemainingMs)}` : '';
    element.textContent = `${result.label || 'No recent data'}${suffix}`;
    const healthy = result.state === 'healthy';
    const slow = result.state === 'slow';
    element.className = `api-status ${healthy ? 'online' : (slow || result.state === 'unknown' ? 'unknown' : 'error')}`;
  }

  function renderApiDiagnostics(diagnostics) {
    if (!diagnostics) return;
    const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = String(value ?? 0); };
    setText('api-cache-avoided', diagnostics.remoteCallsAvoidedByCache);
    setText('api-requests-coalesced', diagnostics.requestsCoalesced);
    setText('api-stale-served', diagnostics.staleResultsServed);
    setText('api-stale-dropped', diagnostics.staleJobsDropped);
    const calls = document.getElementById('api-provider-calls');
    if (calls) {
      const labels = {
        chessApi: 'Chess-API', lichessCloud: 'Lichess Cloud', mastersExplorer: 'Masters DB',
        openingExplorer: 'Opening', tablebase: 'Tablebase'
      };
      calls.textContent = Object.entries(diagnostics.providers || {})
        .map(([provider, data]) => `${labels[provider] || provider}: ${data.calls || 0} call${data.calls === 1 ? '' : 's'} · ${data.label || 'No recent data'}`)
        .join(' | ') || 'No remote calls yet';
    }
  }

  function runHealthCheck() {
    if (healthCheckInFlight) return;
    healthCheckInFlight = true;
    if (dom.btnHealthCheck) {
      dom.btnHealthCheck.disabled = true;
      dom.btnHealthCheck.textContent = 'Refreshing...';
    }
    const restoreButton = () => {
      healthCheckInFlight = false;
      if (dom.btnHealthCheck) {
        dom.btnHealthCheck.disabled = false;
        dom.btnHealthCheck.textContent = 'Refresh Status';
      }
    };
    const safetyTimer = setTimeout(restoreButton, 5000);
    chrome.runtime.sendMessage({ type: 'health_check' }, results => {
      clearTimeout(safetyTimer);
      restoreButton();
      if (chrome.runtime.lastError || !results) return;
      renderPassiveProvider(document.getElementById('health-chessapi'), results['chess-api']);
      renderPassiveProvider(document.getElementById('health-lichess'), results.lichess);
      renderPassiveProvider(document.getElementById('health-masters'), results.masters);
      renderPassiveProvider(document.getElementById('health-opening'), results.opening);
      renderPassiveProvider(document.getElementById('health-tablebase'), results.tablebase);
      renderApiDiagnostics(results.diagnostics);
    });
  }

  // ─── Handle Messages ───────────────────────────────────────────────
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      // v8.5.0: 'position_update' removed — background.js never sends it
      //         (board reading happens here in the side panel via read_board).
      case 'analysis_update':
        handleAnalysisResult(message.data);
        break;
      case 'analysis_error':
        handleAnalysisError(message.data);
        break;
      // v8.5.0: 'analysis_info' removed — background.js never sends it
      //         (handleAnalysisInfo was dead code, also removed).
      case 'turn_status_update':
        handleTurnStatusUpdate(message.data);
        break;
      case 'opening_data_update':
        handleOpeningDataUpdate(message.data);
        break;
    }
    return false;
  }

  function updatePositionContext() {
    if (!dom.positionContext || !dom.positionSource || !dom.positionTurn) return;
    const verified = positionReliable && turnReliable;
    dom.positionContext.classList.toggle('verified', verified);
    dom.positionContext.classList.toggle('partial', !positionReliable && turnReliable);
    dom.positionContext.classList.toggle('pending', !turnReliable);
    dom.positionSource.className = `context-chip ${positionReliable ? 'verified' : 'partial'}`;
    dom.positionSource.textContent = positionReliable ? 'VERIFIED FEN' : 'BOARD SNAPSHOT';
    dom.positionTurn.textContent = !turnReliable
      ? 'Turn unavailable'
      : (isPlayerTurn ? 'Your turn' : 'Opponent turn');
  }

  function handlePositionUpdate(message) {
    const prevFen = currentFen;
    currentFen = message.fen;
    const positionChanged = !prevFen || prevFen.split(' ').slice(0, 4).join(' ') !== currentFen.split(' ').slice(0, 4).join(' ');
    playerColor = message.playerColor || 'w';
    positionReliable = message.positionReliable === true;
    turnReliable = message.turnReliable === true;
    if (assistedPlayerColor === null) {
      assistedPlayerColor = playerColor;
      updatePlayerSelectorUI();
      saveSettings();
    }
    if (prevFen && currentFen && isNewGame(prevFen, currentFen)) {
      evalHistory = [];
      prevEval = null;
      lastCriticalAlert = null;
      isPlayerTurn = true;
      waitingForOpponent = false;
      // v8.5.0: Reset the engine-side correlation tracker + sacrifice history.
      chrome.runtime.sendMessage({ type: 'reset_correlation' }).catch(() => {});
      if (window.ChessHintEngine && typeof window.ChessHintEngine.resetSacrificeHistory === 'function') {
        window.ChessHintEngine.resetSacrificeHistory();
      }
      // v8.5.0 (Enhancement I): Clear local engine-recommendation tracking too.
      lastEngineRecommendationFen = null;
      lastEngineRecommendationUci = null;
      humanPlanState = null;
    }

    // v7.1.0: Turn-based analysis — check whose turn it is before analyzing
    const activeColor = currentFen ? (currentFen.split(' ')[1] || 'w') : 'w';
    const effectiveColor = assistedPlayerColor || playerColor || 'w';
    const wasPlayerTurn = isPlayerTurn;
    isPlayerTurn = activeColor === effectiveColor;
    waitingForOpponent = !isPlayerTurn;
    turnJustChanged = !wasPlayerTurn && isPlayerTurn; // Turn just changed to player's turn
    updatePositionContext();

    // v8.5.0 (Enhancement I): Detect that the player just moved (transition
    // from "player's turn" to "opponent's turn" while we had a stored engine
    // recommendation for the previous FEN). Infer the move by applying the
    // engine's recommended UCI to the previous FEN and comparing placements —
    // if they match, the player played the engine move; otherwise we still
    // report the actual resulting FEN so background can record "didn't match".
    if (wasPlayerTurn && !isPlayerTurn && lastEngineRecommendationFen && lastEngineRecommendationUci) {
      tryReportPlayerMove(lastEngineRecommendationFen, lastEngineRecommendationUci, currentFen);
      lastEngineRecommendationFen = null;
      lastEngineRecommendationUci = null;
    }

    if (!turnReliable) {
      isPlayerTurn = false;
      waitingForOpponent = false;
      updateEngineStatus('unknown', 'Turn unavailable — waiting for a verified position');
      if (dom.hintText) dom.hintText.textContent = 'Turn information is unavailable for this board.';
      return;
    }

    if (isPlayerTurn) {
      // It's the player's turn — request analysis
      if (positionChanged && (settings.autoAnalyze || turnJustChanged)) {
        requestAnalysis();
      }
      updateEngineStatus(wasPlayerTurn ? 'online' : 'analyzing', turnJustChanged ? 'Your turn — analyzing...' : 'Your turn');
    } else {
      // It's the opponent's turn — show waiting status, no API calls
      const playerLabel = effectiveColor === 'w' ? 'White' : 'Black';
      updateEngineStatus('online', `Opponent's turn — waiting...`);
      if (dom.hintText && !lastAnalysis) {
        dom.hintText.textContent = `Waiting for opponent's move...`;
      }
    }
  }

  // v8.5.0 (Enhancement I): Compare the player's actual resulting FEN to the
  // FEN we'd get if they'd played the engine's recommendation. If they match
  // (piece placement + side to move, ignoring move counters), record a match.
  // Otherwise, we still try to derive the actual UCI from the FEN diff and
  // report that. Falls back gracefully if anything is unclear.
  function tryReportPlayerMove(engineFen, engineUci, actualFen) {
    if (!engineFen || !engineUci || !actualFen) return;
    // Background has the stored engine UCI for this FEN and applies it before
    // comparing the observed resulting placement, including special moves.
    chrome.runtime.sendMessage({
      type: 'record_player_move',
      prevFen: engineFen,
      actualFen: actualFen
    }).then((result) => {
      // result may be null if no stored engine recommendation for that FEN.
      if (result && typeof result.matched === 'boolean') updateCorrelationStat();
    }).catch(() => {});
  }

  // v8.5.0 (Enhancement I): Pull current correlation stats from background
  // and render them in the "Engine Match" row of the position-info card.
  function updateCorrelationStat() {
    if (!dom.correlationStat) return;
    chrome.runtime.sendMessage({ type: 'get_correlation_stats' }).then((stats) => {
      if (!stats) {
        dom.correlationStat.textContent = '0 / 0 (0%)';
        return;
      }
      const pct = stats.total > 0 ? Math.round((stats.matches / stats.total) * 100) : 0;
      dom.correlationStat.textContent = `${stats.matches} / ${stats.total} (${pct}%)`;
      // Color cue — green = low correlation, yellow = moderate, red = high
      if (stats.total === 0) {
        dom.correlationStat.style.color = 'var(--text-secondary)';
      } else if (pct >= 80) {
        dom.correlationStat.style.color = 'var(--accent-red)';
      } else if (pct >= 60) {
        dom.correlationStat.style.color = 'var(--accent-yellow)';
      } else {
        dom.correlationStat.style.color = 'var(--accent-green)';
      }
    }).catch(() => {
      dom.correlationStat.textContent = '—';
    });
  }

  // v7.1.0: Handle turn status updates from background script
  function handleTurnStatusUpdate(data) {
    if (!data) return;
    isPlayerTurn = data.isPlayerTurn;
    waitingForOpponent = data.waitingForOpponent;
    if (data.reason === 'turn_unknown') turnReliable = false;
    updatePositionContext();

    if (data.reason === 'turn_unknown') {
      updateEngineStatus('unknown', 'Turn unavailable — waiting for a verified position');
      if (dom.hintText) dom.hintText.textContent = 'Turn information is unavailable for this board.';
      return;
    }

    if (isPlayerTurn) {
      updateEngineStatus('analyzing', 'Your turn — analyzing...');
    } else {
      updateEngineStatus('online', "Opponent's turn — waiting...");
      if (dom.hintText && !lastAnalysis) {
        dom.hintText.textContent = `Waiting for opponent's move...`;
      }
    }
  }

  function isNewGame(oldFen, newFen) {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const newPlacement = newFen.split(' ')[0];
    const startPlacement = startFen.split(' ')[0];
    if (newPlacement === startPlacement && oldFen.split(' ')[0] !== startPlacement) return true;
    const oldMoveNum = parseInt(oldFen.split(' ')[5]) || 1;
    const newMoveNum = parseInt(newFen.split(' ')[5]) || 1;
    if (newMoveNum < oldMoveNum - 2) return true;
    return false;
  }

  function handleAnalysisResult(data) {
    if (!data || !currentFen) return;
    // A slower cloud response for an earlier position must never overwrite the
    // current board. Compare placement + turn because reconstructed counters
    // may legitimately differ between the request and the next poll.
    const resultKey = (data.fen || '').split(' ').slice(0, 4).join(' ');
    const currentKey = currentFen.split(' ').slice(0, 4).join(' ');
    if (!resultKey || resultKey !== currentKey) return;
    const wasUserRefresh = isRefreshing;
    lastAnalysis = data;

    const source = data.source || 'unknown';
    currentSource = source;
    updateSourceFromResult(source, data);

    if (data.pvs && data.pvs.length > 0) {
      const bestPV = data.pvs[0];
      const effectiveColor = assistedPlayerColor || playerColor || 'w';
      // Convert score to player's perspective for consistent tracking
      const evalScore = effectiveColor === 'w' ? bestPV.score : -bestPV.score;
      evalHistory.push({ fen: data.fen, score: evalScore, scoreType: bestPV.scoreType });
      if (evalHistory.length > 50) evalHistory.shift();
      if (prevEval !== null) {
        const evalDiff = evalScore - prevEval;
        if (Math.abs(evalDiff) > 5) renderMoveClassification(evalDiff);
      }
      prevEval = evalScore;

      // v8.5.0 (Enhancement I): Remember the engine's first-choice move +
      // the FEN it was recommended for, so when the player makes their move
      // we can compare and update the correlation tracker.
      if (data.fen && bestPV.pv && bestPV.pv.length > 0) {
        lastEngineRecommendationFen = data.fen;
        lastEngineRecommendationUci = bestPV.pv[0];
      }
    }

    updateEngineStatus('online', data.stale ? 'Cached analysis (stale)' : 'Analysis complete');
    renderAnalysis(data);
    runHealthCheck();

    // v8.5.0 (fix #36): Toast only on user-initiated refresh, not every
    // auto-analysis. The previous code spammed a toast every 2-5s on the
    // player's turn. The `isRefreshing` flag is set when the user clicks
    // Refresh and cleared only when this workflow settles.
    if (data.source && wasUserRefresh) {
      const sourceNames = { 'chess-api': 'Chess-API', 'lichess-cloud': 'Lichess Cloud', 'masters-explorer': 'Masters DB', 'opening-explorer': 'Opening Cache', 'tablebase': 'Tablebase' };
      showToast(`Analysis ready via ${sourceNames[data.source] || data.source}`, 'success', 2000);
    }

    if (data.exactHintBlocked) {
      showToast(data.exactHintBlocked.message, 'warning', 3500);
    }

    // v8.5.0 (Enhancement I): Refresh the correlation stat in the UI.
    updateCorrelationStat();
    if (wasUserRefresh) finishRefresh();
  }

  function handleAnalysisError(data) {
    if (!data) return;
    if (data.fen && currentFen && data.fen.split(' ').slice(0, 4).join(' ') !== currentFen.split(' ').slice(0, 4).join(' ')) return;
    const errorMsg = data.error || 'Cloud analysis unavailable.';
    if (isRefreshing) finishRefresh();
    updateEngineStatus('error', errorMsg);
    // v7.9.0: Show toast for errors
    showToast(errorMsg, 'error', 4000);
    if (dom.hintText) {
      // The background already classifies retry, wait, and hard-budget states.
      // Do not suggest Refresh for a state where it cannot help.
      dom.hintText.textContent = errorMsg;
    }
  }

  // v8.5.0: handleAnalysisInfo() removed — was dead (no sender of 'analysis_info').

  function handleOpeningDataUpdate(data) {
    if (!data || !data.openingData) return;
    // Update opening data in last analysis if we have it
    if (lastAnalysis && lastAnalysis.fen === data.fen) {
      lastAnalysis.openingData = data.openingData;
      renderOpeningExplorer(data.openingData);
      if (dom.openingName && data.openingData.opening) {
        dom.openingName.textContent = data.openingData.opening;
      }
    }
  }

  function updateSourceFromResult(source, data) {
    const sourceLabels = {
      'chess-api': 'Chess-API.com',
      'lichess-cloud': 'Lichess Cloud',
      'masters-explorer': 'Masters DB', // v7.5.0: Human grandmaster moves
      'opening-explorer': 'Opening Explorer Cache',
      'tablebase': 'Tablebase',
      'unknown': '—'
    };
    const label = sourceLabels[source] || source;
    updateSourceIndicator(source, label, data.depth);
  }

  function updateSourceIndicator(source, label, depth) {
    // Source badge distinguishes engine, human/opening, tablebase, and unknown sources
    //         (was missing 'masters-explorer' → 'HUMAN' branch).
    if (dom.sourceBadge) {
      const badgeClass = source === 'tablebase' ? 'tb'
        : (source === 'masters-explorer' || source === 'opening-explorer' ? 'human' : 'cloud');
      dom.sourceBadge.className = `source-badge source-${badgeClass}`;
      dom.sourceBadge.textContent = source === 'tablebase' ? 'TB'
        : (source === 'masters-explorer' ? 'HUMAN'
        : (source === 'opening-explorer' ? 'OPENING'
        : (source === 'unknown' ? '—' : 'CLOUD')));
    }
    if (dom.analysisSource) {
      const depthStr = depth ? ` (depth ${depth})` : '';
      dom.analysisSource.textContent = `${label}${depthStr}`;
      const sourceClass = source === 'tablebase' ? 'tb'
        : (source === 'masters-explorer' || source === 'opening-explorer' ? 'human' : 'cloud');
      dom.analysisSource.className = `info-value source-indicator source-${sourceClass}`;
    }
  }

  // ─── Request Analysis ──────────────────────────────────────────────
  function requestAnalysis(refresh = false) {
    if (!currentFen) return;
    updateEngineStatus('analyzing', refresh ? 'Refreshing...' : 'Analyzing...');
    const colorToSend = assistedPlayerColor || playerColor || 'w';
    chrome.runtime.sendMessage({
      type: 'request_analysis',
      fen: currentFen,
      playerColor: colorToSend,
      multiPv: settings.cloudDepth || 3,
      hintLevel: EXACT_HINT_LEVEL,
      refresh: refresh,
      tabId: activeTabId,
      positionReliable,
      turnReliable
    }).catch(() => {});
  }

  // ─── Render Analysis ───────────────────────────────────────────────
  function renderAnalysis(data) {
    const effectiveColor = assistedPlayerColor || playerColor || 'w';
    const objectivePvs = data.pvs || [];
    const styledPvs = objectivePvs.length > 0 && data.source !== 'tablebase' && (objectivePvs.length > 1 || settings.humanLikeMode)
      ? window.ChessHintEngine.selectPVForStyle(
          objectivePvs,
          data.fen,
          settings.style,
          effectiveColor,
          settings.humanLikeMode,
          { activePlan: humanPlanState?.activePlan || null, openingData: data.openingData }
        )
      : objectivePvs;
    const viewData = { ...data, pvs: styledPvs };

    // The evaluation bar remains objective; every move-oriented section below
    // uses the same style-selected ordering.
    if (objectivePvs.length > 0) {
      const bestPV = objectivePvs[0];
      updateEvalBar(bestPV.score, bestPV.scoreType, effectiveColor);
      updateEvalDescription(bestPV.score, bestPV.scoreType, effectiveColor);
    }
    renderPositionInfo(viewData);
    renderHints(viewData);

    if (data.exactHintBlocked) {
      if (dom.candidateSection) dom.candidateSection.style.display = 'none';
      if (dom.pvLines) dom.pvLines.parentElement.style.display = 'none';
      if (dom.continuationSection) dom.continuationSection.style.display = 'none';
      if (dom.tablebaseSection) dom.tablebaseSection.style.display = 'none';
      if (dom.openingExplorerSection) dom.openingExplorerSection.style.display = 'none';
      if (dom.endgameCoachSection) dom.endgameCoachSection.style.display = 'none';
      return;
    }

    if (settings.showCandidateMoves && styledPvs) {
      renderCandidateMoves(styledPvs, effectiveColor, data.fen);
    } else if (dom.candidateSection) {
      dom.candidateSection.style.display = 'none';
    }

    if (!settings.showCandidateMoves) {
      if (dom.pvLines) dom.pvLines.parentElement.style.display = 'block';
      renderPVLines(styledPvs, effectiveColor);
    } else {
      if (dom.pvLines) dom.pvLines.parentElement.style.display = 'none';
    }

    if (settings.showContinuation) renderContinuation(styledPvs, effectiveColor);
    if (settings.showAssessment && data.fen) renderAssessment(data.fen);

    if (settings.showCriticalMoments) {
      renderCriticalMoment(effectiveColor);
    } else if (dom.criticalMomentSection) {
      dom.criticalMomentSection.style.display = 'none';
    }

    if (data.openingData && settings.showOpeningExplorer) {
      renderOpeningExplorer(data.openingData);
    } else if (dom.openingExplorerSection) {
      dom.openingExplorerSection.style.display = 'none';
    }

    if (data.tablebaseData && settings.showTablebase) {
      renderTablebase(data.tablebaseData);
    } else if (dom.tablebaseSection) {
      dom.tablebaseSection.style.display = 'none';
    }

    if (settings.showEndgameCoach && data.fen) {
      renderEndgameCoach(data.fen, effectiveColor, data.tablebaseData, viewData);
    } else if (dom.endgameCoachSection) {
      dom.endgameCoachSection.style.display = 'none';
    }

    if (settings.showEvalHistory) renderEvalHistory(effectiveColor);
  }

  function updateEvalBar(score, scoreType, effectiveColor) {
    const isWhite = effectiveColor === 'w';
    const displayScore = isWhite ? score : -score;
    const winPct = window.ChessHintEngine.formatEvalBar(score, scoreType, true);
    if (dom.evalBarWhite) {
      dom.evalBarWhite.style.height = `${winPct}%`;
      dom.evalBarWhite.style.width = `${winPct}%`;
    }
    if (dom.evalBarBlack) {
      dom.evalBarBlack.style.height = `${100 - winPct}%`;
      dom.evalBarBlack.style.width = `${100 - winPct}%`;
    }
    const scoreStr = scoreType === 'mate'
      ? (displayScore > 0 ? `+M${displayScore}` : `-M${Math.abs(displayScore)}`)
      : (displayScore >= 0 ? `+${(displayScore / 100).toFixed(1)}` : (displayScore / 100).toFixed(1));
    const oppStr = scoreType === 'mate'
      ? (displayScore > 0 ? `-M${displayScore}` : `+M${Math.abs(displayScore)}`)
      : (displayScore < 0 ? `+${(-displayScore / 100).toFixed(1)}` : (-displayScore / 100).toFixed(1));
    if (dom.evalWhiteLabel) dom.evalWhiteLabel.textContent = isWhite ? scoreStr : oppStr;
    if (dom.evalBlackLabel) dom.evalBlackLabel.textContent = isWhite ? oppStr : scoreStr;
  }

  function updateEvalDescription(score, scoreType, effectiveColor) {
    const desc = window.ChessHintEngine.describeEval(score, scoreType, effectiveColor === 'w', true);
    if (dom.evalDescription) dom.evalDescription.textContent = desc;
  }

  function updateEngineStatus(status, text) {
    if (dom.statusDot) dom.statusDot.className = `status-dot ${status}`;
    if (dom.statusText) dom.statusText.textContent = text;
  }

  function renderPositionInfo(data) {
    if (dom.openingName) {
      if (data.openingData && data.openingData.opening) {
        dom.openingName.textContent = data.openingData.opening;
      } else {
        const opening = window.ChessHintEngine.detectOpening(data.moveHistory);
        dom.openingName.textContent = opening ? opening.name : '\u2014';
      }
    }
    if (dom.gamePhase && data.fen) {
      const phase = window.ChessHintEngine.detectGamePhase(data.fen);
      dom.gamePhase.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
    }
    if (dom.analysisDepth && data.depth) {
      const sourceLabel = currentSource === 'chess-api' ? ' (api)' : (currentSource === 'lichess-cloud' ? ' (cloud)' : (currentSource === 'tablebase' ? ' (TB)' : ''));
      dom.analysisDepth.textContent = `${data.depth}${sourceLabel}`;
    }
    if (dom.materialBalance && data.fen) {
      const assessment = window.ChessHintEngine.assessPosition(data.fen);
      const balance = assessment.material.balance;
      const effectiveColor = assistedPlayerColor || 'w';
      const playerBalance = effectiveColor === 'w' ? balance : -balance;
      if (playerBalance > 0) { dom.materialBalance.textContent = `You +${playerBalance}`; dom.materialBalance.style.color = 'var(--accent-green)'; }
      else if (playerBalance < 0) { dom.materialBalance.textContent = `Opp +${Math.abs(playerBalance)}`; dom.materialBalance.style.color = 'var(--accent-red)'; }
      else { dom.materialBalance.textContent = 'Equal'; dom.materialBalance.style.color = 'var(--text-secondary)'; }
    }
  }

  // ─── Candidate Move Evaluation ────────────────────────────────────
  function renderCandidateMoves(pvs, effectiveColor, fen) {
    if (!dom.candidateSection || !dom.candidateMoves) return;
    if (!pvs || pvs.length === 0) {
      dom.candidateSection.style.display = 'block';
      dom.candidateMoves.innerHTML = '<div class="pv-empty">Waiting for analysis...</div>';
      return;
    }

    dom.candidateSection.style.display = 'block';
    const candidates = window.ChessHintEngine.evaluateCandidateMoves(pvs, effectiveColor, fen);

    if (candidates.length === 0) {
      dom.candidateMoves.innerHTML = '<div class="pv-empty">No candidate moves</div>';
      return;
    }

    const isOpponentTurn = candidates[0]?.isOpponentTurn || false;
    const maxWinPct = Math.max(...candidates.map(c => c.winPct));

    let headerHtml = '';
    if (isOpponentTurn) {
      const oppMove = candidates[0]?.opponentMoveSan;
      const playerLabel = effectiveColor === 'w' ? 'White' : 'Black';
      // v5.4.0: Player-first — header focuses on the player's best responses
      headerHtml = `<div class="cm-opp-turn-header">${h(playerLabel)}'s best responses: ${oppMove ? `If opponent plays <strong>${h(oppMove)}</strong>` : "Waiting for opponent's move"}</div>`;
    }

    dom.candidateMoves.innerHTML = headerHtml + candidates.map(c => {
      const evalClass = c.evalScore > 30 ? 'cm-eval-positive' : (c.evalScore < -30 ? 'cm-eval-negative' : 'cm-eval-neutral');
      const barPct = clamp(maxWinPct > 0 ? (c.winPct / maxWinPct * 100) : 50, 0, 100, 50);
      const qualityClass = ['cm-best', 'cm-good', 'cm-ok', 'cm-risky'].includes(c.qualityClass) ? c.qualityClass : 'cm-risky';
      const barClass = qualityClass === 'cm-best' ? 'bar-green' : (qualityClass === 'cm-good' ? 'bar-blue' : (qualityClass === 'cm-ok' ? 'bar-yellow' : 'bar-red'));

      let deltaHtml = '';
      if (c.deltaDisplay) {
        const deltaClass = c.delta < 0 ? 'delta-neg' : 'delta-pos';
        deltaHtml = `<span class="cm-delta"><span class="${deltaClass}">${h(c.deltaDisplay)}</span></span>`;
      }

      let oppMoveContext = '';
      if (isOpponentTurn && c.opponentMoveSan && c.opponentMoveSan !== candidates[0]?.opponentMoveSan) {
        oppMoveContext = `<span class="cm-opp-move" style="font-size:9px;color:var(--text-dim);display:block">if ${h(c.opponentMoveSan)}</span>`;
      }

      return `
        <div class="candidate-move ${qualityClass}">
          <span class="cm-rank">${h(c.rank)}</span>
          <span class="cm-move">${h(c.san)}</span>
          ${oppMoveContext}
          <span class="cm-fromto">${h(c.fromTo)}</span>
          <span class="cm-eval ${evalClass}">${h(c.evalDisplay)}</span>
          ${deltaHtml}
          <div class="cm-bar">
            <div class="cm-bar-fill ${barClass}" style="width:${barPct}%"></div>
          </div>
          <span style="font-size:10px;color:var(--text-dim)">${h(c.quality)}${c.styleReason ? ` · ${h(c.styleReason)}` : ''}</span>
        </div>
      `;
    }).join('');
  }

  // ─── Critical Moment Alert ────────────────────────────────────────
  function renderCriticalMoment(effectiveColor) {
    if (!dom.criticalMomentSection) return;

    if (!evalHistory || evalHistory.length < 2) {
      dom.criticalMomentSection.style.display = 'none';
      return;
    }

    const lastEval = evalHistory[evalHistory.length - 1];
    const alert = window.ChessHintEngine.detectCriticalMoment(
      evalHistory,
      lastEval.score,
      lastEval.scoreType,
      effectiveColor
    );

    if (!alert) {
      dom.criticalMomentSection.style.display = 'none';
      lastCriticalAlert = null;
      return;
    }

    if (lastCriticalAlert && lastCriticalAlert.type === alert.type) {
      dom.criticalMomentSection.style.display = 'block';
      return;
    }

    lastCriticalAlert = alert;
    dom.criticalMomentSection.style.display = 'block';
    dom.criticalMomentSection.style.animation = 'none';
    dom.criticalMomentSection.offsetHeight;
    dom.criticalMomentSection.style.animation = '';

    if (dom.criticalMomentText) dom.criticalMomentText.textContent = alert.message;
    if (dom.criticalMomentDetail) dom.criticalMomentDetail.textContent = alert.detail;
  }

  // ─── Endgame Technique Coach ──────────────────────────────────────
  function renderEndgameCoach(fen, effectiveColor, tablebaseData, analysisData) {
    if (!dom.endgameCoachSection) return;

    const coach = window.ChessHintEngine.generateEndgameCoach(fen, effectiveColor, tablebaseData, analysisData);
    if (!coach) {
      dom.endgameCoachSection.style.display = 'none';
      return;
    }

    dom.endgameCoachSection.style.display = 'block';

    if (dom.egPhaseLabel) dom.egPhaseLabel.textContent = coach.phaseLabel;

    if (dom.egTechnique) {
      if (coach.techniques.length === 0) {
        dom.egTechnique.innerHTML = '';
      } else {
        dom.egTechnique.innerHTML = coach.techniques.slice(0, 5).map(t => `
          <div class="eg-technique-item">
            <span class="eg-technique-icon">${h(t.icon)}</span>
            <span class="eg-technique-text">${h(t.text)}</span>
          </div>
        `).join('');
      }
    }

    if (dom.egPlan) {
      if (coach.plan) {
        dom.egPlan.style.display = 'block';
        dom.egPlan.innerHTML = `
          <div class="eg-plan-title">Your Plan</div>
          <div class="eg-plan-text">${h(coach.plan)}</div>
        `;
      } else {
        dom.egPlan.style.display = 'none';
      }
    }

    if (dom.egStepList) {
      if (coach.steps.length === 0) {
        dom.egStepList.innerHTML = '';
      } else {
        dom.egStepList.innerHTML = coach.steps.slice(0, 6).map(s => `
          <div class="eg-step">
            <span class="eg-step-num">${h(s.num || '')}</span>
            <span class="eg-step-move">${h(s.move)}</span>
            <span class="eg-step-desc">${h(s.desc)}</span>
          </div>
        `).join('');
      }
    }
  }

  // ─── Opening Explorer Rendering ────────────────────────────────────
  function renderOpeningExplorer(openingData) {
    if (!dom.openingExplorerSection || !openingData) return;
    if (!openingData.moves || openingData.moves.length === 0) {
      dom.openingExplorerSection.style.display = 'none';
      return;
    }

    dom.openingExplorerSection.style.display = 'block';
    const total = openingData.totalGames || 1;

    const whitePct = clamp((openingData.whiteWins || 0) / total * 100, 0, 100, 0).toFixed(1);
    const drawPct = clamp((openingData.draws || 0) / total * 100, 0, 100, 0).toFixed(1);
    const blackPct = clamp((openingData.blackWins || 0) / total * 100, 0, 100, 0).toFixed(1);

    if (dom.winBarWhite) dom.winBarWhite.style.width = `${whitePct}%`;
    if (dom.winBarDraws) dom.winBarDraws.style.width = `${drawPct}%`;
    if (dom.winBarBlack) dom.winBarBlack.style.width = `${blackPct}%`;
    if (dom.winPctWhite) dom.winPctWhite.textContent = `${whitePct}% W`;
    if (dom.winPctDraws) dom.winPctDraws.textContent = `${drawPct}% D`;
    if (dom.winPctBlack) dom.winPctBlack.textContent = `${blackPct}% B`;

    if (dom.openingMoves) {
      dom.openingMoves.innerHTML = openingData.moves.slice(0, 6).map(m => {
        const moveTotal = m.total || 1;
        const wPct = clamp(m.white / moveTotal * 100, 0, 100, 0).toFixed(0);
        const dPct = clamp(m.draws / moveTotal * 100, 0, 100, 0).toFixed(0);
        const bPct = clamp(m.black / moveTotal * 100, 0, 100, 0).toFixed(0);
        return `
          <div class="opening-move-row">
            <span class="opening-move-san">${h(m.san || m.uci)}</span>
            <div class="opening-move-bar">
              <div class="omw" style="width:${wPct}%"></div>
              <div class="omd" style="width:${dPct}%"></div>
              <div class="omb" style="width:${bPct}%"></div>
            </div>
            <span class="opening-move-pct">${wPct}/${dPct}/${bPct}</span>
            <span class="opening-move-games">${(moveTotal / 1000).toFixed(1)}k</span>
          </div>
        `;
      }).join('');
    }

    if (dom.topGames && openingData.topGames && openingData.topGames.length > 0) {
      dom.topGames.innerHTML = '<div class="top-games-title">Notable Games</div>' +
        openingData.topGames.slice(0, 3).map(g => {
          const wName = g.white?.name || '?';
          const bName = g.black?.name || '?';
          const wRating = g.white?.rating || '';
          const bRating = g.black?.rating || '';
          const result = g.winner === 'white' ? '1-0' : (g.winner === 'black' ? '0-1' : '\u00BD-\u00BD');
          return `
            <div class="top-game-row">
              <span class="tg-name">${h(wName)} (${h(wRating)})</span>
              <span class="tg-result">${h(result)}</span>
              <span class="tg-name">${h(bName)} (${h(bRating)})</span>
            </div>
          `;
        }).join('');
    }
  }

  // ─── Tablebase Rendering ───────────────────────────────────────────
  function renderTablebase(tbData) {
    if (!dom.tablebaseSection || !tbData) return;
    dom.tablebaseSection.style.display = 'block';

    const catLabels = {
      'win': 'Winning', 'syzygy-win': 'Winning (Syzygy)', 'maybe-win': 'Probably Winning',
      'cursed-win': 'Cursed Win', 'draw': 'Drawn', 'blessed-loss': 'Blessed Loss',
      'maybe-loss': 'Probably Losing', 'loss': 'Losing', 'unknown': 'Unknown'
    };
    const catColors = {
      'win': '#2b8c5e', 'syzygy-win': '#2b8c5e', 'maybe-win': '#439e72',
      'cursed-win': '#439e72', 'draw': '#d9822b', 'blessed-loss': '#c97238',
      'maybe-loss': '#c94248', 'loss': '#c94248', 'unknown': '#8c93a2'
    };

    if (dom.tbCategory) {
      const cat = tbData.category || 'unknown';
      dom.tbCategory.textContent = catLabels[cat] || cat;
      dom.tbCategory.style.color = catColors[cat] || '#999';
    }

    if (dom.tbDtm) {
      if (tbData.dtm !== null && tbData.dtm !== undefined) {
        const dtm = Math.abs(tbData.dtm);
        dom.tbDtm.textContent = `Mate in ${dtm} move${dtm !== 1 ? 's' : ''} (perfect play)`;
        dom.tbDtm.style.display = 'block';
      } else if (tbData.dtz !== null && tbData.dtz !== undefined) {
        dom.tbDtm.textContent = `DTZ: ${Math.abs(tbData.dtz)}`;
        dom.tbDtm.style.display = 'block';
      } else {
        dom.tbDtm.style.display = 'none';
      }
    }

    if (dom.tbMoves && tbData.moves && tbData.moves.length > 0) {
      dom.tbMoves.innerHTML = tbData.moves.slice(0, 6).map(m => {
        const cat = m.category || 'unknown';
        const color = catColors[cat] || '#999';
        let detail = '';
        if (m.dtm !== null && m.dtm !== undefined) {
          detail = `M${Math.abs(m.dtm)}`;
        } else if (m.dtz !== null && m.dtz !== undefined) {
          detail = `DTZ ${Math.abs(m.dtz)}`;
        }
        return `
          <div class="tb-move-row" style="border-left: 3px solid ${color}">
            <span class="tb-move-san">${h(m.san || m.uci)}</span>
            <span class="tb-move-cat" style="color:${color}">${h(catLabels[cat] || 'Unknown')}</span>
            <span class="tb-move-detail">${h(detail)}</span>
          </div>
        `;
      }).join('');
    }
  }

  // ─── Hint Rendering ────────────────────────────────────────────────
  function renderHints(data) {
    if (data.exactHintBlocked) {
      if (dom.hintText) dom.hintText.textContent = data.exactHintBlocked.message;
      if (dom.hintFromTo) dom.hintFromTo.style.display = 'none';
      if (dom.hintTags) dom.hintTags.innerHTML = '<span class="hint-tag">Exact hint withheld</span>';
      if (dom.hintCard) dom.hintCard.className = 'hint-card exact-move blocked';
      const warningEl = document.getElementById('fair-play-warning');
      const warningText = document.getElementById('fair-play-warning-text');
      if (warningEl) warningEl.style.display = 'flex';
      if (warningText) warningText.textContent = data.exactHintBlocked.message;
      return;
    }
    if (!data.pvs || data.pvs.length === 0) {
      if (dom.hintText) dom.hintText.textContent = 'Waiting for analysis...';
      return;
    }

    // Convert currEval to player's perspective to match prevEval
    // Both must be in the same perspective for correct move classification
    const effectiveColor = assistedPlayerColor || 'w';
    const currEvalPlayerPerspective = effectiveColor === 'w'
      ? (data.pvs[0]?.score || 0)
      : -(data.pvs[0]?.score || 0);

    const effectiveHintLevel = EXACT_HINT_LEVEL;
    const hints = window.ChessHintEngine.generateHints(
      { ...data, prevEval, currEval: currEvalPlayerPerspective },
      effectiveHintLevel,
      effectiveColor,
      settings.style,
      effectiveColor === 'w' ? settings.whiteRepertoire : settings.blackRepertoire,
      settings.humanLikeMode,
      { activePlan: humanPlanState?.activePlan || null }
    );
    if (settings.humanLikeMode && hints.styleAnalysis?.plan) {
      humanPlanState = { activePlan: hints.styleAnalysis.plan, startedAtFen: data.fen };
    }

    if (dom.hintText) {
      dom.hintText.textContent = hints.main;
      dom.hintText.classList.add('fade-in');
      setTimeout(() => dom.hintText.classList.remove('fade-in'), 300);
    }

    if (dom.hintFromTo) {
      if (hints.bestMoveFromTo) {
        dom.hintFromTo.style.display = 'block';
        dom.hintFromTo.textContent = hints.bestMoveFromTo;
      } else {
        dom.hintFromTo.style.display = 'none';
      }
    }

    if (dom.hintCard) {
      let borderColor = 'var(--accent-red)';
      if (settings.style === 'aggressive') borderColor = 'var(--accent-aggressive)';
      if (settings.style === 'super_ultra_aggressive') borderColor = 'var(--accent-super-ultra)';
      dom.hintCard.style.borderLeftColor = borderColor;
      const styleClass = settings.style === 'super_ultra_aggressive' ? ' super-ultra-mode' : '';
      dom.hintCard.className = 'hint-card exact-move' + styleClass;
    }

    if (dom.hintTags) {
      // Keep this compact: only persistent position warnings belong beside an
      // exact hint. Source, style, depth, and mode labels add noise.
      const tags = [];
      if (hints.positionAssessment) {
        const pa = hints.positionAssessment;
        const ec = assistedPlayerColor || 'w';
        const playerBalance = ec === 'w' ? pa.material.balance : -pa.material.balance;
        if (playerBalance > 2) tags.push('Material+');
        else if (playerBalance < -2) tags.push('Material-');
        if (pa.kingSafety.issues.some(i => i.severity === 'high' && i.color === ec)) tags.push('King Danger');
        if (pa.pawnStructure.issues.some(i => i.issue && i.issue.includes('passed') && i.color === ec)) tags.push('Passed Pawn');
      }
      if (hints.isAssistedPlayerTurn === false) tags.push('Waiting for Opponent');
      dom.hintTags.innerHTML = tags.map(t => `<span class="hint-tag">${h(t)}</span>`).join('');
    }

    if (dom.winningPlan && dom.planText) {
      if (hints.winningPlan) {
        dom.winningPlan.style.display = 'flex';
        dom.planText.textContent = hints.winningPlan;
      } else {
        dom.winningPlan.style.display = 'none';
      }
    }

    if (dom.threatSection) {
      if (settings.showThreats && hints.threat) {
        dom.threatSection.style.display = 'block';
        dom.threatText.textContent = hints.threat;
      } else {
        dom.threatSection.style.display = 'none';
      }
    }

    // Fair play warning
    const warningEl = document.getElementById('fair-play-warning');
    const warningText = document.getElementById('fair-play-warning-text');
    if (hints.fairPlayWarning) {
      if (warningEl) warningEl.style.display = 'flex';
      if (warningText) warningText.textContent = hints.fairPlayWarning;
    } else {
      if (warningEl) warningEl.style.display = 'none';
    }

  }

  function renderPVLines(pvs, effectiveColor) {
    if (!dom.pvLines) return;
    if (!pvs || pvs.length === 0) {
      dom.pvLines.innerHTML = '<div class="pv-empty">Engine analysis will appear here</div>';
      return;
    }

    const fenParts = (currentFen || '').split(' ');
    const activeColor = fenParts[1] || 'w';
    const isOpponentTurn = activeColor !== effectiveColor;

    const formatted = window.ChessHintEngine.formatPVs(pvs, effectiveColor === 'w', EXACT_HINT_LEVEL, currentFen);
    dom.pvLines.innerHTML = formatted.map(pv => {
      const scoreClass = pv.score > 30 ? 'positive' : (pv.score < -30 ? 'negative' : 'neutral');
      const depthLabel = pv.depth >= 100 ? 'TB' : `depth ${pv.depth}`;

      let movesHtml = h(pv.movesDisplay);
      if (isOpponentTurn && pv.pv && pv.pv.length > 1) {
        const moves = pv.movesDisplay.split(' ');
        if (moves.length > 0) {
          movesHtml = `<span class="pv-opponent-first">${h(moves[0])}</span>` +
            (moves.length > 1 ? ' ' + h(moves.slice(1).join(' ')) : '');
        }
      }

      return `
        <div class="pv-line" data-pv-index="${h(pv.index)}">
          <div class="pv-line-header">
            <span class="pv-score ${scoreClass}">${h(pv.scoreDisplay)}</span>
            <span class="pv-depth">${h(depthLabel)}</span>
          </div>
          <div class="pv-moves">${movesHtml}</div>
        </div>
      `;
    }).join('');
  }

  function renderContinuation(pvs, effectiveColor) {
    if (!dom.continuationSection) return;
    if (!pvs || pvs.length === 0 || !pvs[0].pv || pvs[0].pv.length === 0) {
      dom.continuationSection.style.display = 'none';
      return;
    }

    dom.continuationSection.style.display = 'block';
    const formatted = window.ChessHintEngine.formatContinuation(pvs[0].pv, EXACT_HINT_LEVEL, effectiveColor === 'w', currentFen);

    dom.continuationMoves.innerHTML = formatted.map(m => {
      const moveNumStr = m.moveNumber ? `<span class="cont-move-number">${h(m.moveNumber)}.</span>` : (m.isWhiteMove ? '' : '<span class="cont-move-number">...</span>');
      const colorClass = m.isWhiteMove ? 'white-move' : 'black-move';
      return `${moveNumStr}<span class="cont-move ${colorClass}">${h(m.move)}</span>`;
    }).join('');
  }

  function renderMoveClassification(evalDiff) {
    if (!dom.moveClassSection || !dom.moveClassDisplay) return;
    const cls = window.ChessHintEngine.classifyMove(0, evalDiff);
    const classKey = cls.label.toLowerCase();
    dom.moveClassDisplay.innerHTML = `
      <span class="class-badge class-${classKey}">${h(cls.label)} ${h(cls.symbol)}</span>
      <span class="class-symbol">${h(cls.symbol)}</span>
    `;
    dom.moveClassSection.style.display = 'block';
  }

  function renderAssessment(fen) {
    if (!dom.assessmentSection || !dom.assessmentCards) return;
    const assessment = window.ChessHintEngine.assessPosition(fen);
    const cards = [];

    // Material
    if (assessment.material.balance !== 0) {
      const sign = assessment.material.balance > 0 ? '+' : '';
      cards.push({
        icon: '\u265F',
        title: 'Material',
        detail: `${assessment.material.description} (${sign}${assessment.material.balance})`,
        severity: Math.abs(assessment.material.balance) > 5 ? 'high' : (Math.abs(assessment.material.balance) > 2 ? 'medium' : 'low')
      });
    }

    // King Safety
    for (const issue of assessment.kingSafety.issues.filter(i => i.severity === 'high')) {
      cards.push({ icon: '\u265A', title: 'King Safety', detail: issue.issue, severity: 'high' });
    }

    // Pawn Structure
    for (const issue of assessment.pawnStructure.issues.filter(i => i.severity === 'high')) {
      cards.push({ icon: '\u265F', title: 'Pawns', detail: issue.issue, severity: issue.severity });
    }

    // Threats
    for (const threat of assessment.threats) {
      cards.push({ icon: '\u26A0', title: 'Tactic', detail: threat.description, severity: threat.severity });
    }

    if (cards.length === 0) {
      dom.assessmentSection.style.display = 'none';
      return;
    }

    dom.assessmentSection.style.display = 'block';
    dom.assessmentCards.innerHTML = cards.map(c => `
      <div class="assessment-card severity-${['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'low'}">
        <span class="assessment-icon">${h(c.icon)}</span>
        <div class="assessment-content">
          <strong>${h(c.title)}</strong>
          <div class="assessment-detail">${h(c.detail)}</div>
        </div>
      </div>
    `).join('');
  }

  function renderEvalHistory(effectiveColor) {
    if (!dom.evalHistorySection || !dom.evalChart) return;
    if (evalHistory.length < 2) {
      dom.evalHistorySection.style.display = 'none';
      return;
    }

    dom.evalHistorySection.style.display = 'block';
    const canvas = dom.evalChart;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Find scale
    const maxEval = Math.max(200, ...evalHistory.map(e => Math.abs(e.score)));
    const scale = (height / 2 - 10) / maxEval;

    // Draw line
    ctx.strokeStyle = '#d9822b';
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let i = 0; i < evalHistory.length; i++) {
      const x = (i / (evalHistory.length - 1)) * width;
      const y = height / 2 - evalHistory[i].score * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill area
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(43, 140, 94, 0.25)');
    gradient.addColorStop(0.5, 'rgba(217, 130, 43, 0.05)');
    gradient.addColorStop(1, 'rgba(201, 66, 72, 0.25)');
    ctx.lineTo(width, height / 2);
    ctx.lineTo(0, height / 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  // ─── Start ─────────────────────────────────────────────────────────
  init();
})();
