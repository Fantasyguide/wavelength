"use strict";

const assert = require("node:assert/strict");
const loadGame = require("./load-game.js");
const WL = require("../game.js");
const config = require("../target-sampling-config.js");
assert.deepEqual(config, { enabled: true, easyThreshold: 70, strength: 0.5,
  minEasyProbability: 0.1, maxEasyProbability: 0.9 });

function randomValues(values, fn) {
  const original = Math.random;
  let index = 0;
  Math.random = () => { assert(index < values.length, "unexpected extra random draw"); return values[index++]; };
  try { const result = fn(); assert.equal(index, values.length, "all proposed targets were consumed"); return result; }
  finally { Math.random = original; }
}
function game(engine = WL) {
  const g = engine.createGame();
  g.round = 1;
  return g;
}
function target(g, proposals, engine = WL) {
  return randomValues(proposals.flatMap(([center, coin]) => [center / 1000, 0, coin]), () => engine.newTarget(g)).center;
}
const g = game();
assert.equal(target(g, [[900, 0.99]]), 900);
g.round = 2; g.active = "B";
assert.equal(target(g, [[100, 0.99]]), 100, "B starts with its own empty history");
g.round = 3; g.active = "A";
assert.equal(target(g, [[900, 0.3], [600, 0.99]]), 600, "after an easy target its next easy acceptance is about 0.253");
g.round = 5;
assert.equal(target(g, [[900, 0.85], [500, 0.99]]), 500, "rejected proposals do not enter the next turn's history");
assert(!/history|sampling|probability/i.test(JSON.stringify(g)), "private sampling data is absent from shared snapshots");

for (const edge of [150, 850]) {
  const boundary = game();
  assert.equal(target(boundary, [[edge, 0.5]]), edge);
  boundary.round = 3;
  assert.equal(target(boundary, [[edge, 0.5], [edge === 150 ? 149 : 851, 0.99]]), edge === 150 ? 149 : 851,
    "exactly +/-70 is hard, the next integer center is easy");
}

const clipped = loadGame({ strength: 100 });
const low = game(clipped);
target(low, [[900, 0.5]], clipped); low.round = 3;
assert.equal(target(low, [[900, 0.2], [500, 0.99]], clipped), 500, "lower bound uses calibrated acceptance");
const high = game(clipped);
target(high, [[500, 0.5]], clipped); high.round = 3;
assert.equal(target(high, [[500, 0.15], [900, 0.99]], clipped), 900, "upper bound uses calibrated acceptance");
const neutral = loadGame({ strength: 0 });
const neutralGame = game(neutral);
target(neutralGame, [[900, 0.99]], neutral); neutralGame.round = 3;
assert.equal(target(neutralGame, [[900, 0.99]], neutral), 900, "zero strength removes history feedback");

const lifecycle = WL.createGame();
const apply = (type, extra = {}) => WL.applyIntent(lifecycle, { type, ...extra });
apply("loadDeck", { cards: [["左", "右"]] }); apply("setOrdered", { value: true });
randomValues([], () => { apply("setup"); apply("revealCards"); apply("redrawCards"); apply("revealCards"); });
randomValues([0.9, 0, 0.99], () => apply("selectCard", { index: 0 }));
assert.equal(lifecycle.target.center, 900, "choosing and redrawing cards do not consume target history");
randomValues([], () => apply("selectCard", { index: 0 }));
lifecycle.round = 3; lifecycle.sudden = true;
assert.equal(target(lifecycle, [[900, 0.3], [500, 0.99]]), 500, "overtime inherits regulation history");
apply("newGame");
randomValues([0.9, 0, 0.99], () => apply("setup", { cardMode: "single" }));
assert.equal(lifecycle.target.center, 900, "a new match clears history");
randomValues([0.9, 0, 0.99], () => apply("skipCard"));
assert.equal(lifecycle.target.center, 900, "classic skip replaces rather than advances the round history");
lifecycle.round = 3;
assert.equal(target(lifecycle, [[900, 0.3], [500, 0.99]]), 500, "classic replacements count once");
randomValues([0.9, 0, 0.99], () => apply("setup", { cardMode: "single" }));
assert.equal(lifecycle.target.center, 900, "setup also resets an existing match");
assert.equal(target(game(), [[900, 0.99]]), 900, "separate games do not share history");

const disabled = loadGame({ enabled: false });
assert.equal(randomValues([0.9, 0], () => disabled.newTarget(game(disabled))).center, 900,
  "file switch disables the extra acceptance draw");
const original = game(); original.ruleSet = "original";
assert.equal(randomValues([0.9, 0], () => WL.newTarget(original)).center, 900, "original rules keep their sampling");
for (const invalid of [{ enabled: "true" }, { strength: -1 }, { strength: Infinity }, { easyThreshold: 100 },
  { minEasyProbability: -0.1 }, { maxEasyProbability: 1.1 }, { minEasyProbability: 0.9, maxEasyProbability: 0.1 }]) {
  assert.throws(() => loadGame(invalid), /Invalid target-sampling-config/);
}

function seeded(seed) {
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function samplePairs(engine) {
  const originalRandom = Math.random;
  Math.random = seeded(20261019);
  const counts = [0, 0, 0], zones = { easy: 0, far: 0, hard: 0, center: 0 };
  let gap2 = 0;
  const n = 30000;
  try {
    for (let i = 0; i < n; i++) {
      const state = engine.createGame(), easy = { A: 0, B: 0 };
      for (let r = 1; r <= 4; r++) {
        state.round = r; state.active = r % 2 ? "A" : "B";
        const distance = Math.abs(engine.newTarget(state).center - 500) / 5;
        if (distance > 70) { easy[state.active]++; zones.easy++; if (distance > 90) zones.far++; }
        else { zones.hard++; if (distance < 20) zones.center++; }
      }
      counts[easy.A]++; counts[easy.B]++;
      if (Math.abs(easy.A - easy.B) === 2) gap2++;
    }
    return { counts: counts.map(x => x / (2 * n)), gap2: gap2 / n,
      easyShare: zones.easy / (4 * n), farWithinEasy: zones.far / zones.easy, centerWithinHard: zones.center / zones.hard };
  } finally { Math.random = originalRandom; }
}
const soft = samplePairs(WL), base = samplePairs(disabled);
const expected = [0.183095862421263, 0.74132940498109, 0.075574732597647];
expected.forEach((p, i) => assert(Math.abs(soft.counts[i] - p) < 0.012, "two-turn history matches independently calculated probabilities"));
assert(Math.abs(soft.easyShare - 0.4462394350881921) < 0.01, "feedback preserves the expected share through two turns");
assert(soft.gap2 > 0.02 && soft.gap2 < 0.04 && base.gap2 > 0.11 && base.gap2 < 0.14,
  "independent teams are much less likely to receive opposite difficulty extremes");
for (const metric of ["farWithinEasy", "centerWithinHard"]) {
  assert(Math.abs(soft[metric] - base[metric]) < 0.015, "conditional target shape is preserved: " + metric);
}
console.log("TARGET SAMPLING TEST PASSED", JSON.stringify({ soft, base }));
