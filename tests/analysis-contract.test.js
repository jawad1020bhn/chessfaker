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
  'the objective default keeps a narrow auto width');
assert.equal(policy.resolveMultiPv({ candidateLines: 'auto', style: 'super_ultra_aggressive' }), 5,
  'the persona requests the wide ranking pool');
assert.equal(policy.resolveMultiPv({ candidateLines: 'auto', style: 'aggressive' }), 5,
  'Aggressive ranks a candidate pool too');
assert.equal(policy.describeQuality('opening-statistics').label, 'Opening statistics');
assert.equal(policy.shouldReplaceHumanWithEngine({ source: 'masters-explorer' }, start), false);

const localLabel = policy.qualityClassFor({ source: 'local-engine', depth: 3 });
assert.equal(localLabel, 'shallow-engine');

// F4 — pool-widening tags must survive sealing, and the authoritative cloud
// line must keep the primary slot even when a local extra carries a higher
// (heuristic, meaningless) score.
const widenedSeal = contract.finalizeAnalysis({
  source: 'chess-api',
  scorePerspective: 'white',
  pvs: [
    { score: 40, scoreType: 'cp', depth: 14, pv: ['e2e4', 'e7e5'] },
    { score: 120, scoreType: 'cp', depth: 5, pv: ['g1f3', 'b8c6'], localPool: true },
    { score: 90, scoreType: 'cp', depth: 4, pv: ['b1c3', 'g8f6'], localPool: true }
  ]
}, start);
assert.equal(widenedSeal.pvs.length, 3, 'the widened pool survives sealing');
assert.equal(widenedSeal.pvs[0].pv[0], 'e2e4', 'the cloud line keeps the primary slot despite lower local scores');
assert.equal(widenedSeal.pvs[0].localPool, false, 'the cloud line is not tagged as a local extra');
// (compared as a joined string: the sealed arrays come from the vm realm, so
// deepStrictEqual would reject them on prototype identity alone)
assert.equal(widenedSeal.pvs.slice(1).map(p => p.pv[0]).join(','), 'g1f3,b1c3',
  'local extras sort below the cloud line, in their own utility order');
assert.ok(widenedSeal.pvs.slice(1).every(p => p.localPool === true),
  'the localPool tag survives sealing so the ranker can bench the extras');

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
