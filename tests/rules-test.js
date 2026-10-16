"use strict";

const assert = require("node:assert/strict");
const WL = require("../game.js");
const replay = require("./fixtures/balanced-replay.json");
const apply = (g, type, extra = {}) => WL.applyIntent(g, { type, ...extra });
const scores = g => [g.teams.A.score, g.teams.B.score];

function game(ruleSet = "balanced", first = "A") {
  const g = WL.createGame();
  apply(g, "setup", { ruleSet, first });
  return g;
}
function turn(g, points, defense = 0) {
  if (g.phase === "chooseCard") apply(g, "selectCard", { index: 0 });
  assert.equal(g.phase, "psychic");
  if (g.ruleSet === "balanced") assert.equal(g.target.dist, "recommended");
  g.target.center = 500;
  apply(g, "donePsychic");
  apply(g, "setDial", { value: 500 + ({ 4: 0, 3: 30, 2: 90, 0: 150 }[points]) });
  apply(g, "lock", { timerSeconds: 0 });
  apply(g, "guess", { guess: defense ? "L" : "R" });
  apply(g, "reveal");
  assert.equal(g.reveal.pts, points);
  assert.equal(g.reveal.oppPts, defense);
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
assert.equal(preset.ruleSet, "original");
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
apply(preset, "setWinScore", { value: 1 });
apply(preset, "setBandWidth", { value: 200 });
assert.deepEqual([preset.winScore, preset.bandWidth], [8, 48], "balanced preset stays fixed");
apply(preset, "setCardMode", { value: "single" });
apply(preset, "setOrdered", { value: true });
apply(preset, "loadDeck", { cards: [["左", "右"]], name: "保留题库" });
apply(preset, "setup", { first: "B", teamA: "甲", teamB: "乙" });
assert.equal(preset.phase, "psychic");
assert.deepEqual(scores(preset), [0, 0]);
apply(preset, "setRuleSet", { value: "original" });
assert.equal(preset.ruleSet, "balanced", "cannot switch rules during a game");
apply(preset, "newGame");
assert.deepEqual([preset.ruleSet, preset.winScore, preset.bandWidth, ...scores(preset)], ["balanced", 8, 48, 0, 0]);
assert.deepEqual([preset.cardMode, preset.ordered, preset.deckName, preset.teams.A.name], ["single", true, "保留题库", "甲"]);
apply(preset, "setRuleSet", { value: "original" });
assert.deepEqual([preset.winScore, preset.bandWidth, ...scores(preset)], [10, 40, 1, 0]);

for (const first of ["A", "B"]) {
  const second = WL.other(first);
  let g = game("balanced", first);
  assert.deepEqual(scores(g), [0, 0]);
  rounds(g, [4, 0, 4]);
  assert.equal(g.teams[first].score, 8);
  assert.equal(g.phase, "revealed", "reaching 8 on turn 3 waits for the opponent");
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
  rounds(g, [4, 4, 3, 3, [0, 1]]);
  assert.equal(g.teams[second].score, 8);
  assert.equal(g.phase, "revealed", "a defense point reaching 8 on turn 5 still waits");
  apply(g, "nextRound");
  turn(g, 4);
  assert.equal(g.result.winner, second);
  assert.equal(g.round, 6);

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
  apply(g, "selectCard", { index: 0 });
  g.target.center = 500;
  apply(g, "donePsychic");
  apply(g, "setDial", { value: 500 + offset });
  apply(g, "lock", { timerSeconds: 0 });
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
for (const match of replay.matches) {
  const g = WL.createGame();
  apply(g, "loadDeck", replay.deck);
  const random = Math.random;
  Math.random = rng(match.seed);
  try {
    apply(g, "setup", { first: match.first, ruleSet: "balanced" });
    for (const r of match.rounds) {
      assert.equal(g.round, r.round);
      assert.equal(g.active, r.team);
      assert.deepEqual(g.cardChoices, r.candidates);
      apply(g, "selectCard", { index: r.selection.index });
      assert.deepEqual(g.target, r.targetRaw);
      apply(g, "donePsychic");
      apply(g, "setDial", { value: WL.fromSignedPercent(r.dial.dial) });
      apply(g, "lock", { timerSeconds: 0 });
      apply(g, "guess", { guess: r.opponentSide });
      apply(g, "reveal");
      assert.deepEqual([g.reveal.pts, g.reveal.oppPts], [r.pts, r.oppPts]);
      assert.deepEqual(scores(g), [r.scoreAfter.A, r.scoreAfter.B]);
      assert.deepEqual(g.sdPts, r.suddenPointsAfter);
      assert.equal(g.catchup, r.catchup);
      assert.deepEqual(g.result, r.resultAfter);
      replayed++;
      if (g.phase !== "over") apply(g, "nextRound");
    }
    assert.equal(g.phase, "over");
  } finally { Math.random = random; }
}
assert.equal(replayed, 22);
console.log("RULES TEST PASSED: presets, paired endings, bounded overtime, draws, original behavior, and all 22 recorded turns");
