"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const WL = require("../game.js");
const send = (game, type, args = {}) => WL.applyIntent(game, { type, ...args });
const yaml = "name: 标签测试\ncards:\n  - concepts: [节目, 效果]\n    tag: 1 # 初步分类\n  - concepts: [普通, 容易, 热, 冷]\n    tag: 2\n  - [远, 近]\n  - concepts: [快, 慢]\n";
const parsed = WL.parseDeck(yaml);
assert.equal(parsed.name, "标签测试");
assert.deepEqual(parsed.cards.map(WL.cardTag), [1, 2, 2, 2]);
assert.deepEqual(WL.cardSides(parsed.cards[1]), [["普通", "容易"], ["热", "冷"]]);
assert.deepEqual(WL.parseDeck(JSON.stringify(parsed)), parsed, "tags survive JSON transport and saved decks");
for (const tag of [0, 3, "1", null]) {
  assert.throws(() => WL.parseDeck(JSON.stringify({ cards: [{ concepts: ["甲", "乙"], tag }] })), /tag/);
}
assert.throws(() => WL.parseDeck("- concepts: [甲, 乙]\n  tag: 3\n"), /格式错误/);
assert.throws(() => WL.parseDeck("- concepts: [甲, 乙]\n  tag: 1\n  tag: 2\n"), /格式错误/);
const defaults = WL.parseDeck(fs.readFileSync(require("node:path").join(__dirname, "../cards.yaml"), "utf8"));
assert(defaults.cards.some(c => WL.cardTag(c) === 1) && defaults.cards.some(c => WL.cardTag(c) === 2));

const realRandom = Math.random;
let seed = 7919;
try {
  Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const g = WL.createGame();
  // Deliberately unequal pool sizes expose depletion-driven probability drift.
  const cards = Array.from({ length: 44 }, (_, i) => ({ concepts: [`左${i}`, `右${i}`], tag: i < 4 ? 1 : 2 }));
  send(g, "loadDeck", { cards });
  let leftFun = 0, rightNormal = 0;
  const trials = 10000;
  for (let i = 0; i < trials; i++) {
    send(g, "setup");
    assert.notDeepEqual(WL.cardSides(g.cardChoices[0]), WL.cardSides(g.cardChoices[1]));
    leftFun += WL.cardTag(g.cardChoices[0]) === 1;
    rightNormal += WL.cardTag(g.cardChoices[1]) === 2;
  }
  assert(Math.abs(leftFun / trials - 0.7) < 0.02, `left tag 1: ${leftFun / trials}`);
  assert(Math.abs(rightNormal / trials - 0.7) < 0.02, `right tag 2: ${rightNormal / trials}`);
  console.log(`tag frequencies: left tag 1 ${leftFun / 100}%, right tag 2 ${rightNormal / 100}%`);

  for (const cards of [parsed.cards.slice(0, 1), parsed.cards.slice(1),
    [["甲", "乙"], { concepts: ["甲", "乙"], tag: 1 }]]) {
    const small = WL.createGame();
    send(small, "loadDeck", { cards });
    send(small, "setup");
    send(small, "redrawCards");
    assert(small.cardChoices.length >= 1 && small.cardChoices.length <= 2);
    if (small.cardChoices.length === 2) assert.notDeepEqual(WL.cardSides(small.cardChoices[0]), WL.cardSides(small.cardChoices[1]));
    send(small, "selectCard", { index: 0 });
    assert.equal(small.phase, "psychic", "missing tags, duplicate metadata and tiny decks stay playable");
  }
} finally {
  Math.random = realRandom;
}
console.log("CARD TAG TEST PASSED: formats, default tags, persistence, weighted selection, missing pools, tiny decks");
