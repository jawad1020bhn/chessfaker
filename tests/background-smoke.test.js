'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const listeners = {};
const values = {};
const sentMessages = [];
const remoteUrls = [];
let remoteMode = 'deny';
let remoteFetches = 0;

function storageGet(keys, callback) {
  let result = {};
  if (keys === null) result = { ...values };
  else for (const key of (Array.isArray(keys) ? keys : [keys])) {
    if (Object.hasOwn(values, key)) result[key] = values[key];
  }
  if (callback) { callback(result); return undefined; }
  return Promise.resolve(result);
}

const chrome = {
  storage: {
    local: {
      get: storageGet,
      set(object, callback) { Object.assign(values, object); callback?.(); return Promise.resolve(); },
      remove(keys, callback) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
        callback?.();
        return Promise.resolve();
      }
    },
    onChanged: { addListener() {} }
  },
  alarms: { get(_name, callback) { callback(null); }, create() {}, onAlarm: { addListener() {} } },
  tabs: {
    onRemoved: { addListener() {} },
    onActivated: { addListener() {} },
    async query() { return []; }
  },
  sidePanel: { async setPanelBehavior() {} },
  runtime: {
    onMessage: { addListener(listener) { listeners.message = listener; } },
    onInstalled: { addListener() {} },
    async sendMessage(message) { sentMessages.push(message); }
  },
  scripting: { async executeScript() { return []; } }
};

const context = {
  chrome,
  console: { log() {}, warn() {}, error() {} },
  navigator: { onLine: true },
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  async fetch(url) {
    remoteFetches++;
    remoteUrls.push(url);
    const makeResponse = data => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      async json() { return data; }
    });
    if (remoteMode === 'tablebase' && url.includes('tablebase.lichess.ovh')) {
      return makeResponse({
        category: 'win', dtz: 1, dtm: 1, checkmate: false, stalemate: false,
        moves: [{ uci: 'h1h8', san: 'Rh8+', category: 'win', dtz: 1, dtm: 1 }]
      });
    }
    if (remoteMode === 'masters' && url.includes('explorer.lichess.ovh/master')) {
      return makeResponse({
        white: 12, draws: 5, black: 3,
        moves: [{ uci: 'e2e4', san: 'e4', white: 8, draws: 3, black: 1, averageRating: 2400 }],
        topGames: []
      });
    }
    throw new Error(`Unexpected remote call: ${url}`);
  }
};
context.globalThis = context;
vm.createContext(context);
context.importScripts = (...files) => {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
};
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
assert.equal(typeof listeners.message, 'function', 'service worker message listener is registered');

function send(message) {
  return new Promise(resolve => {
    const asyncResponse = listeners.message(message, {}, resolve);
    if (asyncResponse !== true) queueMicrotask(() => resolve(undefined));
  });
}

(async () => {
  const health = await send({ type: 'health_check' });
  assert.equal(remoteFetches, 0, 'passive health status must not contact providers');
  assert.equal(health['chess-api'].passive, true);
  assert.equal(health.lichess.passive, true);

  const diagnostics = await send({ type: 'get_api_diagnostics' });
  assert.ok(diagnostics.providers.chessApi);
  assert.equal(diagnostics.remoteCallsAvoidedByCache, 0);

  const waitForMessage = async (type, previousCount) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const matches = sentMessages.filter(message => message?.type === type);
      if (matches.length > previousCount) return matches.at(-1);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${type}`);
  };

  await send({ type: 'panel_state', open: true, tabId: 7 });
  remoteMode = 'tablebase';
  const tablebaseUpdates = sentMessages.filter(message => message?.type === 'analysis_update').length;
  await send({
    type: 'request_analysis',
    tabId: 7,
    fen: '8/8/8/8/8/8/4K3/6kR w - - 0 1',
    playerColor: 'w',
    multiPv: 3,
    hintLevel: 3
  });
  const tablebaseUpdate = await waitForMessage('analysis_update', tablebaseUpdates);
  assert.equal(tablebaseUpdate.data.source, 'tablebase');
  assert.equal(tablebaseUpdate.data.hintLevel, 5, 'all requests produce exact-move hints regardless of legacy requested level');
  assert.equal(tablebaseUpdate.data.exactHintBlocked, null);
  assert.equal(remoteUrls.filter(url => url.includes('tablebase.lichess.ovh')).length, 1);
  assert.equal(remoteUrls.filter(url => url.includes('cloud-eval') || url.includes('chess-api.com')).length, 0,
    'a successful tablebase result prevents engine analysis');

  remoteMode = 'masters';
  const openingUpdates = sentMessages.filter(message => message?.type === 'analysis_update').length;
  await send({
    type: 'request_analysis',
    tabId: 7,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playerColor: 'w',
    multiPv: 3,
    hintLevel: 3
  });
  const openingUpdate = await waitForMessage('analysis_update', openingUpdates);
  assert.equal(openingUpdate.data.source, 'masters-explorer');
  assert.equal(openingUpdate.data.exactHintBlocked, null, 'a new game resets exact-hint cooldown state');
  assert.equal(remoteUrls.filter(url => url.includes('/master?')).length, 1);
  assert.equal(remoteUrls.filter(url => url.includes('/lichess?')).length, 0,
    'Masters success does not trigger unconditional opening enrichment');
  assert.equal(remoteUrls.filter(url => url.includes('cloud-eval') || url.includes('chess-api.com')).length, 0,
    'one successful opening source stops the fallback chain');

  console.log('background smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
