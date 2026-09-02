#!/usr/bin/env node
// Phase 0 — strength harness. Ground truth before any tuning.
//
// EDUCATIONAL USE ONLY — FAIR-PLAY SAFE
// Offline self-play and PGN replay against local opponent models only. It
// never observes, drives, or assists a live or rated game.
//
// Modes
//   --mode selfplay   persona vs. rating-banded opponent, W/D/L + donation +
//                     divergence per band and per style
//   --mode replay     replay the posted C41 loss and report, for every Black
//                     move, what the persona would have played
//   --mode fixtures   dump the attack vocabulary the persona reads in the
//                     regression positions (13. f4 especially)
//
// Usage
//   node scripts/strength-harness.mjs --mode fixtures
//   node scripts/strength-harness.mjs --mode replay
//   node scripts/strength-harness.mjs --mode selfplay --games 4 --bands 1200,1500
import { loadEngine } from './lib/engine-sandbox.mjs';
import { personaDecision } from './lib/persona.mjs';
import { START_FEN, bandFor, mulberry32, opponentMove, terminalState } from './lib/game-driver.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const MODE = arg('mode', 'fixtures');
const GAMES = Number(arg('games', 2));
const BANDS = String(arg('bands', '1200,1500,1800')).split(',').map(Number);
const STYLES = String(arg('styles', 'normal,super_ultra_aggressive')).split(',');
const MAX_PLIES = Number(arg('max-plies', 80));
const SEED = Number(arg('seed', 20260902));

const mods = loadEngine();
const { contract, core, engine, policy } = mods;

// ── The posted game (C41 Philidor, White 1524 vs Black 1490, 1-0) ──────────
const GAME_SAN = `e4 d6 Nf3 e5 Bc4 c6 a4 Bg4 d3 Qa5+ c3 Qc7 Be3 Bxf3 Qxf3 f6 Qh5+ g6
Qh4 Qe7 Nd2 c5 O-O Nc6 f4 g5 Qh5+ Kd8`
  .split(/\s+/)
  .filter(Boolean);

function sanToUci(san, fen) {
  const clean = san.replace(/[!?]+$/, '');
  for (const uci of contract.generateLegalMoves(fen)) {
    if (engine.uciToSan(uci, fen) === clean) return uci;
  }
  // Tolerate missing check/mate suffixes in hand-typed PGN text.
  for (const uci of contract.generateLegalMoves(fen)) {
    if (engine.uciToSan(uci, fen).replace(/[+#]/g, '') === clean.replace(/[+#]/g, '')) return uci;
  }
  return null;
}

function positionsFromSan(moves) {
  let fen = START_FEN;
  const out = [{ fen, ply: 0, move: null }];
  moves.forEach((san, index) => {
    const uci = sanToUci(san, fen);
    if (!uci) throw new Error(`Illegal SAN "${san}" at ply ${index + 1} (${fen})`);
    const next = contract.applyMoveToFen(fen, uci);
    if (!next) throw new Error(`Could not apply ${uci} to ${fen}`);
    fen = next;
    out.push({ fen, ply: index + 1, move: uci, san });
  });
  return out;
}

const fmt = (n, w = 6) => String(n).padStart(w);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

// ── fixtures ───────────────────────────────────────────────────────────────
// The regression positions the vocabulary rewrite is judged against.
function runFixtures() {
  const line = positionsFromSan(GAME_SAN);
  const f4Node = line.find((node) => node.san === 'f4' && node.ply > 20);
  const afterF4 = f4Node.fen; // 13. f4, Black to move
  console.log('▶ Regression fixture — position after 13. f4 (Black to move)');
  console.log(`   FEN: ${afterF4}\n`);

  const probes = ['e5f4', 'g6g5', 'h7h6', 'h7h5', 'f6f5', 'c6d4'];
  const legal = new Set(contract.generateLegalMoves(afterF4));
  console.log('   move    storm  penet  kingPr  overld  cplx   reasons');
  for (const uci of probes) {
    if (!legal.has(uci)) {
      console.log(`   ${uci}  (illegal here)`);
      continue;
    }
    const a = engine.analyzeCandidate(afterF4, [uci], 'b', 0, 'cp', 5, { style: 'super_ultra_aggressive' });
    const scored = { ...a, reasons: [], risks: [] };
    engine.candidateStyleBonus(scored, engine.PLAYING_STYLES.super_ultra_aggressive, {});
    console.log(
      `   ${engine.uciToSan(uci, afterF4).padEnd(6)} ${fmt(a.pawnStormDelta, 6)} ${fmt(a.penetrationDelta, 6)} ` +
        `${fmt(Number(a.kingPressureDelta).toFixed(1), 7)} ${fmt(a.overloadScore, 7)} ${fmt(Number(a.structuralComplexity).toFixed(1), 5)}   ` +
        scored.reasons.slice(0, 4).join(' | ')
    );
  }

  console.log('\n▶ Attack-lane candidates generated in the same position');
  const cands = mods.attackCandidates.rootCandidates({ fen: afterF4, playerColor: 'b', cloudMoves: [] });
  console.log(
    `   ${cands.length ? cands.map((c) => `${engine.uciToSan(c.uci, afterF4)}(${c.kind})`).join(', ') : '(none)'}`
  );

  console.log('\n▶ Persona decision in the same position');
  const decision = personaDecision(mods, afterF4, 'b', { style: 'super_ultra_aggressive' });
  if (decision) {
    console.log(
      `   plays ${engine.uciToSan(decision.uci, afterF4)}  (objective ${engine.uciToSan(decision.objectiveBest, afterF4)}, ` +
        `donation ${decision.donationCp}cp, diverged=${decision.diverged})`
    );
    console.log(`   reasons: ${decision.reasons.slice(0, 5).join(' | ') || '—'}`);
  }
}

// ── replay ─────────────────────────────────────────────────────────────────
function runReplay() {
  const line = positionsFromSan(GAME_SAN);
  console.log('▶ Replay — persona (Black) vs the moves actually played\n');
  console.log('   move  played   persona  objective  donation  diverged  plan');
  let donations = 0;
  let counted = 0;
  let diverged = 0;
  for (const node of line) {
    const toMove = node.fen.split(' ')[1];
    if (toMove !== 'b') continue;
    const decision = personaDecision(mods, node.fen, 'b', { style: 'super_ultra_aggressive' });
    if (!decision) continue;
    const actual = line[node.ply + 1];
    const number = Math.floor(node.ply / 2) + 1;
    donations += decision.donationCp;
    counted += 1;
    if (decision.diverged) diverged += 1;
    console.log(
      `   ${String(number).padStart(4)}. ${(actual ? actual.san : '—').padEnd(8)} ` +
        `${engine.uciToSan(decision.uci, node.fen).padEnd(8)} ` +
        `${engine.uciToSan(decision.objectiveBest, node.fen).padEnd(10)} ` +
        `${fmt(decision.donationCp, 8)}  ${String(decision.diverged).padEnd(8)} ${decision.plan || '—'}`
    );
  }
  console.log(
    `\n   mean donation ${(donations / Math.max(1, counted)).toFixed(1)}cp over ${counted} decisions, ` +
      `divergence ${pct(diverged, counted)}`
  );
}

// ── self-play ──────────────────────────────────────────────────────────────
function playGame(style, rating, personaIsWhite, rand) {
  const band = bandFor(rating);
  const seen = new Map();
  let fen = START_FEN;
  let plies = 0;
  let donation = 0;
  let decisions = 0;
  let diverged = 0;
  let activePlan = null;
  let outcome = { over: false };
  while (plies < MAX_PLIES) {
    const key = fen.split(' ').slice(0, 4).join(' ');
    seen.set(key, (seen.get(key) || 0) + 1);
    outcome = terminalState(mods, fen, seen);
    if (outcome.over) break;
    const toMove = fen.split(' ')[1];
    const personaTurn = (toMove === 'w') === personaIsWhite;
    let uci = null;
    if (personaTurn) {
      const decision = personaDecision(mods, fen, toMove, {
        style,
        aggressionLevel: policy.suggestAggressionLevel(rating) || undefined,
        activePlan
      });
      if (decision) {
        uci = decision.uci;
        donation += decision.donationCp;
        decisions += 1;
        if (decision.diverged) diverged += 1;
        activePlan = decision.plan;
      }
    } else {
      uci = opponentMove(mods, fen, toMove, band, rand);
    }
    if (!uci) uci = outcome.legal[0];
    const next = contract.applyMoveToFen(fen, uci);
    if (!next) break;
    fen = next;
    plies += 1;
  }
  if (!outcome.over) outcome = { over: true, result: '1/2-1/2', reason: 'ply cap' };
  const personaResult =
    outcome.result === '1/2-1/2' ? 'draw' : (outcome.result === '1-0') === personaIsWhite ? 'win' : 'loss';
  return { personaResult, donation, decisions, diverged, plies, reason: outcome.reason };
}

function runSelfPlay() {
  console.log(
    `▶ Self-play baseline — ${GAMES} game(s) per (style, band), max ${MAX_PLIES} plies, seed ${SEED}\n`
  );
  console.log('   style                    band    W   D   L   mean-donation  divergence  avg-plies');
  for (const style of STYLES) {
    for (const rating of BANDS) {
      const rand = mulberry32(SEED + rating + style.length);
      let w = 0;
      let d = 0;
      let l = 0;
      let donation = 0;
      let decisions = 0;
      let diverged = 0;
      let plies = 0;
      for (let i = 0; i < GAMES; i++) {
        const game = playGame(style, rating, i % 2 === 0, rand);
        if (game.personaResult === 'win') w++;
        else if (game.personaResult === 'draw') d++;
        else l++;
        donation += game.donation;
        decisions += game.decisions;
        diverged += game.diverged;
        plies += game.plies;
      }
      console.log(
        `   ${style.padEnd(24)} ${String(rating).padEnd(6)} ${fmt(w, 3)} ${fmt(d, 3)} ${fmt(l, 3)}   ` +
          `${fmt((donation / Math.max(1, decisions)).toFixed(1), 10)}cp  ` +
          `${pct(diverged, decisions).padStart(9)}  ${fmt(Math.round(plies / GAMES), 9)}`
      );
    }
  }
  console.log(
    '\n   Acceptance target (whole plan): Aggressive win rate >= Objective at 1500+,\n' +
      '   with measurable divergence only at <= 1300.'
  );
}

if (MODE === 'selfplay') runSelfPlay();
else if (MODE === 'replay') runReplay();
else if (MODE === 'fixtures') runFixtures();
else {
  console.error(`Unknown --mode ${MODE} (expected fixtures | replay | selfplay)`);
  process.exit(1);
}
if (flag('verbose')) console.log('\n(engine modules loaded from engine/*.js — production decision layer)');
