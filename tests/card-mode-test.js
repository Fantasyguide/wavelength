"use strict";

const assert = require("node:assert/strict");
const WL = require("../game.js");
const topicA = ["热", "冷"];
const topicB = ["大", "小", "快", "慢"];
const topicC = ["远", "近"];
const send = (game, type, args = {}) => WL.applyIntent(game, { type, ...args });

const game = WL.createGame();
assert.equal(game.cardMode, "choice");
send(game, "setRuleSet", { value: "original" });
send(game, "loadDeck", { cards: [topicA, topicB, topicC] });
send(game, "setOrdered", { value: true });
send(game, "setWinScore", { value: 0 });
send(game, "setup", { first: "A" });
assert.equal(game.phase, "readyCards");
assert.equal(game.timerEnd, null);
send(game, "revealCards");
assert.deepEqual(game.cardChoices, [topicC, topicB]);
assert.deepEqual(game.deck, [topicA]);
assert.equal(game.card, null);
assert.equal(game.target, null);
const choiceDeadline = game.timerEnd;
assert.equal(game.timerKind, "chooseCard");
for (const index of [-1, 2, 0.5, "0", null]) send(game, "selectCard", { index });
send(game, "donePsychic");
send(game, "startDialTimer", { timerSeconds: 60 });
send(game, "lock");
assert.equal(game.phase, "chooseCard");
assert.equal(game.timerEnd, choiceDeadline, "invalid actions cannot reset the selection countdown");
assert.equal(game.target, null);
send(game, "setCardMode", { value: "single" });
assert.equal(game.cardMode, "choice", "mode cannot change during a round");
send(game, "selectCard", { index: 1 });
assert.equal(game.phase, "psychic");
assert.equal(game.timerEnd, null, "selecting a card clears its countdown");
assert.deepEqual(game.card, topicB);
assert.deepEqual(game.cardChoices, []);
assert.equal(game.target.dist, "mild");
const selectedTarget = game.target;
send(game, "selectCard", { index: 0 });
assert.equal(game.target, selectedTarget, "duplicate selection does not regenerate target");
send(game, "selectSide", { side: 1 });
assert.equal(game.side, 1, "double-sided card still supports side selection");
send(game, "startDialTimer", { timerSeconds: 60 });
send(game, "skipCard");
assert.equal(game.phase, "psychic", "choice mode cannot bypass redraw limits after selection");
assert.equal(game.round, 1);
assert.equal(game.target, selectedTarget);
assert.equal(game.side, 1);
send(game, "setup");

for (let round = 1; round <= WL.MAX_ROUNDS; round++) {
  assert.equal(game.phase, "readyCards");
  send(game, "revealCards");
  assert.equal(game.cardChoices.length, 2);
  assert.notDeepEqual(game.cardChoices[0], game.cardChoices[1]);
  send(game, "selectCard", { index: round % 2 });
  assert.equal(game.target.dist, WL.targetDistForRound(round));
  send(game, "donePsychic");
  send(game, "setDial", { value: game.target.center });
  send(game, "lock");
  send(game, "startGuess");
  send(game, "guess", { guess: "L" });
  send(game, "reveal");
  assert.equal(game.log.length, round);
  if (round < WL.MAX_ROUNDS) send(game, "nextRound");
}
assert.equal(game.phase, "over");
send(game, "newGame");
assert.equal(game.cardMode, "choice");
assert.equal(game.card, null);
assert.equal(game.target, null);
assert.deepEqual(game.cardChoices, []);
send(game, "setCardMode", { value: "invalid" });
assert.equal(game.cardMode, "choice");
send(game, "setCardMode", { value: "single" });
send(game, "setup");
assert.equal(game.phase, "psychic", "classic mode starts directly with one card");
assert.deepEqual(game.cardChoices, []);
send(game, "skipCard");
assert.equal(game.phase, "psychic");
send(game, "newGame");
assert.equal(game.cardMode, "single", "restart keeps the selected mode");
send(game, "setup", { cardMode: "choice" });
assert.equal(game.phase, "readyCards", "setup can switch back to the default mode");

for (const cards of [[topicA], [topicA, topicA], [topicA, topicB], [topicA, topicA, topicB]]) {
  const small = WL.createGame();
  send(small, "loadDeck", { cards });
  send(small, "setup");
  for (let i = 0; i < 20; i++) {
    assert.equal(small.cardChoices.length, cards.includes(topicB) ? 2 : 1);
    if (small.cardChoices.length === 2) assert.notDeepEqual(small.cardChoices[0], small.cardChoices[1]);
    send(small, "revealCards");
    send(small, "selectCard", { index: 0 });
    send(small, "selectSide", { side: 1 });
    assert(small.side < WL.cardSides(small.card).length);
    send(small, "setup");
  }
}

for (const sign of [-1, 1]) {
  for (const [distance, points] of [[0, 4], [16, 4], [17, 3], [56, 3], [57, 2], [100, 2], [101, 0]]) {
    const scoreGame = WL.createGame();
    send(scoreGame, "setup", { ruleSet: "original" });
    send(scoreGame, "revealCards");
    send(scoreGame, "selectCard", { index: 0 });
    scoreGame.target.center = 500;
    send(scoreGame, "donePsychic");
    send(scoreGame, "setDial", { value: 500 + sign * distance });
    send(scoreGame, "lock");
    send(scoreGame, "startGuess");
    send(scoreGame, "guess", { guess: "L" });
    send(scoreGame, "reveal");
    assert.equal(scoreGame.reveal.pts, points, `score at signed distance ${sign * distance}`);
  }
}

const redraw = WL.createGame();
send(redraw, "loadDeck", { cards: [topicA, topicB, topicC, ["上", "下"]] });
send(redraw, "setOrdered", { value: true });
send(redraw, "setup");
const oldChoices = redraw.cardChoices.slice();
send(redraw, "revealCards");
send(redraw, "redrawCards");
assert.equal(redraw.phase, "readyCards");
assert.equal(redraw.round, 1);
assert.equal(redraw.target, null);
assert(redraw.cardChoices.every(c => !oldChoices.includes(c)), "both candidates replaced when enough topics exist");
assert.deepEqual(redraw.redrawUsed, { A: true, B: false });
const freshChoices = redraw.cardChoices;
send(redraw, "revealCards");
send(redraw, "redrawCards");
assert.equal(redraw.cardChoices, freshChoices, "repeat redraw cannot spend another chance");
for (let round = 1; round <= 3; round++) {
  send(redraw, "revealCards");
  send(redraw, "selectCard", { index: 0 });
  send(redraw, "redrawCards");
  assert.equal(redraw.phase, "psychic", "redraw only allowed before selection");
  send(redraw, "donePsychic");
  send(redraw, "setDial", { value: redraw.target.center > 500 ? 0 : 1000 });
  send(redraw, "lock", { timerSeconds: 0 });
  send(redraw, "startGuess");
  send(redraw, "guess", { guess: "L" });
  send(redraw, "reveal");
  send(redraw, "nextRound");
  if (round === 1) {
    assert.equal(redraw.active, "B");
    send(redraw, "revealCards");
    send(redraw, "redrawCards");
    assert.deepEqual(redraw.redrawUsed, { A: true, B: true }, "other team gets its own chance");
  }
}
redraw.sudden = true;
const overtimeChoices = redraw.cardChoices;
send(redraw, "revealCards");
send(redraw, "redrawCards");
assert.equal(redraw.cardChoices, overtimeChoices, "redraw stays spent in later rounds and overtime");
send(redraw, "newGame");
assert.deepEqual(redraw.redrawUsed, { A: false, B: false }, "restart restores both chances");
send(redraw, "setup", { first: "B" });
send(redraw, "revealCards");
send(redraw, "redrawCards");
assert.deepEqual(redraw.redrawUsed, { A: false, B: true }, "B can redraw when going first");

console.log("CARD MODE TEST PASSED: selection, validation, refill, small decks, full game, classic mode, scoring boundaries");
