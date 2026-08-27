// Efficacy probe: drives the REAL selectPVForStyle decision layer with
// simulated cloud multi-PV sets on python-chess-verified positions.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const sandbox = { console, window: {}, setTimeout, clearTimeout, setInterval, clearInterval, performance: { now: () => Date.now() } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['core-utils.js', 'analysis-policy.js', 'human-form.js', 'chaos-attack.js', 'early-king-hunt.js', 'hint-engine.js']) {
  vm.runInContext(readFileSync(join(ROOT, 'engine', f), 'utf8'), sandbox, { filename: f });
}
const E = sandbox.window.ChessHintEngine;
const HF = sandbox.HumanForm;

const P1 = 'r1bq1rk1/ppp2ppp/2n2n2/4p3/8/3B1N2/PPP2PPP/R1BQ1RK1 w - - 0 1';   // Greek gift available
const P2 = '7k/8/8/8/8/8/R7/1R5K w - - 0 1';                                    // RR ladder, #2
const P3 = '5rk1/6p1/8/8/8/8/4RR2/6K1 w - - 0 1';                               // RR vs R, trade wins
const P5 = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'; // Italian, O-O best
const P4 = 'r1bq1rk1/ppp2ppp/2n2n2/4p3/8/3B1N2/PPP2PPP/R1BQ1RK1 w - - 0 1';    // same shape, desperate evals

const pv = (score, moves, scoreType = 'cp', depth = 25) => ({ scoreType, score, depth, pv: moves });

const SCENARIOS = {
  'P1 Greek-gift-equal (best +40, sac +10, dev +20, passive +5)': {
    fen: P1,
    pool: [
      pv(40, ['d2d4', 'e5d4']),        // central best
      pv(10, ['d3h7', 'g8h7', 'f3g5', 'h7g8', 'h2h4']), // Bxh7+ sac
      pv(20, ['b1c3', 'g7g6']),                 // develop
      pv(5, ['h2h3', 'g7g6'])                   // passive
    ]
  },
  'P2 MateIn2 vs material (best #2, alt +800, +700)': {
    fen: P2,
    pool: [
      pv(2, ['b1b7', 'h8g8', 'a2a8'], 'mate'),
      pv(800, ['a2a7', 'h8g8']),
      pv(700, ['h2h4', 'h8g8'])
    ]
  },
  'P3 WinningEndgame (trade +950, press +900, quiet +880)': {
    fen: P3,
    pool: [
      pv(950, ['f2f8', 'g8f8']),               // simplifying trade into trivial win
      pv(900, ['e2e7', 'f8e8']),               // keep pieces, press
      pv(880, ['g1f1', 'f8e8'])
    ]
  },
  'P5 Opening-dev (O-O +30, d3 +28, h4 +8, Ng5 -60, Nc3 +25)': {
    fen: P5,
    pool: [
      pv(30, ['e1g1', 'g8f8']),
      pv(28, ['d2d3', 'g8f8']),
      pv(8, ['h2h4', 'g8f8']),
      pv(-60, ['f3g5', 'g7g6']),
      pv(25, ['b1c3', 'g8f8'])
    ]
  },
  'P4 Desperate (best -350 defense, wild sac -1400)': {
    fen: P4,
    pool: [
      pv(-350, ['c2c3', 'g7g6']),              // hunker down
      pv(-1400, ['d3h7', 'g8h7', 'f3g5', 'h7g8']) // unsound sac, 1050cp loss
    ]
  }
};

const fmtPick = (out) => {
  const top = out[0]?._styleAnalysis;
  return `${(out[0]?.pv || ['-'])[0]}  (evalLoss=${top?.evalLoss ?? '?'}, bonus=${top?.styleBonus ?? 0}, eligible=${out.filter(p => p._styleAnalysis?.eligible).length}/${out.length})`;
};
const reasons = (out) => (out[0]?._styleAnalysis?.reasons || []).slice(0, 3).join(' | ') || '—';

// Single-persona product: the internal objective anchor plus the Ultra persona.
const STYLES = ['normal', 'super_ultra_aggressive'];
console.log('═══ A. Style differentiation (human mode OFF) ═══');
for (const [name, { fen, pool }] of Object.entries(SCENARIOS)) {
  console.log(`\n▶ ${name}   [${fen.split(' ')[0]}]`);
  for (const style of STYLES) {
    const out = E.selectPVForStyle(structuredClone(pool), fen, style, 'w', false, {});
    console.log(`  ${(style === 'super_ultra_aggressive' ? 'ultra ' : (style + "        ").slice(0,8))} → ${fmtPick(out)}   reasons: ${reasons(out)}`);
  }
}

console.log('\n═══ B. Single-PV source (chess-api style): does the style do anything? ═══');
for (const style of STYLES) {
  const out = E.selectPVForStyle([pv(30, ['e1g1'])], P5, style, 'w', false, {});
  console.log(`  ${style.padEnd(24)} → pick ${out[0].pv[0]}  raw-return(no _styleAnalysis)=${out[0]._styleAnalysis === undefined}`);
}

console.log('\n═══ C. Human-like mode: strength sweep (rating 600 vs 1100 vs 1600) ═══');
for (const [name, { fen, pool }] of Object.entries(Object.fromEntries(Object.entries(SCENARIOS).slice(0, 2).concat([Object.entries(SCENARIOS)[3]])))) {
  console.log(`\n▶ ${name}`);
  for (const style of STYLES) {
    for (const rating of [600, 1100, 1600]) {
      const session = HF.createSession({ rating, seed: 'game-1' });
      const out = E.selectPVForStyle(structuredClone(pool), fen, style, 'w', true, { formSession: session });
      console.log(`  ${style.replace('super_ultra_aggressive', 'ultra').padEnd(10)} @${rating} → ${fmtPick(out)}  humanScore=${out[0]._styleAnalysis.humanScore}`);
    }
  }
}

console.log('\n═══ D. Slip-rate & strength calibration (opening window, 8 positions × 3 sessions) ═══');
const bestMove = 'e1g1';
const P5_POOL = SCENARIOS['P5 Opening-dev (O-O +30, d3 +28, h4 +8, Ng5 -60, Nc3 +25)'].pool;
const lossMap = { e1g1: 0, d2d3: 2, h2h4: 22, f3g5: 90, b1c3: 5 };
const slipStats = {};
for (const rating of [600, 1100, 1600]) {
  let slips = 0, totalLoss = 0, ng5 = 0; const picks = {};
  for (let n = 1; n <= 8; n++) {
    const fen = P5.replace(/ 4 4$/, ` ${n} ${n}`);
    for (let seed = 1; seed <= 3; seed++) {
      const session = HF.createSession({ rating, seed: `game-${seed}` });
      const out = E.selectPVForStyle(structuredClone(P5_POOL), fen, 'super_ultra_aggressive', 'w', true, { formSession: session });
      const pick = out[0].pv[0];
      picks[pick] = (picks[pick] || 0) + 1;
      if (pick !== bestMove) slips++;
      if (pick === 'f3g5') ng5++;
      totalLoss += lossMap[pick] ?? 0;
    }
  }
  slipStats[rating] = slips;
  console.log(`  ultra @${rating}: non-best ${slips}/24, avg cost ${(totalLoss / 24).toFixed(1)}cp, Ng5?! picks ${ng5}, picks=${JSON.stringify(picks)}`);
}
const ratio = slipStats[1600] === 0 ? (slipStats[600] > 0 ? '∞' : '0/0') : (slipStats[600] / slipStats[1600]).toFixed(1);
console.log(`  → 600-vs-1600 non-best ratio: ${ratio}x (gate: ≥ 4x would need opportunities; here every pick must stay sound-class)`);

console.log('\n═══ F. Acceptance gates ═══');
const openingOut = E.selectPVForStyle(structuredClone(P5_POOL), P5, 'super_ultra_aggressive', 'w', false, {});
const openingPick = openingOut[0].pv[0];
console.log(`  [${['e1g1','d2d3','b1c3'].includes(openingPick) ? 'PASS' : 'FAIL'}] opening sanity: ultra picks ${openingPick} (O-O/d3/Nc3 class, was Ng5?!)`);
const desperateOut = E.selectPVForStyle(structuredClone(SCENARIOS['P4 Desperate (best -350 defense, wild sac -1400)'].pool), P4, 'super_ultra_aggressive', 'w', false, {});
console.log(`  [${desperateOut[0].pv[0] === 'c2c3' ? 'PASS' : 'FAIL'}] desperate veto: ultra picks ${desperateOut[0].pv[0]} (was a -1050cp unsound sac)`);
const greekOut = E.selectPVForStyle(structuredClone(SCENARIOS['P1 Greek-gift-equal (best +40, sac +10, dev +20, passive +5)'].pool), P1, 'super_ultra_aggressive', 'w', false, {});
console.log(`  [${greekOut[0].pv[0] === 'd3h7' ? 'PASS' : 'FAIL'}] persona preserved: equal-position Greek gift still chosen (${greekOut[0].pv[0]}, -30cp in-character)`);
const mateOut = E.selectPVForStyle(structuredClone(SCENARIOS['P2 MateIn2 vs material (best #2, alt +800, +700)'].pool), P2, 'super_ultra_aggressive', 'w', false, {});
console.log(`  [${mateOut[0].pv[0] === 'b1b7' ? 'PASS' : 'FAIL'}] mate preservation: fastest mate kept (${mateOut[0].pv[0]})`);
console.log(`  [${slipStats[600] >= 4 * Math.max(1, slipStats[1600]) ? 'PASS' : 'CHECK'}] strength slider differentiation: 600=${slipStats[600]} vs 1600=${slipStats[1600]} non-best`);

console.log('\n═══ E. Early King Hunt add-on (ultra + EKH on) ═══');
for (const [name, { fen, pool }] of Object.entries(Object.fromEntries([Object.entries(SCENARIOS)[0], Object.entries(SCENARIOS)[3]]))) {
  const off = E.selectPVForStyle(structuredClone(pool), fen, 'super_ultra_aggressive', 'w', false, {});
  const on = E.selectPVForStyle(structuredClone(pool), fen, 'super_ultra_aggressive', 'w', false, { earlyKingHuntEnabled: true });
  console.log(`  ${name.split(' (')[0]}: EKH-off → ${off[0].pv[0]}   EKH-on → ${on[0].pv[0]} ${off[0].pv[0] === on[0].pv[0] ? '(same)' : '(CHANGED)'}`);
}
