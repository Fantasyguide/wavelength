"use strict";
// Offline referee for the approved balanced-48 experiment, never a live server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const WL = require('./engine-snapshot.cjs');
const STATE = path.join(__dirname, 'session.json');
const LOCK = path.join(__dirname, '.referee-lock');
const PLAYERS = ['A1', 'A2', 'B1', 'B2'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = x => JSON.parse(JSON.stringify(x));
const score = g => ({ A: g.teams.A.score, B: g.teams.B.score });
const apply = (g, type, extra = {}) => WL.applyIntent(g, { type, ...extra });

function random(s) {
  s.rng = (s.rng + 0x6D2B79F5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function withRandom(s, fn) {
  const original = Math.random;
  Math.random = () => random(s);
  try { return fn(); } finally { Math.random = original; }
}
function prepareRound(s) {
  const g = s.game;
  const role = s.ownTurns[g.active]++ % 2 + 1;
  s.current = {
    game: s.match, round: g.round, team: g.active,
    psychic: g.active + role, guesser: g.active + (3 - role),
    captain: WL.other(g.active) + ((g.round - 1) % 2 + 1),
    candidates: clone(g.cardChoices), scoreBefore: score(g),
    sudden: g.sudden, selection: null, clue: null, dial: null, defense: {},
    startedAt: new Date().toISOString()
  };
  s.stage = 'select';
}
function startMatch(s) {
  s.match++;
  const seed = parseInt(hash('wavelength-balanced48-2026-10-13-match-' + s.match).slice(0, 8), 16);
  s.rng = seed;
  const g = WL.createGame();
  apply(g, 'loadDeck', s.deck);
  withRandom(s, () => apply(g, 'setup', { first: s.match % 2 ? 'B' : 'A', teamA: 'A1 + A2', teamB: 'B1 + B2' }));
  s.game = g;
  s.matches.push({ game: s.match, seed, first: g.first, settings: { winScore: g.winScore, bandWidth: g.bandWidth, maxRounds: WL.MAX_ROUNDS, minRounds: 4, initialScore: [0,0], pairedEnd: true, catchup: false, maxOvertimePairs: 1, targetDistribution: 'recommended', cardMode: g.cardMode }, rounds: [], feedback: {} });
  prepareRound(s);
}
function revealedHistory(s) {
  return s.matches.flatMap(m => m.rounds.map(r => ({
    game: r.game, round: r.round, team: r.team, psychic: r.psychic,
    pair: r.pair, clue: r.clue.clue, target: r.target, dial: r.dial.dial,
    error: r.error, pts: r.pts, oppPts: r.oppPts, scoreAfter: r.scoreAfter,
    opponentSide: r.opponentSide, catchup: r.catchup, sudden: r.sudden
  })));
}
function playerView(s, player) {
  assert(PLAYERS.includes(player));
  const c = s.current;
  const history = revealedHistory(s);
  const base = { player, game: s.match, stage: s.stage, score: score(s.game), sudden: s.game.sudden, suddenPoints: clone(s.game.sdPts), suddenTurns: clone(s.game.sdTurns), historyTotal: history.length, history: s.stage === 'feedback' ? history.filter(r => r.game === s.match) : history.slice(-4), historyNote: '最近四轮公开揭晓；更早轮次请沿用你自己的上下文记忆。局后反馈会给出本局全部轮次。' };
  if (s.stage === 'complete') return { ...base, complete: true };
  if (s.stage === 'feedback') {
    const m = s.matches.at(-1);
    if (m.feedback[player]) return { player, wait: true, stage: s.stage };
    return { ...base, task: 'feedback', winner: m.result.winner, turns: m.rounds.length, result: m.result };
  }
  base.round = c.round;
  base.team = c.team;
  base.psychic = c.psychic;
  base.guesser = c.guesser;
  if (s.stage === 'select' && player === c.psychic) return { ...base, task: 'select', candidates: c.candidates };
  if (s.stage === 'clue' && player === c.psychic) return { ...base, task: 'clue', pair: c.pair, target: WL.toSignedPercent(s.game.target.center), distribution: s.game.target.dist };
  if (s.stage === 'dial' && player === c.guesser) return { ...base, task: 'dial', pair: c.pair, clue: c.clue.clue };
  if (s.stage === 'defend' && player[0] !== c.team && !c.defense[player]) return { ...base, task: 'defend', pair: c.pair, clue: c.clue.clue, lockedDial: c.dial.dial, captain: c.captain };
  return { player, wait: true, game: s.match, round: c.round, stage: s.stage, team: c.team, psychic: c.psychic, guesser: c.guesser };
}
function finishRound(s) {
  const c = s.current, g = s.game;
  const opponents = PLAYERS.filter(p => p[0] !== c.team);
  const average = opponents.reduce((sum, p) => sum + c.defense[p].estimate, 0) / 2;
  c.opponentEstimate = average;
  c.opponentSide = average === c.dial.dial ? c.defense[c.captain].side : average < c.dial.dial ? 'L' : 'R';
  apply(g, 'guess', { guess: c.opponentSide });
  apply(g, 'reveal');
  c.target = WL.toSignedPercent(g.target.center);
  c.targetRaw = clone(g.target);
  c.error = Math.round(Math.abs(c.target - c.dial.dial) * 10) / 10;
  c.pts = g.reveal.pts;
  c.oppPts = g.reveal.oppPts;
  c.opponentCorrect = g.reveal.oppCorrect;
  c.scoreAfter = score(g);
  c.suddenPointsAfter = clone(g.sdPts);
  c.catchup = g.catchup;
  c.resultAfter = clone(g.result);
  c.endedAt = new Date().toISOString();
  s.matches.at(-1).rounds.push(clone(c));
  if (g.phase === 'over') {
    s.matches.at(-1).result = clone(g.result);
    s.matches.at(-1).score = score(g);
    s.stage = 'feedback';
  } else {
    withRandom(s, () => apply(g, 'nextRound'));
    prepareRound(s);
  }
}
function answer(s, player, a) {
  const view = playerView(s, player);
  assert(view.task, 'No action is currently assigned to this player');
  const c = s.current, g = s.game;
  s.actions.push({ player, task: view.task, game: s.match, round: c.round, at: new Date().toISOString(), answer: clone(a) });
  if (view.task === 'select') {
    assert(Number.isInteger(a.index) && a.index >= 0 && a.index < c.candidates.length);
    c.selection = clone(a);
    withRandom(s, () => apply(g, 'selectCard', { index: a.index }));
    c.pair = WL.cardSides(g.card)[0];
    s.stage = 'clue';
  } else if (view.task === 'clue') {
    assert(typeof a.clue === 'string' && a.clue.trim() && a.clue.length <= 40);
    assert(!/[0-9]/.test(a.clue));
    c.clue = clone(a);
    apply(g, 'donePsychic');
    s.stage = 'dial';
  } else if (view.task === 'dial') {
    assert(Number.isFinite(a.dial) && a.dial >= -100 && a.dial <= 100);
    apply(g, 'setDial', { value: WL.fromSignedPercent(a.dial) });
    c.dial = { ...clone(a), requestedDial: a.dial, dial: WL.toSignedPercent(g.dial) };
    apply(g, 'lock', { timerSeconds: 0 });
    s.stage = 'defend';
  } else if (view.task === 'defend') {
    assert(Number.isFinite(a.estimate) && a.estimate >= -100 && a.estimate <= 100);
    assert(['L', 'R'].includes(a.side));
    c.defense[player] = clone(a);
    if (Object.keys(c.defense).length === 2) finishRound(s);
  } else if (view.task === 'feedback') {
    for (const key of ['fun', 'fairness', 'pace', 'agency']) assert(Number.isInteger(a[key]) && a[key] >= 1 && a[key] <= 5);
    s.matches.at(-1).feedback[player] = clone(a);
    if (Object.keys(s.matches.at(-1).feedback).length === 4) {
      if (s.match === 5) s.stage = 'complete';
      else startMatch(s);
    }
  }
  return { accepted: true, task: view.task, next: playerView(s, player) };
}
function status(s) {
  return {
    stage: s.stage, game: s.match, round: s.game.round, score: score(s.game),
    psychic: s.current.psychic, guesser: s.current.guesser,
    pending: PLAYERS.map(p => ({ player: p, task: playerView(s, p).task })).filter(p => p.task),
    matches: s.matches.map(m => ({ game: m.game, first: m.first, rounds: m.rounds.length, result: m.result, score: m.score })),
    lastReveal: revealedHistory(s).at(-1)
  };
}
async function main() {
  const [command, player] = process.argv.slice(2);
  if (command === 'player') {
    let view;
    for (let i = 0; i < (process.argv.includes('--wait') ? 41 : 1); i++) {
      view = playerView(JSON.parse(fs.readFileSync(STATE)), player);
      if (!view.wait) break;
      if (process.argv.includes('--wait')) await wait(500);
    }
    console.log(JSON.stringify(view));
    return;
  }
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); break; }
    catch (err) { if (err.code !== 'EEXIST' || i >= 100) throw err; await wait(100); }
  }
  try {
    let s;
    let result;
    if (command === 'init') {
      assert(!fs.existsSync(STATE), 'Session already exists');
      const deckText = fs.readFileSync(path.join(ROOT, 'cards.yaml'), 'utf8');
      const engine = fs.readFileSync(path.join(__dirname, 'engine-snapshot.cjs'), 'utf8');
      const parsed = WL.parseDeck(deckText);
      const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../2026-10-13-astra-high/session.json')));
      assert.equal(hash(deckText), baseline.deckSha256, 'Use same deck as baseline');
      s = { schema: 2, experiment: 'balanced-48', createdAt: new Date().toISOString(), model: 'gpt-6-astra', reasoningEffort: 'high', baseline: '../2026-10-13-astra-high', baselineEngineSha256: baseline.engineSha256, engineSha256: hash(engine), deckSha256: hash(deckText), deck: { cards: parsed.cards, name: parsed.name }, initialOwnTurns: clone(baseline.ownTurns), match: 0, ownTurns: clone(baseline.ownTurns), matches: [], actions: [] };
      startMatch(s);
      result = status(s);
    } else {
      s = JSON.parse(fs.readFileSync(STATE));
      if (command === 'status') { console.log(JSON.stringify(status(s))); return; }
      assert.equal(command, 'answer');
      result = answer(s, player, JSON.parse(fs.readFileSync(0, 'utf8')));
    }
    const temp = STATE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(temp, STATE);
    console.log(JSON.stringify(result));
  } finally { fs.rmdirSync(LOCK); }
}
main().catch(err => { console.error(err.stack); process.exitCode = 1; });
