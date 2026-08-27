// ESLint flat config. Deliberately pragmatic: the codebase is classic
// browser/service-worker script (globals, no modules), so this starts from
// recommended rules and disables the two rules that would flag thousands of
// pre-existing lines. Tighten incrementally — every rule turned on here
// must pass on the current tree so `npm run lint` stays green in CI.
const browserGlobals = {
  chrome: 'writable',
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  FileReader: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  crypto: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Node: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  setInterval: 'writable',
  setTimeout: 'writable',
  clearInterval: 'writable',
  clearTimeout: 'writable',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  importScripts: 'writable',
  WebSocket: 'readonly',
  caches: 'readonly',
  self: 'writable'
};

// Globals defined by this extension's own classic scripts (loaded via
// <script> tags / importScripts) — needed for no-undef to be meaningful.
const extensionGlobals = {
  ChessCore: 'readonly',
  ChessHintEngine: 'readonly',
  AnalysisPolicy: 'readonly',
  AnalysisContract: 'readonly',
  ApiReliability: 'readonly',
  ChaosAttack: 'readonly',
  EarlyKingHunt: 'readonly',
  HumanForm: 'readonly',
  LocalEngine: 'readonly',
  AttackBook: 'readonly',
  Event: 'readonly',
  // Page-world global accessed by content.js when running in MAIN world.
  lichess: 'readonly'
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'preview/**',
      '**/*.min.js'
    ]
  },
  {
    files: ['background.js', 'content.js', 'engine/**/*.js', 'sidepanel/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browserGlobals, ...extensionGlobals, module: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'warn'
    }
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...browserGlobals,
        ...extensionGlobals,
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'warn'
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...browserGlobals, process: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'warn'
    }
  }
];
