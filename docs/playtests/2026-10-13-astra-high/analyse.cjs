"use strict";
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WL = require('./engine-snapshot.cjs');
const session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json')));
const rounds = session.matches.flatMap(m => m.rounds);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const at = q * (sorted.length - 1), lower = Math.floor(at), upper = Math.ceil(at);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
};
const rounded = x => x === null ? null : Math.round(x * 1000) / 1000;
const apply = (g, type, more = {}) => WL.applyIntent(g, { type, ...more });
const metrics = rs => ({ n: rs.length, meanError: rounded(mean(rs.map(r => r.error))), medianError: rounded(quantile(rs.map(r => r.error), 0.5)), meanPoints: rounded(mean(rs.map(r => r.pts))), zeroRate: rounded(mean(rs.map(r => +(r.pts === 0)))), perfectRate: rounded(mean(rs.map(r => +(r.pts === 4)))), defensePointsPerTurn: rounded(mean(rs.map(r => r.oppPts))) });
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Deterministically replay every observed round through the original engine.
function validate() {
  const engine = fs.readFileSync(path.join(__dirname, 'engine-snapshot.cjs'));
  assert.equal(crypto.createHash('sha256').update(engine).digest('hex'), session.engineSha256, 'Engine changed since experiment began');
  let count = 0;
  const ownTurns = { A: 0, B: 0 };
  for (const match of session.matches) {
    const g = WL.createGame();
    apply(g, 'loadDeck', session.deck);
    const original = Math.random;
    Math.random = rng(match.seed);
    try {
      apply(g, 'setup', { first: match.first });
      for (const r of match.rounds) {
        assert.equal(g.round, r.round);
        assert.equal(g.active, r.team);
        assert.equal(r.psychic, r.team + (ownTurns[r.team]++ % 2 + 1));
        assert.deepEqual(Object.keys(r.defense).sort(), [WL.other(r.team) + '1', WL.other(r.team) + '2']);
        assert.notEqual(r.guesser, r.psychic);
        assert.equal(r.guesser[0], r.team);
        assert.deepEqual(g.cardChoices, r.candidates);
        apply(g, 'selectCard', { index: r.selection.index });
        assert.deepEqual(g.target, r.targetRaw);
        assert.deepEqual(WL.cardSides(g.card)[0], r.pair);
        apply(g, 'donePsychic');
        apply(g, 'setDial', { value: WL.fromSignedPercent(r.dial.dial) });
        apply(g, 'lock', { timerSeconds: 0 });
        apply(g, 'guess', { guess: r.opponentSide });
        apply(g, 'reveal');
        assert.equal(g.reveal.pts, r.pts);
        assert.equal(g.reveal.oppPts, r.oppPts);
        assert.equal(g.teams.A.score, r.scoreAfter.A);
        assert.equal(g.teams.B.score, r.scoreAfter.B);
        assert.equal(g.catchup, r.catchup);
        assert.deepEqual(g.result, r.resultAfter);
        assert.deepEqual(g.sdPts, r.suddenPointsAfter);
        count++;
        if (g.phase !== 'over') apply(g, 'nextRound');
      }
      if (match.result) assert.equal(g.phase, 'over');
    } finally { Math.random = original; }
  }
  if (session.stage === 'complete') {
    assert.equal(session.matches.length, 5);
    for (const m of session.matches) assert.deepEqual(Object.keys(m.feedback).sort(), ['A1', 'A2', 'B1', 'B2']);
    assert.equal(session.actions.length, count * 5 + 20);
  }
  return count;
}

// Rescore identical observations only. These are NOT additional played games.
function rescore(r, width) {
  const rawError = Math.abs(r.targetRaw.center - WL.fromSignedPercent(r.dial.dial));
  const w4 = width * 0.4, w3 = w4 + width, w2 = w3 + width * 1.1;
  const pts = rawError <= w4 ? 4 : rawError <= w3 ? 3 : rawError <= w2 ? 2 : 0;
  const correct = r.target < r.dial.dial ? 'L' : 'R';
  return { pts, oppPts: pts < 4 && r.target !== r.dial.dial && r.opponentSide === correct ? 1 : 0 };
}
function monteCarlo(policy, samples, trials, seed) {
  const random = rng(seed);
  const totals = { meanTurns: 0, firstWins: 0, ties: 0, capHits: 0, overtime: 0, unequalTurns: 0, fewerThanTwoOwnTurns: 0 };
  const lengths = [];
  for (let sim = 0; sim < trials; sim++) {
    const scores = [0, policy.paired ? 0 : 1], turns = [0, 0];
    let active = 0, n = 0, ot = false, sd = [0, 0], sdTurns = 0, winner = null, ended = false;
    while (!ended && n < 200) {
      const sample = samples[Math.floor(random() * samples.length)];
      const { pts, oppPts } = rescore(sample, policy.width);
      n++; turns[active]++;
      if (ot) {
        sd[active] += pts; sd[1 - active] += oppPts; sdTurns++;
        if (sdTurns === 2) {
          if (sd[0] !== sd[1]) { winner = sd[0] > sd[1] ? 0 : 1; ended = true; }
          else if (policy.boundedOvertime) { ended = true; }
          else { sd = [0, 0]; sdTurns = 0; }
        }
        active = 1 - active;
        continue;
      }
      scores[active] += pts; scores[1 - active] += oppPts;
      const boundary = !policy.paired || n % 2 === 0;
      const reached = policy.target > 0 && Math.max(...scores) >= policy.target && n >= (policy.minTurns || 0);
      const cap = n >= policy.cap;
      if (boundary && (reached || cap)) {
        if (cap) totals.capHits++;
        if (scores[0] !== scores[1]) { winner = scores[0] > scores[1] ? 0 : 1; ended = true; }
        else { ot = true; totals.overtime++; }
      }
      const catchup = !policy.paired && !ot && pts === 4 && scores[active] < scores[1 - active];
      if (!catchup) active = 1 - active;
    }
    assert(ended, 'Simulation exceeded overtime safety limit');
    lengths.push(n);
    totals.meanTurns += n;
    totals.firstWins += +(winner === 0);
    totals.ties += +(winner === null);
    totals.unequalTurns += +(turns[0] !== turns[1]);
    totals.fewerThanTwoOwnTurns += +(Math.min(...turns) < 2);
  }
  return { ...policy, trials, meanTurns: rounded(totals.meanTurns / trials), p90Turns: quantile(lengths, 0.9), maxObservedTurns: Math.max(...lengths), firstWinRate: rounded(totals.firstWins / trials), firstWinAmongDecided: rounded(totals.firstWins / (trials - totals.ties)), drawRate: rounded(totals.ties / trials), overtimeRate: rounded(totals.overtime / trials), capRate: rounded(totals.capHits / trials), unequalTurnsRate: rounded(totals.unequalTurns / trials), incompleteRoleCycleRate: rounded(totals.fewerThanTwoOwnTurns / trials) };
}

const replayedRounds = validate();
const report = {
  generatedAt: new Date().toISOString(), complete: session.stage === 'complete', replayedRounds,
  observed: {
    matches: session.matches.map(m => ({ game: m.game, first: m.first, winner: m.result?.winner, score: m.score, overtimeTurns: m.rounds.filter(r => r.sudden).length, winningOvertimePoints: m.result?.sudden ? m.rounds.at(-1).suddenPointsAfter : null, turns: m.rounds.length, turnsA: m.rounds.filter(r => r.team === 'A').length, turnsB: m.rounds.filter(r => r.team === 'B').length, ...metrics(m.rounds) })),
    overall: metrics(rounds),
    teams: Object.fromEntries(['A', 'B'].map(t => [t, metrics(rounds.filter(r => r.team === t))])),
    psychics: Object.fromEntries(['A1', 'A2', 'B1', 'B2'].map(p => [p, metrics(rounds.filter(r => r.psychic === p))])),
    half: { games1and2: metrics(rounds.filter(r => r.game <= 2)), games4and5: metrics(rounds.filter(r => r.game >= 4)) },
    targetRegions: { center: metrics(rounds.filter(r => Math.abs(r.target) <= 20)), middle: metrics(rounds.filter(r => Math.abs(r.target) > 20 && Math.abs(r.target) < 70)), ends: metrics(rounds.filter(r => Math.abs(r.target) >= 70)) },
    catchups: rounds.filter(r => r.catchup).length, overtimeTurns: rounds.filter(r => r.sudden).length,
    opinionDisagreements: rounds.filter(r => new Set(Object.values(r.defense).map(d => d.side)).size > 1).length,
    nearMisses: rounds.filter(r => r.pts === 0 && r.error <= 25).map(r => ({ game: r.game, round: r.round, error: r.error, clue: r.clue.clue })),
    feedback: session.matches.map(m => ({ game: m.game, players: m.feedback }))
  },
  rescoredWidths: [40, 44, 48, 50, 55, 60].map(width => ({ width, meanPoints: rounded(mean(rounds.map(r => rescore(r, width).pts))), zeroRate: rounded(mean(rounds.map(r => +(rescore(r, width).pts === 0)))), perfectRate: rounded(mean(rounds.map(r => +(rescore(r, width).pts === 4)))) })),
  simulationAssumptions: 'Empirical joint resampling of observed target/dial/defense triples; identical skill distribution for both teams, no learning or score-state adaptation, no target-distribution difference by turn; simulated trials are not independent real players or new played games. Alternate widths preserve observed actions. Paired policies use 0:0, no catchup, complete both turns before checking victory; bounded overtime permits a draw after one extra pair.'
};
if (rounds.length && session.stage === 'complete') {
  const policies = [
    { name: '现行10分/10轮', target: 10, cap: 10, width: 40, paired: false },
    { name: '仅降至8分', target: 8, cap: 10, width: 40, paired: false },
    { name: '仅加宽至50', target: 10, cap: 10, width: 50, paired: false },
    { name: '对称6轮/8分/原宽', target: 8, cap: 6, minTurns: 4, width: 40, paired: true, boundedOvertime: true },
    { name: '对称6轮/8分/宽50', target: 8, cap: 6, minTurns: 4, width: 50, paired: true, boundedOvertime: true },
    { name: '对称6轮/6分/宽50', target: 6, cap: 6, minTurns: 4, width: 50, paired: true, boundedOvertime: true },
    { name: '固定6轮/宽50', target: 0, cap: 6, width: 50, paired: true, boundedOvertime: true },
    { name: '固定8轮/宽50', target: 0, cap: 8, width: 50, paired: true, boundedOvertime: true },
    { name: '固定4轮/宽50', target: 0, cap: 4, width: 50, paired: true, boundedOvertime: true },
    { name: '对称6轮/6分/宽48', target: 6, cap: 6, minTurns: 4, width: 48, paired: true, boundedOvertime: true },
    { name: '对称6轮/8分/宽48', target: 8, cap: 6, minTurns: 4, width: 48, paired: true, boundedOvertime: true },
    { name: '对称8轮/8分/宽48', target: 8, cap: 8, minTurns: 4, width: 48, paired: true, boundedOvertime: true },
    { name: '固定8轮/宽48', target: 0, cap: 8, width: 48, paired: true, boundedOvertime: true }
  ];
  report.simulations = policies.map(p => monteCarlo(p, rounds, 50000, 731913));
  const sensitivityPolicies = policies.filter(p => ['现行10分/10轮', '对称6轮/8分/宽48', '对称6轮/6分/宽48'].includes(p.name));
  report.sensitivity = ['A', 'B'].map(team => ({ sourceTeam: team, n: rounds.filter(r => r.team === team).length, policies: sensitivityPolicies.map(p => monteCarlo(p, rounds.filter(r => r.team === team), 20000, 963713)) }));
}
fs.writeFileSync(path.join(__dirname, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
const csv = [['game','round','team','psychic','guesser','left','right','clue','target_signed','dial_signed','absolute_error','points','opponent_side','opponent_points','score_A','score_B','catchup','overtime']];
for (const r of rounds) csv.push([r.game,r.round,r.team,r.psychic,r.guesser,...r.pair,r.clue.clue,r.target,r.dial.dial,r.error,r.pts,r.opponentSide,r.oppPts,r.scoreAfter.A,r.scoreAfter.B,r.catchup,r.sudden]);
fs.writeFileSync(path.join(__dirname, 'rounds.csv'), '\uFEFF' + csv.map(row => row.map(x => '"' + String(x).replaceAll('"','""') + '"').join(',')).join('\n') + '\n');
console.log(JSON.stringify({ replayedRounds, complete: report.complete, observed: report.observed.overall, matches: report.observed.matches, rescoredWidths: report.rescoredWidths, simulations: report.simulations, sensitivity: report.sensitivity }, null, 2));
