"use strict";

var crypto = require("crypto");
var WL = require("./game.js");

// QQ-specific event normalization stays outside the shared/offline game engine.
function qqId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  var id = String(value == null ? "" : value);
  return /^[1-9]\d{0,19}$/.test(id) ? id : "";
}

function parseGuess(message) {
  if (typeof message !== "string" || message.length > 100) return null;
  var match = message.trim().match(/^g\s*([+-]?\d{1,3}(?:\.\d)?)\s*[%％]$/i);
  if (!match || Math.abs(Number(match[1])) > 100) return null;
  return WL.fromSignedPercent(Number(match[1]));
}

function createAudience(config, now, onRound) {
  now = now || Date.now;
  onRound = onRound || function () {};
  var gameId = crypto.randomUUID();
  var roundId;
  var question;
  var target = null;
  var round = 0;
  var openedAt = null;
  var accepting = false;
  var revealed = false;
  var guesses = new Map();
  // Keep recent IDs across rounds so a reconnect cannot reuse an old submission.
  var seen = new Set();
  var sequence = 0;
  var winners = [];
  var submissions = [];

  function resetRound() {
    roundId = crypto.randomUUID();
    openedAt = null;
    accepting = false;
    revealed = false;
    guesses.clear();
    winners = [];
    submissions = [];
    question = null;
  }

  function newGame() {
    gameId = crypto.randomUUID();
    target = null;
    round = 0;
    resetRound();
  }

  function sync(state) {
    if (state.target !== target || state.round !== round || state.phase === "setup") {
      target = state.target;
      round = state.round;
      resetRound();
    }
    if (config.enabled && target && state.phase === "dial" && openedAt === null) {
      openedAt = now();
      question = {
        deckName: state.deckName,
        pair: WL.cardSides(state.card)[state.side].slice(),
        team: state.active,
        teams: { A: state.teams.A.name, B: state.teams.B.name },
        sudden: state.sudden
      };
    }
    accepting = config.enabled && openedAt !== null &&
      ["dial", "guess", "reveal"].includes(state.phase);
    if (!revealed && openedAt !== null && ["revealed", "over"].includes(state.phase)) {
      revealed = true;
      var ranking = Array.from(guesses.values()).sort(function (a, b) {
        return Math.abs(a.value - target.center) - Math.abs(b.value - target.center) ||
          a.sentAt - b.sentAt || a.eventAt - b.eventAt || a.sequence - b.sequence;
      }).map(function (guess, index) {
        return Object.assign({}, guess, {
          rank: index + 1,
          guessPct: WL.toSignedPercent(guess.value),
          errorPct: Math.round(Math.abs(guess.value - target.center) / WL.UNIT * 2000) / 10
        });
      });
      winners = ranking.slice(0, config.topN).map(function (guess) {
        return {
          rank: guess.rank,
          nickname: guess.nickname,
          avatarUrl: guess.avatarUrl || "https://q1.qlogo.cn/g?b=qq&nk=" + guess.userId + "&s=100",
          guessPct: guess.guessPct,
          errorPct: guess.errorPct
        };
      });
      onRound({
        version: 2,
        percentScale: "signed",
        gameId: gameId,
        roundId: roundId,
        round: round,
        groupId: config.groupId,
        openedAt: openedAt,
        revealedAt: now(),
        question: question,
        targetPct: WL.toSignedPercent(target.center),
        dialPct: WL.toSignedPercent(state.dial),
        guessPolicy: config.guessPolicy,
        count: guesses.size,
        ranking: ranking,
        submissions: submissions.slice()
      });
    }
  }

  function receive(event) {
    if (!event || event.groupId !== config.groupId) return false;
    var userId = qqId(event.userId);
    if (!userId) return false;
    var value = parseGuess(event.text);
    if (value === null || !Number.isSafeInteger(event.sentAt) || event.sentAt <= 0 ||
        !Number.isSafeInteger(event.eventAt) || event.eventAt <= 0 ||
        typeof event.messageId !== "string" || !event.messageId || event.messageId.length > 200) return false;
    var key = userId + ":" + event.messageId;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 20000) seen.delete(seen.values().next().value);
    var receivedAt = now();
    // LLBot's created_at is rounded to seconds; its event timestamp is millisecond precision.
    // Check both so fresh messages in the opening second work, while old replays do not.
    var sentAtEnd = event.sentAt + (event.sentAt % 1000 === 0 ? 999 : 0);
    if (!accepting || sentAtEnd < openedAt || event.eventAt < openedAt ||
        event.sentAt > receivedAt + 5000 || event.eventAt > receivedAt + 5000) return false;
    var previous = guesses.get(userId);
    if (previous && (config.guessPolicy === "first" || event.sentAt < previous.sentAt ||
        (event.sentAt === previous.sentAt && event.eventAt < previous.eventAt))) return false;
    var nickname = typeof event.nickname === "string" ? event.nickname.trim().slice(0, 80) : "";
    var guess = {
      userId: userId,
      nickname: nickname || "QQ " + userId,
      avatarUrl: event.avatarUrl,
      messageId: event.messageId,
      value: value,
      guessPct: WL.toSignedPercent(value),
      sentAt: event.sentAt,
      eventAt: event.eventAt,
      receivedAt: receivedAt,
      sequence: sequence++
    };
    guesses.set(userId, guess);
    submissions.push(guess);
    return true;
  }

  function snapshot(connected) {
    return {
      enabled: config.enabled,
      percentScale: "signed",
      connected: connected,
      groupId: config.groupId,
      topN: config.topN,
      guessPolicy: config.guessPolicy,
      accepting: accepting,
      revealed: revealed,
      count: guesses.size,
      targetPct: revealed ? WL.toSignedPercent(target.center) : null,
      winners: winners
    };
  }

  return { sync: sync, receive: receive, snapshot: snapshot, newGame: newGame };
}

module.exports = { createAudience: createAudience, parseGuess: parseGuess, qqId: qqId };
