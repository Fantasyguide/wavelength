"use strict";

const assert = require("node:assert/strict");
const WL = require("../game.js");
const send = (game, type, args = {}) => WL.applyIntent(game, { type, ...args });
const realNow = Date.now;
const realRandom = Math.random;
let now = 100000;
const grace = 1500;

function choiceGame(cards = [["甲", "乙"], ["丙", "丁"], ["戊", "己"]]) {
  Math.random = realRandom;
  const g = WL.createGame();
  send(g, "loadDeck", { cards });
  send(g, "setup");
  return g;
}

// Only the first sample picks a card; later samples generate its target.
function nextRandom(value) {
  Math.random = () => { Math.random = realRandom; return value; };
}

function timedGame(phase = "dial", guessTimerSeconds = 15) {
  Math.random = realRandom;
  const g = WL.createGame();
  send(g, "setup", { cardMode: "single" });
  send(g, "startDialTimer", { timerSeconds: 60, guessTimerSeconds });
  if (phase === "dial") send(g, "donePsychic");
  return g;
}

try {
  Date.now = () => now;
  assert.equal(WL.TIMER_GRACE_MS, grace);
  const choice = choiceGame();
  assert.equal(choice.timerKind, "chooseCard");
  assert.equal(choice.timerEnd, now + 10000, "selection starts with ten seconds");
  now = choice.timerEnd + grace - 1;
  assert.equal(WL.advanceTimers(choice), false, "selection waits throughout the grace period");
  const picked = choice.cardChoices[1];
  send(choice, "selectCard", { index: 1 });
  assert.equal(choice.card, picked, "manual selection is accepted during grace");
  assert.equal(choice.timerEnd, null);
  assert.equal(choice.phase, "psychic");
  const target = choice.target;
  now += 100000;
  assert.equal(WL.advanceTimers(choice), false, "selection does not start the psychic/dial clock");
  assert.equal(choice.target, target);

  const redraw = choiceGame();
  now = redraw.timerEnd + 1000;
  send(redraw, "redrawCards");
  assert.equal(redraw.timerEnd, now + 10000, "redrawing in grace restarts ten seconds");
  const redrawDeadline = redraw.timerEnd;
  now += 1000;
  send(redraw, "redrawCards");
  assert.equal(redraw.timerEnd, redrawDeadline, "spent redraw cannot extend the timer");
  now = redrawDeadline + grace;
  nextRandom(0.25);
  send(redraw, "selectCard", { index: 1 });
  assert.equal(redraw.phase, "psychic", "automatic selection happens at the end of grace");
  assert.equal(redraw.timerEnd, null);

  // Exhaustively sample both layouts, equal tags, and legacy untagged cards.
  for (const tags of [[1, 2], [2, 1], [1, 1], [2, 2], [1, undefined], [undefined, 1], [undefined, 2]]) {
    let left = 0;
    const candidates = tags.map((tag, i) => tag === undefined
      ? ["legacy" + i, "right" + i] : { concepts: ["left" + i, "right" + i], tag });
    for (let i = 0; i < 1000; i++) {
      const g = WL.createGame();
      Object.assign(g, { phase: "chooseCard", cardChoices: candidates.slice(), timerKind: "chooseCard", timerEnd: now - grace });
      nextRandom((i + 0.5) / 1000);
      // A click at the cutoff must not replace the randomized card.
      send(g, "selectCard", { index: 1 });
      if (g.card === candidates[0]) left++;
      assert.equal(g.phase, "psychic");
      assert.equal(g.cardChoices.length, 0);
      assert(g.target);
    }
    const [a, b] = candidates.map(WL.cardTag);
    assert.equal(left, a === b ? 500 : a === 1 ? 700 : 300, `tag probabilities for ${tags}`);
  }
  const singleChoice = choiceGame([["唯一左", "唯一右"]]);
  now = singleChoice.timerEnd + 100000;
  WL.advanceTimers(singleChoice);
  assert.deepEqual(singleChoice.card, ["唯一左", "唯一右"]);
  assert.equal(singleChoice.phase, "psychic", "resuming after selection timeout still waits to view target");
  assert.equal(singleChoice.timerEnd, null);

  for (const phase of ["psychic", "dial"]) {
    const g = timedGame(phase, 7);
    const deadline = g.timerEnd;
    now = deadline - 1;
    assert.equal(WL.advanceTimers(g), false, "no automatic action before the deadline");
    send(g, "startDialTimer", { timerSeconds: 3600 });
    assert.equal(g.timerEnd, deadline, "repeated target viewing cannot extend the clock");
    Math.random = () => 0.9;
    now = deadline + grace - 1;
    assert.equal(WL.advanceTimers(g), false, "psychic/dial remains active until grace ends");
    now = deadline + grace;
    send(g, "lock", { timerSeconds: 3600 });
    assert.equal(g.phase, "guess", `${phase} expires even when a late lock arrives`);
    assert.equal(g.dial, 900, "timeout randomizes a dial still at the displayed zero");
    assert.equal(g.timerEnd, deadline + grace + 7000, "guess countdown starts after dial grace ends");
    send(g, "setDial", { value: 100 });
    assert.equal(g.dial, 900, "late drag cannot move the locked dial");
    now = g.timerEnd + grace - 1;
    assert.equal(WL.advanceTimers(g), false, "guess remains active until grace ends");
    now = g.timerEnd + grace;
    Math.random = () => 0.49999;
    send(g, "guess", { guess: "R" });
    assert.equal(g.guess, "L", "late manual guess cannot override random timeout choice");
    assert.equal(g.phase, "reveal");
    assert.equal(g.timerEnd, null);
    assert.equal(g.timerKind, null);
    assert.equal(WL.advanceTimers(g), false, "expired timer never rerolls the result");
    assert.equal(g.log.length, 0, "scoring waits for explicit reveal");
    send(g, "reveal");
    assert.equal(g.log.length, 1);
    send(g, "reveal");
    assert.equal(g.log.length, 1, "duplicate reveal never scores twice");
  }

  for (const position of [0, 1, 499, 501, 999, 1000]) {
    const g = timedGame("dial", 7);
    const deadline = g.timerEnd;
    now = deadline + grace - 1;
    send(g, "setDial", { value: position });
    Math.random = () => { throw new Error("nonzero dial must not be randomized"); };
    now = deadline + grace;
    send(g, "setDial", { value: 500 });
    assert.equal(g.phase, "guess");
    assert.equal(g.dial, position, "timeout locks the last position received within grace, including both endpoints");
    assert.equal(g.timerEnd, deadline + grace + 7000, "preserving the dial still starts the configured guess clock");
    assert.equal(WL.advanceTimers(g), false, "automatic lock is not repeated");
  }

  const recentered = timedGame();
  send(recentered, "setDial", { value: 750 });
  send(recentered, "setDial", { value: 500 });
  now = recentered.timerEnd + grace;
  Math.random = () => 0.1;
  WL.advanceTimers(recentered);
  assert.equal(recentered.dial, 100, "moving back to displayed zero restores timeout randomization");

  const resumed = timedGame();
  send(resumed, "setDial", { value: 750 });
  now = resumed.timerEnd + 20000;
  Math.random = () => 0.5;
  WL.advanceTimers(resumed);
  assert.equal(resumed.phase, "reveal", "suspended local page catches up through both expired stages");
  assert.equal(resumed.dial, 750, "resuming a suspended page retains its nonzero dial");
  assert.equal(resumed.guess, "R", "the 50% boundary chooses right");

  // A speaking penalty replaces even a moved dial, without changing the target
  // or scoring before the opponent has guessed and the target is revealed.
  for (const [sample, expected] of [[0, 0], [0.25, 250], [0.5, 500], [0.999999, 1000]]) {
    const penalty = timedGame("dial", 7);
    send(penalty, "setDial", { value: 800 });
    const target = JSON.stringify(penalty.target);
    const teams = JSON.stringify(penalty.teams);
    now = penalty.timerEnd + grace - 1;
    nextRandom(sample);
    send(penalty, "penaltyLock", { value: 123 });
    assert.equal(penalty.dial, expected, "penalty uniformly samples the whole scale, ignoring client position");
    assert.equal(penalty.phase, "guess");
    assert.equal(penalty.timerEnd, now + 7000, "penalty starts a full configured guess countdown even during grace");
    assert.equal(JSON.stringify(penalty.target), target);
    assert.equal(JSON.stringify(penalty.teams), teams);
    assert.equal(penalty.log.length, 0);
    const locked = JSON.stringify(penalty);
    send(penalty, "penaltyLock");
    send(penalty, "lock");
    send(penalty, "setDial", { value: 123 });
    assert.equal(JSON.stringify(penalty), locked, "duplicate penalty and late dragging cannot change the locked result");
  }
  for (const phase of ["setup", "chooseCard", "psychic", "guess", "reveal", "revealed", "over"]) {
    const invalid = WL.createGame();
    invalid.phase = phase;
    const before = JSON.stringify(invalid);
    send(invalid, "penaltyLock");
    assert.equal(JSON.stringify(invalid), before, "speaking penalty is only accepted during discussion");
  }
  const untimedPenalty = timedGame("dial");
  send(untimedPenalty, "penaltyLock", { timerSeconds: 0 });
  assert.equal(untimedPenalty.phase, "guess");
  assert.equal(untimedPenalty.timerEnd, null, "penalty respects a disabled guess countdown");
  const latePenalty = timedGame("dial", 7);
  send(latePenalty, "setDial", { value: 800 });
  now = latePenalty.timerEnd + grace;
  send(latePenalty, "penaltyLock", { timerSeconds: 3600 });
  assert.equal(latePenalty.dial, 800, "a penalty confirmed after expiry cannot override the automatic lock");
  assert.equal(latePenalty.timerEnd, now + 7000);

  const noGuessClock = timedGame("dial", 0);
  now = noGuessClock.timerEnd + 20000;
  WL.advanceTimers(noGuessClock);
  assert.equal(noGuessClock.phase, "guess");
  assert.equal(noGuessClock.timerEnd, null, "zero disables the automatic guess clock");
  const noDialClock = WL.createGame();
  send(noDialClock, "setup", { cardMode: "single" });
  send(noDialClock, "startDialTimer", { timerSeconds: 0 });
  now += 100000;
  assert.equal(WL.advanceTimers(noDialClock), false, "zero disables the dial clock");

  const manual = timedGame();
  now = manual.timerEnd + grace - 1;
  send(manual, "setDial", { value: 123 });
  send(manual, "lock", { timerSeconds: 15 });
  assert.equal(manual.timerEnd, now + 15000, "manual lock in grace starts a full guess countdown");
  now = manual.timerEnd + grace - 1;
  send(manual, "guess", { guess: "R" });
  now += 100000;
  assert.equal(WL.advanceTimers(manual), false);
  assert.equal(manual.dial, 123, "manual drag and lock during grace are preserved");
  assert.equal(manual.guess, "R");

  // Stratified random samples cover every supported position, including endpoints.
  const distribution = Array(1001).fill(0);
  let left = 0;
  for (let i = 0; i < 10010; i++) {
    const g = { phase: "dial", timerKind: "dial", timerEnd: now - grace, guessTimerSeconds: 1, dial: 500 };
    Math.random = () => (i + 0.5) / 10010;
    WL.advanceTimers(g);
    distribution[g.dial]++;
    WL.advanceTimers(g, now + 1000 + grace);
    if (g.guess === "L") left++;
  }
  assert(distribution.every(count => count === 10), "all 1001 dial positions receive equal probability");
  assert.equal(left, 5005, "left and right each receive exactly half the probability mass");
} finally {
  Date.now = realNow;
  Math.random = realRandom;
}

console.log("TIMER TEST PASSED: nonzero dial locking, centered randomization, tag probabilities, redraw, 1.5s grace, late input, disabled clocks, resumed pages");
