"use strict";

const assert = require("node:assert/strict");
const WL = require("../game.js");
const replay = require("./fixtures/balanced-replay.json");
const apply = (g, type, extra = {}) => WL.applyIntent(g, { type, ...extra });
const scores = g => [g.teams.A.score, g.teams.B.score];

// Voiding after reveal must restore rule state, including a just-decided final
// and overtime counters, not merely subtract the displayed points.
for (const ruleSet of ['original', 'balanced']) for (const cardMode of ['single', 'choice']) {
  const g = WL.createGame();
  apply(g, 'setup', { ruleSet, cardMode, winScore: 0 });
  const fields = ['teams', 'active', 'catchup', 'sudden', 'sdPts', 'sdTurns', 'result', 'log', 'redrawUsed'];
  const checkpoint = () => JSON.parse(JSON.stringify(Object.fromEntries(fields.map(k => [k, g[k]]))));
  const play = points => {
    if (g.phase === 'readyCards') apply(g, 'revealCards');
    if (g.phase === 'chooseCard') apply(g, 'selectCard', { index: 0 });
    g.target.center = 500;
    apply(g, 'donePsychic');
    apply(g, 'setDial', { value: points ? 500 : 1000 });
    apply(g, 'lock', { timerSeconds: 0 });
    apply(g, 'startGuess');
    apply(g, 'guess', { guess: 'R' });
    apply(g, 'reveal');
  };
  for (let turn = 0; turn < 14 && g.phase !== 'over'; turn++) {
    const before = checkpoint(), round = g.round;
    if (cardMode === 'choice' && !g.redrawUsed[g.active]) {
      apply(g, 'revealCards');
      apply(g, 'redrawCards');
    }
    play(0); const previous = g.card;
    apply(g, 'voidRound');
    assert.deepEqual(checkpoint(), before, 'void restores all scoring, overtime, redraw and history state');
    assert.equal(g.round, round);
    assert.equal(g.phase, cardMode === 'choice' ? 'readyCards' : 'psychic');
    assert(!JSON.stringify(g).includes('checkpoint'), 'private rollback state is never serialized');
    if (cardMode === 'single') assert.notDeepEqual(g.card, previous, 'a sufficient deck avoids the voided topic');
    if (g.sudden) {
      play(4);
      apply(g, 'voidRound'); assert.deepEqual(checkpoint(), before, 'also undo a winning overtime score');
    }
    play(0);
    if (g.phase === 'revealed') apply(g, 'nextRound');
  }
}

{
  const g = WL.createGame();
  apply(g, 'setup', { ruleSet: 'original', cardMode: 'single', winScore: 1 });
  const initial = JSON.parse(JSON.stringify(g.teams));
  g.target.center = 500;
  apply(g, 'donePsychic');
  apply(g, 'lock', { timerSeconds: 0 });
  apply(g, 'startGuess');
  apply(g, 'guess', { guess: 'L' });
  apply(g, 'reveal'); assert.equal(g.phase, 'over');
  apply(g, 'voidRound'); assert.equal(g.phase, 'psychic'); assert.equal(g.result, null);
  assert.deepEqual(g.teams, initial); assert.deepEqual(g.log, []);
}

function game(ruleSet = "balanced", first = "A", winScore) {
  const g = WL.createGame();
  apply(g, "setup", { ruleSet, first, winScore });
  return g;
}
function turn(g, points, defense = 0) {
  if (g.phase === "readyCards") apply(g, "revealCards");
  if (g.phase === "chooseCard") apply(g, "selectCard", { index: 0 });
  assert.equal(g.phase, "psychic");
  if (g.ruleSet === "balanced") assert.equal(g.target.dist, "recommended");
  g.target.center = 500;
  apply(g, "donePsychic");
  apply(g, "setDial", { value: 500 + ({ 4: 0, 3: 30, 2: 90, 0: 150 }[points]) });
  apply(g, "lock", { timerSeconds: 0 });
  apply(g, "startGuess");
  apply(g, "guess", { guess: defense ? "L" : "R" });
  apply(g, "reveal");
  assert.equal(g.reveal.pts, points);
  assert.equal(g.reveal.oppPts, defense);
  assert.equal(g.log[0].guess, defense ? "L" : "R", "history preserves the actual guess, including wrong and perfect-hit turns");
  if (g.ruleSet === "balanced") assert.equal(g.catchup, false);
}
function rounds(g, points) {
  points.forEach((p, i) => {
    turn(g, ...(Array.isArray(p) ? p : [p]));
    if (i < points.length - 1) {
      assert.equal(g.phase, "revealed", "both teams must get their scheduled turns");
      apply(g, "nextRound");
    }
  });
}

const preset = WL.createGame();
assert.equal(preset.ruleSet, "balanced");
assert.deepEqual([preset.winScore, preset.bandWidth, ...scores(preset)], [8, 48, 0, 0], "new games default to the full balanced preset");
apply(preset, "setRuleSet", { value: "original" });
assert.deepEqual(scores(preset), [0, 1]);
apply(preset, "setWinScore", { value: 17 });
apply(preset, "setBandWidth", { value: 30 });
apply(preset, "setRuleSet", { value: "original" });
assert.equal(preset.winScore, 17, "reselecting original preserves custom settings");
for (const value of ["invalid", "__proto__", "constructor", null]) {
  apply(preset, "setRuleSet", { value });
  assert.equal(preset.ruleSet, "original");
}
apply(preset, "setRuleSet", { value: "balanced" });
assert.deepEqual([preset.winScore, preset.bandWidth, ...scores(preset)], [8, 48, 0, 0]);
apply(preset, "setWinScore", { value: 9 });
apply(preset, "setBandWidth", { value: 200 });
apply(preset, "setRuleSet", { value: "balanced" });
assert.deepEqual([preset.winScore, preset.bandWidth], [9, 48], "balanced threshold is adjustable while width stays fixed");
apply(preset, "setCardMode", { value: "single" });
apply(preset, "setOrdered", { value: true });
apply(preset, "loadDeck", { cards: [["左", "右"]], name: "保留题库" });
apply(preset, "setup", { first: "B", teamA: "甲", teamB: "乙" });
assert.equal(preset.phase, "psychic");
assert.equal(preset.winScore, 9, "setup preserves the chosen threshold");
assert.deepEqual(scores(preset), [0, 0]);
apply(preset, "setRuleSet", { value: "original" });
assert.equal(preset.ruleSet, "balanced", "cannot switch rules during a game");
apply(preset, "newGame");
assert.deepEqual([preset.ruleSet, preset.winScore, preset.bandWidth, ...scores(preset)], ["balanced", 9, 48, 0, 0]);
assert.deepEqual([preset.cardMode, preset.ordered, preset.deckName, preset.teams.A.name], ["single", true, "保留题库", "甲"]);
apply(preset, "setRuleSet", { value: "original" });
assert.deepEqual([preset.winScore, preset.bandWidth, ...scores(preset)], [10, 40, 1, 0]);

for (const first of ["A", "B"]) {
  const second = WL.other(first);
  const nine = game("balanced", first, 9);
  rounds(nine, [4, 0, 4]);
  assert.equal(nine.phase, "revealed", "custom 9 keeps playing at 8:0 after turn three");
  apply(nine, "nextRound");
  turn(nine, 2, 1);
  assert.equal(nine.result.winner, first, "custom 9 decides the completed pair at 9:2");
  assert.equal(nine.round, 4);
  for (const limit of [0, 20]) {
    const capped = game("balanced", first, limit);
    rounds(capped, [3, 3, 3, 3, 2, 3]);
    assert.equal(capped.round, 6, "custom thresholds keep the six-round cap");
    assert.equal(capped.result.winner, second);
  }
  let g = game("balanced", first);
  assert.deepEqual(scores(g), [0, 0]);
  rounds(g, [4, 0, 4]);
  assert.equal(g.teams[first].score, 8);
  assert.deepEqual(g.result, { winner: first, early: true }, "8:0 on turn 3 is already decided");
  apply(g, "nextRound");
  assert.equal(g.round, 3, "an early finish cannot start another round");

  g = game("balanced", first);
  rounds(g, [4, 3, 4]);
  assert.deepEqual(g.result, { winner: first, early: true }, "8:3 cannot be tied with one four-point turn");

  g = game("balanced", first);
  rounds(g, [4, 4, 4]);
  assert.equal(g.phase, "revealed", "8:4 must preserve the opponent's chance to tie");
  apply(g, "nextRound");
  turn(g, 0);
  assert.equal(g.round, 4);
  assert.equal(g.result.winner, first);

  g = game("balanced", first);
  rounds(g, [3, 4, 3, 4]);
  assert.equal(g.result.winner, second, "second team can win on the same turn boundary");
  assert.equal(g.round, 4);

  g = game("balanced", first);
  rounds(g, [2, 0, 0, 0, 0, 0]);
  assert.equal(g.result.winner, first);
  assert.equal(g.result.maxRounds, true, "turn 6 settles a low-scoring game");

  g = game("balanced", first);
  rounds(g, [4, 0, [3, 1]]);
  assert.equal(g.phase, "revealed", "below eight points, count opportunities through turn six");
  apply(g, "nextRound");
  turn(g, 0);
  assert.deepEqual(g.result, { winner: first, early: true }, "7:1 on turn 4 ends even below the score threshold");

  g = game("balanced", first);
  rounds(g, [4, 2, 3, 0]);
  assert.equal(g.result, null, "7:2 preserves the remaining defense point and four-point turn");
  apply(g, "nextRound");
  rounds(g, [[0, 1], 4]);
  assert(g.sudden, "the full five-point comeback can lead to overtime");

  g = game("balanced", first);
  rounds(g, [2, 4, 3, 3, 0]);
  assert.deepEqual(g.result, { winner: second, early: true }, "5:7 on turn 5 ends because the trailer has only one defense point left");

  g = game("balanced", first);
  rounds(g, [3, 4, 3, 3, 0]);
  assert.equal(g.result, null, "6:7 on turn 5 still permits a tying defense point");
  apply(g, "nextRound");
  turn(g, 0, 1);
  assert(g.sudden);

  g = game("balanced", first);
  rounds(g, [4, 4, 3, 3, [0, 1]]);
  assert.equal(g.teams[second].score, 8);
  assert.equal(g.phase, "revealed", "a defense point reaching 8 on turn 5 still waits");
  apply(g, "nextRound");
  turn(g, 4);
  assert.equal(g.result.winner, second);
  assert.equal(g.round, 6);

  g = game("balanced", first);
  rounds(g, [[3, 1], 3, 3, 3, [3, 1]]);
  assert.deepEqual([g.teams[first].score, g.teams[second].score], [9, 8]);
  assert.equal(g.round, 5);
  assert.equal(g.phase, "revealed", "9:8 after turn five is not an early finish");
  assert.equal(g.result, null);
  apply(g, "nextRound");
  assert.equal(g.active, second);
  turn(g, 4);
  assert.deepEqual([g.teams[first].score, g.teams[second].score], [9, 12]);
  assert.equal(g.result.winner, second, "the second team can still overturn 9:8 on turn six");

  g = game("balanced", first);
  rounds(g, [4, 4, 4, 4]);
  assert(g.sudden);
  assert.equal(g.phase, "revealed");
  const mainScore = scores(g);
  apply(g, "nextRound");
  turn(g, 3, 1);
  assert.equal(g.phase, "revealed", "first overtime turn cannot decide the game");
  assert.deepEqual(scores(g), mainScore, "overtime leaves main scores unchanged");
  apply(g, "nextRound");
  turn(g, 3);
  assert.equal(g.result.winner, second, "overtime includes the defense point");
  assert.equal(g.result.sudden, true);
  assert.equal(g.round, 6);
  assert.deepEqual(scores(g), mainScore);

  g = game("balanced", first);
  rounds(g, [4, 4, 4, 4, 0, 0]);
  assert.deepEqual(g.result, { winner: null, sudden: true, draw: true });
  assert.equal(g.round, 6, "a tied overtime pair also ends an early tie");

  g = game("balanced", first);
  rounds(g, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(g.phase, "over");
  assert.deepEqual(g.result, { winner: null, sudden: true, draw: true });
  apply(g, "nextRound");
  assert.equal(g.round, 8, "there is never a ninth turn");

  for (const ruleSet of ["original", "balanced"]) {
    g = game(ruleSet, first);
    assert.equal(g.teams[second].score, ruleSet === "original" ? 1 : 0);
    g.teams[second].score = 7;
    turn(g, 4);
    assert.equal(g.catchup, ruleSet === "original");
    apply(g, "nextRound");
    assert.equal(g.active, ruleSet === "original" ? first : second);
  }

  // Original overtime repeats after a tie, then still waits for both teams.
  g = game("original", first);
  g.sudden = true;
  rounds(g, [0, 0]);
  assert.equal(g.phase, "revealed");
  assert.deepEqual(g.sdTurns, { A: false, B: false });
  assert.equal(g.result, null);
  apply(g, "nextRound");
  rounds(g, [4, 0]);
  assert.equal(g.result.winner, first);
}

for (const [offset, points] of [[19, 4], [20, 3], [67, 3], [68, 2], [120, 2], [121, 0]]) {
  const g = game();
  apply(g, "revealCards");
  apply(g, "selectCard", { index: 0 });
  g.target.center = 500;
  apply(g, "donePsychic");
  apply(g, "setDial", { value: 500 + offset });
  apply(g, "lock", { timerSeconds: 0 });
  apply(g, "startGuess");
  apply(g, "guess", { guess: "R" });
  apply(g, "reveal");
  assert.equal(g.reveal.pts, points, "width-48 scoring boundary at " + offset);
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Keep deterministic engine coverage independent of local playtest transcripts.
let replayed = 0;
let earlyReplays = 0;
const earlyReplayRounds = { 2605970957: 3, 3823669892: 5 };
// Historical fixtures predate history-based sampling; preserve their original RNG stream.
const replayWL = require("./load-game.js")({ enabled: false });
const replayApply = (g, type, extra = {}) => replayWL.applyIntent(g, { type, ...extra });
for (const match of replay.matches) {
  const g = replayWL.createGame();
  replayApply(g, "loadDeck", replay.deck);
  const random = Math.random;
  Math.random = rng(match.seed);
  try {
    replayApply(g, "setup", { first: match.first, ruleSet: "balanced" });
    for (const r of match.rounds) {
      assert.equal(g.round, r.round);
      assert.equal(g.active, r.team);
      assert.deepEqual(g.cardChoices, r.candidates);
      replayApply(g, "revealCards");
      replayApply(g, "selectCard", { index: r.selection.index });
      assert.deepEqual(g.target, r.targetRaw);
      replayApply(g, "donePsychic");
      replayApply(g, "setDial", { value: WL.fromSignedPercent(r.dial.dial) });
      replayApply(g, "lock", { timerSeconds: 0 });
      replayApply(g, "startGuess");
      replayApply(g, "guess", { guess: r.opponentSide });
      replayApply(g, "reveal");
      assert.deepEqual([g.reveal.pts, g.reveal.oppPts], [r.pts, r.oppPts]);
      assert.deepEqual(scores(g), [r.scoreAfter.A, r.scoreAfter.B]);
      assert.deepEqual(g.sdPts, r.suddenPointsAfter);
      assert.equal(g.catchup, r.catchup);
      replayed++;
      if (r.round === earlyReplayRounds[match.seed]) {
        assert.deepEqual(g.result, { winner: "A", early: true }, "recorded game now stops once the result is certain");
        earlyReplays++;
        break;
      }
      assert.deepEqual(g.result, r.resultAfter);
      if (g.phase !== "over") replayApply(g, "nextRound");
    }
    assert.equal(g.phase, "over");
  } finally { Math.random = random; }
}
assert.equal(replayed, 20);
assert.equal(earlyReplays, 2);

// Independently enumerate every future scoring outcome. A regulation tie keeps
// both possible winners because either team can win the ensuing overtime pair.
const outcomes = [[0, 0], [0, 1], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0]];
const memo = new Map();
function normalEnd(round, a, b) { return round === 6 || (round === 4 && (a >= 8 || b >= 8)); }
function possibleWinners(round, a, b) {
  if (normalEnd(round, a, b)) return a === b ? 3 : a > b ? 1 : 2;
  const key = [round, a, b].join();
  if (memo.has(key)) return memo.get(key);
  let winners = 0;
  for (const [active, defense] of outcomes) {
    winners |= possibleWinners(round + 1, a + (round % 2 ? defense : active), b + (round % 2 ? active : defense));
    if (winners === 3) break;
  }
  memo.set(key, winners);
  return winners;
}
let states = new Map([["0,0", [0, 0]]]);
let verified = 0;
for (let round = 1; round <= 6; round++) {
  const next = new Map();
  for (const [a, b] of states.values()) {
    for (const [pts, defense] of outcomes) {
      const g = WL.createGame();
      Object.assign(g, { round, phase: "reveal", active: round % 2 ? "A" : "B", card: ["左", "右"],
        target: { center: 500, w4: 19.2, w3: 67.2, w2: 120 },
        dial: 500 + ({ 4: 0, 3: 30, 2: 90, 0: 150 }[pts]), guess: defense ? "L" : "R" });
      g.teams.A.score = a;
      g.teams.B.score = b;
      apply(g, "reveal");
      const [afterA, afterB] = scores(g);
      if (normalEnd(round, afterA, afterB)) continue;
      const winners = possibleWinners(round, afterA, afterB);
      if (winners !== 3) {
        assert.deepEqual(g.result, { winner: winners === 1 ? "A" : "B", early: true }, `all futures agree at ${round}: ${afterA}:${afterB}`);
      } else {
        assert.equal(g.result, null, `possible comeback preserved at ${round}: ${afterA}:${afterB}`);
      }
      next.set([afterA, afterB].join(), [afterA, afterB]);
      verified++;
    }
  }
  states = next;
}
assert(verified > 1000);
console.log(`RULES TEST PASSED: ${verified} early-finish scenarios, tie boundaries, presets, overtime, original behavior, and 20 retained replay turns`);
