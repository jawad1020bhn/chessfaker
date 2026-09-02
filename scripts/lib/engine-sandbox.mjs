// Shared loader: boots the shipped engine modules inside one Node vm context.
//
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// Offline analysis only. Nothing here observes, drives, or assists a live game.
//
// The extension modules are browser-shaped IIFEs that attach themselves to the
// global object (and hint-engine to `window`). Loading them in a vm context is
// how tests/style-efficacy-probe already do it; this module centralises the
// order and the exported handles so harnesses stay consistent with production.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

// Dependency order matters: contract needs core, local-engine needs contract,
// hint-engine delegates to chaos-attack / early-king-hunt.
const MODULES = [
  'core-utils.js',
  'analysis-contract.js',
  'analysis-policy.js',
  'attack-candidates.js',
  'local-engine.js',
  'chaos-attack.js',
  'early-king-hunt.js',
  'hint-engine.js'
];

export function loadEngine() {
  const sandbox = {
    console,
    window: {},
    chrome: { runtime: { getURL: (value) => value } },
    fetch: () => Promise.reject(new Error('offline harness')),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => Date.now() },
    Math,
    Promise,
    Date
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of MODULES) {
    vm.runInContext(readFileSync(join(ROOT, 'engine', file), 'utf8'), sandbox, { filename: file });
  }
  return {
    sandbox,
    core: sandbox.ChessCore,
    contract: sandbox.AnalysisContract,
    policy: sandbox.AnalysisPolicy,
    attackCandidates: sandbox.AttackCandidates,
    local: sandbox.LocalEngine,
    engine: sandbox.window.ChessHintEngine
  };
}
