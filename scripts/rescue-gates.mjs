// Hint-quality rescue — acceptance gates (brief Chapter 6/7).
//
// Harness A per the brief: this loads EXACTLY the production module set —
// the same files `sidepanel/sidepanel.html` scripts and `background.js`
// importScripts — and drives the real `selectPVForStyle` / `generateHints`
// with realistic cloud pools (multi-PV, single-PV, mixed sources, and pools
// whose extras came from the local engine). It deliberately loads nothing
// the shipped runtime does not load; see the F5 guard at the bottom.
//
//   node scripts/rescue-gates.mjs        # prints the gate table, exits 1 on FAIL
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PRODUCTION_MODULES = [
  'core-utils.js', 'analysis-policy.js', 'human-form.js',
  'chaos-attack.js', 'early-king-hunt.js', 'attack-book.js', 'hint-engine.js'
];

const sandbox = {
  console, window: {}, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of PRODUCTION_MODULES) {
  vm.runInContext(readFileSync(join(ROOT, 'engine', file), 'utf8'), sandbox, { filename: file });
}
const E = sandbox.window.ChessHintEngine;
const Policy = sandbox.AnalysisPolicy;
const HF = sandbox.HumanForm;

const pv = (score, moves, scoreType = 'cp', depth = 25, extra = {}) =>
  ({ scoreType, score, depth, pv: moves, ...extra });

// ─── Probe set (brief 7.1, fixed) ────────────────────────────────────
const P1 = 'r1bq1rk1/ppp2ppp/2n2n2/4p3/8/3B1N2/PPP2PPP/R1BQ1RK1 w - - 0 1';   // 1 Greek gift, equal
const P2 = '7k/8/8/8/8/8/R7/1R5K w - - 0 1';                                    // 2 mate-in-2 vs material
const P3 = '5rk1/6p1/8/8/8/8/4RR2/6K1 w - - 0 1';                               // 3 won endgame, trade wins
const P5 = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'; // 4 Italian, O-O best
const P4 = 'r1bq1rk1/ppp2ppp/2n2n2/4p3/8/3B1N2/PPP2PPP/R1BQ1RK1 w - - 0 1';    // 5 desperate, unsound sac
const P6 = '6k1/5ppp/8/8/8/8/5PPP/R2Q2K1 w - - 0 1';                           // 6 up big, mate available
const P7 = 'r3k2r/ppp2ppp/2n5/3qp3/2B5/2N5/PPP2PPP/R2Q1RK1 w kq - 0 1';      // 7 up +250, no forced mate
const P8 = '8/8/4k3/8/8/4K3/4R3/4r3 w - - 0 1';                                 // 8 drawn rook ending
const P9 = '2r2rk1/pp1q1ppp/2n1pn2/3p4/3P4/2N1PN2/PPQ2PPP/R3KB1R w KQ - 0 1'; // 9 offbeat middlegame

export const PROBES = {
  greekGiftEqual: {
    id: 1, fen: P1, expect: { topCloud: 'd2d4' },
    pool: [
      pv(40, ['d2d4', 'e5d4']),
      pv(10, ['d3h7', 'g8h7', 'f3g5', 'h7g8', 'h2h4']),
      pv(20, ['b1c3', 'g7g6']),
      pv(5, ['h2h3', 'g7g6'])
    ]
  },
  mateVsMaterial: {
    id: 2, fen: P2, expect: { topCloud: 'b1b7', keepsClass: 'winning' },
    pool: [
      pv(2, ['b1b7', 'h8g8', 'a2a8'], 'mate'),
      pv(800, ['a2a7', 'h8g8']),
      pv(700, ['h2h4', 'h8g8'])
    ]
  },
  wonEndgameTrade: {
    id: 3, fen: P3, expect: { topCloud: 'f2f8', keepsClass: 'winning' },
    pool: [pv(950, ['f2f8', 'g8f8']), pv(900, ['e2e7', 'f8e8']), pv(880, ['g1f1', 'f8e8'])]
  },
  italianOpening: {
    id: 4, fen: P5, expect: { topCloud: 'e1g1', openingClass: ['e1g1', 'd2d3', 'b1c3'] },
    pool: [
      pv(30, ['e1g1', 'g8f8']), pv(28, ['d2d3', 'g8f8']), pv(8, ['h2h4', 'g8f8']),
      pv(-60, ['f3g5', 'g7g6']), pv(25, ['b1c3', 'g8f8'])
    ]
  },
  desperateUnsoundSac: {
    id: 5, fen: P4, expect: { topCloud: 'c2c3' },
    pool: [pv(-350, ['c2c3', 'g7g6']), pv(-1400, ['d3h7', 'g8h7', 'f3g5', 'h7g8'])]
  },
  upSixHundredMateInThree: {
    id: 6, fen: P6, expect: { topCloud: 'a1a8', keepsClass: 'winning' },
    pool: [
      pv(3, ['a1a8', 'g8h7', 'd1h5', 'h7g8', 'a8h8'], 'mate'),
      pv(620, ['d1d8', 'g8h7']),
      pv(600, ['a1a7', 'g8h7'])
    ]
  },
  upTwoFiftyNoMate: {
    id: 7, fen: P7, expect: { topCloud: 'c4d5', keepsClass: 'winning', maxEvalLoss: 100 },
    pool: [
      pv(300, ['c4d5', 'c6d5']),
      pv(270, ['d1d5', 'd8d5', 'c4d5']),
      pv(150, ['c3b5', 'e8g8']),
      pv(60, ['c4f7', 'e8f7'])
    ]
  },
  drawnRookEnding: {
    id: 8, fen: P8, expect: { topCloud: 'e2d2', keepsClass: 'equal' },
    pool: [pv(0, ['e2d2', 'e1d2', 'e3d2']), pv(-40, ['e3f3', 'e6f6']), pv(-250, ['e2e6', 'e6e6'])]
  },
  // 9 — single-line chess-api middlegames widened with local-engine extras.
  // The cloud line is authoritative; the extras are depth-4 heuristic noise
  // that happens to look attacking (F4).
  singlePvWidened: {
    id: 9, fen: P9, expect: { topCloud: 'f1d3' },
    pool: [
      pv(35, ['f1d3'], 'cp', 14),
      pv(10, ['h2h3'], 'cp', 4, { localPool: true }),
      pv(-20, ['c3b5'], 'cp', 4, { localPool: true }),
      pv(-55, ['f3g5'], 'cp', 5, { localPool: true }),
      pv(-90, ['d1d3'], 'cp', 6, { localPool: true })
    ]
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────
const pick = (out) => out?.[0]?.pv?.[0] || null;
const meta = (out) => out?.[0]?._styleAnalysis || {};
const WIN_CLASS_RANK = { losing: 0, worse: 1, equal: 2, advantage: 3, winning: 4 };
function winClass(score) {
  if (!Number.isFinite(score)) return 'equal';
  if (score > 200) return 'winning';
  if (score > 50) return 'advantage';
  if (score >= -50) return 'equal';
  if (score >= -200) return 'worse';
  return 'losing';
}
const topCloudScore = (probe, color = 'w') => {
  const best = probe.pool
    .filter(p => !p.localPool)
    .map(p => ({ p, s: color === 'w' ? p.score : -p.score, u: p.scoreType === 'mate' ? (p.score > 0 ? 1e6 - Math.abs(p.score) : -1e6 + Math.abs(p.score)) : (color === 'w' ? p.score : -p.score) }))
    .sort((a, b) => b.u - a.u)[0];
  return best ? best.s : 0;
};

const STYLES = ['normal', 'aggressive', 'super_ultra_aggressive'];
const results = [];
function record(gate, ok, detail) { results.push({ gate, ok, detail }); }

// ═══ G0 — default-hint fidelity ══════════════════════════════════════
// With factory defaults (style 'normal', sparring off) the primary pick must
// equal the top cloud PV. The one sanctioned exception is the bounded
// book-first preference (≤50cp), which cannot fire on these engine-only
// pools.
console.log('═══ G0 · default-hint fidelity (style = normal, factory defaults) ═══');
let g0Match = 0;
const g0Total = Object.values(PROBES).length;
for (const [name, probe] of Object.entries(PROBES)) {
  const out = E.selectPVForStyle(structuredClone(probe.pool), probe.fen, 'normal', 'w', false, {});
  const got = pick(out);
  const ok = got === probe.expect.topCloud;
  if (ok) g0Match++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(probe.id).padStart(2)}. ${name.padEnd(24)} top cloud ${probe.expect.topCloud} → picked ${got}` +
    `  (evalLoss=${meta(out).evalLoss ?? '?'})`);
}
const g0Rate = g0Match / g0Total;
record('G0 default-hint fidelity ≥ 95%', g0Rate >= 0.95,
  `${g0Match}/${g0Total} probe positions picked the top cloud PV (${(g0Rate * 100).toFixed(0)}%)`);

// G0 fallback safety is a static + unit assertion; re-check it here so the
// gate table is self-contained.
const source = readFileSync(join(ROOT, 'engine', 'hint-engine.js'), 'utf8');
const staleSites = (source.match(/PLAYING_STYLES\[style\] \|\| PLAYING_STYLES\.super_ultra_aggressive/g) || []).length;
record('G0 unknown style → normal (all sites)', staleSites === 0 &&
  ['normal', 'aggressive', 'super_ultra_aggressive'].every(s => E.resolveStyleProfile(s).id === s) &&
  [undefined, 'berserker', 'kamikaze', ''].every(s => E.resolveStyleProfile(s).id === 'normal'),
  `${staleSites} stale Ultra-fallback site(s) in hint-engine.js`);

// ═══ G1 — win preservation, Auto ceiling, opening sanity, sparring ═══
console.log('\n═══ G1 · win preservation across styles and dial levels ═══');
const winningProbes = ['mateVsMaterial', 'wonEndgameTrade', 'upSixHundredMateInThree', 'upTwoFiftyNoMate'];
let winKept = 0, winTotal = 0;
const dialLevels = ['auto', 1, 2, 3];
for (const style of STYLES) {
  for (const level of dialLevels) {
    for (const name of winningProbes) {
      const probe = PROBES[name];
      const before = topCloudScore(probe);
      const ctx = { aggressionLevel: level === 'auto' ? (Policy.suggestAggressionLevel(1500) || 2) : level };
      const out = E.selectPVForStyle(structuredClone(probe.pool), probe.fen, style, 'w', false, ctx);
      const loss = Number(meta(out).evalLoss ?? 0) || 0;
      const after = before - loss;
      const kept = winClass(after) === winClass(before) || (probe.expect.maxEvalLoss != null && loss <= probe.expect.maxEvalLoss);
      winTotal++;
      if (kept) winKept++;
      if (!kept) {
        console.log(`  FAIL ${style}/L${level} ${name}: ${before}cp → ${after}cp (loss ${loss}, class ${winClass(before)}→${winClass(after)})`);
      }
    }
  }
}
record('G1 winning probes keep the win class (100%)', winKept === winTotal,
  `${winKept}/${winTotal} style×dial×probe combinations kept the class`);

// Auto ceiling: never Level III, for ANY rating input.
const autoLevels = [];
for (let rating = 100; rating <= 4000; rating += 100) autoLevels.push(Policy.suggestAggressionLevel(rating));
autoLevels.push(Policy.suggestAggressionLevel(null), Policy.suggestAggressionLevel(undefined), Policy.suggestAggressionLevel('n/a'));
const distinct = [...new Set(autoLevels.filter(v => v !== null && v !== undefined))].sort();
record('G1 Auto never selects Level III', !distinct.includes(3),
  `Auto produces ${JSON.stringify(distinct)}; <1000→${Policy.suggestAggressionLevel(700)}, 1000–1400→${Policy.suggestAggressionLevel(1200)}, >1400→${Policy.suggestAggressionLevel(1800)}, unknown→null (panel falls back to II)`);

// Opening sanity at Level I (existing project gate, ≥80%).
let openOk = 0;
const OPEN_N = 8;
for (let n = 1; n <= OPEN_N; n++) {
  const fen = P5.replace(/ 4 4$/, ` ${n} ${n}`);
  const out = E.selectPVForStyle(structuredClone(PROBES.italianOpening.pool), fen, 'super_ultra_aggressive', 'w', false, { aggressionLevel: 1 });
  if (PROBES.italianOpening.expect.openingClass.includes(pick(out))) openOk++;
}
record('G1 opening sanity at Level I ≥ 80%', openOk / OPEN_N >= 0.8,
  `${openOk}/${OPEN_N} O-O/d3/Nc3-class picks in the Italian pool`);

// Sparring: differentiation in EQUAL positions (≥4×) and zero slips while
// clearly winning (bestScore > 250) at any strength.
function sparringSweep(probe, style, rating, positions, bestMove) {
  let slips = 0;
  for (let n = 1; n <= positions; n++) {
    const fen = probe.fen.replace(/ \d+ \d+$/, ` ${n} ${n}`);
    for (const seed of ['g1', 'g2', 'g3']) {
      const session = HF.createSession({ rating, seed });
      const out = E.selectPVForStyle(structuredClone(probe.pool), fen, style, 'w', true, { formSession: session });
      if (pick(out) !== bestMove) slips++;
    }
  }
  return slips;
}
const equalTotal = OPEN_N * 3;
const s600 = sparringSweep(PROBES.italianOpening, 'super_ultra_aggressive', 600, OPEN_N, 'e1g1');
const s1600 = sparringSweep(PROBES.italianOpening, 'super_ultra_aggressive', 1600, OPEN_N, 'e1g1');
const ratio = s1600 === 0 ? (s600 > 0 ? Infinity : 1) : s600 / s1600;
record('G1 sparring differentiation ≥ 4× in equal positions', ratio >= 4,
  `600 → ${s600}/${equalTotal} non-best, 1600 → ${s1600}/${equalTotal} (${s1600 === 0 ? '∞' : ratio.toFixed(1)}×)`);

let winSlips = 0, winSlipTotal = 0;
for (const rating of [600, 900, 1100, 1300, 1600]) {
  for (const style of STYLES) {
    for (const name of winningProbes) {
      const probe = PROBES[name];
      for (let n = 1; n <= 4; n++) {
        const fen = probe.fen.replace(/ \d+ \d+$/, ` ${n} ${n}`);
        const session = HF.createSession({ rating, seed: `win-${n}` });
        const out = E.selectPVForStyle(structuredClone(probe.pool), fen, style, 'w', true, { formSession: session });
        winSlipTotal++;
        if (pick(out) !== probe.expect.topCloud) winSlips++;
      }
    }
  }
}
record('G1 zero slips while winning (bestScore > 250)', winSlips === 0,
  `${winSlips}/${winSlipTotal} picks left the objective best in clearly won positions`);

// ═══ G2 — pool integrity ═════════════════════════════════════════════
console.log('\n═══ G2 · pool integrity (widened single-PV pools) ═══');
let widenOk = 0, widenTotal = 0;
for (const style of STYLES) {
  for (const level of [1, 2, 3]) {
    for (const probe of [PROBES.singlePvWidened, PROBES.greekGiftEqual]) {
      const pool = structuredClone(probe.pool).map((p, i) => (
        probe === PROBES.singlePvWidened ? p : (i === 0 ? p : { ...p, localPool: true })
      ));
      const out = E.selectPVForStyle(pool, probe.fen, style, 'w', false, { aggressionLevel: level });
      widenTotal++;
      if (pick(out) === probe.expect.topCloud) widenOk++;
      else console.log(`  FAIL ${style}/L${level} picked ${pick(out)} over cloud ${probe.expect.topCloud}`);
    }
  }
}
record('G2 widened pool: cloud line wins the primary slot (100%)', widenOk === widenTotal,
  `${widenOk}/${widenTotal} style×dial×pool combinations kept the cloud line`);

// F5 guard — the pool-replacing HumanEvaluator must stay out of the tree.
const humanEvalPresent = existsSync(join(ROOT, 'engine', 'human-evaluator.js'));
const references = PRODUCTION_MODULES
  .map(f => readFileSync(join(ROOT, 'engine', f), 'utf8'))
  .join('\n')
  .match(/HumanEvaluator|generateScoredCandidates|enrichWithCloudBonus/g) || [];
record('G2 HumanEvaluator quarantine (F5/F6)', !humanEvalPresent && references.length === 0,
  humanEvalPresent ? 'engine/human-evaluator.js is back in the tree' : `${references.length} pool-replacing reference(s) in the shipped modules`);

// ═══ Gate table ══════════════════════════════════════════════════════
console.log('\n═══ Gate table ═══');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.gate}\n         ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} gates passed.`);
process.exit(failed === 0 ? 0 : 1);
