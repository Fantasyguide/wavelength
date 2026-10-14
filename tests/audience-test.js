"use strict";

const assert = require("node:assert/strict");
const WL = require("../game.js");
const { createAudience, parseGuess } = require("../audience.js");
const { normalizeConfig } = require("../satori.js");

for (const [text, expected] of [["g-100%", 0], ["g0%", 500], ["g+100%", 1000], ["g100%", 1000],
  ["g-50%", 250], ["g+50%", 750], [" G -67.5％ ", 162.5], ["g0.1%", 500.5], ["g-0%", 500]]) {
  assert.equal(parseGuess(text), expected);
  assert.equal(WL.fromSignedPercent(WL.toSignedPercent(expected)), expected, "signed conversion round trip");
}
assert.equal(WL.formatPercent(-100), "-100%");
assert.equal(WL.formatPercent(0), "0%");
assert.equal(WL.formatPercent(100), "+100%");
for (const text of [null, {}, "", "67%", "g101%", "g100.1%", "g-100.1%", "g-101%", "g+-1%", "g1.23%",
  "g1e2%", "g.5%", "g67", "g67% extra", "<at id='1'/>g67%", "gNaN%", "g67%\ng68%"])
  assert.equal(parseGuess(text), null, String(text));

const config = normalizeConfig({ enabled: true, groupId: "123456789" });
assert.equal(config.topN, 5);
assert.equal(config.guessPolicy, "last");
assert.equal(normalizeConfig().enabled, false);
for (const invalid of [{ groupId: "x" }, { topN: 0 }, { topN: 11 }, { topN: 1.5 },
  { guessPolicy: "each" }, { url: "http://localhost/" }, { url: "ws://a:b@localhost/" }])
  assert.throws(() => normalizeConfig({ ...config, ...invalid }));

let clock = 1700000000500;
let messageId = 0;
const records = [];
const audience = createAudience(config, () => clock, record => records.push(record));
const state = WL.createGame();
audience.sync(state);
function intent(type, extra = {}) {
  WL.applyIntent(state, { type, ...extra });
  if (type === "setup" || type === "newGame") audience.newGame();
  audience.sync(state);
}
function event(userId, text, extra = {}) {
  return { groupId: config.groupId, userId, text, nickname: "玩家" + userId,
    messageId: "msg:" + ++messageId, sentAt: clock, eventAt: clock, ...extra };
}
function submit(userId, text, extra) {
  clock++;
  return audience.receive(event(userId, text, extra));
}

assert.equal(submit("1", "g34%"), false, "setup is closed");
intent("setup", { first: "A", cardMode: "single" });
state.target.center = 670;
assert.equal(submit("1", "g34%"), false, "psychic is closed");
intent("skipCard");
state.target.center = 670;
intent("donePsychic");
assert.equal(audience.snapshot(true).accepting, true);
assert.equal(submit("1", "g32%", { sentAt: Math.floor(clock / 1000) * 1000 }), true,
  "LLBot second-precision time accepts messages in the opening second");
assert.equal(submit("2", "g36%"), true);
assert.equal(submit("3", "g34%"), true);
assert.equal(submit("4", "g40%"), true);
assert.equal(submit("5", "g0%"), true);
assert.equal(submit("6", "g98%"), true);
const oldClock = clock;
assert.equal(submit("1", "g36%"), true);
assert.equal(submit("1", "g-98%", { sentAt: oldClock, eventAt: oldClock }), false,
  "out-of-order delivery does not replace a newer answer");
assert.equal(submit("7", "g34%", { groupId: "999" }), false);
assert.equal(submit("7", "普通聊天"), false);
assert.equal(submit("7", "g34%", { sentAt: clock - 60000 }), false);
assert.equal(submit("7", "g34%", { eventAt: clock - 60000 }), false);
assert.equal(submit("7", "g34%", { eventAt: clock + 10000 }), false);
assert.equal(submit("7", "g34%", { userId: "anonymous" }), false);
assert.equal(submit("7", "g34%", { messageId: null }), false);

intent("lock");
const duplicate = event("6", "g34.2%");
assert.equal(audience.receive(duplicate), true, "answers remain open after lock");
assert.equal(audience.receive(duplicate), false);
intent("guess", { guess: "R" });
const hidden = audience.snapshot(true);
assert.equal(hidden.accepting, true, "answers remain open until reveal is processed");
assert.equal(hidden.count, 6);
assert.equal(hidden.targetPct, null);
assert.deepEqual(hidden.winners, []);
assert.equal(JSON.stringify(hidden).includes("玩家"), false);

intent("reveal");
const revealed = audience.snapshot(true);
assert.equal(revealed.accepting, false);
assert.equal(revealed.targetPct, 34);
assert.deepEqual(revealed.winners.map(w => w.nickname), ["玩家3", "玩家6", "玩家2", "玩家1", "玩家4"]);
assert.equal(revealed.winners[1].errorPct, 0.2);
assert.equal(revealed.winners[0].rank, 1);
assert.equal(revealed.winners[0].avatarUrl, "https://q1.qlogo.cn/g?b=qq&nk=3&s=100");
assert.equal(submit("8", "g34%"), false, "late arrival cannot alter the frozen ranking");
audience.sync(state);
assert.equal(records.length, 1, "each round is archived once, even with repeated state broadcasts");
assert.equal(records[0].ranking.length, 6, "archive includes people outside top five");
assert.equal(records[0].submissions.length, 8, "archive keeps accepted revisions only");
assert.equal(records[0].submissions.filter(s => s.userId === "1").length, 2);
assert.equal(records[0].submissions[0].guessPct, 32);
assert.ok(records[0].submissions.every(s => s.messageId && s.receivedAt && s.eventAt));
assert.deepEqual(records[0].question.pair, WL.cardSides(state.card)[state.side]);

clock += 2000;
intent("nextRound");
assert.equal(audience.snapshot(true).count, 0);
assert.deepEqual(audience.snapshot(true).winners, []);
intent("donePsychic");
assert.equal(audience.receive(duplicate), false, "dedup spans rounds");
assert.equal(submit("7", "g34%", { sentAt: oldClock }), false, "replayed messages cannot enter next round");
intent("lock");
intent("guess", { guess: "L" });
intent("reveal");
assert.equal(records[1].count, 0, "empty rounds are recorded");
assert.equal(records[1].gameId, records[0].gameId);
assert.notEqual(records[1].roundId, records[0].roundId);

intent("newGame");
intent("setup", { cardMode: "single" });
intent("donePsychic");
assert.equal(submit("9", "g-100%"), true);
intent("setWinScore", { value: 1 });
intent("lock");
intent("guess", { guess: "L" });
intent("reveal");
assert.equal(state.phase, "over");
assert.equal(audience.snapshot(true).revealed, true, "final round reveals audience too");
assert.notEqual(records[2].gameId, records[0].gameId);

const disabled = createAudience(normalizeConfig());
disabled.sync(state);
assert.equal(disabled.snapshot(false).enabled, false);
assert.equal(disabled.receive(event("1", "g34%")), false);
console.log("AUDIENCE LOGIC TEST PASSED");
