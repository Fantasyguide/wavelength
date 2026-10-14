"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const demo = require("../audience-demo.js");
const WL = require("../game.js");
const state = WL.createGame();
const expected = demo(state);
assert.equal(expected.demo, true);
assert.equal(expected.winners.length, 5);
for (const person of expected.winners) {
  assert(fs.existsSync(path.join(__dirname, "..", person.avatarUrl)));
  assert.equal(person.errorPct, null);
}
for (const phase of ["setup", "chooseCard", "psychic", "dial", "guess", "reveal"]) {
  state.phase = phase;
  state.target = { center: 250 };
  const snapshot = demo(state);
  assert.equal(snapshot.targetPct, null, "no target disclosure before reveal");
  assert.deepEqual(snapshot.winners, expected.winners, "fixed identities, local avatars and answers across phases");
}
state.phase = "revealed";
const revealed = demo(state);
assert.equal(revealed.targetPct, -50);
assert.equal(revealed.accepting, false);
assert.equal(revealed.winners[0].errorPct, 0);
assert(revealed.winners.every((p, i, list) => i === 0 || p.errorPct >= list[i - 1].errorPct));
assert.deepEqual(demo(state), revealed, "repeated snapshots are stable");
revealed.winners[0].nickname = "mutated snapshot";
assert.equal(demo(state).winners[0].nickname, "博丽灵梦", "snapshots do not share mutable fixture data");
console.log("FIXED AUDIENCE DEMO TEST PASSED");
