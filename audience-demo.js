"use strict";

// Opt-in preview data. Never connects to QQ or writes real audience results.
const WL = require("./game.js");
const people = [
  ["博丽灵梦", "reimu", -50],
  ["雾雨魔理沙", "marisa", 0],
  ["十六夜咲夜", "sakuya", 50],
  ["东风谷早苗", "sanae", -25],
  ["魂魄妖梦", "youmu", 75]
];

module.exports = function demoAudience(state) {
  const revealed = ["revealed", "over"].includes(state.phase) && !!state.target;
  const target = revealed ? WL.toSignedPercent(state.target.center) : null;
  const winners = people.map(([nickname, avatar, guessPct]) => ({
    nickname, avatarUrl: "/assets/demo/" + avatar + ".svg", guessPct,
    errorPct: revealed ? Math.round(Math.abs(guessPct - target) * 10) / 10 : null
  }));
  if (revealed) winners.sort((a, b) => a.errorPct - b.errorPct);
  winners.forEach((person, index) => { person.rank = index + 1; });
  return {
    enabled: true, demo: true, connected: true, percentScale: "signed",
    groupId: "固定演示", topN: people.length, guessPolicy: "latest",
    accepting: ["dial", "guess", "reveal"].includes(state.phase),
    revealed, count: people.length, targetPct: target, winners
  };
};
