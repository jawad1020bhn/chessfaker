'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sandbox = { console, Math, Date, Number, Boolean, String, Array, Object, Set, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['engine/core-utils.js', 'engine/analysis-contract.js', 'engine/analysis-policy.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const contract = sandbox.AnalysisContract;
const policy = sandbox.AnalysisPolicy;
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const legal = contract.generateLegalMoves(start);
assert.ok(legal.includes('e2e4'));
assert.ok(legal.includes('g1f3'));
assert.equal(legal.includes('e2e5'), false);
assert.equal(contract.isLegalMove(start, 'e2e4'), true);
assert.equal(contract.isLegalMove(start, 'e2e5'), false);

const afterE4 = contract.applyMoveToFen(start, 'e2e4');
assert.equal(afterE4, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');

const rejected = contract.finalizeAnalysis({
  source: 'chess-api',
  scorePerspective: 'white',
  pvs: [{ score: 30, scoreType: 'cp', depth: 18, pv: ['e2e5'] }]
}, start);
assert.equal(rejected.pvs.length, 0);
assert.equal(rejected.qualityClass, 'unavailable');

const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const flipped = contract.finalizeAnalysis({
  source: 'lichess-cloud',
  scorePerspective: 'side-to-move',
  depth: 30,
  pvs: [{ score: 120, scoreType: 'cp', depth: 30, pv: ['e7e5'] }]
}, blackFen);
assert.equal(flipped.pvs[0].score, -120);
assert.equal(flipped.scorePerspective, 'white');
assert.equal(flipped.bestMove, 'e7e5');

const unreliable = contract.finalizeAnalysis({
  source: 'chess-api',
  pvs: [{ score: 20, scoreType: 'cp', depth: 12, pv: ['e2e4'] }]
}, start, { positionReliable: false });
assert.equal(unreliable.exactHintBlocked.reason, 'unreliable_position');
assert.equal(unreliable.pvs.length, 0);

const migrated = policy.migrateLegacySettings({ depthTarget: 30, cloudDepth: 10, whiteRepertoire: 'x' });
assert.equal(migrated.analysisQuality, 'deep');
assert.equal(migrated.candidateLines, 5);
assert.equal(migrated.whiteRepertoire, undefined);
assert.equal(policy.resolveMultiPv({ candidateLines: 'auto', style: 'normal' }), 2,
  'the internal objective profile keeps a narrow auto width');
assert.equal(policy.resolveMultiPv({ candidateLines: 'auto', style: 'super_ultra_aggressive' }), 5,
  'the single persona always requests the wide ranking pool');
assert.equal(policy.resolveMultiPv({ candidateLines: 'auto', style: 'super_ultra_aggressive' }), 5);
assert.equal(policy.describeQuality('opening-statistics').label, 'Opening statistics');
assert.equal(policy.shouldReplaceHumanWithEngine({ source: 'masters-explorer' }, start), false);

const localLabel = policy.qualityClassFor({ source: 'local-engine', depth: 3 });
assert.equal(localLabel, 'shallow-engine');

// Opponent-aware Auto aggression (the dial's mapping).
// F2 — the Auto mapping is inverted: chaos pays only when the DEFENDER's
// mistakes convert the attack, so the wildest level must never be aimed at
// the weakest opposition. Auto must not return Level III for ANY input.
assert.equal(policy.suggestAggressionLevel(650), 1, 'below 1000 gets the sound "fastest win" discipline');
assert.equal(policy.suggestAggressionLevel(1200), 2, 'the club band keeps the signature level');
assert.equal(policy.suggestAggressionLevel(1400), 2, '1000–1400 is at most Level II');
assert.equal(policy.suggestAggressionLevel(1750), 1, 'strong opposition gets the sound discipline');
assert.equal(policy.suggestAggressionLevel(null), null, 'unknown ratings fall back outside the mapping');
assert.equal(policy.suggestAggressionLevel(undefined), null, 'a missing rating is unknown, not weak');
for (let rating = 100; rating <= 4000; rating += 50) {
  assert.notEqual(policy.suggestAggressionLevel(rating), 3,
    `Auto must never select Max Chaos (rating ${rating}) — Level III is an explicit user choice only`);
}

console.log('analysis-contract tests passed');
