const path = require("path");
const WL = require(path.join(__dirname, "..", "game.js"));

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

function bucketCounts(dist, n) {
  let end = 0, center = 0, valley = 0;
  for (let i = 0; i < n; i++) {
    const x = WL.sampleTargetX(dist);
    const a = Math.abs(x);
    if (a > 0.45) end++;
    else if (a < 0.05) center++;
    else if (a > 0.13 && a < 0.19) valley++;
  }
  return { end, center, valley };
}

const N = 20000;

const u = bucketCounts("uniform", N);
assert(Math.abs(u.end - u.center) / u.center < 0.3, `uniform roughly flat (end=${u.end} center=${u.center} valley=${u.valley})`);

function farEndsFrac(dist, n) {
  let far = 0;
  for (let i = 0; i < n; i++) if (Math.abs(WL.sampleTargetX(dist)) > 0.4) far++;
  return far / n;
}

const fracU = farEndsFrac("uniform", N);
const fracMild = farEndsFrac("mild", N);
const fracRec = farEndsFrac("recommended", N);
const fracStrong = farEndsFrac("strong", N);
assert(fracStrong > fracRec && fracRec > fracMild && fracMild > fracU,
  `far-ends fraction ordered strong>rec>mild>uniform (${[fracU, fracMild, fracRec, fracStrong].map((f) => (f * 100).toFixed(1) + "%").join(" > ")})`);
assert(fracRec > fracU + 0.05,
  `recommended far-ends clearly above uniform (${(fracRec * 100).toFixed(1)}% vs ${(fracU * 100).toFixed(1)}%)`);
assert(fracStrong > fracU + 0.10,
  `strong far-ends clearly above uniform (${(fracStrong * 100).toFixed(1)}% vs ${(fracU * 100).toFixed(1)}%)`);
console.log(`ok: far-ends fractions uniform=${(fracU * 100).toFixed(1)}% mild=${(fracMild * 100).toFixed(1)}% rec=${(fracRec * 100).toFixed(1)}% strong=${(fracStrong * 100).toFixed(1)}%`);

for (const [name, dist] of [["mild", "mild"], ["recommended", "recommended"], ["strong", "strong"]]) {
  const b = bucketCounts(dist, N);
  assert(b.end > b.center, `${name}: ends > center (${b.end} vs ${b.center})`);
  assert(b.center > b.valley, `${name}: center > valley (${b.center} vs ${b.valley})`);
  assert(b.end / b.valley > 1.3, `${name}: ends/valley ratio > 1.3 (${(b.end / b.valley).toFixed(2)})`);
  console.log(`ok: ${name} ratios end/valley=${(b.end / b.valley).toFixed(2)} center/valley=${(b.center / b.valley).toFixed(2)}`);
}

const t = WL.newTarget({ dist: "recommended" });
assert(t.center >= 0 && t.center <= 1000, "target center within [0,1000]");
assert(t.center + t.w4 >= 0 && t.center - t.w4 <= 1000, "4-point wedge always at least partially on bar");
assert(t.w4 === 16 && t.w3 === 56 && t.w2 === 100, "default scoring boundaries are 16/56/100");
assert(2 * t.w4 === 32 && t.w3 - t.w4 === 40 && t.w2 - t.w3 === 44, "4/3/2 band widths are 32/40/44");
const t2 = WL.newTarget({ dist: "uniform", bandWidth: 25 });
assert(t2.w4 === 10 && t2.w3 === 35 && t2.w2 === 62.5, "bandWidth override preserves 80%/100%/110% ratios (25)");
assert(WL.BAND_WIDTH === 40, "BAND_WIDTH default exported as 40");

function finishPerfectRound(game) {
  WL.applyIntent(game, { type: "donePsychic" });
  WL.applyIntent(game, { type: "setDial", value: game.target.center });
  WL.applyIntent(game, { type: "lock" });
  WL.applyIntent(game, { type: "startGuess" });
  WL.applyIntent(game, { type: "guess", guess: "L" });
  WL.applyIntent(game, { type: "reveal" });
}

const scheduled = WL.createGame();
WL.applyIntent(scheduled, { type: "setRuleSet", value: "original" });
WL.applyIntent(scheduled, { type: "setCardMode", value: "single" });
WL.applyIntent(scheduled, { type: "setWinScore", value: 0 });
WL.applyIntent(scheduled, { type: "setup", teamA: "先手", teamB: "后手", first: "A" });
assert(scheduled.round === 1 && scheduled.target.dist === "mild", "round 1 uses mild target distribution");
finishPerfectRound(scheduled);
WL.applyIntent(scheduled, { type: "nextRound" });
assert(scheduled.round === 2 && scheduled.active === "B" && scheduled.target.dist === "strong", "round 2 gives the later team the strong distribution");
finishPerfectRound(scheduled);
WL.applyIntent(scheduled, { type: "nextRound" });
assert(scheduled.round === 3 && scheduled.target.dist === "recommended", "round 3 uses recommended target distribution");
for (;;) {
  finishPerfectRound(scheduled);
  if (scheduled.phase === "over") break;
  WL.applyIntent(scheduled, { type: "nextRound" });
  assert(scheduled.target.dist === "recommended", `round ${scheduled.round} keeps recommended target distribution`);
}
assert(scheduled.round === WL.MAX_ROUNDS && scheduled.result.winner === "B" && scheduled.result.maxRounds, "round 10 ends an unlimited-score game with the higher score winning");

const tiedAtTen = WL.createGame();
WL.applyIntent(tiedAtTen, { type: "setRuleSet", value: "original" });
WL.applyIntent(tiedAtTen, { type: "setCardMode", value: "single" });
WL.applyIntent(tiedAtTen, { type: "setWinScore", value: 0 });
WL.applyIntent(tiedAtTen, { type: "setup", teamA: "甲", teamB: "乙", first: "A" });
tiedAtTen.round = WL.MAX_ROUNDS;
tiedAtTen.active = "B";
tiedAtTen.phase = "reveal";
tiedAtTen.teams.A.score = 5;
tiedAtTen.teams.B.score = 5;
tiedAtTen.target = { center: 0, w4: 20, w3: 60, w2: 100, dist: "recommended" };
tiedAtTen.dial = 500;
tiedAtTen.guess = "R";
WL.applyIntent(tiedAtTen, { type: "reveal" });
assert(tiedAtTen.phase === "revealed" && tiedAtTen.sudden && tiedAtTen.result === null, "a tie after round 10 enters sudden death");
assert(WL.MAX_ROUNDS === 10, "MAX_ROUNDS is fixed at 10");

console.log("DIST TEST PASSED");
process.exit(0);
