/**
 * Chess Hint Assistant — Side Panel Controller
 * Turn-Based Analysis Engine. No local Stockfish.
 *
 * EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
 * This project is a study/research tool for building a chess engine that can
 * play in a variety of styles (normal, aggressive, ultra-aggressive). It is
 * intended for learning, offline analysis, and engine-variation research. It
 * is anti-cheat compliant and fair-play safe: it never assists a player in a
 * rated or live online game, and it must not be used to gain an unfair
 * advantage against human opponents.
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
  // Exact-move-only product: the engine always runs at this level. The constant
  // is reused as the value embedded in `request_analysis` messages and as the
  // back-compat second arg to `generateHints`. The engine exports its own copy
  // (window.ChessHintEngine.EXACT_HINT_LEVEL) — keep these in sync if it ever
  // changes.
  const EXACT_HINT_LEVEL = 5;
  let lastAnalysis = null;
  let prevEval = null;
  let prevScoreType = 'cp';
  // Per-game moves history, persisted in chrome.storage.local so the
  // History tab survives a side-panel reload. Each entry:
  //   { moveNumber, color, uci, san, classification, evalBefore,
  //     evalAfter, scoreTypeBefore, scoreTypeAfter, winChanceLost,
  //     winChanceGained, accuracy, t, fen }
  // `color` is the side that played the move; `moveNumber` is the
  // fullmove number in the FEN *after* the move. We cap the in-memory
  // array at 200 entries; older entries are dropped on overflow. The
  // persisted copy is overwritten in full on every change.
  let movesHistory = [];
  const MOVES_HISTORY_LIMIT = 200;
  // Baseline eval at the position right after the assistant's last move.
  // Populated by the snapshot analysis we fire the moment we detect the
  // assistant moved, so the next classification can rate the opponent's
  // reply as a single-ply effect instead of comparing across two plies.
  let evalAfterMyMove = null;
  let scoreTypeAfterMyMove = 'cp';
  // FEN at which the snapshot was taken. Used to infer the opponent's
  // UCI for the moves-history log: currentFEN - this FEN is the opponent's
  // last move.
  let fenAfterMyMove = null;
  let evalHistory = [];
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
    showCriticalMoments: true,
    showCorrelationStat: true,      // Engine-comparison card in the position-info card
    // Which row of the engine-comparison card to highlight:
    //   'engine'      — "how often did I follow the engine top pick?"
    //   'human'       — "how often did I follow the human-like pick?"
    //   'independent' — "how often did I play a move neither side suggested?"
    comparisonMode: 'engine',
    // Still gate background fetching that feeds the coach tab (opening name,
    // tablebase-backed winning plans); the explore UI is gone.
    showOpeningExplorer: true,
    showTablebase: true,
    depthTarget: 0,                 // 0 = no minimum; otherwise min depth for exact hints
    useChessApi: true,
    useLichessCloud: true,
    useMastersExplorer: true
  };

  const STYLE_DESCRIPTIONS = {
    normal: 'Objective best play, reliable conversion, and solid defense. This is the engine\'s strongest recommendation with no style bias.',
    aggressive: 'Win as fast as possible through sound, forcing play. Push the initiative and keep pressure on the enemy king without throwing material away.',
    super_ultra_aggressive: 'Fearless, organized attack: build up soundly, then break through with checks, pawn storms, forks, pins and bold sacrifices to finish fast against <=1100 opponents.'
  };

  function updateStyleDescription() {
    const el = $('#style-description');
    if (!el) return;
    el.textContent = STYLE_DESCRIPTIONS[settings.style] || STYLE_DESCRIPTIONS.normal;
  }

  // The engine-comparison card (replaces the old "Sensible moves" headline).
  // Hiding it keeps the underlying tracker running, so toggling back on
  // shows the latest stats immediately.
  function applyCorrelationVisibility() {
    const show = settings.showCorrelationStat !== false;
    if (dom.comparisonCard) dom.comparisonCard.hidden = !show;
  }

  // Autopilot visual sync. The hero knob and the settings-panel checkbox
  // are two surfaces over the same setting; this helper paints both from
  // `settings.autoAnalyze` so they never disagree. The label's `data-on`
  // attribute is what the CSS key reads — flipping it triggers the rail
  // fill, the knob slide, the title recolour, and (when ON) the heartbeat
  // pulse. We also reword the subtitle so the OFF state has a useful,
  // non-judgmental "manual" copy.
  function applyAutopilot() {
    const on = settings.autoAnalyze !== false;
    if (dom.autopilotCard) dom.autopilotCard.dataset.on = on ? 'true' : 'false';
    if (dom.autopilotToggle) dom.autopilotToggle.checked = on;
    const settingsBox = $('#setting-auto-analyze');
    if (settingsBox) settingsBox.checked = on;
    if (dom.autopilotSub) {
      dom.autopilotSub.textContent = on
        ? 'Engine watches your turn'
        : 'Manual — press R to refresh';
    }
  }

  // ─── DOM References ─────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    statusDot: $('.status-dot'),
    statusText: $('.status-text'),
    positionContext: $('#position-context'),
    positionSource: $('#position-source'),
    positionTurn: $('#position-turn'),
    evalBarBlack: $('#eval-bar-black'),
    evalBarWhite: $('#eval-bar-white'),
    evalBar: $('#eval-bar'),
    evalWhiteLabel: $('#eval-white-label'),
    evalBlackLabel: $('#eval-black-label'),
    evalDescription: $('#eval-description'),
    openingName: $('#opening-name'),
    gamePhase: $('#game-phase'),
    analysisSource: $('#analysis-source'),
    sourceBadge: $('#source-badge'),
    materialBalance: $('#material-balance'),
    hintText: $('#hint-text'),
    hintFromTo: $('#hint-fromto'),
    hintCard: $('#hint-card'),
    threatPill: $('#threat-pill'),
    threatPillText: $('#threat-pill-text'),
    moveClassSection: $('#move-class-section'),
    moveClassDisplay: $('#move-class-display'),
    settingsPanel: $('#settings-panel'),
    btnSettings: $('#btn-settings'),
    btnCloseSettings: $('#btn-close-settings'),
    btnRefresh: $('#btn-refresh'),
    btnHealthCheck: $('#btn-health-check'),
    btnClearCaches: $('#btn-clear-caches'),
    // Features
    playerSelector: $('#player-selector'),
    criticalMomentSection: $('#critical-moment-section'),
    criticalMomentText: $('#critical-moment-text'),
    criticalMomentDetail: $('#critical-moment-detail'),
    // Engine-comparison card (replaces the old "Sensible moves" headline).
    comparisonCard: $('#comparison-card'),
    comparisonRows: {
      engine: $('#comparison-engine'),
      human: $('#comparison-human'),
      independent: $('#comparison-independent'),
      agreement: $('#comparison-agreement')
    },
    // History tab content node. The actual <ol> and summary are
    // built and replaced dynamically by `renderHistory`.
    historyCard: $('#history-card'),
    // Autopilot: hero-shortcut for the "Auto-analyze on your turn"
    // setting. Two coordinated controls: the visible <label> knob in the
    // hero (id="autopilot-card") and the hidden native checkbox that the
    // settings page mirrors (id="autopilot-toggle"). Setting
    // `data-on` on the label is what flips the CSS pulse + knob
    // travel; the hidden checkbox is the real source of truth so the
    // existing settings handler keeps working unchanged.
    autopilotCard: $('#autopilot-card'),
    autopilotToggle: $('#autopilot-toggle'),
    autopilotSub: $('#autopilot-sub')
  };

  // ─── Turn-Based State ──────────────────────────────────────────────
  let isPlayerTurn = true;             // Is it currently the assisted player's turn?
  let waitingForOpponent = false;      // Are we waiting for opponent to move?
  let turnJustChanged = false;         // Did the turn just change to the player?

  // Track player's actual moves vs engine recommendations.
  // We remember the FEN at the moment the engine returned its recommendation;
  // when the side panel later observes a new FEN where it's no longer the player's
  // turn (i.e. the player just moved), we infer the move and report it to background.
  let lastEngineRecommendationFen = null;
  let lastEngineRecommendationUci = null;

  // ─── Board Reading with Jitter ───────────────────────────────────
  let boardReadTimer = null;
  // Tracks the last signature we sent to the background. We resend the
  // "panel still open" heartbeat only when something material has changed
  // (tab id or FEN), which is enough to keep the coordinator's per-tab
  // recency signal fresh without waking the service worker on every
  // jittered poll.
  let lastReportedSignature = '';
  const READ_INTERVAL_MIN = 2000;
  const READ_INTERVAL_MAX = 5000;

  function startBoardReading() {
    if (boardReadTimer) return;
    readBoardFromBackground();
    scheduleNextRead();
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
        // Resend the "panel still open" heartbeat only when the tab id or
        // the observed FEN has changed. This is the cheapest signal that
        // matches what the coordinator cares about: a per-tab liveness
        // hint that the user is still on this game. Caching the
        // signature avoids waking the service worker for every jittered
        // poll on a static position.
        const signature = `${activeTabId}|${result.fen}`;
        if (signature !== lastReportedSignature) {
          lastReportedSignature = signature;
          chrome.runtime.sendMessage({ type: 'panel_state', open: true, tabId: activeTabId }).catch(() => {});
        }
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
  // ─── Toast Notification System ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  const TOAST_DURATION = 3500;
  const TOAST_MAX = 3;

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
  // ─── Keyboard Shortcuts ──────────────────────────────────────────────
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
    bindEvents();
    initKeyboardShortcuts();
    initSettingsFocusTrap();
    applyCorrelationVisibility();
    // Load the persisted moves history so the History tab is populated
    // even if the side panel reloaded mid-game.
    loadMovesHistory().then(() => renderHistory());
    chrome.runtime.sendMessage({ type: 'panel_state', open: true }).catch(() => {});
    window.addEventListener('pagehide', () => {
      chrome.runtime.sendMessage({ type: 'panel_state', open: false, tabId: activeTabId }).catch(() => {});
    }, { once: true });
    startBoardReading();
    syncWelcome();
    updateEngineStatus('connecting', 'Connecting to cloud...');
    updateCorrelationStat();   // initialise the engine-comparison card with placeholders
    runHealthCheck();          // passive status only; does not call providers
  }

  // Focus trap for the settings panel so Tab can't escape
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
      'setting-depth-target': settings.depthTarget,
      'setting-style': settings.style,
      'setting-human-like-mode': settings.humanLikeMode,
      'setting-white-repertoire': settings.whiteRepertoire,
      'setting-black-repertoire': settings.blackRepertoire,
      'setting-auto-analyze': settings.autoAnalyze,
      'setting-show-threats': settings.showThreats,
      'setting-show-critical-moments': settings.showCriticalMoments,
      'setting-show-correlation-stat': settings.showCorrelationStat,
      'setting-comparison-mode': settings.comparisonMode,
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
    const humanStatus = document.querySelector('.human-mode-status');
    if (humanStatus) humanStatus.textContent = settings.humanLikeMode ? 'On' : 'Off';
    $$('.human-mode-opt').forEach(btn => {
      const active = (btn.dataset.mode === 'on') === settings.humanLikeMode;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    updateStyleDescription();
    applyCorrelationVisibility();
    applyAutopilot();
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
        // Update ARIA
        $$('.player-btn').forEach(b => b.setAttribute('aria-checked', b.dataset.color === assistedPlayerColor ? 'true' : 'false'));
        saveSettings();
        lastEngineRecommendationFen = null;
        lastEngineRecommendationUci = null;
        // Switching the assisted player invalidates the snapshot baseline —
        // the next move will be a different "my" move.
        evalAfterMyMove = null;
        scoreTypeAfterMyMove = 'cp';
        fenAfterMyMove = null;
        // The moves history is keyed on assistant's turn transitions;
        // switching which side is the assistant changes every entry's
        // semantics, so reset rather than carry stale data forward.
        clearMovesHistory();
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
          // Restore the *exact* original label.
          setTimeout(() => { dom.btnClearCaches.textContent = ORIGINAL_TEXT; }, 2000);
        }
      });
    }

    // Settings and CSP-safe shortcut-help close button
    const closeShortcutHelp = document.getElementById('btn-close-shortcut-help');
    if (closeShortcutHelp) closeShortcutHelp.addEventListener('click', () => {
      const help = document.getElementById('shortcut-help');
      if (help) help.style.display = 'none';
      shortcutHelpVisible = false;
    });
    if (dom.btnSettings) dom.btnSettings.addEventListener('click', () => { if (dom.settingsPanel) dom.settingsPanel.style.display = 'block'; runHealthCheck(); });
    if (dom.btnCloseSettings) dom.btnCloseSettings.addEventListener('click', () => { if (dom.settingsPanel) dom.settingsPanel.style.display = 'none'; });

    // Autopilot (hero shortcut). Clicking the felt rail flips the hidden
    // checkbox and synthesises a `change` event so the existing
    // settings-panel handler runs — the same code path that runs when
    // the user toggles "Auto-analyze on your turn" in Settings. This
    // is the only way the two surfaces stay in lockstep.
    if (dom.autopilotCard && dom.autopilotToggle) {
      // The hidden input lives inside the label, so a click on the
      // label already toggles the checkbox; we just need to fire the
      // same change event the settings panel would. We listen on the
      // toggle itself so it works whether the click came from the
      // felt row or from a programmatic toggle.
      dom.autopilotToggle.addEventListener('change', () => {
        const settingsBox = $('#setting-auto-analyze');
        if (!settingsBox) return;
        if (settingsBox.checked === dom.autopilotToggle.checked) return;
        settingsBox.checked = dom.autopilotToggle.checked;
        settingsBox.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Tab strip (Hint | History). We don't drive the panel with hidden
    // attributes only — `.is-active` toggles the CSS so the active panel
    // lays out normally and the inactive one takes no space. ARIA states
    // are kept in sync with the visual state for screen readers.
    const tabButtons = Array.from(document.querySelectorAll('.tab-strip__tab'));
    const tabPanels = {
      hint: document.getElementById('tab-panel-hint'),
      history: document.getElementById('tab-panel-history')
    };
    for (const btn of tabButtons) {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        for (const other of tabButtons) {
          const active = other === btn;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        for (const [key, panel] of Object.entries(tabPanels)) {
          if (!panel) continue;
          const active = key === target;
          panel.classList.toggle('is-active', active);
          if (active) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
        }
        // Refresh history content on first switch so any new moves are
        // reflected, then re-render to pick up live state.
        if (target === 'history') renderHistory();
      });
    }

    const settingEls = {
      'setting-cloud-depth': (v) => { settings.cloudDepth = parseInt(v); },
      'setting-depth-target': (v) => { settings.depthTarget = parseInt(v); },
      'setting-style': (v) => { settings.style = v; },
      'setting-human-like-mode': (v) => { settings.humanLikeMode = v; },
      'setting-white-repertoire': (v) => { settings.whiteRepertoire = v; },
      'setting-black-repertoire': (v) => { settings.blackRepertoire = v; },
      'setting-auto-analyze': (v) => { settings.autoAnalyze = v; },
      'setting-show-threats': (v) => { settings.showThreats = v; },
      'setting-show-critical-moments': (v) => { settings.showCriticalMoments = v; },
      'setting-show-correlation-stat': (v) => {
        settings.showCorrelationStat = v;
        applyCorrelationVisibility();
      },
      'setting-comparison-mode': (v) => {
        settings.comparisonMode = v;
        // Re-render the comparison card so the highlight switches immediately.
        if (lastAnalysis) renderComparisonCard(getComparisonStatsForUI());
      },
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
        // The human-mode "active plan" is keyed on (style, human-like, and
        // the depth of the next-best candidate). Anything that changes the
        // ranked-PV ordering invalidates it. We rerun renderAnalysis so the
        // UI immediately reflects the new style without waiting for a fresh
        // network round-trip.
        const styleAffectingKeys = new Set([
          'setting-style', 'setting-human-like-mode', 'setting-cloud-depth',
          'setting-white-repertoire', 'setting-black-repertoire'
        ]);
        if (styleAffectingKeys.has(id) && lastAnalysis) {
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

    // Human-mode segmented control (Engine | Human) drives the hidden checkbox.
    $$('.human-mode-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = $('#setting-human-like-mode');
        if (!el) return;
        const on = btn.dataset.mode === 'on';
        if (el.checked === on) return;
        el.checked = on;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
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
      case 'analysis_update':
        handleAnalysisResult(message.data);
        break;
      case 'analysis_error':
        handleAnalysisError(message.data);
        break;
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

  // Hide engine scaffolding (eval bar, position info) until a board position
  // is detected, so the hint section shows alone instead of dead placeholders.
  function syncWelcome() {
    const app = document.getElementById('app');
    if (app) app.classList.toggle('no-position', !currentFen);
  }

  function handlePositionUpdate(message) {
    const prevFen = currentFen;
    currentFen = message.fen;
    syncWelcome();
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
      prevScoreType = 'cp';
      evalAfterMyMove = null;
      scoreTypeAfterMyMove = 'cp';
      fenAfterMyMove = null;
      lastCriticalAlert = null;
      isPlayerTurn = true;
      waitingForOpponent = false;
      // Reset the engine-side correlation tracker + sacrifice history.
      chrome.runtime.sendMessage({ type: 'reset_correlation' }).catch(() => {});
      if (window.ChessHintEngine && typeof window.ChessHintEngine.resetSacrificeHistory === 'function') {
        window.ChessHintEngine.resetSacrificeHistory();
      }
      // Clear local engine-recommendation tracking too.
      lastEngineRecommendationFen = null;
      lastEngineRecommendationUci = null;
      humanPlanState = null;
      // A new game means the previous moves history no longer applies.
      clearMovesHistory();
    }

    // Turn-based analysis — check whose turn it is before analyzing
    const activeColor = currentFen ? (currentFen.split(' ')[1] || 'w') : 'w';
    const effectiveColor = assistedPlayerColor || playerColor || 'w';
    const wasPlayerTurn = isPlayerTurn;
    isPlayerTurn = activeColor === effectiveColor;
    waitingForOpponent = !isPlayerTurn;
    turnJustChanged = !wasPlayerTurn && isPlayerTurn; // Turn just changed to player's turn
    updatePositionContext();

    // Detect that the player just moved (transition
    // from "player's turn" to "opponent's turn" while we had a stored engine
    // recommendation for the previous FEN). Infer the move by applying the
    // engine's recommended UCI to the previous FEN and comparing placements —
    // if they match, the player played the engine move; otherwise we still
    // report the actual resulting FEN so background can record "didn't match".
    if (wasPlayerTurn && !isPlayerTurn && lastEngineRecommendationFen && lastEngineRecommendationUci) {
      tryReportPlayerMove(lastEngineRecommendationFen, lastEngineRecommendationUci, currentFen);
      // Fire a snapshot analysis at the position right after the assistant's
      // move. The result's `bestPV.score` becomes the baseline for the
      // next classification, so the opponent's reply is rated as a
      // single-ply effect rather than comparing two plies at once.
      requestEvalSnapshot(currentFen);
      lastEngineRecommendationFen = null;
      lastEngineRecommendationUci = null;
    }

    if (!turnReliable) {
      isPlayerTurn = false;
      waitingForOpponent = false;
      updateEngineStatus('unknown', 'Turn unavailable: waiting for a verified position');
      if (dom.hintText) dom.hintText.textContent = 'Turn information is unavailable for this board.';
      return;
    }

    if (isPlayerTurn) {
      // It's the player's turn — request analysis
      if (positionChanged && (settings.autoAnalyze || turnJustChanged)) {
        requestAnalysis();
      }
      updateEngineStatus(wasPlayerTurn ? 'online' : 'analyzing', turnJustChanged ? 'Your turn: analyzing...' : 'Your turn');
    } else {
      // It's the opponent's turn — show waiting status, no API calls
      updateEngineStatus('online', `Opponent's turn: waiting...`);
      if (dom.hintText && !lastAnalysis) {
        dom.hintText.textContent = `Waiting for opponent's move...`;
      }
    }
  }

  // Compare the player's actual resulting FEN to the
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

  // Snapshot analysis: fire-and-forget `request_cloud_analysis` for the
  // position right after the assistant moved, store the result's
  // bestPV.score, and use it as the baseline for the next classification.
  // The request bypasses the turn-based gate (which would refuse the
  // opponent's turn), and the response is read here rather than via the
  // `analysis_update` message because the snapshot is for bookkeeping
  // only — it must not overwrite `lastAnalysis` or the UI.
  function requestEvalSnapshot(fen) {
    if (!fen) return;
    const colorToSend = assistedPlayerColor || playerColor || 'w';
    fenAfterMyMove = fen;
    chrome.runtime.sendMessage({
      type: 'request_cloud_analysis',
      fen,
      playerColor: colorToSend,
      multiPv: settings.cloudDepth || 3,
      tabId: activeTabId,
      positionReliable
    }).then(result => {
      if (!result || !result.pvs || result.pvs.length === 0) return;
      const pv = result.pvs[0];
      if (!pv || typeof pv.score !== 'number') return;
      // Only consume the snapshot if the FEN still matches what we asked
      // for. The board may have changed (e.g. the opponent undid a move)
      // between the request firing and the response arriving.
      if (fenAfterMyMove !== fen) return;
      evalAfterMyMove = pv.score;        // White-relative (per classifyMove contract)
      scoreTypeAfterMyMove = pv.scoreType || 'cp';
    }).catch(() => {});
  }

  // Pull current correlation stats from background and render them in
  // the "Sensible moves" row of the position-info card. The stat is a
  // human-likeness guard: high = your moves look natural/human (fair-play safe),
  // low = you are blindly copying the engine's exact top picks.
  function updateCorrelationStat() {
    // The legacy "Sensible moves" headline is replaced by the engine-
    // comparison card. The function is kept as a no-op wrapper so the
    // existing call sites (init, after every analysis, after every recorded
    // move) continue to work without churn.
    updateComparisonCard();
  }

  // ─── Engine-comparison card ───────────────────────────────────────
  // Four independent percentages, each with its own denominator:
  //   engine      — followed the engine top pick
  //   human       — followed the human-like pick (denominator = moves where
  //                  a human pick was offered, which may be 0 in standard mode)
  //   independent — played a move neither side suggested
  //   agreement   — engine and human happened to suggest the same move
  //                  (diagnostic: when this is high, the engine/human rows
  //                   are measuring the same thing twice)
  function getComparisonStatsForUI() {
    return chrome.runtime.sendMessage({ type: 'get_comparison_stats' });
  }

  function formatRatioText(matches, total) {
    if (total <= 0) return '—';
    return `${matches} / ${total} (${Math.round((matches / total) * 100)}%)`;
  }

  function ratioHue(matches, total) {
    if (total <= 0) return 'var(--text-secondary)';
    const pct = (matches / total) * 100;
    if (pct >= 60) return 'var(--accent-green)';
    if (pct >= 30) return 'var(--accent-yellow)';
    return 'var(--accent-red)';
  }

  function renderComparisonCard(stats) {
    if (!dom.comparisonCard) return;
    if (!stats) {
      // Initial / error state — neutral placeholders.
      const placeholders = { engine: '—', human: '—', independent: '—', agreement: '—' };
      Object.entries(dom.comparisonRows).forEach(([key, el]) => {
        if (!el) return;
        el.classList.toggle('is-highlighted', settings.comparisonMode === key);
        el.classList.remove('is-dim');
        const value = el.querySelector('.comparison-row__value');
        if (value) value.textContent = placeholders[key];
      });
      return;
    }
    const rows = dom.comparisonRows;
    const sets = {
      engine:      { text: formatRatioText(stats.engine.matches, stats.engine.total), tone: ratioHue(stats.engine.matches, stats.engine.total) },
      human:       { text: formatRatioText(stats.human.matches, stats.human.total), tone: ratioHue(stats.human.matches, stats.human.total) },
      independent: { text: formatRatioText(stats.independent.moves, stats.independent.total), tone: ratioHue(stats.independent.moves, stats.independent.total) },
      // Agreement is diagnostic, not a verdict — keep it dim regardless.
      agreement:   { text: formatRatioText(stats.agreement.agreed, stats.agreement.total), tone: 'var(--text-dim)' }
    };
    Object.entries(rows).forEach(([key, el]) => {
      if (!el) return;
      const valueEl = el.querySelector('.comparison-row__value');
      if (valueEl) {
        valueEl.textContent = sets[key].text;
        valueEl.style.color = sets[key].tone;
      }
      el.classList.toggle('is-highlighted', settings.comparisonMode === key);
      // Dim the agreement row whenever it's not the focused one so the
      // user can pick the row they care about.
      el.classList.toggle('is-dim', key === 'agreement' && settings.comparisonMode !== 'agreement');
    });
  }

  function updateComparisonCard() {
    if (!dom.comparisonCard) return;
    getComparisonStatsForUI().then(stats => renderComparisonCard(stats)).catch(() => renderComparisonCard(null));
  }

  // ─── Moves history (History tab) ──────────────────────────────────
  // Persisted in chrome.storage.local so the tab survives a side-panel
  // reload. The persisted copy is keyed by `gameId` from the position
  // generation token; a new game wipes the previous game's history.
  const MOVES_HISTORY_STORAGE_KEY = 'movesHistory';

  function loadMovesHistory() {
    return new Promise(resolve => {
      chrome.storage.local.get([MOVES_HISTORY_STORAGE_KEY], result => {
        const stored = result && result[MOVES_HISTORY_STORAGE_KEY];
        if (Array.isArray(stored)) {
          movesHistory = stored.slice(-MOVES_HISTORY_LIMIT);
        }
        resolve();
      });
    });
  }

  function persistMovesHistory() {
    // Storage is fire-and-forget; the in-memory array is the source of
    // truth for the duration of the side panel's lifetime.
    try {
      chrome.storage.local.set({ [MOVES_HISTORY_STORAGE_KEY]: movesHistory });
    } catch (_) { /* storage may be unavailable in some test contexts */ }
  }

  // Record a single classified move. The classification comes from the
  // engine (already computed by the caller); the SAN is computed at the
  // FEN *before* the move so the result is the move the player/opponent
  // actually played, not the engine's top pick.
  // Identify the UCI of the move being classified and hand it to the
  // history log. The strategy depends on whose move it was:
  //   * Opponent's move (we have a snapshot FEN): ask the background to
  //     infer the UCI from the FEN diff. This is reliable because the
  //     diff is one legal move.
  //   * Assistant's move (fallback path, no snapshot): use the engine's
  //     recommendation for `prevFen` as a best-effort. If the assistant
  //     played the engine move, this is exact; if not, the SAN will be
  //     wrong but the eval/classification is still right.
  function recordClassifiedMove(opts) {
    const { prevFen, currentFen, playedUciHint, classification, evalBeforeWhite, evalAfterWhite, scoreTypeBefore, scoreTypeAfter } = opts;
    if (!prevFen || !classification) return;
    // First, try the FEN-diff inference (background).
    chrome.runtime.sendMessage({
      type: 'infer_move',
      prevFen,
      currentFen
    }).then(inferred => {
      const uci = inferred || playedUciHint || null;
      if (!uci) return;
      recordHistoryEntry(prevFen, uci, classification, evalBeforeWhite, evalAfterWhite, scoreTypeBefore, scoreTypeAfter);
    }).catch(() => {
      // Background offline; fall back to the engine recommendation.
      if (playedUciHint) {
        recordHistoryEntry(prevFen, playedUciHint, classification, evalBeforeWhite, evalAfterWhite, scoreTypeBefore, scoreTypeAfter);
      }
    });
  }

  function recordHistoryEntry(prevFen, playedUci, classification, evalBeforeWhite, evalAfterWhite, scoreTypeBefore, scoreTypeAfter) {
    if (!prevFen || !playedUci || !classification) return;
    // The mover's color is the side that's about to play in prevFen
    // (because after they move, it's the opponent's turn).
    const moverColor = (prevFen.split(' ')[1] || 'w') === 'w' ? 'w' : 'b';
    const fullmove = parseInt(prevFen.split(' ')[5], 10) || 1;
    // SAN at the position the move was played from.
    let san = null;
    if (window.ChessHintEngine && typeof window.ChessHintEngine.uciToSan === 'function') {
      try { san = window.ChessHintEngine.uciToSan(playedUci, prevFen); } catch (_) {}
    }
    // The FEN after the move (for a future "jump to position" feature).
    let fenAfter = null;
    if (window.ChessCore && typeof window.ChessCore.applyMoveToFen === 'function') {
      try { fenAfter = window.ChessCore.applyMoveToFen(prevFen, playedUci); } catch (_) {}
    }
    const entry = {
      moveNumber: fullmove,
      color: moverColor,
      uci: playedUci,
      san: san || playedUci,
      classification,
      evalBefore: evalBeforeWhite,
      evalAfter: evalAfterWhite,
      scoreTypeBefore,
      scoreTypeAfter,
      t: Date.now(),
      fen: fenAfter
    };
    movesHistory.push(entry);
    if (movesHistory.length > MOVES_HISTORY_LIMIT) {
      movesHistory.splice(0, movesHistory.length - MOVES_HISTORY_LIMIT);
    }
    persistMovesHistory();
    renderHistory();
  }

  // Reset history (called on new game or player color change).
  function clearMovesHistory() {
    movesHistory = [];
    persistMovesHistory();
    renderHistory();
  }

  // Per-label colour for the classification badge. Mirrors the palette
  // used by `classifyMove` in engine/hint-engine.js so the table is
  // visually consistent with the rest of the UI.
  const CLASSIFICATION_COLOR = {
    'Brilliant': '#26cad4',
    'Great':     '#5aade0',
    'Best':      '#97af8b',
    'Excellent': '#97af8b',
    'Good':      '#97af8b',
    'Inaccuracy': '#f7c631',
    'Mistake':   '#e6923a',
    'Blunder':   '#ca3531'
  };

  function classifyAccent(label) {
    return CLASSIFICATION_COLOR[label] || 'var(--text-secondary)';
  }

  // Format an eval for the history table: cp with sign and decimal, or
  // "M5" / "-M3" for mate scores.
  function formatEvalForTable(whiteScore, scoreType) {
    if (scoreType === 'mate') {
      const n = Math.abs(Math.round(whiteScore));
      return whiteScore > 0 ? `+M${n}` : `-M${n}`;
    }
    const pawns = whiteScore / 100;
    const rounded = Math.round(pawns * 10) / 10;
    return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
  }

  // Build the moves-history table content. Two pieces:
  //   - the aggregate summary (counts per classification, average accuracy)
  //   - the per-move list, newest first
  // Both are rendered into the existing `#history-card` element so the
  // History tab can be styled like the other cards.
  function renderHistory() {
    if (!dom.historyCard) return;
    if (movesHistory.length === 0) {
      dom.historyCard.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No moves yet. Play a game and the engine will rate every move here.';
      dom.historyCard.appendChild(empty);
      return;
    }
    // ── Aggregate summary ─────────────────────────────────────────
    const counts = {};
    let totalAccuracy = 0;
    let counted = 0;
    let whiteMoves = 0, whiteAccuracy = 0;
    let blackMoves = 0, blackAccuracy = 0;
    let bestAccuracy = 0, worstAccuracy = 100;
    for (const e of movesHistory) {
      const label = e.classification && e.classification.label;
      if (!label) continue;
      counts[label] = (counts[label] || 0) + 1;
      const acc = Number(e.classification.accuracy) || 0;
      totalAccuracy += acc;
      counted += 1;
      if (e.color === 'w') { whiteMoves += 1; whiteAccuracy += acc; }
      else                { blackMoves += 1; blackAccuracy += acc; }
      if (acc > bestAccuracy) bestAccuracy = acc;
      if (acc < worstAccuracy) worstAccuracy = acc;
    }
    const avgAccuracy = counted > 0 ? Math.round(totalAccuracy / counted) : 0;
    const whiteAvg = whiteMoves > 0 ? Math.round(whiteAccuracy / whiteMoves) : 0;
    const blackAvg = blackMoves > 0 ? Math.round(blackAccuracy / blackMoves) : 0;

    const summary = document.createElement('div');
    summary.className = 'history-summary';
    const total = document.createElement('div');
    total.className = 'history-summary__row history-summary__row--total';
    const totalLabel = document.createElement('span');
    totalLabel.className = 'history-summary__label';
    totalLabel.textContent = 'Total moves';
    const totalValue = document.createElement('span');
    totalValue.className = 'history-summary__value';
    totalValue.textContent = String(counted);
    total.append(totalLabel, totalValue);

    const acc = document.createElement('div');
    acc.className = 'history-summary__row history-summary__row--accuracy';
    const accLabel = document.createElement('span');
    accLabel.className = 'history-summary__label';
    accLabel.textContent = 'Average accuracy';
    const accValue = document.createElement('span');
    accValue.className = 'history-summary__value';
    accValue.textContent = `${avgAccuracy}%`;
    accValue.style.color = avgAccuracy >= 80 ? 'var(--accent-green)'
      : avgAccuracy >= 60 ? 'var(--accent-yellow)' : 'var(--accent-red)';
    acc.append(accLabel, accValue);

    const breakdown = document.createElement('div');
    breakdown.className = 'history-summary__row';
    const breakdownLabel = document.createElement('span');
    breakdownLabel.className = 'history-summary__label';
    breakdownLabel.textContent = 'By color';
    const breakdownValue = document.createElement('span');
    breakdownValue.className = 'history-summary__value';
    breakdownValue.textContent = `W: ${whiteAvg}%  ·  B: ${blackAvg}%`;
    breakdown.append(breakdownLabel, breakdownValue);

    const range = document.createElement('div');
    range.className = 'history-summary__row';
    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'history-summary__label';
    rangeLabel.textContent = 'Best / worst';
    const rangeValue = document.createElement('span');
    rangeValue.className = 'history-summary__value';
    rangeValue.textContent = `${bestAccuracy}% / ${worstAccuracy}%`;
    range.append(rangeLabel, rangeValue);

    const histogram = document.createElement('div');
    histogram.className = 'history-histogram';
    const order = ['Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'];
    for (const label of order) {
      const c = counts[label] || 0;
      if (c === 0) continue;
      const row = document.createElement('div');
      row.className = 'history-histogram__row';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'history-histogram__label';
      labelSpan.style.color = classifyAccent(label);
      labelSpan.textContent = label;
      const bar = document.createElement('div');
      bar.className = 'history-histogram__bar';
      const fill = document.createElement('div');
      fill.className = 'history-histogram__fill';
      // Scale: 100% = the most-common label in this game. The bar tops
      // out at the most frequent label so the distribution stays
      // legible whether the game has 5 or 50 moves.
      const maxCount = Math.max(1, ...order.map(l => counts[l] || 0));
      const widthPct = Math.min(100, (c / maxCount) * 100);
      fill.style.width = `${widthPct}%`;
      fill.style.background = classifyAccent(label);
      bar.appendChild(fill);
      const value = document.createElement('span');
      value.className = 'history-histogram__value';
      value.textContent = String(c);
      row.append(labelSpan, bar, value);
      histogram.appendChild(row);
    }

    summary.append(total, acc, breakdown, range, histogram);

    // ── Per-move list (newest first) ────────────────────────────────
    const list = document.createElement('ol');
    list.className = 'history-list';
    list.setAttribute('aria-label', 'Move history, newest first');
    // Cap the rendered list at 200 entries to keep DOM cost bounded.
    const rendered = movesHistory.slice(-MOVES_HISTORY_LIMIT).slice().reverse();
    for (const e of rendered) {
      const item = document.createElement('li');
      item.className = 'history-row';
      const cls = e.classification;
      const moveHead = document.createElement('div');
      moveHead.className = 'history-row__head';
      const moveLabel = document.createElement('span');
      moveLabel.className = 'history-row__move';
      const moveNum = `${e.moveNumber}${e.color === 'w' ? '.' : '...'}`;
      moveLabel.textContent = `${moveNum} ${e.san || e.uci}`;
      const clsBadge = document.createElement('span');
      // Map the classification label to a CSS class (cls-brilliant,
      // cls-mistake, etc.) so the colour comes from the stylesheet
      // rather than per-render inline styling. The label is whitelisted
      // by `classifyMove` in the engine.
      const clsClass = `cls-${String(cls.label || 'good').toLowerCase().replace(/[^a-z]/g, '')}`;
      clsBadge.className = `history-row__class ${clsClass}`;
      clsBadge.textContent = `${cls.label}${cls.symbol ? ' ' + cls.symbol : ''}`;
      moveHead.append(moveLabel, clsBadge);

      const moveMeta = document.createElement('div');
      moveMeta.className = 'history-row__meta';
      const wcDelta = (Number(cls.winChanceLost) || 0) - (Number(cls.winChanceGained) || 0);
      // Positive = lost win chance, negative = gained. Show as a signed
      // percentage with the same sign convention as Lichess.
      const wcText = wcDelta === 0 ? '±0.0%'
        : (wcDelta > 0 ? `−${wcDelta.toFixed(1)}%` : `+${(-wcDelta).toFixed(1)}%`);
      const evalText = `${formatEvalForTable(e.evalBefore, e.scoreTypeBefore)} → ${formatEvalForTable(e.evalAfter, e.scoreTypeAfter)}`;
      const accText = `Acc ${cls.accuracy}%`;
      moveMeta.textContent = `${wcText}  ·  ${evalText}  ·  ${accText}`;
      item.append(moveHead, moveMeta);
      list.appendChild(item);
    }

    dom.historyCard.replaceChildren(summary, list);
  }

  // Handle turn status updates from background script
  function handleTurnStatusUpdate(data) {
    if (!data) return;
    isPlayerTurn = data.isPlayerTurn;
    waitingForOpponent = data.waitingForOpponent;
    if (data.reason === 'turn_unknown') turnReliable = false;
    updatePositionContext();

    if (data.reason === 'turn_unknown') {
      updateEngineStatus('unknown', 'Turn unavailable: waiting for a verified position');
      if (dom.hintText) dom.hintText.textContent = 'Turn information is unavailable for this board.';
      return;
    }

    if (isPlayerTurn) {
      updateEngineStatus('analyzing', 'Your turn: analyzing...');
    } else {
      updateEngineStatus('online', "Opponent's turn: waiting...");
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
    updateSourceFromResult(source, data);

    if (data.pvs && data.pvs.length > 0) {
      const bestPV = data.pvs[0];
      const effectiveColor = assistedPlayerColor || playerColor || 'w';
      // Convert score to player's perspective for consistent tracking
      const evalScore = effectiveColor === 'w' ? bestPV.score : -bestPV.score;
      evalHistory.push({ fen: data.fen, score: evalScore, scoreType: bestPV.scoreType });
      if (evalHistory.length > 50) evalHistory.shift();
      // The "Last move" classification prefers a snapshot taken right after
      // the assistant's last move (evalAfterMyMove) over the previous
      // analysis's eval. The snapshot is White-relative; prevEval is
      // player-relative, so we convert. Falls back to the previous
      // analysis if no snapshot is available yet.
      let classifyBaselineWhite = null;
      let classifyBaselineType = 'cp';
      if (evalAfterMyMove !== null) {
        classifyBaselineWhite = effectiveColor === 'w' ? evalAfterMyMove : -evalAfterMyMove;
        classifyBaselineType = scoreTypeAfterMyMove || 'cp';
      } else if (prevEval !== null) {
        classifyBaselineWhite = effectiveColor === 'w' ? prevEval : -prevEval;
        classifyBaselineType = prevScoreType || 'cp';
      }
      if (classifyBaselineWhite !== null) {
        const currWhite = effectiveColor === 'w' ? bestPV.score : -bestPV.score;
        const fenActiveColor = (data.fen || '').split(' ')[1] || 'w';
        // The side that just moved is the opposite of the side to move.
        const moverColor = fenActiveColor === 'w' ? 'b' : 'w';
        const cls = renderMoveClassification(classifyBaselineWhite, currWhite, {
          moverColor,
          scoreTypeBefore: classifyBaselineType,
          scoreTypeAfter: bestPV.scoreType
        });
        // Record the classified move in the history log. We try to
        // identify the UCI played by FEN-diff against the snapshot
        // FEN (opponent's move) or the engine's recommendation (assistant's
        // move). When inference fails we still log the move with a
        // placeholder UCI so the eval/classification isn't lost.
        recordClassifiedMove({
          prevFen: evalAfterMyMove !== null ? fenAfterMyMove : lastEngineRecommendationFen,
          currentFen: data.fen,
          playedUciHint: lastEngineRecommendationUci,
          classification: cls,
          evalBeforeWhite: classifyBaselineWhite,
          evalAfterWhite: currWhite,
          scoreTypeBefore: classifyBaselineType,
          scoreTypeAfter: bestPV.scoreType
        });
      }
      // Consume the snapshot. The next baseline will be the eval we just
      // saw (set into prevEval below) — unless the next analysis is
      // itself preceded by another snapshot, in which case that one wins.
      evalAfterMyMove = null;
      scoreTypeAfterMyMove = 'cp';
      fenAfterMyMove = null;
      prevEval = evalScore;
      prevScoreType = bestPV.scoreType;

      // Remember the engine's first-choice move +
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

    // Toast only on user-initiated refresh, not every
    // auto-analysis. The `isRefreshing` flag is set when the user clicks
    // Refresh and cleared only when this workflow settles.
    if (data.source && wasUserRefresh) {
      const sourceNames = { 'chess-api': 'Chess-API', 'lichess-cloud': 'Lichess Cloud', 'masters-explorer': 'Masters DB', 'opening-explorer': 'Opening Cache', 'tablebase': 'Tablebase' };
      showToast(`Analysis ready via ${sourceNames[data.source] || data.source}`, 'success', 2000);
    }

    if (data.exactHintBlocked) {
      showToast(data.exactHintBlocked.message, 'warning', 3500);
    }

    // Refresh the correlation stat in the UI.
    updateCorrelationStat();
    if (wasUserRefresh) finishRefresh();
  }

  function handleAnalysisError(data) {
    if (!data) return;
    if (data.fen && currentFen && data.fen.split(' ').slice(0, 4).join(' ') !== currentFen.split(' ').slice(0, 4).join(' ')) return;
    const errorMsg = data.error || 'Cloud analysis unavailable.';
    if (isRefreshing) finishRefresh();
    updateEngineStatus('error', errorMsg);
    // Show toast for errors
    showToast(errorMsg, 'error', 4000);
    if (dom.hintText) {
      // The background already classifies retry, wait, and hard-budget states.
      // Do not suggest Refresh for a state where it cannot help.
      dom.hintText.textContent = errorMsg;
    }
  }

  function handleOpeningDataUpdate(data) {
    if (!data || !data.openingData) return;
    // Update opening data in last analysis if we have it
    if (lastAnalysis && lastAnalysis.fen === data.fen) {
      lastAnalysis.openingData = data.openingData;
      if (dom.openingName && data.openingData.opening) {
        dom.openingName.textContent = data.openingData.opening;
      }
    }
  }

  function updateSourceFromResult(source, data) {
    const sourceLabels = {
      'chess-api': 'Chess-API.com',
      'lichess-cloud': 'Lichess Cloud',
      'masters-explorer': 'Masters DB', // Human grandmaster moves
      'opening-explorer': 'Opening Explorer Cache',
      'tablebase': 'Tablebase',
      'unknown': '\u2013'
    };
    const label = sourceLabels[source] || source;
    updateSourceIndicator(source, label, data.depth, data.stale);
  }

  // The hero "source-badge" pill and the "Analysis" row in position-info are
  // rendered from a single helper so the depth, staleness, and colour cue
  // stay in sync. `depth` is reported by the engine; `stale` is set by the
  // background coordinator when a cached result past its fresh window is
  // served because the source was unavailable.
  function updateSourceIndicator(source, label, depth, stale) {
    // Hero badge: a compact source-type pill next to the move.
    if (dom.sourceBadge) {
      const badgeClass = source === 'tablebase' ? 'tb'
        : (source === 'masters-explorer' || source === 'opening-explorer' ? 'human' : 'cloud');
      dom.sourceBadge.className = `source-badge source-${badgeClass}`;
      dom.sourceBadge.textContent = source === 'tablebase' ? 'TB'
        : (source === 'masters-explorer' ? 'HUMAN'
        : (source === 'opening-explorer' ? 'OPENING'
        : (source === 'unknown' ? '\u2013' : 'CLOUD')));
    }
    // "Analysis" row in the position-info card: provider + depth + stale.
    if (dom.analysisSource) {
      const sourceClass = source === 'tablebase' ? 'tb'
        : (source === 'masters-explorer' || source === 'opening-explorer' ? 'human' : 'cloud');
      const parts = [label];
      if (depth) parts.push(`depth ${depth}`);
      if (stale) parts.push('stale');
      dom.analysisSource.textContent = parts.join(' \u00b7 ');
      dom.analysisSource.className = `info-value source-indicator source-${sourceClass}${stale ? ' stale' : ''}`;
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

    // Always compute the would-be-human pick so the engine-comparison card
    // can show what the human-like re-ranker would have suggested, even when
    // the user is currently in standard mode. This is a pure call on the
    // same PVS so it costs nothing; the result is recorded into the
    // background's `humanMoveByFen` map and feeds the comparison stats.
    let humanPickUci = null;
    if (objectivePvs.length > 0 && data.source !== 'tablebase') {
      const humanRankedPvs = window.ChessHintEngine.selectPVForStyle(
        objectivePvs,
        data.fen,
        settings.style,
        effectiveColor,
        true,
        { activePlan: humanPlanState?.activePlan || null, openingData: data.openingData }
      );
      if (humanRankedPvs.length > 0 && humanRankedPvs[0].pv && humanRankedPvs[0].pv.length > 0) {
        humanPickUci = humanRankedPvs[0].pv[0];
      }
    }

    // Track the move the panel actually recommends. In human-like mode
    // this is the human-natural styled pick (possibly different from the raw
    // engine top move); the correlation guard uses it to distinguish human-like
    // play from blind engine-top copies, and the FEN-diff reporter uses it as
    // the expected move for the position.
    if (styledPvs.length > 0 && styledPvs[0].pv && styledPvs[0].pv.length > 0) {
      lastEngineRecommendationFen = data.fen;
      lastEngineRecommendationUci = styledPvs[0].pv[0];
      // Record the would-be-human pick whenever we have one. The background
      // dedupes by FEN, so toggling modes after the fact doesn't overwrite
      // the prior human pick; this lets the comparison card show a meaningful
      // "human match" rate even for users who stay in standard mode.
      if (humanPickUci) {
        chrome.runtime.sendMessage({
          type: 'record_human_recommendation',
          fen: data.fen,
          uci: humanPickUci
        }).catch(() => {});
      }
    }

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
      return;
    }

    if (settings.showCriticalMoments) {
      renderCriticalMoment(effectiveColor);
    } else if (dom.criticalMomentSection) {
      dom.criticalMomentSection.style.display = 'none';
    }
  }

  function updateEvalBar(score, scoreType, effectiveColor) {
    const isWhite = effectiveColor === 'w';
    const displayScore = isWhite ? score : -score;
    const winPct = window.ChessHintEngine.formatEvalBar(score, scoreType, true) / 100;
    if (dom.evalBarWhite) {
      // Width encodes win-chance: the white side fills `winPct` of the
      // bar from the left. The black side is mirrored via `1 - winPct`
      // from the right.
      dom.evalBarWhite.style.width = `${(winPct * 100).toFixed(2)}%`;
    }
    if (dom.evalBarBlack) {
      dom.evalBarBlack.style.width = `${((1 - winPct) * 100).toFixed(2)}%`;
    }
    const scoreStr = scoreType === 'mate'
      ? (displayScore > 0 ? `+M${displayScore}` : `-M${Math.abs(displayScore)}`)
      : (displayScore >= 0 ? `+${(displayScore / 100).toFixed(1)}` : (displayScore / 100).toFixed(1));
    const oppStr = scoreType === 'mate'
      ? (displayScore > 0 ? `-M${displayScore}` : `+M${Math.abs(displayScore)}`)
      : (displayScore < 0 ? `+${(-displayScore / 100).toFixed(1)}` : (-displayScore / 100).toFixed(1));
    if (dom.evalBar) {
      const evalPawns = scoreType === 'mate'
        ? (displayScore > 0 ? 10 : -10) * Math.sign(displayScore || 1)
        : score / 100;
      dom.evalBar.setAttribute('aria-valuenow', String(Math.max(-10, Math.min(10, evalPawns))));
      dom.evalBar.setAttribute('aria-valuetext', `${scoreStr} for ${isWhite ? 'White' : 'Black'}`);
    }
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
        dom.openingName.textContent = opening ? opening.name : '\u2013';
      }
    }
    if (dom.gamePhase && data.fen) {
      const phase = window.ChessHintEngine.detectGamePhase(data.fen);
      dom.gamePhase.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
    }
    // The "Analysis" row is rendered by updateSourceIndicator from
    // handleAnalysisResult; nothing to do here.
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

  // ─── Hint Rendering ────────────────────────────────────────────────
  function renderHints(data) {
    if (data.exactHintBlocked) {
      if (dom.hintText) dom.hintText.textContent = data.exactHintBlocked.message;
      if (dom.hintFromTo) dom.hintFromTo.style.display = 'none';
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

    // The engine is exact-move-only; the hint level passed to generateHints
    // is a back-compat parameter and is ignored. EXACT_HINT_LEVEL is kept as
    // the single source of truth for the value embedded in messages.
    const hints = window.ChessHintEngine.generateHints(
      { ...data, prevEval, currEval: currEvalPlayerPerspective },
      EXACT_HINT_LEVEL,
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
      let accent = 'var(--accent-gold)';
      if (settings.style === 'aggressive') accent = 'var(--accent-aggressive)';
      if (settings.style === 'super_ultra_aggressive') accent = 'var(--accent-super-ultra)';
      dom.hintCard.style.setProperty('--hint-accent', accent);
      const styleClass = settings.style === 'super_ultra_aggressive' ? ' super-ultra-mode' : '';
      const humanClass = settings.humanLikeMode ? ' human-mode' : '';
      dom.hintCard.className = 'hint-card exact-move' + styleClass + humanClass;
    }

    if (dom.threatPill && dom.threatPillText) {
      if (settings.showThreats && hints.threat) {
        dom.threatPillText.textContent = hints.threat;
        dom.threatPill.style.display = 'flex';
      } else {
        dom.threatPill.style.display = 'none';
        dom.threatPillText.textContent = '';
      }
    }

  }

  function renderMoveClassification(evalBefore, evalAfter, opts) {
    if (!dom.moveClassSection || !dom.moveClassDisplay) return null;
    const cls = window.ChessHintEngine.classifyMove(evalBefore, evalAfter, opts || {});
    const classKey = cls.label.toLowerCase();
    const lost = cls.winChanceLost > 0 ? `Win −${cls.winChanceLost}%` : (cls.winChanceGained > 0 ? `Win +${cls.winChanceGained}%` : '');
    // Whitelist the class key against the labels classifyMove actually emits.
    // The labels are static today, but defending in depth is cheap — the
    // previous template-literal interpolation built a `class="${classKey}"`
    // attribute that would have been a latent XSS sink if labels ever
    // became localized or user-influenced.
    const ALLOWED_CLASS_KEYS = new Set(['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']);
    const safeClassKey = ALLOWED_CLASS_KEYS.has(classKey) ? classKey : 'good';
    const badge = document.createElement('span');
    badge.className = `class-badge class-${safeClassKey}`;
    badge.textContent = `${cls.label} ${cls.symbol || ''}`;
    const accuracy = document.createElement('span');
    accuracy.className = 'class-accuracy';
    accuracy.title = 'Engine accuracy estimate for this move (0-100)';
    accuracy.textContent = `Acc ${cls.accuracy}`;
    const main = document.createElement('div');
    main.className = 'class-main';
    main.append(badge, accuracy);
    dom.moveClassDisplay.replaceChildren(main);
    if (lost) {
      const metric = document.createElement('span');
      metric.className = 'class-metric';
      metric.textContent = lost;
      dom.moveClassDisplay.appendChild(metric);
    }
    dom.moveClassSection.style.display = 'block';
    return cls;
  }

  // ─── Start ─────────────────────────────────────────────────────────
  init();
})();
